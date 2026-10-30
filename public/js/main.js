// UI flow: menu -> lobby -> game -> results. Owns the peer-to-peer session and the frame loop.
//
// Multiplayer is serverless: the player who creates a room runs the game (Host) in their
// browser and the others connect to it directly over WebRTC. The public PeerJS broker
// (0.peerjs.com) is only used to introduce the browsers to each other.
import { Renderer, T } from './render.js';
import { ClientGame } from './game.js';
import { Host } from './host.js';
import { mapList } from './sim.js';
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
    send({ t: 'hello', name: $('name').value });
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
      send({ t: 'hello', name: $('name').value });
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
    li.append(sw, nm);
    if (p.id === m.host) { const h = document.createElement('span'); h.className = 'host'; h.textContent = 'HOST'; li.append(h); }
    ul.appendChild(li);
  }
  const isHost = m.host === myId;
  buildMapPicker($('lobbyMaps'), isHost);
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
    $('overSummary').textContent = `Your team survived until wave ${m.wave} · ${m.kills} undead destroyed · ${m.score.toLocaleString()} points`;
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
window.__cs = { get game() { return game; } };

getName();
buildMapPicker($('mapPick'), true);
setupMenuBg();
if (pendingJoin && /^[A-Z]{4}$/i.test(pendingJoin)) {
  // invite link: join straight away
  $('code').value = pendingJoin.toUpperCase();
  joinGame(pendingJoin.toUpperCase());
}
requestAnimationFrame(frame);
