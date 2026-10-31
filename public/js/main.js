// UI flow: menu -> lobby -> game -> results. Owns the peer-to-peer session and the frame loop.
//
// Multiplayer is serverless: the player who creates a room runs the game (Host) in their
// browser and the others connect to it directly over WebRTC. The public PeerJS broker
// (0.peerjs.com) is only used to introduce the browsers to each other.
import { Renderer, T, CHARS, LOOKS, GUNS } from './render.js';
import { ClientGame } from './game.js';
import { Host } from './host.js';
import { mapList, DIFFICULTY, FOE_TYPES, BOSSES, MODES, MISSIONS } from './sim.js';
import * as A from './audio.js';

const $ = id => document.getElementById(id);
const canvas = $('game');
const renderer = new Renderer(canvas);
const PEER_PREFIX = 'cube-siege-v1-';

let session = null;   // { role: 'host' | 'client', peer, host?, conn?, send }
let myId = null;
const maps = mapList();
let room = null;
let game = null;
let selectedMap = 'depot';
let selectedChar = 0;
try { selectedChar = Math.min(CHARS.length - 1, Math.max(0, parseInt(localStorage.getItem('cs_char'), 10) || 0)); } catch (e) { /* ignore */ }

const DIFF_DESC = {
  easy: 'Slower, weaker undead that hit softly, smaller waves, more drops.',
  normal: 'The intended experience.',
  hard: 'Tougher, faster undead, bigger waves, fewer drops.',
  nightmare: 'Fast, brutal hordes. Bring friends.',
};
const FOE_INFO = {
  shambler: ['Shambler', 'slow horde'],
  sprinter: ['Sprinter', 'fast, fragile'],
  warlock: ['Warlock', 'fireballs'],
  brute: ['Brute', 'tanky'],
  bloater: ['Bloater', 'explodes'],
  colossus: ['Colossus', 'boss'],
  leaper: ['Leaper', 'pounces'],
  spitter: ['Spitter', 'acid pools'],
  riot: ['Riot', 'front shield'],
  shaman: ['Shaman', 'heals undead'],
  splitter: ['Splitter', 'splits in 3'],
  wraith: ['Wraith', 'through walls'],
  juggernaut: ['Juggernaut', 'boss, charges'],
};
const GOAL_TEXT = {
  waves: g => `Survive ${g.n} waves`,
  defend: g => `Defend the generator for ${g.n} waves`,
  collect: g => `Find ${g.n} fuel cans`,
  holdout: g => `Hold out for ${g.secs / 60} minutes`,
};

// local progress: missions cleared (unlocks the next) and best waves in the endless modes
function loadNum(key) {
  try { return parseInt(localStorage.getItem(key), 10) || 0; } catch (e) { return 0; }
}
function saveNum(key, v) {
  try { localStorage.setItem(key, String(v)); } catch (e) { /* ignore */ }
}
const missionsCleared = () => Math.min(MISSIONS.length, loadNum('cs_missions'));
const bestKey = (mode, diff) => `cs_best_${mode}_${diff}`;
let roster = new Map();
let pendingJoin = new URLSearchParams(location.search).get('room');
let menuBg = null;

// --------------------------------------------------------------- network --
function randomCode() {
  return Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');
}

function send(obj) {
  if (session && session.send) session.send(obj);
}

const net = { send };

function deliver(raw) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
  if (m && typeof m === 'object') onMessage(m);
}

function teardown() {
  const s = session;
  session = null;
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  if (s.host) s.host.stop();
  try { s.peer.destroy(); } catch (e) { /* ignore */ }
}

function backToMenu(msg) {
  teardown();
  if (game) endGame();
  room = null;
  history.replaceState(null, '', location.pathname);
  show('menu');
  status(msg || '');
  setBusy(false);
}

function peerError(err) {
  const t = err && err.type;
  if (t === 'peer-unavailable') return 'Room not found. Check the code (the host must keep the game open).';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Could not reach the matchmaking server (0.peerjs.com). Check your internet connection.';
  if (t === 'browser-incompatible') return 'Your browser does not support WebRTC.';
  if (t === 'webrtc') return 'The peer-to-peer connection failed (a strict firewall may block it).';
  return 'Connection error: ' + (t || err);
}

function hostGame() {
  if (typeof Peer === 'undefined') { status('Could not load PeerJS. Check your internet connection.'); return; }
  teardown();
  setBusy(true);
  status('Creating room...');
  const code = randomCode();
  const peer = new Peer(PEER_PREFIX + code);
  const s = session = { role: 'host', peer, host: null, send: null };
  peer.on('open', () => {
    if (session !== s) return;
    const host = s.host = new Host(code, selectedMap);
    const local = host.addClient(str => queueMicrotask(() => { if (session === s) deliver(str); }));
    s.send = m => host.receive(local, m);
    status('');
    send({ t: 'hello', name: $('name').value, char: selectedChar });
    send({ t: 'join' });
  });
  peer.on('connection', conn => {
    conn.on('open', () => {
      if (session !== s || !s.host) { conn.close(); return; }
      const c = s.host.addClient(str => { if (conn.open) conn.send(str); });
      conn.on('data', d => { if (session === s) { try { s.host.receive(c, JSON.parse(d)); } catch (e) { /* bad message */ } } });
      conn.on('close', () => { if (s.host) s.host.removeClient(c); });
      conn.on('error', () => { if (s.host) s.host.removeClient(c); });
    });
  });
  peer.on('error', err => {
    if (session !== s) return;
    if (err.type === 'unavailable-id') { hostGame(); return; } // code taken, roll a new one
    if (s.host && (err.type === 'network' || err.type === 'server-error')) return; // broker hiccup, peers stay connected
    backToMenu(peerError(err));
  });
  peer.on('disconnected', () => { if (session === s && !peer.destroyed) peer.reconnect(); });
}

function joinGame(code) {
  if (typeof Peer === 'undefined') { status('Could not load PeerJS. Check your internet connection.'); return; }
  teardown();
  setBusy(true);
  status(`Connecting to room ${code}...`);
  const peer = new Peer();
  const s = session = { role: 'client', peer, send: null };
  s.timer = setTimeout(() => { if (session === s && !s.send) backToMenu('Could not connect to the room (timed out). A firewall may be blocking peer-to-peer connections.'); }, 20000);
  peer.on('open', () => {
    if (session !== s) return;
    const conn = s.conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'raw' });
    conn.on('open', () => {
      if (session !== s) return;
      clearTimeout(s.timer);
      s.send = m => { if (conn.open) conn.send(JSON.stringify(m)); };
      status('');
      send({ t: 'hello', name: $('name').value, char: selectedChar });
      send({ t: 'join' });
    });
    conn.on('data', d => { if (session === s) deliver(d); });
    conn.on('close', () => { if (session === s) backToMenu('The host closed the room.'); });
  });
  peer.on('error', err => { if (session === s) backToMenu(peerError(err)); });
  peer.on('disconnected', () => { if (session === s && !peer.destroyed && !s.send) peer.reconnect(); });
}

window.addEventListener('beforeunload', teardown);

function onMessage(m) {
  switch (m.t) {
    case 'welcome': myId = m.id; break;
    case 'room': onRoom(m); break;
    case 'start': startGame(m); break;
    case 's': if (game) game.onSnapshot(m); break;
    case 'over': onOver(m); break;
    case 'chat': onChat(m); break;
    case 'err': backToMenu(m.msg); break;
    case 'pong': if (game) game.ping = performance.now() - m.id; break;
  }
}

// ------------------------------------------------------------------ menu --
function getName() {
  let n = '';
  try { n = localStorage.getItem('cs_name') || ''; } catch (e) { /* ignore */ }
  if (!n) n = ['Ace', 'Bolt', 'Crash', 'Dash', 'Echo', 'Flint', 'Grit', 'Hawk', 'Jinx', 'Knox'][Math.random() * 10 | 0] + (Math.random() * 90 + 10 | 0);
  $('name').value = n;
  return n;
}

function saveName() {
  const n = $('name').value.trim().slice(0, 16);
  try { localStorage.setItem('cs_name', n); } catch (e) { /* ignore */ }
}
$('name').addEventListener('change', saveName);

function status(msg) { $('status').textContent = msg || ''; }

function show(screen) {
  for (const s of ['menu', 'lobby', 'over']) $(s).classList.toggle('hidden', s !== screen);
  document.body.classList.toggle('playing', !screen);
}

function mapPreview(m) {
  const s = 3;
  const c = document.createElement('canvas');
  c.width = m.w * s; c.height = m.h * s;
  const g = c.getContext('2d');
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const ch = m.rows[y][x];
    g.fillStyle = ch === '#' ? m.theme.wallTop : ch === 'B' ? m.theme.crateTop : ch === 'T' ? m.theme.treeTop
      : ch === 'S' ? '#a0701a' : ch === 'P' ? '#4ab0ff' : ch === ',' ? m.theme.floor2 : m.theme.floor;
    g.fillRect(x * s, y * s, s, s);
  }
  return c;
}

function buildMapPicker(el, interactive) {
  el.innerHTML = '';
  el.classList.toggle('locked', !interactive);
  for (const m of maps) {
    const d = document.createElement('div');
    d.className = 'map' + (m.id === selectedMap ? ' sel' : '');
    d.appendChild(mapPreview(m));
    const b = document.createElement('b'); b.textContent = m.name;
    const sp = document.createElement('span'); sp.textContent = m.desc;
    d.append(b, sp);
    if (interactive) d.onclick = () => {
      selectedMap = m.id;
      if (room) send({ t: 'map', map: m.id });
      for (const x of el.children) x.classList.remove('sel');
      d.classList.add('sel');
      A.initAudio(); A.play('click');
    };
    el.appendChild(d);
  }
}

// small portrait of a character or enemy drawn with the game renderer
function charCanvas(look, opts = {}) {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 108;
  const k = 2 * Math.min(1, 1.3 / look.s);
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 48, 100);
  renderer.drawChar(g, { x: 0, y: 0, a: 0.9, look, phase: 0, t: 0, id: 1, ...opts });
  return c;
}

function buildCharPicker(color) {
  const el = $('charPick');
  el.innerHTML = '';
  CHARS.forEach((ch, i) => {
    const d = document.createElement('div');
    d.className = 'char' + (i === selectedChar ? ' sel' : '');
    d.appendChild(charCanvas(ch, { shirt: color, hair: ch.hair ? '#3a2a1e' : null, gun: GUNS.pistol }));
    d.append(ch.name);
    d.onclick = () => {
      selectedChar = i;
      try { localStorage.setItem('cs_char', String(i)); } catch (e) { /* ignore */ }
      send({ t: 'char', char: i });
      for (const x of el.children) x.classList.remove('sel');
      d.classList.add('sel');
      A.initAudio(); A.play('click');
    };
    el.appendChild(d);
  });
}

function buildSettings(m, interactive) {
  const modes = $('modePick');
  modes.innerHTML = '';
  modes.classList.toggle('locked', !interactive);
  for (const [id, md] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.textContent = md.name;
    b.className = id === m.mode ? 'sel' : '';
    b.disabled = !interactive && id !== m.mode;
    if (interactive) b.onclick = () => {
      const cfg = { t: 'cfg', mode: id };
      // jump to the first mission not cleared yet
      if (id === 'missions' && m.mode !== 'missions') cfg.mission = Math.min(missionsCleared(), MISSIONS.length - 1);
      send(cfg);
      A.initAudio(); A.play('click');
    };
    modes.appendChild(b);
  }
  $('modeDesc').textContent = (MODES[m.mode] || MODES.classic).desc;
  const isMissions = m.mode === 'missions';
  $('missionBox').classList.toggle('hidden', !isMissions);
  $('mapBox').classList.toggle('hidden', isMissions);
  $('foeBox').classList.toggle('hidden', isMissions);
  if (isMissions) {
    const cleared = missionsCleared();
    $('missionProg').textContent = `${cleared} / ${MISSIONS.length} cleared`;
    const list = $('missionPick');
    list.innerHTML = '';
    list.classList.toggle('locked', !interactive);
    MISSIONS.forEach((ms, i) => {
      const locked = i > cleared;
      const d = document.createElement('div');
      d.className = 'mission' + (i === m.mission ? ' sel' : '') + (locked ? ' locked' : '') + (i < cleared ? ' done' : '');
      const num = document.createElement('span'); num.className = 'num'; num.textContent = i < cleared ? '✓' : String(i + 1);
      const info = document.createElement('div');
      const b = document.createElement('b'); b.textContent = locked ? `${ms.name} (locked)` : ms.name;
      const sm = document.createElement('small');
      sm.textContent = `${(maps.find(x => x.id === ms.map) || {}).name} · ${GOAL_TEXT[ms.goal.type](ms.goal)}`;
      info.append(b, sm);
      d.append(num, info);
      if (interactive && !locked) d.onclick = () => { send({ t: 'cfg', mission: i }); A.initAudio(); A.play('click'); };
      list.appendChild(d);
    });
    const sel = MISSIONS[m.mission];
    $('missionDesc').textContent = sel ? sel.desc : '';
  }
  const best = loadNum(bestKey(m.mode, m.diff));
  $('bestNote').textContent = !isMissions && best ? `Your best in ${MODES[m.mode].name} on ${DIFFICULTY[m.diff].name}: wave ${best}` : '';
  const seg = $('diffPick');
  seg.innerHTML = '';
  seg.classList.toggle('locked', !interactive);
  for (const [id, d] of Object.entries(DIFFICULTY)) {
    const b = document.createElement('button');
    b.textContent = d.name;
    b.className = id === m.diff ? 'sel' : '';
    b.disabled = !interactive && id !== m.diff;
    if (interactive) b.onclick = () => { send({ t: 'cfg', diff: id }); A.initAudio(); A.play('click'); };
    seg.appendChild(b);
  }
  $('diffDesc').textContent = DIFF_DESC[m.diff] || '';
  const foes = $('foePick');
  foes.innerHTML = '';
  foes.classList.toggle('locked', !interactive);
  for (const type of FOE_TYPES) {
    const on = m.foes.includes(type);
    const d = document.createElement('div');
    d.className = 'foe' + (on ? '' : ' off');
    d.appendChild(charCanvas(LOOKS[type]));
    const [name, tip] = FOE_INFO[type];
    const sm = document.createElement('small'); sm.textContent = tip;
    d.append(name, sm);
    if (interactive) d.onclick = () => {
      const next = on ? m.foes.filter(t => t !== type) : [...m.foes, type];
      if (!next.some(t => !BOSSES.includes(t))) { toast('Keep at least one regular enemy type.'); return; }
      send({ t: 'cfg', foes: next });
      A.initAudio(); A.play('click');
    };
    foes.appendChild(d);
  }
  $('cfgNote').classList.toggle('hidden', interactive);
}

function setBusy(b) {
  $('createBtn').disabled = b;
  $('joinBtn').disabled = b;
}

$('createBtn').onclick = () => { A.initAudio(); saveName(); hostGame(); };
$('joinBtn').onclick = () => {
  A.initAudio();
  saveName();
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { status('Room codes have 4 letters.'); return; }
  joinGame(code);
};
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

// ----------------------------------------------------------------- lobby --
function onRoom(m) {
  const first = !room || room.code !== m.code;
  room = m;
  roster = new Map(m.players.map(p => [p.id, p]));
  if (game) game.roster = roster;
  selectedMap = m.map;
  $('roomCode').textContent = m.code;
  const web = location.protocol.startsWith('http');
  $('shareLink').value = `${location.origin}${location.pathname}?room=${m.code}`;
  $('share').classList.toggle('hidden', !web);
  if (web) history.replaceState(null, '', `?room=${m.code}`);
  setBusy(false);
  const ul = $('playerList');
  ul.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = p.color;
    const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    const cn = document.createElement('span'); cn.className = 'muted'; cn.textContent = (CHARS[p.char] || CHARS[0]).name;
    li.append(sw, nm, cn);
    if (p.id === m.host) { const h = document.createElement('span'); h.className = 'host'; h.textContent = 'HOST'; li.append(h); }
    ul.appendChild(li);
  }
  const isHost = m.host === myId;
  if (game) game.isHost = isHost;
  buildMapPicker($('lobbyMaps'), isHost);
  buildSettings(m, isHost);
  const mine = m.players.find(p => p.id === myId);
  if (mine && mine.char !== selectedChar) send({ t: 'char', char: selectedChar });
  buildCharPicker(mine ? mine.color : '#888');
  $('startBtn').classList.toggle('hidden', !isHost);
  $('waitHost').classList.toggle('hidden', isHost);
  $('waitHost').textContent = m.state === 'game' ? 'Game in progress, joining...' : 'Waiting for host to start...';
  if (first) $('lobbyChat').innerHTML = '';
  if (!game && $('over').classList.contains('hidden')) show('lobby');
}

$('startBtn').onclick = () => { A.initAudio(); send({ t: 'start' }); };
$('leaveBtn').onclick = () => { send({ t: 'leave' }); backToMenu(''); };
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('shareLink').value); toast('Invite link copied!'); }
  catch (e) { $('shareLink').select(); document.execCommand('copy'); toast('Invite link copied!'); }
};
$('lobbyChatIn').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value }); e.target.value = ''; }
});

function onChat(m) {
  const d = document.createElement('div');
  if (m.from) {
    const b = document.createElement('b'); b.textContent = m.from + ': '; b.style.color = m.color || '#fff';
    d.append(b, document.createTextNode(m.text));
  } else { d.className = 'sys'; d.textContent = m.text; }
  const log = $('lobbyChat');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  if (game) { if (m.from) game.chat(m.from, m.color, m.text); else game.sysChat(m.text); }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.add('hidden'), 1800);
}

// ------------------------------------------------------------------ game --
function startGame(m) {
  A.initAudio();
  game = new ClientGame(renderer, net, m, roster, { openChat, setHurt });
  game.isHost = !!room && room.host === myId;
  show(null);
  canvas.focus();
}

let hurtShown = -1;
function setHurt(v) {
  v = Math.round(v * 50) / 50;
  if (v !== hurtShown) { hurtShown = v; $('hurt').style.opacity = v; }
}

function endGame() {
  setHurt(0);
  if (game) game.clearInput();
  game = null;
  closeChat();
  document.body.classList.remove('playing');
}

function onOver(m) {
  A.play('over', 1);
  const g = game;
  setTimeout(() => {
    if (game && game !== g) return; // a new round already started
    if (game === g) endGame();
    const diffId = room && DIFFICULTY[room.diff] ? room.diff : 'normal';
    const diff = ` on ${DIFFICULTY[diffId].name}`;
    const ms = m.mode === 'missions' ? MISSIONS[m.mission] : null;
    const title = $('overTitle');
    title.textContent = m.won ? 'MISSION COMPLETE' : ms && m.lost ? 'MISSION FAILED' : 'OVERRUN';
    title.className = m.won ? 'victory' : 'danger';
    const stats = `${m.kills} undead destroyed · ${m.score.toLocaleString()} points`;
    if (ms) {
      let extra = '';
      if (m.won) {
        const before = missionsCleared();
        if (m.mission + 1 > before) saveNum('cs_missions', m.mission + 1);
        const nxt = MISSIONS[m.mission + 1];
        extra = nxt && m.mission + 1 > before ? ` · Unlocked: ${nxt.name}` : !nxt ? ' · Campaign complete!' : '';
      }
      $('overSummary').textContent = `Mission ${m.mission + 1}: ${ms.name}${diff} · ${m.won ? 'cleared!' : m.lost || `overrun on wave ${m.wave}`} · ${stats}${extra}`;
    } else {
      const key = bestKey(m.mode || 'classic', diffId);
      const best = loadNum(key);
      if (m.wave > best) saveNum(key, m.wave);
      const rec = m.wave > best && best ? ' · New personal best!' : best ? ` · Best: wave ${best}` : '';
      $('overSummary').textContent = `Your team survived until wave ${m.wave}${diff} · ${stats}${rec}`;
    }
    const tbl = $('overTable');
    tbl.innerHTML = '<tr><th>Survivor</th><th>Kills</th><th>Best chain</th><th>Revives</th><th>Score</th></tr>';
    for (const s of [...m.stats].sort((a, b) => b.score - a.score)) {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = s.color;
      td0.append(sw, document.createTextNode(s.name));
      tr.appendChild(td0);
      for (const v of [s.kills, s.best, s.revives, s.score.toLocaleString()]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    show('over');
  }, 1600);
}

$('overBtn').onclick = () => { if (room && session) show('lobby'); else backToMenu(''); };

// chat inside the game
const chatIn = $('chatIn');
function openChat() {
  if (!game) return;
  game.chatting = true;
  game.clearInput();
  chatIn.classList.remove('hidden');
  chatIn.value = '';
  setTimeout(() => chatIn.focus(), 0);
}
function closeChat() {
  chatIn.classList.add('hidden');
  chatIn.blur();
  if (game) game.chatting = false;
}
chatIn.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    if (chatIn.value.trim()) send({ t: 'chat', text: chatIn.value });
    closeChat();
  } else if (e.key === 'Escape') closeChat();
});

// ----------------------------------------------------------------- input --
window.addEventListener('keydown', e => {
  if (!game || game.chatting) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (['Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  if (e.key === 'Escape') {
    if (e.repeat) return;
    if (room && room.host === myId) send({ t: 'pause' });
    else game.announce('ONLY THE HOST CAN PAUSE', '', 1.5, true);
    return;
  }
  game.keyDown(e);
});
window.addEventListener('keyup', e => { if (game) game.keyUp(e); });
window.addEventListener('blur', () => { if (game) game.clearInput(); });
canvas.addEventListener('mousemove', e => {
  if (!game) return;
  if (Math.abs(e.clientX - game.mouse.x) + Math.abs(e.clientY - game.mouse.y) > 3) game.aimMode = 'mouse';
  game.mouse.x = e.clientX;
  game.mouse.y = e.clientY;
});
canvas.addEventListener('mousedown', e => {
  A.initAudio();
  if (!game) return;
  if (game.chatting) closeChat();
  if (e.button === 0 && game.clickUI(e.clientX, e.clientY)) { e.preventDefault(); return; }
  if (e.button === 0) { game.mouse.down = true; game.aimMode = 'mouse'; }
  e.preventDefault();
});
window.addEventListener('mouseup', e => { if (game && e.button === 0) game.mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => { if (game) { game.cycle(e.deltaY > 0 ? 1 : -1); e.preventDefault(); } }, { passive: false });
window.addEventListener('resize', () => renderer.resize());

setInterval(() => { if (game) send({ t: 'ping', id: performance.now() }); }, 2000);

// -------------------------------------------------------- menu backdrop --
function setupMenuBg() {
  menuBg = { map: maps.find(x => x.id === 'depot'), t: 0 };
}

function drawMenuBg(dt) {
  if (!menuBg) {
    const ctx = renderer.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e0d0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (renderer.map !== menuBg.map) renderer.setMap(menuBg.map);
  menuBg.t += dt;
  const m = menuBg.map;
  const t = menuBg.t * 0.05;
  const cx = (m.w * T) / 2 + Math.cos(t) * m.w * T * 0.25;
  const cy = (m.h * T) / 2 + Math.sin(t * 1.3) * m.h * T * 0.2;
  renderer.begin(cx, cy);
  renderer.drawGround();
  renderer.drawScene([]);
  renderer.drawLighting([{ x: cx, y: cy, r: 700, i: 0.6 }], 0.25);
}

// ------------------------------------------------------------------ loop --
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (game) {
    if (renderer.map !== game.map) renderer.setMap(game.map);
    game.update(dt);
    game.render();
  } else {
    drawMenuBg(dt);
  }
  requestAnimationFrame(frame);
}

// handle for automated tests / debugging in the console
window.__cs = { get game() { return game; }, get host() { return session && session.host; } };

getName();
buildMapPicker($('mapPick'), true);
setupMenuBg();
if (pendingJoin && /^[A-Z]{4}$/i.test(pendingJoin)) {
  // invite link: join straight away
  $('code').value = pendingJoin.toUpperCase();
  joinGame(pendingJoin.toUpperCase());
}
requestAnimationFrame(frame);
