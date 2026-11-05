// Balance metric for the arsenal. Two independent measurements:
//
//  PAPER: the Weapon Power Index (WPI). Fires each weapon at fixed targets using the game's real stats
//  and spread rules, then blends three numbers (see wpi()). Instant and repeatable. 100 = stock pistol.
//
//  FIELD: bots play real rounds in the real game engine with one weapon each, and we see which wave they
//  reach. Noisy and slower, but it includes everything the paper model leaves out (riot shields,
//  knockback, running out of ammo mid-fight).
//
// The paper numbers give the Balance Score out of 100. The field test doesn't change the score: it is there
// to catch the paper model being wrong. See README, "Balance metric".
import { Game, WEAPONS, UPGRADES, PERKS, FOE_TYPES, BOSSES, loadoutStats } from './sim.js';
import { botTick } from './bot.js';

const GUNS = WEAPONS.filter(w => w.kind === 'hit' || w.kind === 'flame' || w.kind === 'proj').map(w => w.id);
const IDX = Object.fromEntries(WEAPONS.map((w, i) => [w.id, i]));
const BURN_DPS = 20;             // keep in step with updateEnemies
const TARGET_R = 12;             // shambler-sized target
const WINDOW = 60;               // length of the "sustained" fight, seconds
const CRATE_EVERY = 20;          // ammo crates reaching you during that fight, seconds apart

export const maskFor = wid => UPGRADES.reduce((m, u, i) => (u.w === wid ? m | 1 << i : m), 0);

// Situations every weapon is compared in. "own" = each weapon has all of its own upgrades.
export const SCENARIOS = [
  { id: 'stock', name: 'Stock', perks: {}, own: false, weight: 3 },
  { id: 'trigger', name: 'Trigger Finger x3', perks: { trigger: 3 }, own: false, weight: 2, perk: true },
  { id: 'guns', name: 'Big Guns x5', perks: { guns: 5 }, own: false, weight: 2, perk: true },
  { id: 'pockets', name: 'Deep Pockets x2', perks: { pockets: 2 }, own: false, weight: 1, perk: true },
  { id: 'both', name: 'Trigger x3 + Guns x5', perks: { trigger: 3, guns: 5 }, own: false, weight: 2 },
  { id: 'upgrades', name: 'All upgrades', perks: {}, own: true, weight: 3 },
  { id: 'allin', name: 'Upgrades + all perks', perks: { trigger: 3, guns: 5, pockets: 2 }, own: true, weight: 2 },
];

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hordeAt(dist, rnd) {
  const out = [];
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 120;
    out.push({ x: dist + Math.cos(a) * r, y: Math.sin(a) * r, r: TARGET_R });
  }
  return out;
}

// Average damage from one shot/tick against these targets, using the same rules as Game.fireHitscan,
// fireFlame and explode. The shooter stands at the origin aiming along +x.
function shotDamage(w, targets, rnd, samples = 160) {
  let total = 0;
  for (let s = 0; s < samples; s++) {
    const burned = new Set();
    if (w.kind === 'hit') {
      const n = w.pellets;
      for (let k = 0; k < n; k++) {
        const a = n > 1 ? (k / (n - 1) - 0.5) * w.spread * 2 + (rnd() * 2 - 1) * 0.04 : (rnd() * 2 - 1) * w.spread;
        const dx = Math.cos(a), dy = Math.sin(a), hits = [];
        for (const e of targets) {
          const t = e.x * dx + e.y * dy;
          if (t < 0 || t > w.range + e.r) continue;
          const rr = e.r + 3;
          if (e.x * e.x + e.y * e.y - t * t <= rr * rr) hits.push([t, e]);
        }
        hits.sort((p, q) => p[0] - q[0]);
        for (const [, e] of w.pierce ? hits : hits.slice(0, 1)) { total += w.dmg; burned.add(e); }
      }
    } else if (w.kind === 'flame') {
      for (const e of targets) {
        const d = Math.hypot(e.x, e.y);
        if (d > w.range + e.r || (d > e.r && Math.abs(Math.atan2(e.y, e.x)) > w.cone)) continue;
        total += w.dmg;
        burned.add(e);
      }
      total += burned.size * BURN_DPS * Math.min(w.rate, 2.2);
      burned.clear();
    } else if (w.kind === 'proj') {
      let imp = w.range;
      for (const e of targets) {
        const t = e.x;
        if (t > 0 && Math.abs(e.y) < e.r + 6) imp = Math.min(imp, t);
      }
      const blast = (x, y, radius, dmg) => {
        for (const e of targets) {
          const d = Math.hypot(e.x - x, e.y - y);
          if (d < radius + e.r) total += dmg * (1 - 0.5 * Math.min(1, d / radius));
        }
      };
      blast(imp, 0, w.radius, w.dmg);
      for (let c = 0; c < (w.cluster || 0); c++) {
        const a = rnd() * Math.PI * 2, r = 70 + rnd() * 50;
        blast(imp + Math.cos(a) * r, Math.sin(a) * r, w.radius * 0.6, w.dmg * 0.4);
      }
    }
    if (w.burn) total += burned.size * BURN_DPS * Math.min(w.rate, w.burn);
  }
  return total / samples;
}

// Single-target DPS over the typical range of fights, weighted towards mid range
const SINGLE_MIX = [[70, 0.25], [150, 0.35], [260, 0.25], [420, 0.15]];
function singleDps(w, seed) {
  const rnd = rng(seed);
  let sum = 0;
  for (const [d, wgt] of SINGLE_MIX) {
    sum += wgt * shotDamage(w, [{ x: d, y: 0, r: TARGET_R }], rnd) / w.rate;
  }
  return sum;
}

// DPS into a crowd, standing at a few distances from it
function hordeDps(w, seed) {
  const rnd = rng(seed + 1);
  let sum = 0;
  for (const d of [130, 240, 360]) {
    for (let rep = 0; rep < 4; rep++) sum += shotDamage(w, hordeAt(d, rnd), rnd, 40) / w.rate;
  }
  return sum / 12;
}

// How long the ammo lasts in a 60 s fight. Faster fire empties a weapon faster, so fire-rate perks do less
// here for anything with a magazine. When a gun runs dry you are back on the pistol.
function uptime(w) {
  if (w.ammo < 0) return 1;
  const shots = w.ammo + (w.pickup || 0) * (WINDOW / CRATE_EVERY);
  return Math.min(1, shots * w.rate / WINDOW);
}

// One weapon in one loadout.
function evalWeapon(stats, id, pistolHorde) {
  const w = stats[IDX[id]], seed = 1000 + IDX[id];
  const single = singleDps(w, seed), horde = hordeDps(w, seed);
  const up = uptime(w);
  const sustained = up * horde + (1 - up) * pistolHorde;
  return { id, single, horde, up, sustained, raw: single ** 0.3 * horde ** 0.3 * sustained ** 0.4 };
}

let baseRaw = null;
function normal(raw) {
  if (baseRaw === null) {
    const st = loadoutStats(0, {});
    const h = hordeDps(st[IDX.pistol], 1000 + IDX.pistol);
    baseRaw = evalWeapon(st, 'pistol', h).raw;
  }
  return raw / baseRaw * 100;
}

export function resetCache() { baseRaw = null; }

export function wpiTable(perks = {}, own = false) {
  const pistolStats = loadoutStats(own ? maskFor('pistol') : 0, perks);
  const pistolH = hordeDps(pistolStats[IDX.pistol], 1000 + IDX.pistol);
  return GUNS.map(id => {
    const st = loadoutStats(own ? maskFor(id) : 0, perks);
    const r = evalWeapon(st, id, pistolH);
    return { ...r, wpi: normal(r.raw) };
  });
}

// ------------------------------------------------------------ scoring --
const clamp01 = v => Math.max(0, Math.min(1, v));

// Least-squares line through ln(WPI) by unlock order: how far is each weapon from a smooth power curve?
function curveFit(rows) {
  const n = rows.length, ys = rows.map(r => Math.log(r.wpi));
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  const b = num / den, a = my - b * mx;
  const res = ys.map((y, i) => y - (a + b * i));
  return { a, b, res, rms: Math.sqrt(res.reduce((s, r) => s + r * r, 0) / n) };
}

// Rates one scenario out of 100: smooth power curve (40), later weapons beat earlier ones (30), and the
// free infinite-ammo pistol stays below every gun you have to earn (30).
function scoreScenario(rows) {
  const fit = curveFit(rows);
  const curve = clamp01(1 - fit.rms / 0.45);
  let good = 0, pairs = 0;
  const inversions = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    pairs++;
    if (rows[j].wpi >= rows[i].wpi * 0.92) good++;
    else inversions.push([rows[i].id, rows[j].id, rows[i].wpi / rows[j].wpi]);
  }
  const ladder = good / pairs;
  const pistol = rows[0].wpi, lowest = Math.min(...rows.slice(1).map(r => r.wpi));
  const sidearm = clamp01(1 - Math.max(0, pistol / lowest - 0.85) / 0.6);
  return { score: 40 * curve + 30 * ladder + 30 * sidearm, curve, ladder, sidearm, fit, inversions };
}

// How unevenly a perk helps different weapons: spread of the WPI gains (0 = perfectly even).
function perkSpread(stock, boosted) {
  const gains = stock.map((r, i) => boosted[i].wpi / r.wpi);
  const m = gains.reduce((a, b) => a + b, 0) / gains.length;
  const cv = Math.sqrt(gains.reduce((s, g) => s + (g - m) ** 2, 0) / gains.length) / m;
  return { gains, mean: m, cv };
}

// What each upgrade does for its own weapon, in WPI.
export function upgradeValues() {
  return UPGRADES.map((u, i) => {
    if (!GUNS.includes(u.w)) return { ...u, i, gain: null };
    const base = loadoutStats(0, {}), up = loadoutStats(1 << i, {});
    const ph = hordeDps(base[IDX.pistol], 1000 + IDX.pistol), php = hordeDps(up[IDX.pistol], 1000 + IDX.pistol);
    return { ...u, i, gain: evalWeapon(up, u.w, php).raw / evalWeapon(base, u.w, ph).raw };
  });
}

// The fully upgraded pistol against every gun with no upgrades at all: upgrades are random drops, so this
// lopsided fight really happens.
export function sidearmCheck() {
  const stock = wpiTable({}, false);
  const st = loadoutStats(maskFor('pistol'), {});
  const r = evalWeapon(st, 'pistol', hordeDps(st[IDX.pistol], 1000 + IDX.pistol));
  const pistol = normal(r.raw);
  return { pistol, beats: stock.slice(1).filter(x => x.wpi < pistol).map(x => x.id), stock };
}

export function paperReport() {
  const stock = wpiTable({}, false);
  const scenarios = SCENARIOS.map(s => {
    const rows = wpiTable(s.perks, s.own);
    return { ...s, rows, ...scoreScenario(rows), spread: s.perk ? perkSpread(stock, rows) : null };
  });
  const totalW = scenarios.reduce((a, s) => a + s.weight, 0);
  const scenarioScore = scenarios.reduce((a, s) => a + s.score * s.weight, 0) / totalW;
  // perk fairness: 0 spread is perfect, a 30% spread scores nothing
  const perks = scenarios.filter(s => s.perk);
  const perkFair = clamp01(1 - perks.reduce((a, s) => a + s.spread.cv, 0) / perks.length / 0.3);
  const side = sidearmCheck();
  const lottery = side.beats.length / (GUNS.length - 1);
  const upgrades = upgradeValues();
  const gains = upgrades.filter(u => u.gain !== null).map(u => u.gain);
  const wild = gains.filter(g => g > 1.75 || g < 1.04).length / gains.length;
  const score = scenarioScore * 0.7 + perkFair * 100 * 0.1 + (1 - lottery) * 100 * 0.1 + (1 - wild) * 100 * 0.1;
  return { score, scenarioScore, perkFair, lottery, wild, side, upgrades, scenarios };
}

// Plain-language list of what is off, worst first. level: 'fail' | 'warn'
export function findIssues(report) {
  const out = [], name = id => WEAPONS[IDX[id]].name;
  const seen = new Set();
  for (const s of report.scenarios) {
    for (const [a, b, ratio] of s.inversions) {
      const key = a + b;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ level: ratio > 1.4 ? 'fail' : 'warn', text: `${name(a)} beats ${name(b)}, which unlocks later, by ${Math.round((ratio - 1) * 100)}% (${s.name}).` });
    }
  }
  if (report.side.beats.length) {
    out.push({ level: report.side.beats.length > 1 ? 'fail' : 'warn', text: `A fully upgraded Pistol beats stock ${report.side.beats.map(name).join(', ')}.` });
  }
  for (const u of report.upgrades) {
    if (u.gain === null) continue;
    if (u.gain > 1.75) out.push({ level: 'warn', text: `${u.name} is too strong: x${u.gain.toFixed(2)} on its own weapon.` });
    if (u.gain < 1.04) out.push({ level: 'warn', text: `${u.name} does almost nothing: x${u.gain.toFixed(2)}.` });
  }
  for (const s of report.scenarios) {
    if (s.spread && s.spread.cv > 0.15) out.push({ level: 'warn', text: `${s.name} helps some weapons much more than others (spread ${Math.round(s.spread.cv * 100)}%).` });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fail' ? -1 : 1));
}

// ---------------------------------------------------------- field test --
const TICK = 1 / 30;
const PERK_IDX = Object.fromEntries(PERKS.map((p, i) => [p.id, i]));

// One bot plays Classic with one weapon until it goes down. Returns the wave it reached.
export function fieldRun({ weapon, ups = 0, perks = {}, map = 'depot', diff = 'normal', maxWave = 40 }) {
  // no bosses: the bot can't dodge them, so they would end almost every run at the same wave
  const g = new Game(map, { mode: 'classic', diff, foes: FOE_TYPES.filter(t => !BOSSES.includes(t)) });
  g.unlocked = (1 << WEAPONS.length) - 1;
  g.rollUpgrade = () => -1;             // boss crates would change the loadout under test
  const p = g.addPlayer(1, 'bot', '#fff');
  p.ups = ups;
  for (const [k, v] of Object.entries(perks)) p.perks[PERK_IDX[k]] = v;
  g.applyPerks(p);
  p.hp = p.maxhp;
  const wi = IDX[weapon];
  p.ws.forEach((w, i) => { p.ammo[i] = i ? w.ammo : -1; });
  let shots = 0, dry = 0, ticks = 0;
  const cap = 60 * 60 * 30;
  while (!g.over && g.wave < maxWave && ticks < cap) {
    botTick(g, p, TICK, { weapon: wi });
    if (p.trigger) { shots++; if (p.weapon !== wi) dry++; }
    g.tick(TICK);
    ticks++;
    if (p.perks) p.offer = null;
  }
  return { wave: g.wave, kills: g.totalKills, time: ticks * TICK, dry: shots ? dry / shots : 0 };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
export const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

export function fieldCell(cfg, runs) {
  const rs = Array.from({ length: runs }, () => fieldRun(cfg));
  return { wave: mean(rs.map(r => r.wave)), median: median(rs.map(r => r.wave)), dry: mean(rs.map(r => r.dry)), kills: mean(rs.map(r => r.kills)) };
}

// The jobs of a whole field test, as a list so a UI can run them a few at a time and show progress.
export const FIELD_WEAPONS = WEAPONS.map(w => w.id).filter(id => id !== 'barricade');
export const FIELD_LOADOUTS = [
  { id: 'stock', name: 'Stock', perks: {}, own: false },
  { id: 'trigger', name: 'Trigger x3', perks: { trigger: 3 }, own: false },
  { id: 'guns', name: 'Guns x5', perks: { guns: 5 }, own: false },
  { id: 'upgrades', name: 'All upgrades', perks: {}, own: true },
];
export function fieldJobs(loadouts = FIELD_LOADOUTS) {
  const jobs = [];
  for (const l of loadouts) for (const id of FIELD_WEAPONS) jobs.push({ loadout: l.id, weapon: id, cfg: { weapon: id, perks: l.perks, ups: l.own ? maskFor(id) : 0 } });
  return jobs;
}

// Value of each perk at max rank, measured the same way with one weapon held constant.
export function perkJobs(weapon = 'rifle') {
  return [{ perk: null, cfg: { weapon } }, ...PERKS.map(pk => ({ perk: pk.id, cfg: { weapon, perks: { [pk.id]: pk.max } } }))];
}
