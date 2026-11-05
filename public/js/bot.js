// A simple player bot that drives the real Game class without a browser. Used by the tests and by the
// balance lab. It kites away from the horde, shoots the closest enemy it can see and walks to objectives.
const T = 32, PR = 11;

function step(game, p, dx, dy, dt, speed = p.speed) {
  const l = Math.hypot(dx, dy);
  if (l < 1e-3) return;
  const d = speed * dt, n = Math.max(1, Math.ceil(d / 8));
  let x = p.x, y = p.y;
  for (let i = 0; i < n; i++) [x, y] = game.collide(x + dx / l * d / n, y + dy / l * d / n, PR);
  p.x = x; p.y = y;
}

// goal: where the bot wants to be right now, or null to just fight
export function botTick(game, p, dt, { goal = null, weapon = null, kite = 1 } = {}) {
  if (p.state !== 'alive') { p.trigger = false; p.use = false; return; }
  let near = null, nd = 1e9, rx = 0, ry = 0;
  for (const e of game.enemies.values()) {
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < 190 && d > 0.1) { const f = (190 - d) / 190; rx += (p.x - e.x) / d * f * f; ry += (p.y - e.y) / d * f * f; }
    if (d < nd && (e.type === 'wraith' || game.los(p.x, p.y, e.x, e.y))) { near = e; nd = d; }
  }
  let mx = rx * 2.5 * kite, my = ry * 2.5 * kite;
  if (goal) {
    const dg = Math.hypot(goal[0] - p.x, goal[1] - p.y);
    if (dg > (goal[2] ?? 8)) {
      const ga = botPath(game, p, goal);
      mx += ga[0] * 1.6; my += ga[1] * 1.6;
    }
  } else if (Math.hypot(mx, my) < 0.05) {
    // nothing pressing: pick up the closest supplies
    let item = null, id = 1e9;
    for (const it of game.items.values()) {
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (it.kind === 5 || it.kind === 3) continue;
      if (it.kind === 2 && p.ups >> it.u & 1) continue;
      if (it.kind === 1 && p.hp >= p.maxhp) continue;
      if (d < id) { item = it; id = d; }
    }
    if (item) { const ga = botPath(game, p, [item.x, item.y]); mx = ga[0]; my = ga[1]; }
  } else {
    // keep away from walls a little by leaning towards open ground
    const c = botPath(game, p, [game.w * T / 2, game.h * T / 2]);
    mx += c[0] * 0.25; my += c[1] * 0.25;
  }
  // weapon: a fixed choice falls back to the pistol when dry, like a player would
  if (weapon !== null) p.weapon = p.ammo[weapon] !== 0 ? weapon : 0;
  if (p.carry) p.weapon = 0;
  const w = p.ws[p.weapon];
  // walk into range of targets that hang back (shamans and spitters park out of flamethrower reach)
  if (near && w.range && nd > w.range * 0.85 && Math.hypot(rx, ry) < 0.3) {
    const ga = botPath(game, p, [near.x, near.y]);
    mx += ga[0]; my += ga[1];
  }
  step(game, p, mx, my, dt);
  if (near) p.angle = Math.atan2(near.y - p.y, near.x - p.x);
  p.trigger = !!near && (w.kind === 'place' ? nd < 170 : nd < (w.range || 600));
}

// next-step direction towards a point, using a cached flood fill
function botPath(game, p, goal) {
  const key = Math.floor(goal[0] / T) + ',' + Math.floor(goal[1] / T) + ',' + game.structs.size + ',' + game.doorMask;
  if (!p._bf || p._bk !== key) { p._bf = game.flood(goal[0], goal[1]); p._bk = key; }
  const f = p._bf, w = game.w, tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
  let best = f[ty * w + tx], bx = -1, by = -1;
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = tx + ox, ny = ty + oy;
    if (game.solid(nx, ny)) continue;
    if (ox && oy && (game.solid(nx, ty) || game.solid(tx, ny))) continue;
    if (f[ny * w + nx] < best) { best = f[ny * w + nx]; bx = nx; by = ny; }
  }
  const dx = bx >= 0 ? (bx + 0.5) * T - p.x : goal[0] - p.x, dy = bx >= 0 ? (by + 0.5) * T - p.y : goal[1] - p.y;
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

// Where a bot should head for the current Breakthrough task. Returns [x, y, stopDistance] or null.
export function runGoal(game, p, idx = 0) {
  // whoever is down comes first, like a decent teammate
  for (const q of game.players.values()) {
    if (q !== p && q.state === 'down') return [q.x, q.y, 20];
  }
  if (game.waveState === 'break') {
    const z = game.zones[game.zoneI];
    return [(z.x0 + 4) * T, (z.entry[1] + 0.5) * T, 20];
  }
  const t = game.task;
  if (!t) return null;
  switch (t.type) {
    case 'nests': {
      let best = null, bd = 1e9;
      for (const id of game.nestIds) { const e = game.enemies.get(id); if (e) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } } }
      return best ? [best.x, best.y, 90] : null;
    }
    case 'hack': { const s = game.sites.find(q => q.prog < q.need); return s ? [s.x, s.y, 20] : null; }
    case 'hold': case 'extract': { const s = game.sites[0]; return [s.x, s.y, 30]; }
    case 'fuel': {
      if (p.carry) { const s = game.sites[0]; return [s.x, s.y, 30]; }
      let best = null, bd = 1e9;
      for (const it of game.items.values()) { if (it.kind !== 5) continue; const d = Math.hypot(it.x - p.x, it.y - p.y); if (d < bd) { bd = d; best = it; } }
      return best ? [best.x, best.y, 2] : null;
    }
    case 'charge': case 'fix': { const s = game.sites[0]; return [s.x - 40, s.y + (idx % 2 ? 60 : -60), 40]; }
    case 'boss': {
      for (const id of game.bossIds) { const e = game.enemies.get(id); if (e) return [e.x, e.y, 240]; }
      return null;
    }
    case 'clear': {
      let best = null, bd = 1e9;
      for (const e of game.enemies.values()) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } }
      return best && bd > 300 ? [best.x, best.y, 200] : null;
    }
  }
  return null;
}

// Use the interact key when the bot is standing where a terminal needs it. Only works if no enemy is on
// top of it, a sensible player's rule of thumb.
export function runUse(game, p) {
  p.use = false;
  const t = game.task;
  if (!t || t.type !== 'hack' || p.state !== 'alive') return;
  const s = game.sites.find(q => q.prog < q.need && Math.hypot(q.x - p.x, q.y - p.y) < 40);
  if (!s) return;
  let close = 0;
  for (const e of game.enemies.values()) if (Math.hypot(e.x - p.x, e.y - p.y) < 110) close++;
  p.use = close === 0 || s.prog > s.need * 0.85;
}
