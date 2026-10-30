// Authoritative game simulation. Runs inside the host's browser.
// The host owns enemies, projectiles, pickups, structures, damage and score.
// Clients own their own movement (validated here) and send aim + trigger state.

const T = 32;                // tile size in world pixels
const PR = 11;               // player radius
const PLAYER_SPEED = 165;
const PLAYER_HP = 100;
const BLEED_TIME = 25;       // seconds a downed player can be revived
const REVIVE_TIME = 2.5;
const REVIVE_DIST = 46;
const COMBO_TIME = 2.6;      // seconds to chain the next kill
const SOLID_CHARS = new Set(['#', 'B', 'T']);

const rand = (a, b) => a + Math.random() * (b - a);
const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const choice = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = v => Math.round(v * 10) / 10;
function angdiff(a, b) {
  const d = ((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(d);
}

// ================================================================== maps ==
// Tile legend: # wall, B crate/car/hay, T tree/pillar, . , floor, S enemy spawn, P player spawn
function seeded(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sRange = (rnd, a, b) => a + Math.floor(rnd() * (b - a));          // [a, b)
const sInt = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));        // [a, b]
const half = n => Math.floor(n / 2);

function grid(w, h, ch = '.') { return Array.from({ length: h }, () => Array(w).fill(ch)); }
function rect(g, x, y, w, h, ch) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (yy >= 0 && yy < g.length && xx >= 0 && xx < g[0].length) g[yy][xx] = ch;
  }
}
function mirror4(g, x, y, w, h, ch) {
  const W = g[0].length, H = g.length;
  for (const [mx, my] of [[x, y], [W - x - w, y], [x, H - y - h], [W - x - w, H - y - h]]) rect(g, mx, my, w, h, ch);
}
function border(g, ch = '#') {
  const W = g[0].length, H = g.length;
  rect(g, 0, 0, W, 1, ch); rect(g, 0, H - 1, W, 1, ch);
  rect(g, 0, 0, 1, H, ch); rect(g, W - 1, 0, 1, H, ch);
}
function gates(g, size = 4) {
  const W = g[0].length, H = g.length;
  const cx = half(W) - half(size), cy = half(H) - half(size);
  rect(g, cx, 0, size, 2, 'S'); rect(g, cx, H - 2, size, 2, 'S');
  rect(g, 0, cy, 2, size, 'S'); rect(g, W - 2, cy, 2, size, 'S');
}

function makeDepot() {
  const W = 46, H = 34, g = grid(W, H), rnd = seeded(7);
  for (let i = 0; i < 60; i++) rect(g, sRange(rnd, 0, W), sRange(rnd, 0, H), sInt(rnd, 1, 4), sInt(rnd, 1, 3), ',');
  border(g); gates(g);
  for (const r of [[5, 4, 3, 2], [12, 6, 2, 2], [5, 10, 2, 3], [14, 12, 3, 1], [18, 3, 1, 3], [9, 2, 1, 1], [2, 6, 1, 1]]) mirror4(g, ...r, 'B');
  mirror4(g, 9, 13, 4, 1, '#');
  mirror4(g, 9, 13, 1, 3, '#');
  for (const r of [[15, 7, 1, 1], [20, 8, 1, 1]]) mirror4(g, ...r, 'T');
  rect(g, half(W) - 1, half(H) - 1, 2, 2, 'P');
  return g;
}

function makeCrossroads() {
  const W = 50, H = 36, g = grid(W, H, '#');
  rect(g, 4, 4, W - 8, 4, '.'); rect(g, 4, H - 8, W - 8, 4, '.');
  rect(g, 4, 4, 4, H - 8, '.'); rect(g, W - 8, 4, 4, H - 8, '.');
  rect(g, 0, half(H) - 3, W, 6, '.'); rect(g, half(W) - 3, 0, 6, H, '.');
  rect(g, half(W) - 8, half(H) - 6, 16, 12, ',');
  rect(g, 14, 8, 2, 7, '.'); rect(g, W - 16, H - 15, 2, 7, '.');
  rect(g, 8, 24, 9, 2, '.'); rect(g, W - 17, 10, 9, 2, '.');
  rect(g, 9, 9, 4, 6, ',');
  g[10][10] = 'T'; g[13][11] = 'T';
  for (const [x, y, w, h] of [[10, 5, 2, 1], [36, 6, 2, 1], [5, 22, 1, 2], [44, 12, 1, 2], [16, 29, 2, 1], [31, 28, 2, 1],
    [21, 13, 1, 1], [28, 22, 1, 1], [21, 22, 1, 1], [28, 13, 1, 1], [12, 17, 2, 1], [36, 18, 2, 1]]) rect(g, x, y, w, h, 'B');
  rect(g, half(W) - 1, half(H) - 4, 2, 1, 'T'); rect(g, half(W) - 1, half(H) + 3, 2, 1, 'T');
  rect(g, 0, half(H) - 3, 2, 6, 'S'); rect(g, W - 2, half(H) - 3, 2, 6, 'S');
  rect(g, half(W) - 3, 0, 6, 2, 'S'); rect(g, half(W) - 3, H - 2, 6, 2, 'S');
  rect(g, half(W) - 1, half(H) - 1, 2, 2, 'P');
  return g;
}

function makeBunker() {
  const W = 46, H = 37, g = grid(W, H, '#');
  const rw = 13, rh = 10;
  const xs = [2, 2 + rw + 2, 2 + 2 * (rw + 2)], ys = [2, 2 + rh + 2, 2 + 2 * (rh + 2)];
  xs.forEach((x, i) => ys.forEach((y, j) => rect(g, x, y, rw, rh, (i + j) % 2 ? ',' : '.')));
  for (const y of ys) for (let i = 0; i < 2; i++) rect(g, xs[i] + rw, y + half(rh) - 1, 2, 3, '.');
  for (const x of xs) for (let j = 0; j < 2; j++) rect(g, x + half(rw) - 1, ys[j] + rh, 3, 2, '.');
  rect(g, xs[1] + half(rw) - 2, ys[0] + rh, 5, 2, '.');
  rect(g, xs[1] + half(rw) - 2, ys[1] + rh, 5, 2, '.');
  rect(g, 0, ys[0] + 3, 2, 3, 'S'); rect(g, W - 2, ys[2] + 3, 2, 3, 'S');
  rect(g, xs[2] + 4, 0, 3, 2, 'S'); rect(g, xs[0] + 6, H - 2, 3, 2, 'S');
  rect(g, xs[1] + 5, 0, 3, 2, 'S'); rect(g, xs[1] + 5, H - 2, 3, 2, 'S');
  for (const x of xs) for (const y of ys) { rect(g, x + 3, y + 2, 1, 1, 'B'); rect(g, x + rw - 4, y + rh - 3, 1, 1, 'B'); }
  rect(g, xs[0] + 6, ys[0] + 4, 2, 2, 'T'); rect(g, xs[2] + 5, ys[2] + 4, 2, 2, 'T');
  rect(g, xs[2] + 5, ys[0] + 4, 2, 2, 'B'); rect(g, xs[0] + 5, ys[2] + 4, 2, 2, 'B');
  const cx = xs[1], cy = ys[1];
  rect(g, cx + 2, cy + 2, 1, 1, 'T'); rect(g, cx + rw - 3, cy + 2, 1, 1, 'T');
  rect(g, cx + 2, cy + rh - 3, 1, 1, 'T'); rect(g, cx + rw - 3, cy + rh - 3, 1, 1, 'T');
  rect(g, cx + half(rw) - 1, cy + half(rh) - 1, 2, 2, 'P');
  return g;
}

function makeOrchard() {
  const W = 48, H = 36, g = grid(W, H, ','), rnd = seeded(42);
  rect(g, 0, half(H) - 1, W, 3, '.'); rect(g, half(W) - 1, 0, 3, H, '.');
  for (let i = 0; i < 25; i++) rect(g, sRange(rnd, 0, W), sRange(rnd, 0, H), sInt(rnd, 2, 5), sInt(rnd, 1, 3), '.');
  border(g); gates(g, 3);
  rect(g, 2, 0, 3, 1, 'S'); rect(g, W - 5, H - 1, 3, 1, 'S');
  for (let y = 4; y < H - 4; y += 4) for (let x = 4; x < W - 4; x += 4) {
    if (Math.abs(x - half(W)) < 5 && Math.abs(y - half(H)) < 5) continue;
    if (Math.abs(y - half(H)) <= 2 || Math.abs(x - half(W)) <= 2) continue;
    if (rnd() < 0.8) g[y + sInt(rnd, -1, 0)][x + sInt(rnd, -1, 1)] = 'T';
  }
  for (let i = 0; i < 14; i++) {
    const x = sRange(rnd, 3, W - 4), y = sRange(rnd, 3, H - 3);
    if (Math.abs(x - half(W)) < 4 && Math.abs(y - half(H)) < 4) continue;
    if ('.,'.includes(g[y][x]) && '.,'.includes(g[y][x + 1])) g[y][x] = g[y][x + 1] = 'B';
  }
  rect(g, 33, 4, 8, 1, '#'); rect(g, 33, 4, 1, 6, '#'); rect(g, 40, 4, 1, 6, '#');
  rect(g, 34, 5, 6, 5, '.'); rect(g, 35, 9, 4, 1, '.');
  rect(g, half(W) - 1, half(H) - 1, 2, 2, 'P');
  return g;
}

const THEMES = {
  depot: { floor: '#3d3b37', floor2: '#36342f', grid: '#2f2d29', wallTop: '#8a8580', wallFront: '#55514c', crateTop: '#b0834a', crateFront: '#7a5530', tree: '#6f6a64', treeTop: '#9a958d', dark: 0.30, pillar: true, bg: '#151412' },
  crossroads: { floor: '#3a3c40', floor2: '#4b4639', grid: '#303236', wallTop: '#7a4f3c', wallFront: '#4f3328', crateTop: '#6c7f8f', crateFront: '#3f4c57', tree: '#2f5a2a', treeTop: '#4c8a3c', dark: 0.38, pillar: false, roof: true, bg: '#121316' },
  bunker: { floor: '#40453f', floor2: '#383d38', grid: '#323631', wallTop: '#6b7068', wallFront: '#40443e', crateTop: '#5e6b3e', crateFront: '#3a4227', tree: '#7a7f77', treeTop: '#9da298', dark: 0.5, pillar: true, bg: '#0d0f0d' },
  orchard: { floor: '#6b5638', floor2: '#3f5a2c', grid: '#4d3f29', wallTop: '#8b6b43', wallFront: '#5c4429', crateTop: '#d8b65a', crateFront: '#9a7c34', tree: '#2d4f22', treeTop: '#4f7d33', dark: 0.42, pillar: false, fence: true, bg: '#14140c' },
};

const MAPS = {
  depot: { name: 'Rust Depot', desc: 'Open warehouse yard full of crate stacks. Four gates.', gen: makeDepot },
  crossroads: { name: 'Crossroads', desc: 'Abandoned town streets with a central square. Long sight lines.', gen: makeCrossroads },
  bunker: { name: 'Bunker 9', desc: 'Nine concrete rooms joined by tight doors. Hold the chokepoints.', gen: makeBunker },
  orchard: { name: 'Dusk Orchard', desc: 'Fenced orchard at sunset, trees everywhere. Enemies come from all sides.', gen: makeOrchard },
};

const mapCache = {};
export function getMap(id) {
  if (!MAPS[id]) id = 'depot';
  if (!mapCache[id]) {
    const rows = MAPS[id].gen().map(r => r.join(''));
    mapCache[id] = { id, name: MAPS[id].name, desc: MAPS[id].desc, w: rows[0].length, h: rows.length, rows, theme: THEMES[id] };
  }
  return mapCache[id];
}
export const mapList = () => Object.keys(MAPS).map(getMap);
export const isMap = id => Object.prototype.hasOwnProperty.call(MAPS, id);

// =============================================================== weapons ==
// kind: hit = hitscan bullets, proj = rocket, flame = cone, place = deployable
export const WEAPONS = [
  { id: 'pistol', name: 'Pistol', kind: 'hit', dmg: 26, rate: 0.25, ammo: -1, pellets: 1, spread: 0.03, range: 560, kb: 40, unlock: 0, pickup: 0 },
  { id: 'smg', name: 'SMG', kind: 'hit', dmg: 13, rate: 0.075, ammo: 300, pellets: 1, spread: 0.10, range: 480, kb: 14, unlock: 400, pickup: 90 },
  { id: 'shotgun', name: 'Shotgun', kind: 'hit', dmg: 15, rate: 0.72, ammo: 50, pellets: 8, spread: 0.30, range: 300, kb: 26, unlock: 1300, pickup: 14 },
  { id: 'barricade', name: 'Barricade', kind: 'place', ammo: 8, rate: 0.3, hp: 450, unlock: 2600, pickup: 3 },
  { id: 'rifle', name: 'Assault Rifle', kind: 'hit', dmg: 32, rate: 0.11, ammo: 240, pellets: 1, spread: 0.045, range: 660, kb: 22, unlock: 4500, pickup: 60 },
  { id: 'mine', name: 'Mines', kind: 'place', ammo: 8, rate: 0.3, dmg: 300, radius: 105, unlock: 7000, pickup: 3 },
  { id: 'rail', name: 'Railgun', kind: 'hit', dmg: 200, rate: 0.9, ammo: 30, pellets: 1, spread: 0, range: 1100, kb: 60, pierce: true, unlock: 10500, pickup: 7 },
  { id: 'flame', name: 'Flamethrower', kind: 'flame', dmg: 7, rate: 0.05, ammo: 400, range: 185, cone: 0.42, unlock: 15000, pickup: 110 },
  { id: 'rocket', name: 'Rocket Launcher', kind: 'proj', dmg: 280, rate: 0.9, ammo: 20, radius: 125, speed: 640, range: 950, unlock: 21000, pickup: 5 },
  { id: 'sentry', name: 'Sentry Gun', kind: 'place', ammo: 3, rate: 0.5, hp: 320, unlock: 28000, pickup: 1 },
];
const W_INDEX = Object.fromEntries(WEAPONS.map((w, i) => [w.id, i]));
const SENTRY_GUN = { ...WEAPONS[W_INDEX.rifle], dmg: 15, spread: 0.05, kb: 10 };

// =============================================================== enemies ==
export const ENEMY_TYPES = ['shambler', 'sprinter', 'brute', 'warlock', 'bloater', 'colossus'];
const ENEMIES = {
  shambler: { hp: 55, speed: 72, r: 12, dmg: 10, rate: 0.9, score: 10 },
  sprinter: { hp: 32, speed: 150, r: 10, dmg: 7, rate: 0.6, score: 15 },
  brute: { hp: 480, speed: 54, r: 19, dmg: 26, rate: 1.2, score: 50, kbres: 0.25 },
  warlock: { hp: 110, speed: 66, r: 12, dmg: 8, rate: 1.0, score: 30 },
  bloater: { hp: 85, speed: 58, r: 15, dmg: 0, rate: 1.0, score: 25 },
  colossus: { hp: 3600, speed: 50, r: 30, dmg: 38, rate: 1.3, score: 700, kbres: 0.05 },
};

const NEIGH8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

// minimal binary heap of [priority, value]
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class Player {
  constructor(id, name, color) {
    this.id = id; this.name = name; this.color = color;
    this.x = 0; this.y = 0; this.angle = 0;
    this.hp = PLAYER_HP;
    this.state = 'dead';         // alive | down | dead
    this.downT = 0; this.rev = 0;
    this.weapon = 0;
    this.ammo = WEAPONS.map((w, i) => (i ? 0 : -1));
    this.trigger = false; this.shooting = false; this.fireCd = 0;
    this.combo = 0; this.comboT = 0; this.bestCombo = 0;
    this.kills = 0; this.score = 0; this.downs = 0; this.revives = 0;
    this.budget = 60; this.lastIn = performance.now() / 1000;
    this.tp = null; this.tpSeq = 0;
  }
  get mult() { return Math.min(10, 1 + Math.floor(this.combo / 4)); }
}

class Enemy {
  constructor(id, type, x, y, hpScale, speedScale) {
    const d = ENEMIES[type];
    this.id = id; this.type = type; this.tid = ENEMY_TYPES.indexOf(type);
    this.x = x; this.y = y;
    this.maxhp = this.hp = d.hp * hpScale;
    this.speed = d.speed * speedScale * rand(0.9, 1.1);
    this.r = d.r; this.dmg = d.dmg; this.rate = d.rate; this.score = d.score;
    this.kbres = d.kbres ?? 1;
    this.angle = 0; this.atkCd = 0.5;
    this.kx = 0; this.ky = 0;
    this.burn = 0; this.burnSrc = null;
    this.special = rand(1.5, 3); this.special2 = 6;
  }
}

// ================================================================== game ==
export class Game {
  constructor(mapId) {
    const m = getMap(mapId);
    this.map = m;
    this.w = m.w; this.h = m.h; this.rows = m.rows;
    this.static = new Uint8Array(this.w * this.h);
    this.spawns = []; this.pspawns = [];
    m.rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (SOLID_CHARS.has(ch)) this.static[y * this.w + x] = 1;
      else if (ch === 'S') this.spawns.push([(x + 0.5) * T, (y + 0.5) * T]);
      else if (ch === 'P') this.pspawns.push([(x + 0.5) * T, (y + 0.5) * T]);
    }));
    this.players = new Map();
    this.enemies = new Map();
    this.projs = new Map();
    this.items = new Map();
    this.structs = new Map();
    this.structAt = new Map();      // tile index -> solid structure (barricade / sentry)
    this.nid = 1;
    this.events = [];
    this.time = 0;
    this.wave = 0;
    this.waveState = 'break';
    this.timer = 5;
    this.queue = [];
    this.spawnCd = 0;
    this.score = 0;
    this.unlocked = 1;
    this.field = null;
    this.fieldCd = 0;
    this.over = false;
    this.totalKills = 0;
  }

  // ----------------------------------------------------------- helpers --
  newId() { return ++this.nid; }
  ev(...e) { this.events.push(e); }

  solid(tx, ty, structs = true) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return true;
    const i = ty * this.w + tx;
    return this.static[i] === 1 || (structs && this.structAt.has(i));
  }

  collide(x, y, r, structs = true) {
    for (let it = 0; it < 3; it++) {
      let moved = false;
      const tx0 = Math.floor((x - r) / T), tx1 = Math.floor((x + r) / T);
      const ty0 = Math.floor((y - r) / T), ty1 = Math.floor((y + r) / T);
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.solid(tx, ty, structs)) continue;
        const cx = clamp(x, tx * T, tx * T + T), cy = clamp(y, ty * T, ty * T + T);
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          x += dx / d * (r - d); y += dy / d * (r - d);
        } else { // centre inside the tile: leave along the shallowest side
          const l = x - tx * T, rr = tx * T + T - x, u = y - ty * T, dd = ty * T + T - y;
          const mn = Math.min(l, rr, u, dd);
          if (mn === l) x = tx * T - r; else if (mn === rr) x = tx * T + T + r;
          else if (mn === u) y = ty * T - r; else y = ty * T + T + r;
        }
        moved = true;
      }
      if (!moved) break;
    }
    return [x, y];
  }

  // distance along the ray to the first static wall (DDA)
  rayWall(x, y, dx, dy, maxd) {
    let tx = Math.floor(x / T), ty = Math.floor(y / T);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx ? Math.abs(T / dx) : 1e9, tdy = dy ? Math.abs(T / dy) : 1e9;
    let txm = dx > 0 ? ((tx + 1) * T - x) / dx : dx < 0 ? (tx * T - x) / dx : 1e9;
    let tym = dy > 0 ? ((ty + 1) * T - y) / dy : dy < 0 ? (ty * T - y) / dy : 1e9;
    for (;;) {
      let t;
      if (txm < tym) { t = txm; txm += tdx; tx += sx; } else { t = tym; tym += tdy; ty += sy; }
      if (t >= maxd) return maxd;
      if (this.solid(tx, ty, false)) return t;
    }
  }

  los(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
    if (d < 1) return true;
    return this.rayWall(x1, y1, dx / d, dy / d, d) >= d - 1;
  }

  alivePlayers() { return [...this.players.values()].filter(p => p.state === 'alive'); }

  // ----------------------------------------------------------- players --
  addPlayer(id, name, color) {
    const p = new Player(id, name, color);
    WEAPONS.forEach((w, i) => { if (i && this.unlocked >> i & 1) p.ammo[i] = Math.floor(w.ammo / 2); });
    this.players.set(id, p);
    if (this.waveState === 'break' || !this.alivePlayers().length) this.respawn(p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.checkOver();
  }

  respawn(p) {
    const [x, y] = choice(this.pspawns);
    [p.x, p.y] = this.collide(x + rand(-20, 20), y + rand(-20, 20), PR);
    p.hp = PLAYER_HP;
    p.state = 'alive';
    p.rev = 0;
    p.budget = 60;
    p.tp = [p.x, p.y];
    p.tpSeq++;
  }

  handleInput(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    const a = Number(m.a);
    if (Number.isFinite(a)) p.angle = a;
    p.trigger = !!m.f;
    const w = m.w | 0;
    if (w >= 0 && w < WEAPONS.length && this.unlocked >> w & 1) p.weapon = w;
    const x = Number(m.x), y = Number(m.y);
    const now = performance.now() / 1000;
    const dt = Math.min(0.5, now - p.lastIn);
    p.lastIn = now;
    if (p.state !== 'alive' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // movement budget: tolerates jitter but blocks speed hacks / teleports
    p.budget = Math.min(p.budget + PLAYER_SPEED * 1.25 * dt, 90);
    let dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
    if (d > p.budget) { dx = dx / d * p.budget; dy = dy / d * p.budget; d = p.budget; }
    p.budget -= d;
    const steps = Math.floor(d / 8) + 1;
    let nx = p.x, ny = p.y;
    for (let i = 0; i < steps; i++) [nx, ny] = this.collide(nx + dx / steps, ny + dy / steps, PR);
    p.x = nx; p.y = ny;
    if (Math.hypot(nx - x, ny - y) > 6) { p.tp = [nx, ny]; p.tpSeq++; }
  }

  hurtPlayer(p, dmg) {
    if (p.state !== 'alive') return;
    p.hp -= dmg;
    this.ev('ph', p.id, Math.round(dmg));
    if (p.hp <= 0) {
      p.hp = 0;
      p.state = 'down';
      p.downT = BLEED_TIME;
      p.rev = 0;
      p.downs++;
      p.trigger = false;
      this.ev('down', p.id);
      this.checkOver();
    }
  }

  checkOver() {
    if (this.players.size && !this.alivePlayers().length && !this.over) this.over = true;
  }

  // ----------------------------------------------------------- weapons --
  updatePlayer(p, dt) {
    p.shooting = false;
    if (p.comboT > 0) {
      p.comboT -= dt;
      if (p.comboT <= 0) p.combo = 0;
    }
    if (p.state === 'down') {
      p.downT -= dt;
      const helpers = this.alivePlayers().filter(q => Math.hypot(q.x - p.x, q.y - p.y) < REVIVE_DIST);
      if (helpers.length) {
        p.rev += dt * (1 + 0.5 * (helpers.length - 1));
        if (p.rev >= REVIVE_TIME) {
          p.state = 'alive';
          p.hp = 45;
          p.budget = 60;
          for (const q of helpers) q.revives++;
          this.ev('rev', p.id, helpers[0].id);
        }
      } else p.rev = Math.max(0, p.rev - dt * 0.5);
      if (p.state === 'down' && p.downT <= 0) {
        p.state = 'dead';
        this.ev('dead', p.id);
      }
      return;
    }
    if (p.state !== 'alive') return;
    p.fireCd -= dt;
    const w = WEAPONS[p.weapon];
    while (p.trigger && p.fireCd <= 0) {
      if (p.ammo[p.weapon] === 0) break;
      let ok = true;
      if (w.kind === 'hit') this.fireHitscan(p, p.weapon, w);
      else if (w.kind === 'flame') this.fireFlame(p, w);
      else if (w.kind === 'proj') this.fireRocket(p, w);
      else if (w.kind === 'place') ok = this.place(p, w);
      if (!ok) { p.fireCd = Math.max(p.fireCd, 0.15); break; }
      p.shooting = true;
      if (p.ammo[p.weapon] > 0) p.ammo[p.weapon]--;
      p.fireCd += w.rate;
    }
    if (p.fireCd < -0.05) p.fireCd = p.trigger ? -0.05 : 0;
  }

  // o: optional { ox, oy, angle, owner } for sentry guns
  fireHitscan(p, widx, w, o = null) {
    const sx = o ? o.ox : p.x, sy = o ? o.oy : p.y;
    const base = o ? o.angle : p.angle;
    const src = o ? (o.owner || p) : p;
    const n = w.pellets;
    for (let k = 0; k < n; k++) {
      const a = n > 1 ? base + (k / (n - 1) - 0.5) * w.spread * 2 + rand(-0.04, 0.04) : base + rand(-1, 1) * w.spread;
      const dx = Math.cos(a), dy = Math.sin(a);
      const wd = this.rayWall(sx, sy, dx, dy, w.range);
      const hits = [];
      for (const e of this.enemies.values()) {
        const ex = e.x - sx, ey = e.y - sy;
        const t = ex * dx + ey * dy;
        if (t < 0 || t > wd + e.r) continue;
        const perp2 = ex * ex + ey * ey - t * t, rr = e.r + 3;
        if (perp2 <= rr * rr) hits.push([t, e]);
      }
      let end = wd;
      if (hits.length) {
        hits.sort((h1, h2) => h1[0] - h2[0]);
        if (w.pierce) {
          for (const [, e] of hits) this.damageEnemy(e, w.dmg, src, dx * w.kb, dy * w.kb);
        } else {
          const [t, e] = hits[0];
          end = Math.max(0, t);
          this.damageEnemy(e, w.dmg, src, dx * w.kb, dy * w.kb);
        }
      }
      this.ev('tr', Math.round(sx + dx * 14), Math.round(sy + dy * 14), Math.round(sx + dx * end), Math.round(sy + dy * end),
        widx, !o || !o.owner || o.owner === p ? p.id : 0);
    }
  }

  fireFlame(p, w) {
    for (const e of [...this.enemies.values()]) {
      const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
      if (d > w.range + e.r) continue;
      if (d > e.r && angdiff(Math.atan2(dy, dx), p.angle) > w.cone) continue;
      if (!this.los(p.x, p.y, e.x, e.y)) continue;
      e.burn = 2.2;
      e.burnSrc = p;
      this.damageEnemy(e, w.dmg, p, Math.cos(p.angle) * 6, Math.sin(p.angle) * 6, false);
    }
  }

  fireRocket(p, w) {
    const id = this.newId();
    const vx = Math.cos(p.angle) * w.speed, vy = Math.sin(p.angle) * w.speed;
    this.projs.set(id, { id, kind: 0, x: p.x + vx / w.speed * 16, y: p.y + vy / w.speed * 16, vx, vy,
      life: w.range / w.speed, owner: p, dmg: w.dmg, radius: w.radius });
    this.ev('rk', p.id);
  }

  place(p, w) {
    if (w.id === 'mine') {
      for (const s of this.structs.values()) if (s.type === 1 && Math.hypot(s.x - p.x, s.y - p.y) < 26) return false;
      const id = this.newId();
      this.structs.set(id, { id, type: 1, x: p.x, y: p.y, hp: 1, maxhp: 1, owner: p, armed: 0.6, a: 0 });
      this.ev('place', 1, Math.round(p.x), Math.round(p.y));
      return true;
    }
    const tx = Math.floor((p.x + Math.cos(p.angle) * 34) / T), ty = Math.floor((p.y + Math.sin(p.angle) * 34) / T);
    if (this.solid(tx, ty)) return false;
    const x0 = tx * T, y0 = ty * T;
    for (const q of this.players.values()) {
      if (q !== p && q.state !== 'dead' && x0 - PR < q.x && q.x < x0 + T + PR && y0 - PR < q.y && q.y < y0 + T + PR) return false;
    }
    if (x0 < p.x && p.x < x0 + T && y0 < p.y && p.y < y0 + T) return false;
    for (const e of this.enemies.values()) {
      if (x0 - e.r < e.x && e.x < x0 + T + e.r && y0 - e.r < e.y && e.y < y0 + T + e.r) return false;
    }
    if (this.rows[ty][tx] === 'S') return false;
    const id = this.newId();
    const type = w.id === 'barricade' ? 0 : 2;
    const s = { id, type, x: x0 + T / 2, y: y0 + T / 2, tx, ty, hp: w.hp, maxhp: w.hp, owner: p, a: p.angle, cd: 0, ammo: 260, life: 60 };
    this.structs.set(id, s);
    this.structAt.set(ty * this.w + tx, s);
    this.fieldCd = 0;
    const [nx, ny] = this.collide(p.x, p.y, PR);
    if (nx !== p.x || ny !== p.y) { p.x = nx; p.y = ny; p.tp = [nx, ny]; p.tpSeq++; }
    this.ev('place', type, Math.round(s.x), Math.round(s.y));
    return true;
  }

  damageStruct(s, dmg) {
    s.hp -= dmg;
    if (s.hp <= 0) this.removeStruct(s);
  }

  removeStruct(s) {
    this.structs.delete(s.id);
    if (s.type !== 1) {
      this.structAt.delete(s.ty * this.w + s.tx);
      this.fieldCd = 0;
    }
    this.ev('sx', s.type, Math.round(s.x), Math.round(s.y));
  }

  // ------------------------------------------------------------ damage --
  damageEnemy(e, dmg, src, kx = 0, ky = 0, blood = true) {
    if (!this.enemies.has(e.id)) return;
    e.hp -= dmg;
    e.kx += kx * e.kbres * 3;
    e.ky += ky * e.kbres * 3;
    if (blood) this.ev('hit', e.id, Math.round(e.x), Math.round(e.y), e.tid);
    if (e.hp <= 0) this.killEnemy(e, src);
  }

  killEnemy(e, src) {
    if (!this.enemies.delete(e.id)) return;
    this.totalKills++;
    let pts = e.score, mult = 1, pid = 0;
    if (src instanceof Player) {
      src.combo = src.comboT > 0 ? src.combo + 1 : 1;
      src.comboT = COMBO_TIME;
      src.bestCombo = Math.max(src.bestCombo, src.combo);
      mult = src.mult;
      pts = e.score * mult;
      src.kills++;
      src.score += pts;
      pid = src.id;
    }
    this.score += pts;
    this.ev('die', Math.round(e.x), Math.round(e.y), e.tid, pts, mult, pid, Math.round(e.angle * 10), e.id);
    this.checkUnlocks();
    const r = Math.random();
    if (e.type === 'colossus') {
      for (let i = 0; i < 5; i++) this.drop(e.x + rand(-30, 30), e.y + rand(-30, 30), i < 3 ? 0 : 1);
    } else if (r < 0.085) this.drop(e.x, e.y, 0);
    else if (r < 0.12) this.drop(e.x, e.y, 1);
    if (e.type === 'bloater') this.explode(e.x, e.y, 95, 160, null, 30);
  }

  drop(x, y, kind) {
    const id = this.newId();
    [x, y] = this.collide(x, y, 8, false);
    this.items.set(id, { id, kind, x, y, life: 28 });
  }

  explode(x, y, radius, dmg, src, hurtPlayers = 0) {
    this.ev('ex', Math.round(x), Math.round(y), radius);
    for (const e of [...this.enemies.values()]) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < radius + e.r) {
        const f = 1 - 0.5 * Math.min(1, d / radius);
        const k = 220 * f / Math.max(d, 1);
        this.damageEnemy(e, dmg * f, src, (e.x - x) * k / 3, (e.y - y) * k / 3);
      }
    }
    if (hurtPlayers) {
      for (const p of this.alivePlayers()) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < radius + PR) this.hurtPlayer(p, hurtPlayers * (1 - 0.5 * Math.min(1, d / radius)));
      }
      for (const s of [...this.structs.values()]) {
        if (s.type !== 1 && Math.hypot(s.x - x, s.y - y) < radius + 16) this.damageStruct(s, dmg);
      }
    }
  }

  checkUnlocks() {
    WEAPONS.forEach((w, i) => {
      if (!(this.unlocked >> i & 1) && this.score >= w.unlock) {
        this.unlocked |= 1 << i;
        for (const p of this.players.values()) p.ammo[i] = Math.max(p.ammo[i], Math.floor(w.ammo / 2));
        this.ev('unl', i);
      }
    });
  }

  // ------------------------------------------------------- pathfinding --
  buildField() {
    const INF = 1e9, w = this.w, h = this.h, n = w * h;
    const dist = new Float64Array(n).fill(INF);
    const heap = new Heap();
    for (const p of this.alivePlayers()) {
      const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
      if (tx >= 0 && tx < w && ty >= 0 && ty < h) {
        dist[ty * w + tx] = 0;
        heap.push([0, ty * w + tx]);
      }
    }
    const st = this.static, sa = this.structAt;
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      const x = i % w, y = (i - x) / w;
      for (const [ox, oy, c] of NEIGH8) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (st[j]) continue;
        if (ox && oy) {
          const a = y * w + nx, b = ny * w + x;
          if (st[a] || st[b] || sa.has(a) || sa.has(b)) continue;
        }
        const nd = d + c + (sa.has(j) ? 7 : 0);
        if (nd < dist[j]) { dist[j] = nd; heap.push([nd, j]); }
      }
    }
    this.field = dist;
  }

  // ----------------------------------------------------------- enemies --
  spawnEnemy(type) {
    const alive = this.alivePlayers();
    const far = this.spawns.filter(s => alive.every(p => Math.hypot(s[0] - p.x, s[1] - p.y) > 260));
    const [x, y] = choice(far.length ? far : this.spawns);
    const n = this.players.size;
    const hpScale = (1 + 0.11 * (this.wave - 1)) * (type === 'colossus' ? 1 + 0.35 * (n - 1) : 1);
    const spScale = 1 + Math.min(0.3, 0.02 * (this.wave - 1));
    const e = new Enemy(this.newId(), type, x + rand(-10, 10), y + rand(-10, 10), hpScale, spScale);
    this.enemies.set(e.id, e);
    return e;
  }

  updateEnemies(dt) {
    const alive = this.alivePlayers();
    const field = this.field, w = this.w;
    for (const e of [...this.enemies.values()]) {
      if (!this.enemies.has(e.id)) continue;
      if (e.burn > 0) {
        e.burn -= dt;
        this.damageEnemy(e, 20 * dt, e.burnSrc, 0, 0, false);
        if (!this.enemies.has(e.id)) continue;
      }
      e.atkCd -= dt;
      let target = null, td = 1e9;
      for (const p of alive) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < td) { target = p; td = d; }
      }
      let mx = 0, my = 0, nextStruct = null;
      if (target) {
        const tx = Math.floor(e.x / T), ty = Math.floor(e.y / T);
        let direct = td < 150 && this.los(e.x, e.y, target.x, target.y);
        if (!direct && field && tx >= 0 && tx < this.w && ty >= 0 && ty < this.h) {
          let best = field[ty * w + tx], bx = -1, by = -1;
          for (const [ox, oy] of NEIGH8) {
            const nx = tx + ox, ny = ty + oy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            if (ox && oy && (this.solid(nx, ty) || this.solid(tx, ny))) continue;
            const d = field[ny * w + nx];
            if (d < best) { best = d; bx = nx; by = ny; }
          }
          if (bx < 0) direct = true;
          else {
            const dx = (bx + 0.5) * T - e.x, dy = (by + 0.5) * T - e.y, dl = Math.hypot(dx, dy) || 1;
            mx = dx / dl; my = dy / dl;
            nextStruct = this.structAt.get(by * w + bx) || null;
          }
        } else if (!direct) direct = true;
        if (direct) { mx = (target.x - e.x) / (td || 1); my = (target.y - e.y) / (td || 1); }
        e.angle = direct || td < 200 ? Math.atan2(target.y - e.y, target.x - e.x) : Math.atan2(my, mx);
      }
      let speed = e.speed;
      // --- type specials
      if (e.type === 'warlock' && target) {
        e.special -= dt;
        if (td < 330 && this.los(e.x, e.y, target.x, target.y)) {
          speed *= td < 240 ? 0.15 : 0.6;
          if (e.special <= 0) {
            e.special = rand(1.8, 2.6);
            this.enemyShot(e, Math.atan2(target.y - e.y, target.x - e.x), 250, 13);
          }
        }
      } else if (e.type === 'colossus' && target) {
        e.special -= dt;
        e.special2 -= dt;
        if (e.special <= 0) {
          e.special = 3.2;
          const off = Math.random();
          for (let k = 0; k < 14; k++) this.enemyShot(e, (k + off) / 14 * Math.PI * 2, 200, 15, 2);
          this.ev('roar', e.id);
        }
        if (e.special2 <= 0 && this.enemies.size < 90) {
          e.special2 = 9;
          for (let k = 0; k < 3; k++) {
            const m = this.spawnEnemy(this.wave > 9 ? 'sprinter' : 'shambler');
            [m.x, m.y] = this.collide(e.x + rand(-40, 40), e.y + rand(-40, 40), m.r);
          }
          this.ev('sum', Math.round(e.x), Math.round(e.y));
        }
      } else if (e.type === 'bloater' && target && td < e.r + PR + 6) {
        this.killEnemy(e, null);
        continue;
      }
      // --- attack
      if (target && td < e.r + PR + 5 && e.dmg) {
        speed *= 0.2;
        if (e.atkCd <= 0) {
          e.atkCd = e.rate;
          this.hurtPlayer(target, e.dmg);
          this.ev('bite', e.id);
        }
      } else if (nextStruct) {
        if (Math.hypot(nextStruct.x - e.x, nextStruct.y - e.y) < e.r + 24) {
          speed = 0;
          e.angle = Math.atan2(nextStruct.y - e.y, nextStruct.x - e.x);
          if (e.atkCd <= 0) {
            e.atkCd = e.rate;
            this.damageStruct(nextStruct, Math.max(e.dmg, 12));
            this.ev('bite', e.id);
          }
        }
      }
      if (!target) speed = 0;
      e.x += mx * speed * dt + e.kx * dt;
      e.y += my * speed * dt + e.ky * dt;
      const decay = Math.exp(-8 * dt);
      e.kx *= decay;
      e.ky *= decay;
    }
    // separation (spatial hash)
    const cell = 40, grid = new Map();
    const key = (cx, cy) => cx * 4096 + cy;
    for (const e of this.enemies.values()) {
      const k = key(Math.floor(e.x / cell), Math.floor(e.y / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(e);
    }
    for (const [k, lst] of grid) {
      const cx = Math.floor(k / 4096), cy = k - cx * 4096;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const other = grid.get(key(cx + ox, cy + oy));
        if (!other) continue;
        for (const a of lst) for (const b of other) {
          if (b.id <= a.id) continue;
          const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r, d2 = dx * dx + dy * dy;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.01, push = (rr - d) * 0.5;
            const wa = b.r / rr, wb = a.r / rr, nx = dx / d, ny = dy / d;
            a.x -= nx * push * wa * 1.2; a.y -= ny * push * wa * 1.2;
            b.x += nx * push * wb * 1.2; b.y += ny * push * wb * 1.2;
          }
        }
      }
    }
    for (const e of this.enemies.values()) [e.x, e.y] = this.collide(e.x, e.y, Math.min(e.r, 15));
  }

  enemyShot(e, a, speed, dmg, kind = 1) {
    const id = this.newId();
    this.projs.set(id, { id, kind, x: e.x + Math.cos(a) * e.r, y: e.y + Math.sin(a) * e.r,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 3, owner: null, dmg, radius: 0 });
    if (kind === 1) this.ev('orb', Math.round(e.x), Math.round(e.y));
  }

  // ------------------------------------------------------- projectiles --
  updateProjs(dt) {
    for (const pr of [...this.projs.values()]) {
      let dead = false;
      for (let s = 0; s < 3 && !dead; s++) {
        pr.x += pr.vx * dt / 3;
        pr.y += pr.vy * dt / 3;
        const tx = Math.floor(pr.x / T), ty = Math.floor(pr.y / T);
        if (pr.kind === 0) { // rocket
          let hit = this.solid(tx, ty, false);
          if (!hit) for (const e of this.enemies.values()) if (Math.hypot(e.x - pr.x, e.y - pr.y) < e.r + 6) { hit = true; break; }
          if (hit) { this.explode(pr.x, pr.y, pr.radius, pr.dmg, pr.owner); dead = true; }
        } else { // enemy orb
          if (this.solid(tx, ty, false)) { dead = true; break; }
          const st = this.structAt.get(ty * this.w + tx);
          if (st) { this.damageStruct(st, pr.dmg * 2); dead = true; break; }
          for (const p of this.alivePlayers()) {
            if (Math.hypot(p.x - pr.x, p.y - pr.y) < PR + 7) { this.hurtPlayer(p, pr.dmg); dead = true; break; }
          }
        }
      }
      pr.life -= dt;
      if (dead || pr.life <= 0) {
        if (!dead && pr.kind === 0) this.explode(pr.x, pr.y, pr.radius, pr.dmg, pr.owner);
        else if (dead && pr.kind !== 0) this.ev('pop', Math.round(pr.x), Math.round(pr.y), pr.kind);
        this.projs.delete(pr.id);
      }
    }
  }

  // -------------------------------------------------------- structures --
  updateStructs(dt) {
    for (const s of [...this.structs.values()]) {
      if (!this.structs.has(s.id)) continue;
      if (s.type === 1) { // mine
        s.armed -= dt;
        if (s.armed > 0) continue;
        for (const e of this.enemies.values()) {
          if (Math.hypot(e.x - s.x, e.y - s.y) < e.r + 14) {
            this.structs.delete(s.id);
            const w = WEAPONS[W_INDEX.mine];
            this.explode(s.x, s.y, w.radius, w.dmg, s.owner);
            break;
          }
        }
      } else if (s.type === 2) { // sentry
        s.life -= dt;
        s.cd -= dt;
        if (s.life <= 0 || s.ammo <= 0) { this.removeStruct(s); continue; }
        if (s.cd > 0) continue;
        let best = null, bd = 430;
        for (const e of this.enemies.values()) {
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d < bd && this.los(s.x, s.y, e.x, e.y)) { best = e; bd = d; }
        }
        if (best) {
          s.a = Math.atan2(best.y - s.y, best.x - s.x);
          s.cd = 0.11;
          s.ammo--;
          const owner = this.players.has(s.owner.id) ? s.owner : null;
          this.fireHitscan(s.owner, -1, SENTRY_GUN, { ox: s.x, oy: s.y - 4, angle: s.a, owner });
        }
      }
    }
  }

  // ------------------------------------------------------------- items --
  updateItems(dt) {
    for (const it of [...this.items.values()]) {
      it.life -= dt;
      if (it.life <= 0) { this.items.delete(it.id); continue; }
      for (const p of this.alivePlayers()) {
        if (Math.hypot(p.x - it.x, p.y - it.y) >= PR + 14) continue;
        if (it.kind === 1) {
          if (p.hp >= PLAYER_HP) continue;
          p.hp = Math.min(PLAYER_HP, p.hp + 35);
        } else {
          WEAPONS.forEach((w, i) => { if (i && this.unlocked >> i & 1) p.ammo[i] = Math.min(w.ammo, p.ammo[i] + w.pickup); });
        }
        this.items.delete(it.id);
        this.ev('pk', p.id, it.kind, Math.round(it.x), Math.round(it.y));
        break;
      }
    }
  }

  // ------------------------------------------------------------- waves --
  startWave() {
    const wv = ++this.wave;
    const n = Math.max(1, this.players.size);
    const count = Math.floor((10 + wv * 5) * (1 + 0.55 * (n - 1)));
    const q = [];
    for (let i = 0; i < count; i++) {
      const pool = [['shambler', 1]];
      if (wv >= 2) pool.push(['sprinter', 0.12 + 0.03 * wv]);
      if (wv >= 3) pool.push(['warlock', 0.05 + 0.012 * wv]);
      if (wv >= 4) pool.push(['brute', 0.04 + 0.01 * wv]);
      if (wv >= 6) pool.push(['bloater', 0.09]);
      let r = Math.random() * pool.reduce((s, p) => s + p[1], 0);
      let pick = 'shambler';
      for (const [name, wgt] of pool) { r -= wgt; if (r <= 0) { pick = name; break; } }
      q.push(pick);
    }
    if (wv % 5 === 0) for (let k = 0; k < Math.floor(wv / 10) + 1; k++) q.splice(Math.floor(q.length / 3) + k * 5, 0, 'colossus');
    this.queue = q;
    this.waveState = 'fight';
    this.spawnCd = 1;
    this.ev('wave', wv, wv % 5 === 0 ? 1 : 0);
  }

  endWave() {
    this.waveState = 'break';
    this.timer = 9;
    for (const p of this.players.values()) {
      if (p.state !== 'alive') { this.respawn(p); p.hp = 70; } else p.hp = Math.min(PLAYER_HP, p.hp + 25);
    }
    for (let k = 0; k < 2; k++) {
      const [x, y] = choice(this.pspawns);
      this.drop(x + rand(-60, 60), y + rand(-60, 60), k);
    }
    this.ev('clear', this.wave);
  }

  updateWaves(dt) {
    if (this.waveState === 'break') {
      this.timer -= dt;
      if (this.timer <= 0) this.startWave();
      return;
    }
    const n = Math.max(1, this.players.size);
    const maxAlive = Math.min(95, 35 + 12 * n);
    this.spawnCd -= dt;
    if (this.queue.length && this.spawnCd <= 0 && this.enemies.size < maxAlive) {
      const burst = randint(1, 2 + Math.min(3, Math.floor(this.wave / 3)));
      for (let i = 0; i < burst && this.queue.length; i++) this.spawnEnemy(this.queue.shift());
      this.spawnCd = Math.max(0.35, 1.6 - this.wave * 0.07) / (1 + 0.35 * (n - 1));
    }
    if (!this.queue.length && !this.enemies.size) this.endWave();
  }

  // -------------------------------------------------------------- tick --
  tick(dt) {
    if (this.over) return;
    this.time += dt;
    this.fieldCd -= dt;
    if (this.fieldCd <= 0) { this.buildField(); this.fieldCd = 0.25; }
    for (const p of this.players.values()) this.updatePlayer(p, dt);
    this.updateEnemies(dt);
    this.updateProjs(dt);
    this.updateStructs(dt);
    this.updateItems(dt);
    this.updateWaves(dt);
    this.checkOver();
  }

  // ----------------------------------------------------------- network --
  snapshotCommon() {
    const st = { alive: 0, down: 1, dead: 2 };
    return {
      t: 's',
      tm: Math.round(this.time * 1000) / 1000,
      wv: this.wave,
      ws: this.waveState === 'fight' ? 1 : 0,
      wt: r1(Math.max(0, this.timer)),
      left: this.queue.length + this.enemies.size,
      sc: this.score,
      un: this.unlocked,
      p: [...this.players.values()].map(p => [p.id, r1(p.x), r1(p.y), Math.round(p.angle * 100), Math.round(p.hp), p.weapon,
        st[p.state], Math.round(p.rev / REVIVE_TIME * 100), p.shooting ? 1 : 0, p.mult, Math.round(p.downT), p.kills, p.score]),
      e: [...this.enemies.values()].map(e => [e.id, e.tid, Math.round(e.x), Math.round(e.y), Math.round(e.angle * 10),
        Math.round(Math.max(0, e.hp) / e.maxhp * 100), e.burn > 0 ? 1 : 0]),
      pr: [...this.projs.values()].map(p => [p.id, p.kind, Math.round(p.x), Math.round(p.y)]),
      it: [...this.items.values()].map(it => [it.id, it.kind, Math.round(it.x), Math.round(it.y)]),
      st: [...this.structs.values()].map(s => [s.id, s.type, Math.round(s.x), Math.round(s.y), Math.round(s.hp / s.maxhp * 100), Math.round((s.a || 0) * 10)]),
      ev: this.events,
    };
  }

  snapshotPrivate(id) {
    const p = this.players.get(id);
    if (!p) return {};
    const me = { am: p.ammo, k: p.kills, ps: p.score, cb: p.combo, ct: Math.round(Math.max(0, p.comboT) / COMBO_TIME * 100) };
    if (p.tp) { me.tp = [r1(p.tp[0]), r1(p.tp[1]), p.tpSeq]; p.tp = null; }
    return me;
  }

  stats() {
    return [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, score: p.score,
      best: p.bestCombo, downs: p.downs, revives: p.revives }));
  }

  startInfo() {
    const m = this.map;
    return {
      t: 'start',
      map: { id: m.id, name: m.name, w: m.w, h: m.h, rows: m.rows, theme: m.theme },
      weapons: WEAPONS.map(w => ({ id: w.id, name: w.name, kind: w.kind, ammo: w.ammo, rate: w.rate, unlock: w.unlock })),
      enemies: ENEMY_TYPES,
      speed: PLAYER_SPEED,
      pr: PR,
    };
  }
}
