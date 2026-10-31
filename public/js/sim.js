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

function makeCemetery() {
  const W = 48, H = 36, g = grid(W, H, ','), rnd = seeded(13);
  for (let i = 0; i < 30; i++) rect(g, sRange(rnd, 0, W), sRange(rnd, 0, H), sInt(rnd, 2, 5), sInt(rnd, 1, 3), '.');
  rect(g, 0, half(H) - 1, W, 3, '.'); rect(g, half(W) - 1, 0, 3, H, '.');
  border(g); gates(g);
  // rows of gravestones
  for (let y = 4; y < H - 4; y += 3) for (let x = 4; x < W - 4; x += 3) {
    if (Math.abs(x - half(W)) < 7 && Math.abs(y - half(H)) < 5) continue;
    if (Math.abs(y - half(H)) <= 2 || Math.abs(x - half(W)) <= 2) continue;
    if (rnd() < 0.55) g[y][x] = 'B';
  }
  mirror4(g, 6, 5, 4, 3, '#');      // mausoleums
  for (let i = 0; i < 12; i++) {    // dead trees
    const x = sRange(rnd, 3, W - 3), y = sRange(rnd, 3, H - 3);
    if (Math.abs(x - half(W)) < 7 && Math.abs(y - half(H)) < 5) continue;
    if ('.,'.includes(g[y][x])) g[y][x] = 'T';
  }
  // ruined chapel walls around the spawn
  for (const [x, y] of [[-6, -4], [3, -4], [-6, 3], [3, 3]]) rect(g, half(W) + x, half(H) + y, 3, 1, '#');
  rect(g, half(W) - 1, half(H) - 1, 2, 2, 'P');
  return g;
}

const THEMES = {
  depot: { floor: '#3d3b37', floor2: '#36342f', grid: '#2f2d29', wallTop: '#8a8580', wallFront: '#55514c', crateTop: '#b0834a', crateFront: '#7a5530', tree: '#6f6a64', treeTop: '#9a958d', dark: 0.30, pillar: true, bg: '#151412' },
  crossroads: { floor: '#3a3c40', floor2: '#4b4639', grid: '#303236', wallTop: '#7a4f3c', wallFront: '#4f3328', crateTop: '#6c7f8f', crateFront: '#3f4c57', tree: '#2f5a2a', treeTop: '#4c8a3c', dark: 0.38, pillar: false, roof: true, bg: '#121316' },
  bunker: { floor: '#40453f', floor2: '#383d38', grid: '#323631', wallTop: '#6b7068', wallFront: '#40443e', crateTop: '#5e6b3e', crateFront: '#3a4227', tree: '#7a7f77', treeTop: '#9da298', dark: 0.5, pillar: true, bg: '#0d0f0d' },
  orchard: { floor: '#6b5638', floor2: '#3f5a2c', grid: '#4d3f29', wallTop: '#8b6b43', wallFront: '#5c4429', crateTop: '#d8b65a', crateFront: '#9a7c34', tree: '#2d4f22', treeTop: '#4f7d33', dark: 0.42, pillar: false, fence: true, bg: '#14140c' },
  cemetery: { floor: '#3b3e3a', floor2: '#2f3a2c', grid: '#2c302c', wallTop: '#77787a', wallFront: '#4a4b4e', crateTop: '#8c8f94', crateFront: '#5a5d62', tree: '#3a3330', treeTop: '#544a42', dark: 0.55, pillar: false, grave: true, bg: '#0c0d10' },
};

const MAPS = {
  depot: { name: 'Rust Depot', desc: 'Open warehouse yard full of crate stacks. Four gates.', gen: makeDepot },
  crossroads: { name: 'Crossroads', desc: 'Abandoned town streets with a central square. Long sight lines.', gen: makeCrossroads },
  bunker: { name: 'Bunker 9', desc: 'Nine concrete rooms joined by tight doors. Hold the chokepoints.', gen: makeBunker },
  orchard: { name: 'Dusk Orchard', desc: 'Fenced orchard at sunset, trees everywhere. Enemies come from all sides.', gen: makeOrchard },
  cemetery: { name: 'Old Cemetery', desc: 'Foggy graveyard with rows of tombstones around a ruined chapel.', gen: makeCemetery },
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

// Weapon upgrades drop from bosses (and rarely brutes). Each one belongs to the player who
// picks it up; mods overwrite the weapon's base stats.
export const UPGRADES = [
  { w: 'pistol', name: 'Hair Trigger', desc: 'Full-auto pistol', mod: { rate: 0.11 } },
  { w: 'pistol', name: 'Dual Pistols', desc: 'Two bullets per shot', mod: { pellets: 2, spread: 0.07 } },
  { w: 'smg', name: 'Drum Mag', desc: 'Double SMG ammo, faster fire', mod: { ammo: 600, rate: 0.06 } },
  { w: 'smg', name: 'Hot Rounds', desc: 'SMG bullets set undead on fire', mod: { burn: 1.2 } },
  { w: 'shotgun', name: 'Auto Shotgun', desc: 'Shotgun fires 2x faster', mod: { rate: 0.32 } },
  { w: 'shotgun', name: 'Long Barrel', desc: 'Shotgun range +70%, 10 pellets', mod: { range: 510, spread: 0.2, pellets: 10 } },
  { w: 'shotgun', name: "Dragon's Breath", desc: 'Incendiary shotgun shells', mod: { burn: 1.6 } },
  { w: 'barricade', name: 'Steel Plating', desc: 'Barricades have 3x health', mod: { hp: 1350 } },
  { w: 'rifle', name: 'AP Rounds', desc: 'Rifle bullets pierce enemies', mod: { pierce: true } },
  { w: 'rifle', name: 'Marksman', desc: '+50% rifle damage, tighter spread', mod: { dmg: 48, spread: 0.02 } },
  { w: 'mine', name: 'Big Boom', desc: 'Bigger, deadlier mines', mod: { radius: 160, dmg: 450 } },
  { w: 'rail', name: 'Capacitor', desc: 'Railgun fires 2x faster', mod: { rate: 0.45 } },
  { w: 'flame', name: 'Napalm', desc: 'Flamethrower +60% range, wider cone', mod: { range: 300, cone: 0.55 } },
  { w: 'rocket', name: 'Cluster Rockets', desc: 'Rockets scatter bomblets', mod: { cluster: 6 } },
  { w: 'rocket', name: 'Rapid Launcher', desc: 'Rocket launcher fires 2x faster', mod: { rate: 0.45 } },
  { w: 'sentry', name: 'Heavy Sentry', desc: 'Sentries last 2x longer and hit harder', mod: { life: 120, sdmg: 26 } },
];

// per-player weapon stats for an upgrade bitmask
export function weaponStats(mask) {
  return WEAPONS.map(w => {
    const s = { ...w };
    UPGRADES.forEach((u, i) => { if (mask >> i & 1 && u.w === w.id) Object.assign(s, u.mod); });
    return s;
  });
}

export const DIFFICULTY = {
  easy: { name: 'Easy', hp: 0.7, speed: 0.85, dmg: 0.6, count: 0.75, drops: 1.4 },
  normal: { name: 'Normal', hp: 1, speed: 1, dmg: 1, count: 1, drops: 1 },
  hard: { name: 'Hard', hp: 1.35, speed: 1.1, dmg: 1.35, count: 1.25, drops: 0.85 },
  nightmare: { name: 'Nightmare', hp: 1.8, speed: 1.22, dmg: 1.75, count: 1.5, drops: 0.7 },
};

// ================================================================= modes ==
export const MODES = {
  classic: { name: 'Classic', desc: 'Endless waves. Unlock the arsenal and hold out as long as you can.' },
  gauntlet: { name: 'Gauntlet', desc: 'Endless waves, but every wave you pick a perk, waves get random mutators and elite undead show up early.' },
  missions: { name: 'Missions', desc: 'A campaign of 10 levels with objectives. Clear one to unlock the next. Perks every wave.' },
};

// Perks: picked from three random offers after every wave (Gauntlet and Missions). Ranks stack up to max.
export const PERKS = [
  { id: 'tough', name: 'Toughness', desc: '+25 max health', max: 3, icon: '♥', color: '#e8423f' },
  { id: 'feet', name: 'Quick Feet', desc: '+10% move speed', max: 3, icon: '»', color: '#5fb0ff' },
  { id: 'guns', name: 'Big Guns', desc: '+15% weapon damage', max: 5, icon: '✸', color: '#f2873a' },
  { id: 'trigger', name: 'Trigger Finger', desc: '+12% fire rate', max: 3, icon: '↯', color: '#f2c230' },
  { id: 'pockets', name: 'Deep Pockets', desc: '+50% max ammo and ammo pickups', max: 2, icon: '▤', color: '#c8b070' },
  { id: 'vamp', name: 'Vampire', desc: 'Heal 1 HP for every kill', max: 3, icon: '✚', color: '#d04a7a' },
  { id: 'medic', name: 'Field Medic', desc: 'Revive teammates 2x faster, bleed out 10s slower', max: 1, icon: '+', color: '#7fff8f' },
  { id: 'combo', name: 'Combo Artist', desc: '+1s to chain the next kill', max: 2, icon: '∞', color: '#f2b33a' },
  { id: 'demo', name: 'Demolitions', desc: '+25% explosion size and damage', max: 2, icon: '✺', color: '#ff6030' },
  { id: 'regen', name: 'Regeneration', desc: 'Regain 2 HP/s after 3s without damage', max: 2, icon: '❋', color: '#49c46b' },
  { id: 'lucky', name: 'Scavenger', desc: '+35% drop chance', max: 2, icon: '♣', color: '#a0d060' },
  { id: 'wind', name: 'Second Wind', desc: 'Once per wave, get back up on your own after 3s', max: 1, icon: '↺', color: '#b25be8' },
];
const PERK = Object.fromEntries(PERKS.map((p, i) => [p.id, i]));

// Wave mutators (Gauntlet: random from wave 3, two at once from wave 12; some missions have fixed ones)
export const MUTATORS = [
  { id: 'swift', name: 'Blood Moon', desc: 'Undead are 25% faster' },
  { id: 'tough', name: 'Ironhide', desc: 'Undead have 50% more health' },
  { id: 'swarm', name: 'Swarm', desc: '60% more undead, but weaker' },
  { id: 'dark', name: 'Blackout', desc: 'The lights are failing' },
  { id: 'volatile', name: 'Volatile', desc: 'Undead may explode when they die' },
  { id: 'gold', name: 'Gold Rush', desc: 'Kills are worth double points' },
  { id: 'elite', name: 'Champions', desc: 'Far more elite undead' },
  { id: 'regen', name: 'Undying', desc: 'Undead regenerate health' },
  { id: 'glass', name: 'Glass Cannons', desc: 'Undead have 40% less health but hit 40% harder' },
];

// goal types: waves (clear n waves), defend (keep the generator alive for n waves),
// collect (pick up n fuel cans), holdout (survive secs seconds).
// start: team score to begin with (pre-unlocks weapons), lvl: how far into the threat curve it starts.
export const MISSIONS = [
  { name: 'First Night', map: 'depot', goal: { type: 'waves', n: 5 }, foes: ['shambler', 'sprinter'], start: 0, lvl: 0,
    desc: 'Survive 5 waves at the depot. A gentle start.' },
  { name: 'Power Down', map: 'bunker', goal: { type: 'defend', n: 6 }, foes: ['shambler', 'sprinter', 'brute', 'leaper'], start: 1300, lvl: 2,
    desc: 'Keep the generator running for 6 waves. The undead go for it first.' },
  { name: 'Scavenger Run', map: 'crossroads', goal: { type: 'collect', n: 6 }, foes: ['shambler', 'sprinter', 'warlock', 'spitter'], start: 1300, lvl: 3,
    desc: 'Find 6 fuel cans scattered around town while the horde closes in.' },
  { name: 'The Pack', map: 'orchard', goal: { type: 'waves', n: 7 }, foes: ['shambler', 'sprinter', 'leaper', 'splitter'], start: 2600, lvl: 4,
    desc: 'Survive 7 waves of fast hunters in the orchard.' },
  { name: 'Juggernaut', map: 'depot', goal: { type: 'waves', n: 6 }, foes: ['shambler', 'brute', 'riot', 'bloater'], boss: { 6: ['juggernaut'] }, start: 4500, lvl: 5,
    desc: 'Survive 6 waves. The Juggernaut arrives on the last one. Dodge its charge!' },
  { name: 'Acid Rain', map: 'cemetery', goal: { type: 'holdout', secs: 240 }, foes: ['shambler', 'sprinter', 'spitter', 'riot'], start: 4500, lvl: 6,
    desc: 'Hold out for 4 minutes in the graveyard. Stay out of the acid.' },
  { name: 'Lights Out', map: 'bunker', goal: { type: 'waves', n: 8 }, foes: ['shambler', 'leaper', 'bloater', 'wraith'], mut: ['dark'], start: 7000, lvl: 7,
    desc: 'Survive 8 waves in the dark. Wraiths drift through walls.' },
  { name: 'Harvest Moon', map: 'orchard', goal: { type: 'defend', n: 8 }, foes: ['shambler', 'sprinter', 'warlock', 'splitter', 'shaman'], mut: ['swift'], start: 10500, lvl: 8,
    desc: 'Defend the generator for 8 waves under a blood moon.' },
  { name: 'Unholy Choir', map: 'cemetery', goal: { type: 'collect', n: 8 }, foes: ['shambler', 'warlock', 'riot', 'shaman', 'wraith'], boss: { 5: ['colossus'] }, start: 10500, lvl: 9,
    desc: 'Recover 8 fuel cans while shamans keep the horde alive.' },
  { name: 'Last Stand', map: 'crossroads', goal: { type: 'waves', n: 10 }, foes: null, boss: { 5: ['colossus'], 10: ['colossus', 'juggernaut'] }, start: 15000, lvl: 10,
    desc: 'Ten waves, every kind of undead, and both bosses at the end.' },
];

// =============================================================== enemies ==
// Index order is the network type id; never reorder, only append.
export const ENEMY_TYPES = ['shambler', 'sprinter', 'brute', 'warlock', 'bloater', 'colossus',
  'leaper', 'spitter', 'riot', 'shaman', 'splitter', 'wraith', 'juggernaut', 'splitling'];
export const BOSSES = ['colossus', 'juggernaut'];
export const FOE_TYPES = ENEMY_TYPES.filter(t => t !== 'splitling');   // the ones the host can toggle
const ENEMIES = {
  shambler: { hp: 55, speed: 56, r: 12, dmg: 10, rate: 0.9, score: 10 },
  sprinter: { hp: 32, speed: 118, r: 10, dmg: 7, rate: 0.6, score: 15 },
  brute: { hp: 480, speed: 46, r: 19, dmg: 26, rate: 1.2, score: 50, kbres: 0.25 },
  warlock: { hp: 110, speed: 56, r: 12, dmg: 8, rate: 1.0, score: 30 },
  bloater: { hp: 85, speed: 50, r: 15, dmg: 0, rate: 1.0, score: 25 },
  colossus: { hp: 3600, speed: 44, r: 30, dmg: 38, rate: 1.3, score: 700, kbres: 0.05 },
  leaper: { hp: 45, speed: 70, r: 10, dmg: 9, rate: 0.8, score: 20 },
  spitter: { hp: 75, speed: 50, r: 12, dmg: 8, rate: 1.0, score: 30 },
  riot: { hp: 170, speed: 50, r: 13, dmg: 14, rate: 1.0, score: 35, kbres: 0.4 },
  shaman: { hp: 95, speed: 50, r: 12, dmg: 6, rate: 1.0, score: 45 },
  splitter: { hp: 130, speed: 52, r: 15, dmg: 12, rate: 1.0, score: 25 },
  wraith: { hp: 42, speed: 76, r: 11, dmg: 9, rate: 0.8, score: 30 },
  juggernaut: { hp: 3200, speed: 48, r: 26, dmg: 34, rate: 1.2, score: 800, kbres: 0.03 },
  splitling: { hp: 24, speed: 105, r: 8, dmg: 5, rate: 0.6, score: 5 },
};
const REGULAR = FOE_TYPES.filter(t => !BOSSES.includes(t));
// [type, first wave, base weight, weight per wave] for the endless modes
const SCHEDULE = [
  ['shambler', 1, 1, 0], ['sprinter', 2, 0.12, 0.03], ['warlock', 3, 0.05, 0.012], ['brute', 4, 0.04, 0.01],
  ['leaper', 5, 0.06, 0.01], ['bloater', 6, 0.09, 0], ['spitter', 7, 0.05, 0.008], ['riot', 8, 0.04, 0.008],
  ['shaman', 9, 0.03, 0.003], ['splitter', 10, 0.05, 0.006], ['wraith', 12, 0.04, 0.008],
];

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
    this.ups = 0; this.ws = weaponStats(0);
    this.combo = 0; this.comboT = 0; this.bestCombo = 0; this.comboMax = COMBO_TIME;
    this.kills = 0; this.score = 0; this.downs = 0; this.revives = 0;
    this.budget = 60; this.lastIn = performance.now() / 1000;
    this.tp = null; this.tpSeq = 0;
    this.maxhp = PLAYER_HP; this.speed = PLAYER_SPEED;
    this.perks = PERKS.map(() => 0);
    this.offer = null; this.picks = 0;   // current perk offer (3 PERKS indices) and how many picks are owed
    this.hurtT = 0; this.windReady = true; this.autoRev = 0;
    this.dirty = true;                   // private stats changed: resend weapon stats / perks
  }
  get mult() { return Math.min(10, 1 + Math.floor(this.combo / 4)); }
  rank(id) { return this.perks[PERK[id]]; }
}

class Enemy {
  constructor(id, type, x, y, hpScale, speedScale, dmgScale) {
    const d = ENEMIES[type];
    this.id = id; this.type = type; this.tid = ENEMY_TYPES.indexOf(type);
    this.x = x; this.y = y;
    this.maxhp = this.hp = d.hp * hpScale;
    this.speed = d.speed * speedScale * rand(0.9, 1.1);
    this.r = d.r; this.dmg = d.dmg * dmgScale; this.rate = d.rate; this.score = d.score;
    this.kbres = d.kbres ?? 1;
    this.angle = 0; this.atkCd = 0.5;
    this.kx = 0; this.ky = 0;
    this.burn = 0; this.burnSrc = null;
    this.special = rand(1.5, 3); this.special2 = 6;
    this.elite = false;
    this.mode = 0; this.mt = 0;          // leaper / juggernaut: 0 walk, 1 wind-up, 2 leap/charge, 3 stunned
    this.vx = 0; this.vy = 0; this.hitSet = null;
    this.shield = type === 'riot' ? d.hp * 1.6 * hpScale : 0;   // riot shield soaks frontal bullets until it breaks
  }
}

// ================================================================== game ==
export class Game {
  // opts: { diff: DIFFICULTY key, foes: allowed enemy types, mode: MODES key, mission: MISSIONS index }
  constructor(mapId, opts = {}) {
    this.mode = MODES[opts.mode] ? opts.mode : 'classic';
    this.missionIdx = this.mode === 'missions' ? clamp(opts.mission | 0, 0, MISSIONS.length - 1) : -1;
    this.mission = MISSIONS[this.missionIdx] || null;
    if (this.mission) mapId = this.mission.map;
    const m = getMap(mapId);
    this.map = m;
    this.diffId = DIFFICULTY[opts.diff] ? opts.diff : 'normal';
    this.diff = DIFFICULTY[this.diffId];
    const foes = this.mission ? this.mission.foes || REGULAR : opts.foes || FOE_TYPES;
    this.foes = new Set(foes.filter(t => FOE_TYPES.includes(t)));
    if (!REGULAR.some(t => this.foes.has(t))) this.foes.add('shambler');
    this.perksOn = this.mode !== 'classic';
    this.mutators = [];               // MUTATORS ids active this wave
    this.goal = this.mission ? this.mission.goal : null;
    this.goalV = 0;                   // collect: cans found, holdout: seconds survived
    this.won = false;
    this.lost = '';                   // reason the mission failed, if not a wipe
    this.gen = null;
    this.hazards = new Map();
    this.bossWave = false;
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
    if (this.mission) this.setupMission();
  }

  setupMission() {
    const ms = this.mission;
    this.score = ms.start;
    WEAPONS.forEach((w, i) => { if (ms.start >= w.unlock) this.unlocked |= 1 << i; });
    const cx = this.pspawns.reduce((s, p) => s + p[0], 0) / this.pspawns.length;
    const cy = this.pspawns.reduce((s, p) => s + p[1], 0) / this.pspawns.length;
    if (this.goal.type === 'defend') {
      const tx = Math.floor(cx / T), ty = Math.floor(cy / T);
      const id = this.newId();
      const hp = 3000;
      this.gen = { id, type: 3, x: tx * T + T / 2, y: ty * T + T / 2, tx, ty, hp, maxhp: hp, owner: null, a: 0 };
      this.structs.set(id, this.gen);
      this.structAt.set(ty * this.w + tx, this.gen);
    } else if (this.goal.type === 'collect') {
      // fuel cans: far from the start, away from enemy gates and spread out
      const spots = [];
      this.rows.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch !== '.' && ch !== ',') return;
        const px = (x + 0.5) * T, py = (y + 0.5) * T;
        if (Math.hypot(px - cx, py - cy) < 9 * T) return;
        if (this.spawns.some(s => Math.hypot(s[0] - px, s[1] - py) < 4 * T)) return;
        spots.push([px, py]);
      }));
      const placed = [];
      for (let tries = 0; placed.length < this.goal.n && tries < 4000; tries++) {
        const s = choice(spots);
        if (!s || placed.some(q => Math.hypot(q[0] - s[0], q[1] - s[1]) < (tries < 2000 ? 7 : 3) * T)) continue;
        placed.push(s);
        const id = this.newId();
        this.items.set(id, { id, kind: 3, x: s[0], y: s[1], u: -1, life: Infinity });
      }
    }
  }

  win() {
    if (this.over) return;
    this.won = true;
    this.over = true;
    this.ev('win');
  }

  hasMut(id) { return this.mutators.includes(id); }

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
    p.hp = p.maxhp;
    p.state = 'alive';
    p.rev = 0;
    p.autoRev = 0;
    p.budget = 60;
    p.tp = [p.x, p.y];
    p.tpSeq++;
  }

  // ------------------------------------------------------------- perks --
  // weapon stats, health and speed from upgrades + perks
  applyPerks(p) {
    const dm = 1 + 0.15 * p.rank('guns'), rm = 1 / (1 + 0.12 * p.rank('trigger'));
    const am = 1 + 0.5 * p.rank('pockets'), ex = 1 + 0.25 * p.rank('demo');
    p.ws = weaponStats(p.ups).map(w => {
      if (w.dmg) w.dmg *= dm;
      w.rate *= rm;
      if (w.ammo > 0) w.ammo = Math.round(w.ammo * am);
      w.pickup = Math.round(w.pickup * am);
      if (w.radius) { w.radius *= ex; w.dmg *= ex; }
      if (w.id === 'sentry') w.sdmg = (w.sdmg || SENTRY_GUN.dmg) * dm;
      return w;
    });
    const was = p.maxhp;
    p.maxhp = PLAYER_HP + 25 * p.rank('tough');
    if (p.maxhp > was && p.state === 'alive') p.hp += p.maxhp - was;
    p.speed = PLAYER_SPEED * (1 + 0.1 * p.rank('feet'));
    p.comboMax = COMBO_TIME + p.rank('combo');
    p.dirty = true;
  }

  rollPerks(p) {
    const opts = PERKS.map((k, i) => i).filter(i => p.perks[i] < PERKS[i].max);
    for (let i = opts.length - 1; i > 0; i--) { const j = randint(0, i); [opts[i], opts[j]] = [opts[j], opts[i]]; }
    return opts.length ? opts.slice(0, 3) : null;
  }

  offerPerk(p) {
    if (!this.perksOn) return;
    p.picks++;
    if (!p.offer) p.offer = this.rollPerks(p);
    if (!p.offer) p.picks = 0;
    p.dirty = true;
  }

  choosePerk(id, i) {
    const p = this.players.get(id);
    if (!p || !p.offer || !(i >= 0 && i < p.offer.length)) return;
    const k = p.offer[i];
    p.perks[k]++;
    p.picks = Math.max(0, p.picks - 1);
    p.offer = p.picks > 0 ? this.rollPerks(p) : null;
    if (!p.offer) p.picks = 0;
    this.applyPerks(p);
    this.ev('perk', p.id, k);
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
    p.budget = Math.min(p.budget + p.speed * 1.25 * dt, 90);
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
    p.hurtT = 0;
    this.ev('ph', p.id, Math.round(dmg));
    if (p.hp <= 0) {
      p.hp = 0;
      p.state = 'down';
      p.downT = BLEED_TIME + 10 * p.rank('medic');
      p.rev = 0;
      p.downs++;
      p.trigger = false;
      if (p.windReady && p.rank('wind')) { p.windReady = false; p.autoRev = 3; }
      this.ev('down', p.id);
      this.checkOver();
    }
  }

  // push a player (they own their position, so this goes out as a correction)
  shove(p, dx, dy) {
    const steps = Math.ceil(Math.hypot(dx, dy) / 8) || 1;
    let x = p.x, y = p.y;
    for (let i = 0; i < steps; i++) [x, y] = this.collide(x + dx / steps, y + dy / steps, PR);
    p.x = x; p.y = y; p.tp = [x, y]; p.tpSeq++;
  }

  checkOver() {
    if (this.over || !this.players.size || this.alivePlayers().length) return;
    if ([...this.players.values()].some(p => p.state === 'down' && p.autoRev > 0)) return;
    this.over = true;
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
      if (p.autoRev > 0) {
        p.autoRev -= dt;
        p.rev = Math.max(p.rev, (1 - p.autoRev / 3) * REVIVE_TIME);
        if (p.autoRev <= 0) {
          p.autoRev = 0;
          p.state = 'alive';
          p.hp = 40;
          p.budget = 60;
          this.ev('sw', p.id);
          return;
        }
      }
      if (helpers.length) {
        const medic = helpers.some(q => q.rank('medic')) ? 2 : 1;
        p.rev += dt * (1 + 0.5 * (helpers.length - 1)) * medic;
        if (p.rev >= REVIVE_TIME) {
          p.state = 'alive';
          p.hp = 45;
          p.budget = 60;
          p.autoRev = 0;
          for (const q of helpers) q.revives++;
          this.ev('rev', p.id, helpers[0].id);
        }
      } else if (!p.autoRev) p.rev = Math.max(0, p.rev - dt * 0.5);
      if (p.state === 'down' && p.downT <= 0) {
        p.state = 'dead';
        p.autoRev = 0;
        this.ev('dead', p.id);
        this.checkOver();
      }
      return;
    }
    if (p.state !== 'alive') return;
    p.hurtT += dt;
    const regen = p.rank('regen');
    if (regen && p.hurtT > 3 && p.hp < p.maxhp) p.hp = Math.min(p.maxhp, p.hp + 2 * regen * dt);
    p.fireCd -= dt;
    const w = p.ws[p.weapon];
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
        const struck = w.pierce ? hits : [hits[0]];
        if (!w.pierce) end = Math.max(0, hits[0][0]);
        for (const [, e] of struck) {
          // riot shields stop bullets from the front (railgun and AP rounds punch through)
          if (e.shield > 0 && !w.pierce && dx * Math.cos(e.angle) + dy * Math.sin(e.angle) < -0.45) {
            e.shield -= w.dmg;
            this.ev('shd', Math.round(e.x + Math.cos(e.angle) * 12), Math.round(e.y + Math.sin(e.angle) * 8), e.shield <= 0 ? 1 : 0);
            this.damageEnemy(e, w.dmg * 0.1, src, dx * w.kb * 0.2, dy * w.kb * 0.2, false);
            continue;
          }
          if (w.burn) { e.burn = Math.max(e.burn, w.burn); e.burnSrc = src; }
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
      life: w.range / w.speed, owner: p, dmg: w.dmg, radius: w.radius, cluster: w.cluster || 0 });
    this.ev('rk', p.id);
  }

  place(p, w) {
    if (w.id === 'mine') {
      for (const s of this.structs.values()) if (s.type === 1 && Math.hypot(s.x - p.x, s.y - p.y) < 26) return false;
      const id = this.newId();
      this.structs.set(id, { id, type: 1, x: p.x, y: p.y, hp: 1, maxhp: 1, owner: p, armed: 0.6, a: 0, dmg: w.dmg, radius: w.radius });
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
    const s = { id, type, x: x0 + T / 2, y: y0 + T / 2, tx, ty, hp: w.hp, maxhp: w.hp, owner: p, a: p.angle, cd: 0,
      ammo: w.life ? 520 : 260, life: w.life || 60, gun: w.sdmg ? { ...SENTRY_GUN, dmg: w.sdmg } : SENTRY_GUN };
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
    if (s === this.gen) {
      this.ev('ex', Math.round(s.x), Math.round(s.y), 140);
      this.lost = 'The generator was destroyed.';
      this.over = true;
    }
  }

  // ------------------------------------------------------------ damage --
  damageEnemy(e, dmg, src, kx = 0, ky = 0, blood = true) {
    if (!this.enemies.has(e.id)) return;
    if (e.mode === 3) dmg *= 1.5;      // stunned juggernaut
    e.hp -= dmg;
    e.kx += kx * e.kbres * 3;
    e.ky += ky * e.kbres * 3;
    if (blood) this.ev('hit', e.id, Math.round(e.x), Math.round(e.y), e.tid);
    if (e.hp <= 0) this.killEnemy(e, src);
  }

  killEnemy(e, src) {
    if (!this.enemies.delete(e.id)) return;
    this.totalKills++;
    let pts = e.score * (this.hasMut('gold') ? 2 : 1), mult = 1, pid = 0, luck = 1;
    if (src instanceof Player) {
      src.combo = src.comboT > 0 ? src.combo + 1 : 1;
      src.comboT = src.comboMax;
      src.bestCombo = Math.max(src.bestCombo, src.combo);
      mult = src.mult;
      pts *= mult;
      src.kills++;
      src.score += pts;
      pid = src.id;
      luck = 1 + 0.35 * src.rank('lucky');
      if (src.state === 'alive' && src.rank('vamp')) src.hp = Math.min(src.maxhp, src.hp + src.rank('vamp'));
    }
    this.score += pts;
    this.ev('die', Math.round(e.x), Math.round(e.y), e.tid, pts, mult, pid, Math.round(e.angle * 10), e.id);
    this.checkUnlocks();
    const r = Math.random() / (this.diff.drops * luck);
    if (BOSSES.includes(e.type)) {
      for (let i = 0; i < 5; i++) this.drop(e.x + rand(-30, 30), e.y + rand(-30, 30), i < 3 ? 0 : 1);
      this.dropUpgrades(e.x, e.y, Math.max(1, this.players.size), 50);
    } else if (e.elite) {
      if (Math.random() < 0.12) this.dropUpgrades(e.x, e.y, 1, 0);
      else this.drop(e.x, e.y, Math.random() < 0.6 ? 0 : 1);
    } else if (e.type === 'brute' && Math.random() < 0.05 * this.diff.drops) this.dropUpgrades(e.x, e.y, 1, 0);
    else if (r < 0.085) this.drop(e.x, e.y, 0);
    else if (r < 0.12) this.drop(e.x, e.y, 1);
    if (e.type === 'bloater') this.explode(e.x, e.y, 95, 160, null, 30 * this.diff.dmg);
    else if (this.hasMut('volatile') && e.type !== 'splitling' && Math.random() < 0.35) this.explode(e.x, e.y, 60, 45, null, 8 * this.diff.dmg);
    if (e.type === 'splitter') {
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2;
        const m = this.spawnEnemy('splitling', [e.x + Math.cos(a) * 12, e.y + Math.sin(a) * 12], true);
        m.kx = Math.cos(a) * 150; m.ky = Math.sin(a) * 150;
      }
    }
  }

  // kind: 0 ammo, 1 med-kit, 2 weapon upgrade (u = UPGRADES index), 3 fuel can (mission objective)
  drop(x, y, kind, u = -1) {
    const id = this.newId();
    [x, y] = this.collide(x, y, 8, false);
    this.items.set(id, { id, kind, x, y, u, life: kind === 2 ? 60 : 28 });
  }

  // an upgrade for an unlocked weapon that some player still lacks, preferring ones not already on the floor
  rollUpgrade(taken) {
    const players = [...this.players.values()];
    const opts = UPGRADES.map((u, i) => i).filter(i => this.unlocked >> W_INDEX[UPGRADES[i].w] & 1 && players.some(p => !(p.ups >> i & 1)));
    const fresh = opts.filter(i => !taken.has(i));
    const pool = fresh.length ? fresh : opts;
    return pool.length ? choice(pool) : -1;
  }

  dropUpgrades(x, y, n, spread) {
    const taken = new Set([...this.items.values()].filter(it => it.kind === 2).map(it => it.u));
    for (let k = 0; k < n; k++) {
      const u = this.rollUpgrade(taken);
      if (u < 0) { this.drop(x + rand(-spread, spread), y + rand(-spread, spread), 0); continue; }
      taken.add(u);
      this.drop(x + rand(-spread, spread), y + rand(-spread, spread), 2, u);
    }
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
        for (const p of this.players.values()) p.ammo[i] = Math.max(p.ammo[i], Math.floor(p.ws[i].ammo / 2));
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
    if (this.gen && this.structs.has(this.gen.id)) {
      const i = this.gen.ty * w + this.gen.tx;
      dist[i] = 0;
      heap.push([0, i]);
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
  minionType() {
    if (this.wave > 9 && this.foes.has('sprinter')) return 'sprinter';
    if (this.foes.has('shambler')) return 'shambler';
    return REGULAR.find(t => this.foes.has(t));
  }

  // wave number used for enemy scaling (missions start further along the curve)
  threatWave() { return this.wave + (this.mission ? Math.floor(this.mission.lvl / 2) : 0); }

  eliteChance() {
    const wv = this.threatWave();
    let c = 0;
    if (this.mode === 'gauntlet') c = wv >= 4 ? Math.min(0.12, 0.02 + 0.004 * wv) : 0;
    else if (this.mode === 'missions') c = this.mission.lvl >= 4 ? 0.03 : 0;
    else c = wv >= 15 ? Math.min(0.08, 0.02 + 0.002 * (wv - 15)) : 0;
    return c * (this.hasMut('elite') ? 4 : 1);
  }

  // at: optional [x, y] to spawn there instead of at a gate
  spawnEnemy(type, at = null, noElite = false) {
    let x, y;
    if (at) [x, y] = at;
    else {
      const alive = this.alivePlayers();
      const far = this.spawns.filter(s => alive.every(p => Math.hypot(s[0] - p.x, s[1] - p.y) > 260));
      [x, y] = choice(far.length ? far : this.spawns);
      x += rand(-10, 10); y += rand(-10, 10);
    }
    const n = this.players.size;
    const d = this.diff;
    const boss = BOSSES.includes(type);
    let hpm = d.hp, dmgm = d.dmg, spm = d.speed;
    if (this.hasMut('tough')) hpm *= 1.5;
    if (this.hasMut('swarm')) hpm *= 0.65;
    if (this.hasMut('glass')) { hpm *= 0.6; dmgm *= 1.4; }
    if (this.hasMut('swift')) spm *= 1.25;
    const hpScale = (1 + 0.11 * (this.threatWave() - 1)) * (boss ? 1 + 0.35 * (n - 1) : 1) * hpm;
    const spScale = (1 + Math.min(0.2, 0.012 * (this.threatWave() - 1))) * spm;
    const e = new Enemy(this.newId(), type, x, y, hpScale, spScale, dmgm);
    if (!boss && !noElite && type !== 'splitling' && Math.random() < this.eliteChance()) {
      e.elite = true;
      e.maxhp = e.hp = e.hp * 3;
      e.score *= 3;
      e.speed *= 1.08;
      e.dmg *= 1.25;
      e.r = Math.round(e.r * 1.15);
      e.kbres *= 0.6;
    }
    this.enemies.set(e.id, e);
    return e;
  }

  updateEnemies(dt) {
    const alive = this.alivePlayers();
    const field = this.field, w = this.w;
    const gen = this.gen && this.structs.has(this.gen.id) ? this.gen : null;
    for (const e of [...this.enemies.values()]) {
      if (!this.enemies.has(e.id)) continue;
      if (e.burn > 0) {
        e.burn -= dt;
        this.damageEnemy(e, 20 * dt, e.burnSrc, 0, 0, false);
        if (!this.enemies.has(e.id)) continue;
      }
      if (this.hasMut('regen') && e.hp < e.maxhp) e.hp = Math.min(e.maxhp, e.hp + e.maxhp * 0.03 * dt);
      e.atkCd -= dt;
      let target = null, td = 1e9;
      for (const p of alive) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < td) { target = p; td = d; }
      }
      // the generator draws the horde unless a survivor is much closer
      if (gen && target) {
        const dg = Math.hypot(gen.x - e.x, gen.y - e.y);
        if (dg * 0.6 < td) { target = gen; td = dg; }
      }
      const isP = target instanceof Player;
      const reach = isP ? PR : 16;
      let mx = 0, my = 0, nextStruct = null;
      if (target) {
        const tx = Math.floor(e.x / T), ty = Math.floor(e.y / T);
        let direct = e.type === 'wraith' || (td < 150 && this.los(e.x, e.y, target.x, target.y));
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
      let melee = true;
      // --- type specials
      if (e.type === 'warlock' && target) {
        e.special -= dt;
        if (td < 330 && this.los(e.x, e.y, target.x, target.y)) {
          speed *= td < 240 ? 0.15 : 0.6;
          if (e.special <= 0) {
            e.special = rand(1.8, 2.6);
            this.enemyShot(e, Math.atan2(target.y - e.y, target.x - e.x), 250, 13 * this.diff.dmg);
          }
        }
      } else if (e.type === 'spitter' && target) {
        e.special -= dt;
        if (td < 380 && this.los(e.x, e.y, target.x, target.y)) {
          speed *= td < 260 ? 0.1 : 0.55;
          if (e.special <= 0) {
            e.special = rand(2.6, 3.4);
            this.spit(e, target);
          }
        }
      } else if (e.type === 'shaman' && target) {
        e.special -= dt;
        if (td < 300 && this.los(e.x, e.y, target.x, target.y)) speed *= td < 220 ? 0 : 0.4;
        if (e.special <= 0) {
          e.special = 3.5;
          let healed = false;
          for (const o of this.enemies.values()) {
            if (o === e || o.hp >= o.maxhp || Math.hypot(o.x - e.x, o.y - e.y) > 170) continue;
            o.hp = Math.min(o.maxhp, o.hp + o.maxhp * (BOSSES.includes(o.type) ? 0.04 : 0.3));
            healed = true;
          }
          if (healed) this.ev('heal', Math.round(e.x), Math.round(e.y));
        }
      } else if (e.type === 'leaper' && target) {
        e.special -= dt;
        if (e.mode === 0 && e.special <= 0 && isP && td > 50 && td < 230 && this.los(e.x, e.y, target.x, target.y)) {
          e.mode = 1; e.mt = 0.45;
        }
        if (e.mode === 1) {
          speed = 0;
          e.mt -= dt;
          if (e.mt <= 0) {
            const a = Math.atan2(target.y - e.y, target.x - e.x);
            e.mode = 2; e.mt = 0.34; e.vx = Math.cos(a); e.vy = Math.sin(a); e.hitSet = null;
            e.angle = a;
            this.ev('leap', e.id);
          }
        } else if (e.mode === 2) {
          mx = e.vx; my = e.vy; speed = 430; melee = false;
          e.angle = Math.atan2(my, mx);
          for (const p of alive) {
            if (!e.hitSet && Math.hypot(p.x - e.x, p.y - e.y) < e.r + PR + 4) {
              e.hitSet = true;
              this.hurtPlayer(p, e.dmg * 1.6);
              this.ev('bite', e.id);
            }
          }
          e.mt -= dt;
          if (e.mt <= 0) { e.mode = 0; e.special = rand(2.2, 3.2); e.atkCd = 0.4; }
        }
      } else if (e.type === 'juggernaut' && target) {
        e.special -= dt;
        if (e.mode === 0 && e.special <= 0 && td > 90 && td < 520 && this.los(e.x, e.y, target.x, target.y)) {
          e.mode = 1; e.mt = 0.9;
          this.ev('roar', e.id);
        }
        if (e.mode === 1) {
          speed = 0;
          e.mt -= dt;
          if (e.mt <= 0) {
            const a = Math.atan2(target.y - e.y, target.x - e.x);
            e.mode = 2; e.mt = 1.3; e.vx = Math.cos(a); e.vy = Math.sin(a); e.hitSet = new Set();
            e.angle = a;
          }
        } else if (e.mode === 2) {
          mx = e.vx; my = e.vy; speed = 470; melee = false;
          e.angle = Math.atan2(my, mx);
          for (const p of alive) {
            if (e.hitSet.has(p.id) || Math.hypot(p.x - e.x, p.y - e.y) > e.r + PR + 4) continue;
            e.hitSet.add(p.id);
            this.hurtPlayer(p, e.dmg);
            const side = (p.x - e.x) * -my + (p.y - e.y) * mx >= 0 ? 1 : -1;
            this.shove(p, (mx * 0.5 - my * side) * 70, (my * 0.5 + mx * side) * 70);
          }
          for (const s of [...this.structs.values()]) {
            if (s.type !== 1 && s !== gen && Math.hypot(s.x - e.x, s.y - e.y) < e.r + 22) this.damageStruct(s, 600);
          }
          if (gen && Math.hypot(gen.x - e.x, gen.y - e.y) < e.r + 22 && !e.hitSet.has('gen')) {
            e.hitSet.add('gen');
            this.damageStruct(gen, e.dmg * 4);
          }
          e.mt -= dt;
          const ahead = this.solid(Math.floor((e.x + mx * (e.r + 6)) / T), Math.floor((e.y + my * (e.r + 6)) / T), false);
          if (ahead) { e.mode = 3; e.mt = 1.6; this.ev('slam', Math.round(e.x + mx * e.r), Math.round(e.y + my * e.r)); }
          else if (e.mt <= 0) { e.mode = 0; e.special = rand(3.5, 5); }
        } else if (e.mode === 3) {
          speed = 0; melee = false;
          e.mt -= dt;
          if (e.mt <= 0) { e.mode = 0; e.special = rand(3.5, 5); }
        }
      } else if (e.type === 'colossus' && target) {
        e.special -= dt;
        e.special2 -= dt;
        if (e.special <= 0) {
          e.special = 3.2;
          const off = Math.random();
          for (let k = 0; k < 14; k++) this.enemyShot(e, (k + off) / 14 * Math.PI * 2, 200, 15 * this.diff.dmg, 2);
          this.ev('roar', e.id);
        }
        if (e.special2 <= 0 && this.enemies.size < 90) {
          e.special2 = 9;
          for (let k = 0; k < 3; k++) {
            const m = this.spawnEnemy(this.minionType());
            [m.x, m.y] = this.collide(e.x + rand(-40, 40), e.y + rand(-40, 40), m.r);
          }
          this.ev('sum', Math.round(e.x), Math.round(e.y));
        }
      } else if (e.type === 'bloater' && target && td < e.r + reach + 6) {
        this.killEnemy(e, null);
        continue;
      }
      // --- attack
      if (melee && target && td < e.r + reach + (isP ? 5 : 8) && e.dmg) {
        speed *= 0.2;
        if (e.atkCd <= 0) {
          e.atkCd = e.rate;
          if (isP) this.hurtPlayer(target, e.dmg);
          else this.damageStruct(target, e.dmg);
          this.ev('bite', e.id);
        }
      } else if (melee && nextStruct && e.type !== 'wraith') {
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
    for (const e of this.enemies.values()) {
      if (e.type === 'wraith') {   // drifts through walls, but stays inside the map
        e.x = clamp(e.x, T, (this.w - 1) * T);
        e.y = clamp(e.y, T, (this.h - 1) * T);
      } else [e.x, e.y] = this.collide(e.x, e.y, Math.min(e.r, 15));
    }
  }

  spit(e, target) {
    // lob acid where the target is heading
    const tx = target.x + rand(-20, 20), ty = target.y + rand(-20, 20);
    const d = Math.hypot(tx - e.x, ty - e.y) || 1, speed = 260;
    const id = this.newId();
    this.projs.set(id, { id, kind: 4, x: e.x, y: e.y, vx: (tx - e.x) / d * speed, vy: (ty - e.y) / d * speed,
      life: d / speed, owner: null, dmg: 6 * this.diff.dmg, radius: 0 });
    this.ev('spit', Math.round(e.x), Math.round(e.y));
  }

  addHazard(x, y, dmg) {
    const id = this.newId();
    this.hazards.set(id, { id, x, y, r: 42, life: 4.5, cd: 0.25, dmg });
    this.ev('acid', Math.round(x), Math.round(y));
  }

  updateHazards(dt) {
    for (const h of [...this.hazards.values()]) {
      h.life -= dt;
      if (h.life <= 0) { this.hazards.delete(h.id); continue; }
      h.cd -= dt;
      if (h.cd > 0) continue;
      h.cd = 0.5;
      for (const p of this.alivePlayers()) if (Math.hypot(p.x - h.x, (p.y - h.y) * 1.4) < h.r + PR * 0.5) this.hurtPlayer(p, h.dmg);
    }
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
        if (pr.kind === 0 || pr.kind === 3) { // rocket / bomblet
          let hit = this.solid(tx, ty, false);
          if (!hit) for (const e of this.enemies.values()) if (Math.hypot(e.x - pr.x, e.y - pr.y) < e.r + 6) { hit = true; break; }
          if (hit) { this.detonate(pr); dead = true; }
        } else if (pr.kind === 4) { // acid glob: lobbed, only walls stop it
          if (this.solid(tx, ty, false)) { pr.x -= pr.vx * dt / 3; pr.y -= pr.vy * dt / 3; dead = true; }
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
        if (pr.kind === 4) this.addHazard(pr.x, pr.y, pr.dmg);
        else if (!dead && (pr.kind === 0 || pr.kind === 3)) this.detonate(pr);
        else if (dead && (pr.kind === 1 || pr.kind === 2)) this.ev('pop', Math.round(pr.x), Math.round(pr.y), pr.kind);
        this.projs.delete(pr.id);
      }
    }
  }

  detonate(pr) {
    this.explode(pr.x, pr.y, pr.radius, pr.dmg, pr.owner);
    const sp = Math.hypot(pr.vx, pr.vy) || 1;
    const bx = pr.x - pr.vx / sp * 10, by = pr.y - pr.vy / sp * 10;
    for (let k = 0; k < pr.cluster; k++) {
      const id = this.newId(), a = rand(0, Math.PI * 2), v = rand(140, 260);
      this.projs.set(id, { id, kind: 3, x: bx, y: by, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.35, 0.6),
        owner: pr.owner, dmg: 110, radius: 70, cluster: 0 });
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
            this.explode(s.x, s.y, s.radius, s.dmg, s.owner);
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
          this.fireHitscan(s.owner, -1, s.gun, { ox: s.x, oy: s.y - 4, angle: s.a, owner });
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
        if (it.kind === 3) {
          this.goalV++;
        } else if (it.kind === 2) {
          if (p.ups >> it.u & 1) continue;
          p.ups |= 1 << it.u;
          this.applyPerks(p);
          const wi = W_INDEX[UPGRADES[it.u].w];
          if (p.ammo[wi] >= 0) p.ammo[wi] = Math.max(p.ammo[wi], p.ws[wi].ammo);
        } else if (it.kind === 1) {
          if (p.hp >= p.maxhp) continue;
          p.hp = Math.min(p.maxhp, p.hp + 35);
        } else {
          p.ws.forEach((w, i) => { if (i && this.unlocked >> i & 1) p.ammo[i] = Math.min(w.ammo, p.ammo[i] + w.pickup); });
        }
        this.items.delete(it.id);
        this.ev('pk', p.id, it.kind, Math.round(it.x), Math.round(it.y), it.u);
        if (it.kind === 3 && this.goalV >= this.goal.n) this.win();
        break;
      }
    }
  }

  // ------------------------------------------------------------- waves --
  bossesFor(wv) {
    if (this.mission) return (this.mission.boss && this.mission.boss[wv]) || [];
    const types = BOSSES.filter(t => this.foes.has(t));
    if (wv % 5 !== 0 || !types.length) return [];
    return Array.from({ length: Math.floor(wv / 10) + 1 }, (_, k) => types[(wv / 5 - 1 + k) % types.length]);
  }

  rollMutators() {
    if (this.mission) return [...(this.mission.mut || [])];
    if (this.mode !== 'gauntlet' || this.wave < 3) return [];
    const ids = MUTATORS.map(m => m.id);
    const out = [];
    const n = this.wave >= 12 ? 2 : 1;
    while (out.length < n) {
      const id = choice(ids);
      if (!out.includes(id) && !(id === 'swarm' && out.includes('tough'))) out.push(id);
    }
    return out;
  }

  startWave() {
    const wv = ++this.wave;
    this.mutators = this.rollMutators();
    const ew = this.threatWave();
    const n = Math.max(1, this.players.size);
    const count = Math.floor((10 + ew * 5) * (1 + 0.55 * (n - 1)) * this.diff.count * (this.hasMut('swarm') ? 1.6 : 1));
    const pool = [];
    for (const [type, from, base, per] of SCHEDULE) {
      // missions bring their whole roster from the start
      if (this.foes.has(type) && (this.mission || ew >= from)) pool.push([type, Math.min(1, base + per * ew)]);
    }
    // only late enemy types selected: let them in from wave 1
    if (!pool.length) for (const type of REGULAR) if (this.foes.has(type)) pool.push([type, 1]);
    const bosses = this.bossesFor(wv);
    this.bossWave = bosses.length > 0;
    const q = [];
    for (let i = 0; i < count; i++) {
      let r = Math.random() * pool.reduce((s, p) => s + p[1], 0);
      let pick = pool[0][0];
      for (const [name, wgt] of pool) { r -= wgt; if (r <= 0) { pick = name; break; } }
      q.push(pick);
    }
    bosses.forEach((b, k) => q.splice(Math.floor(q.length / 3) + k * 5, 0, b));
    this.queue = q;
    this.waveState = 'fight';
    this.spawnCd = 1;
    this.ev('wave', wv, bosses.map(b => ENEMY_TYPES.indexOf(b)), this.mutators);
  }

  endWave() {
    const g = this.goal;
    if (g && (g.type === 'waves' || g.type === 'defend') && this.wave >= g.n) { this.win(); return; }
    this.waveState = 'break';
    this.timer = g && g.type === 'holdout' ? 5 : 9;
    this.mutators = this.mission ? this.rollMutators() : [];
    for (const p of this.players.values()) {
      if (p.state !== 'alive') { this.respawn(p); p.hp = Math.min(p.maxhp, 70); } else p.hp = Math.min(p.maxhp, p.hp + 25);
      p.windReady = true;
      this.offerPerk(p);
    }
    if (this.gen && this.structs.has(this.gen.id)) this.gen.hp = Math.min(this.gen.maxhp, this.gen.hp + this.gen.maxhp * 0.2);
    for (let k = 0; k < 2; k++) {
      const [x, y] = choice(this.pspawns);
      this.drop(x + rand(-60, 60), y + rand(-60, 60), k);
    }
    // no boss to drop upgrades: hand them out after every 5th wave instead
    if (this.wave % 5 === 0 && !this.bossWave) {
      const [x, y] = choice(this.pspawns);
      this.dropUpgrades(x, y, Math.max(1, this.players.size), 70);
    }
    this.ev('clear', this.wave);
  }

  updateWaves(dt) {
    if (this.goal && this.goal.type === 'holdout' && this.wave > 0) {
      this.goalV += dt;
      if (this.goalV >= this.goal.secs) { this.win(); return; }
    }
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
    this.updateHazards(dt);
    this.updateItems(dt);
    this.updateWaves(dt);
    this.checkOver();
  }

  objective() {
    const g = this.goal;
    if (!g) return 0;
    if (g.type === 'waves') return ['waves', this.wave, g.n];
    if (g.type === 'defend') return ['defend', this.gen ? Math.max(0, Math.ceil(this.gen.hp / this.gen.maxhp * 100)) : 0, g.n, this.wave];
    if (g.type === 'collect') return ['collect', this.goalV, g.n];
    return ['holdout', Math.max(0, Math.ceil(g.secs - this.goalV)), g.secs];
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
      mu: this.mutators,
      ob: this.objective(),
      p: [...this.players.values()].map(p => [p.id, r1(p.x), r1(p.y), Math.round(p.angle * 100), Math.ceil(p.hp), p.weapon,
        st[p.state], Math.round(p.rev / REVIVE_TIME * 100), p.shooting ? 1 : 0, p.mult, Math.round(p.downT), p.kills, p.score, p.maxhp]),
      // flags: 1 elite, 2|4 mode (wind-up / leap / stunned), 8 shield up
      e: [...this.enemies.values()].map(e => [e.id, e.tid, Math.round(e.x), Math.round(e.y), Math.round(e.angle * 10),
        Math.round(Math.max(0, e.hp) / e.maxhp * 100), e.burn > 0 ? 1 : 0, (e.elite ? 1 : 0) | e.mode << 1 | (e.shield > 0 ? 8 : 0)]),
      pr: [...this.projs.values()].map(p => [p.id, p.kind, Math.round(p.x), Math.round(p.y)]),
      it: [...this.items.values()].map(it => [it.id, it.kind, Math.round(it.x), Math.round(it.y), it.u]),
      st: [...this.structs.values()].map(s => [s.id, s.type, Math.round(s.x), Math.round(s.y), Math.round(s.hp / s.maxhp * 100), Math.round((s.a || 0) * 10)]),
      hz: [...this.hazards.values()].map(h => [h.id, Math.round(h.x), Math.round(h.y), h.r, r1(h.life)]),
      ev: this.events,
    };
  }

  snapshotPrivate(id) {
    const p = this.players.get(id);
    if (!p) return {};
    const me = { am: p.ammo, up: p.ups, k: p.kills, ps: p.score, cb: p.combo, ct: Math.round(Math.max(0, p.comboT) / p.comboMax * 100) };
    if (p.tp) { me.tp = [r1(p.tp[0]), r1(p.tp[1]), p.tpSeq]; p.tp = null; }
    if (p.dirty) {
      p.dirty = false;
      me.ws = p.ws.map(w => [Math.round(w.rate * 1000) / 1000, w.ammo]);
      me.sp = Math.round(p.speed);
      me.pk = p.perks;
      me.po = p.offer || 0;
      me.pp = p.picks;
    }
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
      upgrades: UPGRADES.map(u => ({ w: W_INDEX[u.w], name: u.name, desc: u.desc, rate: u.mod.rate, ammo: u.mod.ammo })),
      enemies: ENEMY_TYPES,
      diff: this.diff.name,
      speed: PLAYER_SPEED,
      pr: PR,
      mode: this.mode,
      mission: this.mission ? { idx: this.missionIdx, name: this.mission.name, desc: this.mission.desc } : null,
      perks: PERKS,
      mutators: MUTATORS,
    };
  }
}
