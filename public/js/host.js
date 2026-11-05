// The room "server", running inside the host's browser.
// Clients (the host's own client and remote peers) talk to it with the same JSON messages.
import { Game, isMap, DIFFICULTY, FOE_TYPES, BOSSES, MODES, MISSIONS, FRIENDLY_FIRE } from './sim.js';

const TICK = 1 / 30;
const SNAPSHOT_EVERY = 2;     // ticks per snapshot -> 15 Hz
export const MAX_PLAYERS = 8;
const MAX_CHARS = 32;          // cosmetic character index; the renderer falls back for unknown ones
const COLORS = ['#e8423f', '#3f8be8', '#f2c230', '#3fc46a', '#b25be8', '#f2873a', '#38d0d0', '#ef6fb4'];

const cleanText = (s, n) => [...String(s ?? '')].filter(ch => ch >= ' ').join('').trim().slice(0, n);

// Background tabs throttle timers on the main thread; a worker keeps the game ticking
// when the host switches to another window.
function makeTicker(fn, ms) {
  try {
    const src = 'let iv; onmessage = e => { clearInterval(iv); if (e.data > 0) iv = setInterval(() => postMessage(0), e.data); };';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    w.postMessage(ms);
    return () => { w.postMessage(0); w.terminate(); };
  } catch (e) {
    const iv = setInterval(fn, ms);
    return () => clearInterval(iv);
  }
}

export class Host {
  constructor(code, mapId) {
    this.code = code;
    this.mapId = isMap(mapId) ? mapId : 'depot';
    this.diff = 'normal';
    this.foes = [...FOE_TYPES];
    this.mode = 'classic';
    this.mission = 0;
    this.ff = 'off';
    this.paused = false;
    this.clients = new Map();     // id -> { id, name, color, inRoom, sendRaw }
    this.hostId = null;
    this.state = 'lobby';
    this.game = null;
    this.nid = 0;
    this.stopTicker = null;
  }

  // ---------------------------------------------------------- clients --
  addClient(sendRaw) {
    const c = { id: ++this.nid, name: `Player${this.nid + 1}`, color: null, char: 0, inRoom: false, sendRaw };
    this.clients.set(c.id, c);
    return c;
  }

  removeClient(c) {
    if (!this.clients.has(c.id)) return;
    this.clients.delete(c.id);
    if (c.inRoom) this.leaveRoom(c);
  }

  send(c, msg) {
    try { c.sendRaw(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch (e) { /* peer went away */ }
  }

  members() { return [...this.clients.values()].filter(c => c.inRoom); }

  broadcast(msg) {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const c of this.members()) this.send(c, s);
  }

  info() {
    return {
      t: 'room', code: this.code, map: this.mapId, host: this.hostId, state: this.state, diff: this.diff, foes: this.foes,
      mode: this.mode, mission: this.mission, ff: this.ff, paused: this.paused,
      players: this.members().map(c => ({ id: c.id, name: c.name, color: c.color, char: c.char })),
    };
  }

  joinRoom(c) {
    if (c.inRoom) return;
    const members = this.members();
    if (members.length >= MAX_PLAYERS) { this.send(c, { t: 'err', msg: 'Room is full.' }); return; }
    const used = new Set(members.map(x => x.color));
    c.color = COLORS.find(col => !used.has(col)) || COLORS[c.id % COLORS.length];
    c.inRoom = true;
    if (this.hostId === null) this.hostId = c.id;
    this.broadcast(this.info());
    this.broadcast({ t: 'chat', from: '', text: `${c.name} joined.` });
    if (this.state === 'game' && this.game) {
      this.game.addPlayer(c.id, c.name, c.color);
      this.send(c, { ...this.game.startInfo(), you: c.id });
    }
  }

  leaveRoom(c) {
    c.inRoom = false;
    if (this.game) this.game.removePlayer(c.id);
    if (!this.members().length) { this.stop(); return; }
    this.broadcast(this.info());
    this.broadcast({ t: 'chat', from: '', text: `${c.name} left.` });
  }

  // ------------------------------------------------------------- game --
  start() {
    if (this.state === 'game') return;
    this.game = new Game(this.mapId, { diff: this.diff, foes: this.foes, mode: this.mode, mission: this.mission, ff: this.ff });
    this.paused = false;
    for (const c of this.members()) this.game.addPlayer(c.id, c.name, c.color);
    this.state = 'game';
    const info = this.game.startInfo();
    for (const c of this.members()) this.send(c, { ...info, you: c.id });
    this.broadcast(this.info());
    this.tickN = 0;
    this.acc = 0;
    this.last = performance.now();
    this.stopTicker = makeTicker(() => this.loop(), 1000 * TICK);
  }

  stop() {
    if (this.stopTicker) this.stopTicker();
    this.stopTicker = null;
    this.state = 'lobby';
    this.game = null;
    this.paused = false;
  }

  // Tell everyone how the round went and go back to the lobby. A round the host stopped by hand is
  // flagged so it doesn't read as a defeat.
  finishRound(game, stopped = false) {
    this.broadcast({ t: 'over', wave: game.wave, score: game.score, kills: game.totalKills, stats: game.stats(),
      mode: game.mode, mission: game.missionIdx, won: game.won, lost: game.lost, stopped, ff: game.ffId });
    this.stop();
    this.broadcast(this.info());
  }

  setPaused(on) {
    if (!this.game || this.paused === on) return;
    this.paused = on;
    this.pauseSnap = 0;
    this.broadcast({ t: 'chat', from: '', text: on ? 'The host paused the game.' : 'The host resumed the game.' });
  }

  sendSnapshot(game) {
    const common = JSON.stringify({ ...game.snapshotCommon(), pz: this.paused ? 1 : 0 }).slice(0, -1);
    game.events = [];
    for (const c of this.members()) this.send(c, common + ',"me":' + JSON.stringify(game.snapshotPrivate(c.id)) + '}');
  }

  loop() {
    const game = this.game;
    if (!game) return;
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    if (this.paused) {
      // frozen: keep (late joiners) informed a couple of times per second
      this.acc = 0;
      this.pauseSnap -= elapsed;
      if (this.pauseSnap <= 0) { this.pauseSnap = 0.5; this.sendSnapshot(game); }
      return;
    }
    this.acc = Math.min(this.acc + elapsed, TICK * 8);
    try {
      while (this.acc >= TICK && this.game === game) {
        this.acc -= TICK;
        game.tick(TICK);
        this.tickN++;
        if (this.tickN % SNAPSHOT_EVERY === 0 || game.over) this.sendSnapshot(game);
        if (game.over) { this.finishRound(game); return; }
      }
    } catch (e) {
      console.error(e);
      this.broadcast({ t: 'chat', from: '', text: 'Host error, game ended.' });
      this.stop();
      this.broadcast(this.info());
    }
  }

  // --------------------------------------------------------- messages --
  receive(c, m) {
    if (!m || typeof m !== 'object' || !this.clients.has(c.id)) return;
    switch (m.t) {
      case 'hello':
        c.name = cleanText(m.name, 16) || c.name;
        c.char = Math.min(MAX_CHARS - 1, Math.max(0, m.char | 0));
        this.send(c, { t: 'welcome', id: c.id });
        break;
      case 'join': this.joinRoom(c); break;
      case 'leave': if (c.inRoom) this.leaveRoom(c); break;
      case 'in': if (c.inRoom && this.game && !this.paused) this.game.handleInput(c.id, m); break;
      case 'perk': if (c.inRoom && this.game) this.game.choosePerk(c.id, m.i | 0); break;
      case 'pause': if (c.id === this.hostId && this.state === 'game') this.setPaused(m.on === undefined ? !this.paused : !!m.on); break;
      case 'end':
        if (c.id === this.hostId && this.state === 'game' && this.game) {
          this.broadcast({ t: 'chat', from: '', text: 'The host ended the round.' });
          this.finishRound(this.game, true);
        }
        break;
      case 'restart':
        if (c.id === this.hostId && this.state === 'game' && this.game) {
          this.stop();
          this.broadcast({ t: 'chat', from: '', text: 'The host restarted the round.' });
          this.start();
        }
        break;
      case 'map':
        if (c.id === this.hostId && this.state === 'lobby' && isMap(m.map)) {
          this.mapId = m.map;
          this.broadcast(this.info());
        }
        break;
      case 'char':
        c.char = Math.min(MAX_CHARS - 1, Math.max(0, m.char | 0));
        if (c.inRoom) this.broadcast(this.info());
        break;
      case 'cfg':
        if (c.id !== this.hostId || this.state !== 'lobby') break;
        if (Object.prototype.hasOwnProperty.call(DIFFICULTY, m.diff)) this.diff = m.diff;
        if (Array.isArray(m.foes)) {
          const foes = FOE_TYPES.filter(t => m.foes.includes(t));
          if (foes.some(t => !BOSSES.includes(t))) this.foes = foes;
        }
        if (Object.prototype.hasOwnProperty.call(MODES, m.mode)) this.mode = m.mode;
        if (Object.prototype.hasOwnProperty.call(FRIENDLY_FIRE, m.ff)) this.ff = m.ff;
        if (Number.isInteger(m.mission) && m.mission >= 0 && m.mission < MISSIONS.length) this.mission = m.mission;
        this.broadcast(this.info());
        break;
      case 'start': if (c.id === this.hostId && this.state === 'lobby') this.start(); break;
      case 'chat': {
        const text = cleanText(m.text, 140);
        if (text && c.inRoom) this.broadcast({ t: 'chat', from: c.name, color: c.color, text });
        break;
      }
      case 'ping': this.send(c, { t: 'pong', id: m.id }); break;
    }
  }
}
