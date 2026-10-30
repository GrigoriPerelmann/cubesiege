// The room "server", running inside the host's browser.
// Clients (the host's own client and remote peers) talk to it with the same JSON messages.
import { Game, isMap } from './sim.js';

const TICK = 1 / 30;
const SNAPSHOT_EVERY = 2;     // ticks per snapshot -> 15 Hz
export const MAX_PLAYERS = 8;
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
    this.clients = new Map();     // id -> { id, name, color, inRoom, sendRaw }
    this.hostId = null;
    this.state = 'lobby';
    this.game = null;
    this.nid = 0;
    this.stopTicker = null;
  }

  // ---------------------------------------------------------- clients --
  addClient(sendRaw) {
    const c = { id: ++this.nid, name: `Player${this.nid + 1}`, color: null, inRoom: false, sendRaw };
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
      t: 'room', code: this.code, map: this.mapId, host: this.hostId, state: this.state,
      players: this.members().map(c => ({ id: c.id, name: c.name, color: c.color })),
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
    this.game = new Game(this.mapId);
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
  }

  loop() {
    const game = this.game;
    if (!game) return;
    const now = performance.now();
    this.acc = Math.min(this.acc + (now - this.last) / 1000, TICK * 8);
    this.last = now;
    try {
      while (this.acc >= TICK && this.game === game) {
        this.acc -= TICK;
        game.tick(TICK);
        this.tickN++;
        if (this.tickN % SNAPSHOT_EVERY === 0 || game.over) {
          const common = JSON.stringify(game.snapshotCommon()).slice(0, -1);
          game.events = [];
          for (const c of this.members()) this.send(c, common + ',"me":' + JSON.stringify(game.snapshotPrivate(c.id)) + '}');
        }
        if (game.over) {
          this.broadcast({ t: 'over', wave: game.wave, score: game.score, kills: game.totalKills, stats: game.stats() });
          this.stop();
          this.broadcast(this.info());
          return;
        }
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
        this.send(c, { t: 'welcome', id: c.id });
        break;
      case 'join': this.joinRoom(c); break;
      case 'leave': if (c.inRoom) this.leaveRoom(c); break;
      case 'in': if (c.inRoom && this.game) this.game.handleInput(c.id, m); break;
      case 'map':
        if (c.id === this.hostId && this.state === 'lobby' && isMap(m.map)) {
          this.mapId = m.map;
          this.broadcast(this.info());
        }
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
