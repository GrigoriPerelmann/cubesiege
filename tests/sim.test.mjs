// Tests for the simulation, the room host and the balance metric. No dependencies.
// In a browser: python3 -m http.server 8000   then open http://localhost:8000/tests/
// With Node:    node tests/sim.test.mjs
import { Game, MISSIONS, WEAPONS, UPGRADES, getMap, mapList, isMap, weaponStats, loadoutStats } from '../public/js/sim.js';
import { Host } from '../public/js/host.js';
import { paperReport, findIssues, wpiTable, maskFor } from '../public/js/balance.js';
import { botTick, runGoal, runUse } from '../public/js/bot.js';

const T = 32, DT = 1 / 30;
const W = Object.fromEntries(WEAPONS.map((w, i) => [w.id, i]));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function ok(c, msg = 'expected true') { if (!c) throw new Error(msg); }
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`); }
function near(a, b, tol, msg = '') { if (Math.abs(a - b) > tol) throw new Error(`${msg} expected ${b} +-${tol}, got ${a}`); }

const missionIdx = name => MISSIONS.findIndex(m => m.name === name);

// an empty, calm arena: two players side by side, far from everything
function arena(ff = 'off', n = 2) {
  const g = new Game('depot', { mode: 'classic', ff, foes: ['shambler'] });
  g.timer = 1e9;
  const ps = [];
  for (let i = 0; i < n; i++) {
    const p = g.addPlayer(i + 1, `P${i}`, '#fff');
    p.x = 23 * T; p.y = (15 + i * 0) * T;
    ps.push(p);
  }
  // open floor row for shots along +x
  return { g, ps };
}
const put = (p, x, y) => { p.x = x; p.y = y; };
function fire(g, p, weapon, ticks = 1) {
  p.weapon = weapon; p.trigger = true; p.fireCd = 0; p.ammo[weapon] = 99;
  for (let i = 0; i < ticks; i++) g.tick(DT);
  p.trigger = false;
}
function openSpot(g) {  // two free spots in a line along +x, with no solid tile between
  for (let y = 3; y < g.h - 3; y++) for (let x = 3; x < g.w - 12; x++) {
    let free = true;
    for (let k = -1; k <= 10 && free; k++) for (const oy of [-1, 0, 1]) if (g.solid(x + k, y + oy)) free = false;
    if (free && !g.spawns.some(s => Math.hypot(s[0] - x * T, s[1] - y * T) < 100)) return [(x + 0.5) * T, (y + 0.5) * T];
  }
  throw new Error('no open spot');
}

// ------------------------------------------------------------ friendly fire
test('FF off: bullets, flames and rockets ignore teammates', () => {
  const { g, ps: [a, b] } = arena('off');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 60, y); a.angle = 0;
  fire(g, a, W.pistol); fire(g, a, W.flame);
  g.unlocked = -1;
  fire(g, a, W.rocket, 30);
  eq(b.hp, 100, 'teammate hp'); eq(a.hp, 100, 'own hp'); eq(a.ffDealt, 0);
});
test('FF light: a bullet does 25%, full does 100%', () => {
  for (const [ff, want] of [['light', 26 * 0.25], ['full', 26]]) {
    const { g, ps: [a, b] } = arena(ff);
    const [x, y] = openSpot(g);
    put(a, x, y); put(b, x + 60, y); a.angle = 0;
    a.ws[0].spread = 0;
    fire(g, a, W.pistol);
    near(100 - b.hp, want, 0.01, ff);
    near(a.ffDealt, want, 0.01, 'ffDealt');
  }
});
test('FF: a teammate stops the bullet, an enemy behind them is safe', () => {
  const { g, ps: [a, b] } = arena('full');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 60, y); a.angle = 0; a.ws[0].spread = 0;
  const e = g.spawnEnemy('shambler', [x + 150, y]);
  const hp = e.hp;
  fire(g, a, W.pistol);
  eq(e.hp, hp, 'enemy behind teammate');
  ok(b.hp < 100);
});
test('FF: an enemy in front of the teammate takes the bullet', () => {
  const { g, ps: [a, b] } = arena('full');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 180, y); a.angle = 0; a.ws[0].spread = 0;
  const e = g.spawnEnemy('shambler', [x + 80, y]);
  const hp = e.hp;
  fire(g, a, W.pistol);
  ok(e.hp < hp, 'enemy should be hit'); eq(b.hp, 100, 'teammate behind enemy');
});
test('FF: piercing railgun hits the teammate and the enemy behind', () => {
  const { g, ps: [a, b] } = arena('light');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 60, y); a.angle = 0; g.unlocked = -1;
  const e = g.spawnEnemy('brute', [x + 150, y]);
  const hp = e.hp;
  fire(g, a, W.rail);
  ok(e.hp < hp); near(100 - b.hp, a.ws[W.rail].dmg * 0.25, 0.01);
});
test('FF: your own rocket hurts you and teammates, flamethrower hits teammates', () => {
  const { g, ps: [a, b] } = arena('light');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 100, y); a.angle = 0; g.unlocked = -1;
  fire(g, a, W.flame);
  ok(b.hp < 100, 'flame'); b.hp = 100;
  g.explode(a.x, a.y, 100, 200, a);
  ok(a.hp < 100, 'self blast'); ok(b.hp < 100, 'mate in blast');
});
test('FF: sentries never hit friends', () => {
  const { g, ps: [a, b] } = arena('full');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 60, y);
  const e = g.spawnEnemy('brute', [x + 150, y]);
  e.speed = 0;
  g.fireHitscan(a, -1, { ...WEAPONS[W.rifle], dmg: 15, spread: 0, kb: 0, pellets: 1, range: 400 }, { ox: x, oy: y, angle: 0, owner: a });
  eq(b.hp, 100);
});
test('FF: shooting a teammate down names the shooter', () => {
  const { g, ps: [a, b] } = arena('full');
  const [x, y] = openSpot(g);
  put(a, x, y); put(b, x + 60, y); a.angle = 0; a.ws[0].spread = 0; b.hp = 5;
  fire(g, a, W.pistol);
  eq(b.state, 'down');
  ok(g.events.some(e => e[0] === 'down' && e[1] === b.id && e[2] === a.id), 'event names the shooter');
});

// ------------------------------------------------------------- boxing in
function boxIn(g, p) {
  const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T), out = [];
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (!ox && !oy) continue;
    const id = g.newId(), hp = 450;
    const s = { id, type: 0, x: (tx + ox + 0.5) * T, y: (ty + oy + 0.5) * T, tx: tx + ox, ty: ty + oy, hp, maxhp: hp, owner: p, a: 0, cd: 0, ammo: 0, life: 60, lifeMax: 60 };
    g.structs.set(id, s); g.structAt.set(s.ty * g.w + s.tx, s); out.push(s);
  }
  return out;
}
test('box: a walled-in player is detected and can dig out alone during a break', () => {
  const { g, ps: [a] } = arena('off', 1);
  const [x, y] = openSpot(g);
  put(a, x, y);
  boxIn(g, a);
  for (let i = 0; i < 40; i++) g.tick(DT);
  ok(a.sealed, 'should be sealed');
  // the player can't walk out
  let wx = a.x;
  for (let i = 0; i < 20; i++) [wx] = g.collide(wx + 4, a.y, 11);
  ok(wx < a.x + 12, 'wall holds');
  a.use = true;
  for (let i = 0; i < 40; i++) g.tick(DT);
  a.use = false;
  for (let i = 0; i < 40; i++) g.tick(DT);
  ok(g.structs.size < 8, 'took a wall down');
});
test('box: every wall comes down with the key held, then the player is free', () => {
  const { g, ps: [a] } = arena('off', 1);
  const [x, y] = openSpot(g);
  put(a, x, y);
  boxIn(g, a);
  a.use = true;
  for (let i = 0; i < 30 * 8; i++) g.tick(DT);
  a.use = false;
  for (let i = 0; i < 30; i++) g.tick(DT);
  eq(g.structs.size, 0); ok(!a.sealed, 'no longer sealed');
});
test('box: dismantling refunds only like-new structures', () => {
  const { g, ps: [a] } = arena('off', 1);
  g.unlocked = -1;
  const [x, y] = openSpot(g);
  put(a, x, y); a.ammo[W.barricade] = 2; a.ammo[W.sentry] = 1;
  const mk = (type, hp, life) => {
    const id = g.newId();
    const s = { id, type, x: x + 30, y, tx: Math.floor((x + 30) / T), ty: Math.floor(y / T), hp, maxhp: 450, owner: a, a: 0, life, lifeMax: 60 };
    g.structs.set(id, s); return s;
  };
  g.dismantle(a, mk(0, 450, 60)); eq(a.ammo[W.barricade], 3, 'fresh barricade');
  g.dismantle(a, mk(0, 200, 60)); eq(a.ammo[W.barricade], 3, 'worn barricade');
  g.dismantle(a, mk(2, 450, 58)); eq(a.ammo[W.sentry], 2, 'fresh sentry');
  g.dismantle(a, mk(2, 450, 20)); eq(a.ammo[W.sentry], 2, 'old sentry is no refresh trick');
});
test('box: undead break walls faster the longer the team stays sealed', () => {
  const { g } = arena('off', 1);
  g.siege = 0; eq(g.siegeMult(), 1);
  g.siege = 10; eq(g.siegeMult(), 1);
  g.siege = 20; eq(g.siegeMult(), 2);
  g.siege = 99; eq(g.siegeMult(), 3);
});
test('box: fuel cans cannot be built over', () => {
  const g = new Game('depot', { mode: 'missions', mission: missionIdx('Scavenger Run') });
  const p = g.addPlayer(1, 'a', '#fff');
  const can = [...g.items.values()].find(i => i.kind === 3);
  put(p, can.x - 34, can.y); p.angle = 0;
  g.unlocked = -1;
  ok(!g.place(p, p.ws[W.barricade]), 'should refuse');
});
test('box: the interact key doubles as nothing when there is nothing near', () => {
  const { g, ps: [a] } = arena('off', 1);
  const [x, y] = openSpot(g);
  put(a, x, y); a.use = true; g.tick(DT);
  eq(a.useK, 0); ok(!a.busy, 'free to fire');
});

// ------------------------------------------------------------- maps
test('maps: Breakthrough maps stay out of the picker', () => {
  const ids = mapList().map(m => m.id);
  eq(ids.length, 5);
  for (const m of MISSIONS) if (m.zones) { ok(!ids.includes(m.map), m.map); ok(!isMap(m.map), 'host must refuse it'); }
});
for (const ms of MISSIONS.filter(m => m.zones)) {
  test(`maps: ${ms.map} has the right shape and every spot is reachable`, () => {
    const m = getMap(ms.map);
    eq(m.zones.length, ms.zones.length, 'zones vs mission');
    ok(m.rows.every(r => r.length === m.w), 'row width');
    // walk the whole map with all doors open
    const solid = (x, y) => x < 0 || y < 0 || x >= m.w || y >= m.h || '#BT'.includes(m.rows[y][x]);
    const [sx, sy] = m.zones[0].entry, seen = new Set([`${sx},${sy}`]), q = [[sx, sy]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const k = `${nx},${ny}`;
        if (!solid(nx, ny) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
      }
    }
    m.zones.forEach((z, i) => {
      for (const [x, y] of [z.entry, z.exit, ...z.anchors]) {
        ok(seen.has(`${x},${y}`), `zone ${i} spot ${x},${y} unreachable`);
        ok(!solid(x, y), `zone ${i} spot ${x},${y} solid`);
      }
      if (z.door) ok(m.rows[z.door.y][z.door.x] === 'D', `zone ${i} door`);
      // doors really are the only way through
      let holes = 0;
      if (z.door) for (let y = 0; y < m.h; y++) if (!'#'.includes(m.rows[y][z.x1 + 1]) && m.rows[y][z.x1 + 1] !== 'D') holes++;
      eq(holes, 0, `zone ${i} wall holes`);
    });
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.rows[y][x] === 'S') ok(seen.has(`${x},${y}`), `gate ${x},${y}`);
  });
}

// ------------------------------------------------------------- zones
const run = (name, n = 1, opts = {}) => {
  const g = new Game('depot', { mode: 'missions', mission: missionIdx(name), ...opts });
  for (let i = 0; i < n; i++) g.addPlayer(i + 1, `P${i}`, '#fff');
  return g;
};
const untilFight = g => { g.timer = 0; g.tick(DT); };
test('zones: doors block walking, bullets and pathing until opened', () => {
  const g = run('Breach');
  const d = g.zones[0].door, tx = d.x, ty = d.y + 2;
  ok(g.solid(tx, ty), 'door solid');
  ok(!g.los((tx - 1) * T, (ty + 0.5) * T, (tx + 3) * T, (ty + 0.5) * T), 'blocks sight');
  g.buildField();
  eq(g.field[ty * g.w + tx + 3], 1e9, 'no path past it');
  g.openDoor(0);
  ok(!g.solid(tx, ty), 'open');
  g.buildField();
  ok(g.field[ty * g.w + tx + 3] < 1e9, 'path now');
  eq(g.snapshotCommon().dm, 1, 'clients are told');
});
test('zones: undead only spawn in the active zone', () => {
  const g = run('Breach');
  untilFight(g);
  for (let i = 0; i < 300; i++) { g.tick(DT); g.players.get(1).hp = 100; }
  const z = g.zones[0];
  ok(g.enemies.size > 0, 'something spawned');
  for (const e of g.enemies.values()) ok(e.x < (z.x1 + 1) * T, `enemy past the door at ${e.x}`);
});
test('zones: wraiths cannot drift past a closed door', () => {
  const g = run('Consecrate');
  untilFight(g);
  const z = g.zones[0];
  const e = g.spawnEnemy('wraith', [(z.x1 - 1) * T, 5 * T]);
  e.kx = 4000;
  for (let i = 0; i < 30; i++) { g.tick(DT); g.players.get(1).hp = 100; }
  if (g.enemies.has(e.id)) ok(e.x <= (z.x1 + 1) * T, `wraith at ${e.x}`);
});
test('zones: finishing a zone opens the door, revives, offers a perk and waits for the team', () => {
  const g = run('Breach', 2);
  const [a, b] = g.humans();
  untilFight(g);
  a.state = 'dead'; b.hp = 50;
  g.queue = []; g.enemies.clear();
  g.tick(DT);
  eq(g.doorMask & 1, 1, 'door open'); eq(g.zoneI, 1); eq(g.waveState, 'break');
  eq(a.state, 'alive', 'revived'); ok(a.x < g.zones[1].x0 * T, 'respawned on the near side');
  ok(Math.hypot(a.x - g.zones[0].door.x * T, a.y - (g.zones[0].door.y + 2.5) * T) < 200, 'close to the door');
  ok(a.offer || a.picks, 'perk offered');
  // nothing happens until someone walks through
  for (let i = 0; i < 90; i++) g.tick(DT);
  eq(g.waveState, 'break', 'still calm');
});
test('zones: walking through the door wakes the next zone', () => {
  const g = run('Breach');
  const p = g.humans()[0];
  untilFight(g);
  g.queue = []; g.enemies.clear(); g.tick(DT);
  eq(g.waveState, 'break');
  const z = g.zones[1];
  put(p, (z.entry[0] + 0.5) * T, (z.entry[1] + 0.5) * T);
  g.tick(DT);
  eq(g.waveState, 'fight'); eq(g.task.type, 'nests');
});
test('zones: the calm ends by itself so nobody can stall forever', () => {
  const g = run('Breach');
  untilFight(g);
  g.queue = []; g.enemies.clear(); g.tick(DT);
  const p = g.humans()[0];
  put(p, (g.zones[0].x0 + 3) * T, (g.zones[0].entry[1] + 0.5) * T);
  g.timer = 0.01;
  g.tick(DT);
  eq(g.waveState, 'fight');
});
function toTask(g, zi, ti) {
  // jump straight to a given zone and task
  while (g.zoneI < zi) { g.openDoor(g.zoneI); g.zoneI++; }
  g.waveState = 'fight'; g.spawns = g.spawnsIn(zi); g.setEntry(zi);
  g.wave = zi + 1; g.taskI = ti - 1; g.queue = []; g.enemies.clear();
  g.nextTask();
  for (const p of g.humans()) { const [x, y] = g.pspawns[0]; put(p, x, y); }
  return g.task;
}
test('task nests: rooted, hatch undead, count down as they die', () => {
  const g = run('Breach');
  const t = toTask(g, 1, 0);
  eq(t.type, 'nests'); eq(g.nestIds.size, 3);
  const n = g.enemies.get([...g.nestIds][0]), hx = n.x;
  n.kx = 500;
  const before = g.enemies.size;
  for (let i = 0; i < 300; i++) { g.tick(DT); for (const p of g.humans()) p.hp = 100; }
  eq(n.x, hx, 'stays put'); ok(g.enemies.size > before, 'hatches');
  for (const id of [...g.nestIds]) g.killEnemy(g.enemies.get(id), g.humans()[0]);
  g.tick(DT);
  ok(g.task !== t, 'task finished');
});
test('task hack: progress needs the key, hands are busy, progress decays when left alone', () => {
  const g = run('Breach', 2);
  const t = toTask(g, 2, 0);
  eq(t.type, 'hack');
  const s = g.sites[0], [a] = g.humans();
  put(a, s.x + 30, s.y);
  g.tick(DT); eq(a.useK, 2, 'prompt'); eq(s.prog, 0);
  a.use = true; a.trigger = true; a.fireCd = 0;
  const sc = a.ammo[0];
  for (let i = 0; i < 60; i++) { g.tick(DT); a.hp = 100; }
  ok(s.prog > 1.5, 'progress'); ok(a.busy, 'busy'); ok(!a.shooting, 'cannot fire'); eq(sc, a.ammo[0]);
  a.use = false; a.trigger = false;
  const p0 = s.prog;
  for (let i = 0; i < 30; i++) { g.tick(DT); a.hp = 100; }
  ok(s.prog < p0, 'decays'); ok(s.prog > 0, 'only slowly');
});
test('task fuel: carrying locks you to the pistol and slows you, downing drops it, delivery counts', () => {
  const g = run('Fuel Line', 2);
  const t = toTask(g, 0, 0);
  eq(t.type, 'fuel');
  const p = g.humans()[0], can = [...g.items.values()].find(i => i.kind === 5), gen = g.sites[0];
  const speed = p.speed;
  p.weapon = W.shotgun;
  put(p, can.x, can.y);
  g.tick(DT);
  ok(p.carry, 'picked up'); eq(p.weapon, 0, 'pistol'); near(p.speed, speed * 0.8, 0.01, 'speed');
  g.handleInput(1, { x: p.x, y: p.y, a: 0, w: W.shotgun });
  eq(p.weapon, 0, 'input cannot switch');
  const cans = () => [...g.items.values()].filter(i => i.kind === 5).length;
  const before = cans();
  g.hurtPlayer(p, 1000);
  ok(!p.carry, 'dropped'); eq(cans(), before + 1, 'can on the floor');
  p.state = 'alive'; p.hp = 100; p.carry = true;
  put(p, gen.x + 10, gen.y);
  g.tick(DT);
  ok(!p.carry); eq(gen.prog, 1, 'delivered'); near(p.speed, speed, 0.01, 'speed back');
});
test('task hold: needs someone in the circle', () => {
  const g = run('Consecrate');
  const t = toTask(g, 1, 0);
  eq(t.type, 'hold');
  const s = g.sites[0], p = g.humans()[0];
  put(p, (g.zones[1].x0 + 2) * T, s.y);
  if (Math.hypot(p.x - s.x, p.y - s.y) < s.r) p.x += 400;
  g.tick(DT); eq(s.prog, 0, 'outside');
  put(p, s.x, s.y);
  for (let i = 0; i < 30; i++) { g.tick(DT); p.hp = 100; }
  ok(s.prog > 0.9, 'inside');
});
test('task charge: the door blows when time is up, losing it fails the mission', () => {
  let g = run('Fuel Line');
  let t = toTask(g, 2, 0);
  eq(t.type, 'charge');
  const site = g.sites[0];
  ok(g.gen, 'charge placed');
  site.prog = site.need - 0.01;
  g.tick(DT);
  eq(g.zoneI, 3, 'next zone'); ok(!g.over, 'not a loss'); eq(g.gen, null);
  g = run('Fuel Line');
  toTask(g, 2, 0);
  g.damageStruct(g.gen, 1e6);
  ok(g.over); ok(!g.won); ok(g.lost.includes('charge'), g.lost);
});
test('task boss: door stays shut until the boss is dead', () => {
  const g = run('Fuel Line');
  const t = toTask(g, 3, 0);
  eq(t.type, 'boss'); eq(g.bossIds.size, 1);
  for (let i = 0; i < 30; i++) { g.tick(DT); g.humans()[0].hp = 100; }
  eq(g.task, t, 'still on boss');
  g.killEnemy(g.enemies.get([...g.bossIds][0]), g.humans()[0]);
  g.tick(DT);
  eq(g.task.type, 'extract');
});
test('task extract: needs every standing survivor inside, then wins', () => {
  const g = run('Breach', 2);
  const t = toTask(g, 2, 1);
  eq(t.type, 'extract');
  const s = g.sites[0], [a, b] = g.humans();
  put(a, s.x, s.y);
  put(b, s.x - 400, s.y);
  for (let i = 0; i < 30; i++) { g.tick(DT); a.hp = b.hp = 100; }
  eq(s.prog, 0, 'b is outside');
  put(b, s.x + 10, s.y);
  s.prog = s.need - 0.05;
  g.tick(DT); g.tick(DT);
  ok(g.won, 'won');
});
test('extract: a downed survivor does not hold up the rest', () => {
  const g = run('Breach', 2);
  toTask(g, 2, 1);
  const s = g.sites[0], [a, b] = g.humans();
  put(a, s.x, s.y);
  b.state = 'down'; b.downT = 25;
  put(b, s.x - 400, s.y);
  for (let i = 0; i < 30; i++) { g.tick(DT); a.hp = 100; }
  ok(s.prog > 0.5);
});

// --------------------------------------------------------------- VIP
test('vip: not a player for scaling, drops or results', () => {
  const g = run('Dr. Block', 1);
  ok(g.vip); eq(g.players.size, 2); eq(g.humanCount(), 1);
  eq(g.stats().length, 1); eq(g.humans().length, 1);
  g.choosePerk(g.vip.id, 0);
  const si = g.startInfo();
  eq(si.vip.name, 'Dr. Block');
});
test('vip: follows the nearest survivor and walks through barricades', () => {
  const g = run('Dr. Block');
  const p = g.humans()[0], v = g.vip;
  untilFight(g); g.queue = []; g.spawnCd = 1e9;
  put(p, (g.zones[0].x0 + 15) * T + 16, (g.zones[0].entry[1] + 0.5) * T);
  const d0 = Math.hypot(p.x - v.x, p.y - v.y);
  for (let i = 0; i < 150; i++) g.tick(DT);
  ok(Math.hypot(p.x - v.x, p.y - v.y) < d0 - 100, 'moved closer');
});
test('vip: bleeding out fails the mission, and a survivor can revive them', () => {
  let g = run('Dr. Block');
  const v = g.vip, p = g.humans()[0];
  g.hurtPlayer(v, 1e4); eq(v.state, 'down'); ok(!g.over, 'still in it');
  put(p, v.x + 20, v.y);
  for (let i = 0; i < 90; i++) g.tick(DT);
  eq(v.state, 'alive', 'revived');
  g = run('Dr. Block');
  g.hurtPlayer(g.vip, 1e4);
  put(g.humans()[0], g.vip.x + 400, g.vip.y);
  g.vip.downT = 0.01;
  g.tick(DT);
  ok(g.over); ok(!g.won); ok(g.lost.includes('Dr. Block'));
});
test('vip: the team wiping still ends the game with the doctor alive', () => {
  const g = run('Dr. Block');
  const p = g.humans()[0];
  p.state = 'dead';
  g.checkOver();
  ok(g.over);
});
test('task fix: Dr. Block works the door, undead next to them stall it', () => {
  const g = run('Dr. Block');
  let t = toTask(g, 0, 1);
  eq(t.type, 'fix');
  const s = g.sites[0], v = g.vip;
  g.spawnCd = 1e9;
  put(v, s.x, s.y);
  for (let i = 0; i < 30; i++) g.tick(DT);
  ok(s.prog > 0.8, 'working');
  const e = g.spawnEnemy('shambler', [v.x + 10, v.y]);
  const p0 = s.prog;
  e.dmg = 0;
  g.tick(DT);
  eq(s.prog, p0, 'stalled'); ok(s.stalled);
  eq(g.objective()[5], 1, 'HUD knows');
});

// ------------------------------------------------------------ whole game
test('play: four bots can finish every Breakthrough mission on Easy', () => {
  for (const ms of MISSIONS.filter(m => m.zones)) {
    let won = false;
    for (let tries = 0; tries < 8 && !won; tries++) {
      const g = run(ms.name, 4, { diff: 'easy' });
      let t = 0;
      while (!g.over && t < 900) {
        for (const p of g.humans()) {
          if (p.offer) g.choosePerk(p.id, 0);
          let wi = 0;
          for (let i = p.ws.length - 1; i >= 0; i--) if (g.unlocked >> i & 1 && p.ws[i].kind !== 'place' && p.ammo[i] !== 0) { wi = i; break; }
          const goal = runGoal(g, p, p.id);
          botTick(g, p, DT, { goal, weapon: wi, kite: goal ? 0.6 : 1 });
          runUse(g, p);
        }
        g.tick(DT);
        t += DT;
      }
      ok(t < 900, `${ms.name} stalled in zone ${g.zoneI} on ${g.task && g.task.type}`);
      won = g.won;
    }
    ok(won, `${ms.name} never won`);
  }
});
test('play: the Siege missions and endless modes still run', () => {
  for (const opts of [{ mode: 'classic' }, { mode: 'gauntlet' }, { mode: 'missions', mission: 1 }, { mode: 'missions', mission: 2 }, { mode: 'missions', mission: 5 }]) {
    const g = new Game('depot', opts);
    const p = g.addPlayer(1, 'b', '#fff');
    for (let i = 0; i < 30 * 60 && !g.over; i++) {
      if (p.offer) g.choosePerk(1, 0);
      botTick(g, p, DT, { weapon: 0 });
      g.tick(DT);
      JSON.stringify(g.snapshotCommon()); g.events = [];
      g.snapshotPrivate(1);
    }
    ok(g.time > 5);
  }
});

// ------------------------------------------------------------------ host
function fakeHost() {
  const h = new Host('ABCD', 'depot');
  const inbox = [];
  const c1 = h.addClient(s => inbox.push(['a', JSON.parse(s)]));
  const c2 = h.addClient(s => inbox.push(['b', JSON.parse(s)]));
  h.receive(c1, { t: 'hello', name: 'A' }); h.receive(c1, { t: 'join' });
  h.receive(c2, { t: 'hello', name: 'B' }); h.receive(c2, { t: 'join' });
  return { h, c1, c2, inbox };
}
test('host: FF setting comes from the host only, and reaches the game', () => {
  const { h, c1, c2 } = fakeHost();
  h.receive(c2, { t: 'cfg', ff: 'full' }); eq(h.ff, 'off', 'guest ignored');
  h.receive(c1, { t: 'cfg', ff: 'nonsense' }); eq(h.ff, 'off', 'bad value');
  h.receive(c1, { t: 'cfg', ff: 'light' }); eq(h.ff, 'light');
  h.receive(c1, { t: 'start' });
  eq(h.game.ffMult, 0.25);
  h.stop();
});
test('host: only the host can end or restart, and ending reports a stopped round', () => {
  const { h, c1, c2, inbox } = fakeHost();
  h.receive(c1, { t: 'start' });
  const g = h.game;
  h.receive(c2, { t: 'end' }); eq(h.state, 'game', 'guest cannot end');
  h.receive(c2, { t: 'restart' }); eq(h.game, g, 'guest cannot restart');
  h.receive(c1, { t: 'restart' });
  ok(h.game !== g, 'new game'); eq(h.state, 'game'); eq(h.game.players.size, 2);
  h.receive(c1, { t: 'end' });
  eq(h.state, 'lobby'); eq(h.game, null);
  const over = inbox.filter(m => m[1].t === 'over');
  eq(over.length, 2, 'both told'); ok(over[0][1].stopped); ok(!over[0][1].won);
  h.stop();
});
test('host: pausing takes an explicit state and restart clears it', () => {
  const { h, c1, c2 } = fakeHost();
  h.receive(c1, { t: 'start' });
  h.receive(c2, { t: 'pause', on: true }); eq(h.paused, false, 'guest');
  h.receive(c1, { t: 'pause', on: true }); eq(h.paused, true);
  h.receive(c1, { t: 'pause', on: true }); eq(h.paused, true, 'idempotent');
  h.receive(c1, { t: 'restart' }); eq(h.paused, false);
  h.stop();
});
test('host: refuses a Breakthrough map as a free-play map', () => {
  const { h, c1 } = fakeHost();
  h.receive(c1, { t: 'map', map: 'run_yard' });
  eq(h.mapId, 'depot');
  h.stop();
});
test('host: leaving mid-mission with fuel in hand puts the can back', () => {
  const g = run('Fuel Line', 2);
  toTask(g, 0, 0);
  const [a] = g.humans(), n = [...g.items.values()].filter(i => i.kind === 5).length;
  a.carry = true;
  g.removePlayer(a.id);
  eq([...g.items.values()].filter(i => i.kind === 5).length, n + 1);
});

// --------------------------------------------------------------- balance
test('balance: the pistol stays the weakest gun in every situation', () => {
  for (const s of paperReport().scenarios) {
    const min = Math.min(...s.rows.slice(1).map(r => r.wpi));
    ok(s.rows[0].wpi < min, `${s.name}: pistol ${s.rows[0].wpi.toFixed(0)} vs ${min.toFixed(0)}`);
  }
});
test('balance: a fully upgraded pistol loses to a fully upgraded SMG and to most stock guns', () => {
  const up = wpiTable({}, true), by = Object.fromEntries(up.map(r => [r.id, r.wpi]));
  ok(by.pistol < by.smg);
  const stock = Object.fromEntries(wpiTable({}, false).map(r => [r.id, r.wpi]));
  ok(by.pistol < stock.rifle); ok(by.pistol < stock.flame);
});
test('balance: Trigger Finger helps guns with magazines as much as the pistol', () => {
  const stock = wpiTable(), tf = wpiTable({ trigger: 3 });
  stock.forEach((r, i) => near(tf[i].wpi / r.wpi, 1.36, 0.08, r.id));
});
test('balance: the score does not slip and nothing is flagged', () => {
  const r = paperReport();
  ok(r.score >= 80, `score ${r.score.toFixed(1)}`);
  const fails = findIssues(r).filter(i => i.level === 'fail');
  eq(fails.length, 0, JSON.stringify(fails));
});
test('balance: upgrades stack by multiplying', () => {
  const both = maskFor('rifle');
  const w = weaponStats(both)[W.rifle];
  near(w.dmg, WEAPONS[W.rifle].dmg * 0.65 * 1.4, 0.001); ok(w.pierce);
  const all = loadoutStats((1 << UPGRADES.length) - 1, { guns: 5, trigger: 3, pockets: 2, demo: 2 });
  for (const s of all) for (const k of ['dmg', 'rate', 'ammo', 'range', 'radius']) if (s[k] !== undefined) ok(Number.isFinite(s[k]), `${s.id}.${k}`);
});

// ---------------------------------------------------------------- runner
export async function runAll(log = console.log, filter = '') {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (filter && !name.includes(filter)) continue;
    try {
      fn();
      pass++;
      log(`ok    ${name}`);
    } catch (e) {
      fail++;
      log(`FAIL  ${name}\n      ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 0));
  }
  log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('sim.test.mjs')) {
  runAll(console.log, process.argv[2] || '').then(f => process.exit(f ? 1 : 0));
}
