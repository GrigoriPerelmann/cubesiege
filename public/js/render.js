// World rendering: pre-rendered floor + wall strips, blocky characters, particles, lighting.
export const T = 32;
const HMAX = 60; // extra space above each wall row for tall objects
const LIGHT_DIV = 3; // lighting buffer resolution divider

// ------------------------------------------------------------ utilities --
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function shade(hex, amt) {
  // amt -1..1 : darken / lighten
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(ch => ch + ch).join('');
  const n = parseInt(c, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// --------------------------------------------------------- enemy styles --
export const LOOKS = {
  player: { s: 1, skin: '#e2b48c', pants: '#2b3346', eye: '#1b1b1b' },
  shambler: { s: 1, skin: '#83a86b', shirt: '#5d4c3b', pants: '#363b45', eye: '#3a0606', zombie: true },
  sprinter: { s: 0.88, skin: '#b3c2b8', shirt: '#2f3b52', pants: '#22242a', eye: '#ffd23a', zombie: true, slim: true },
  brute: { s: 1.5, skin: '#757093', shirt: '#3d2f42', pants: '#2a2530', eye: '#ff3a3a', zombie: true, big: true },
  warlock: { s: 1.05, skin: '#c4473a', shirt: '#2b1825', pants: '#2b1825', eye: '#ffcc33', horns: '#eadcb5', robe: true },
  bloater: { s: 1.15, skin: '#a8b64c', shirt: '#7d8a31', pants: '#4a5222', eye: '#2a2a00', zombie: true, fat: true },
  colossus: { s: 2.4, skin: '#5c2121', shirt: '#26262b', pants: '#1c1c20', eye: '#ffb02e', horns: '#d8c8a0', zombie: true, big: true, glow: '#ff6a2a' },
};
export const BLOOD = { shambler: '#8a1010', sprinter: '#7a1414', brute: '#5a0d2a', warlock: '#d0601a', bloater: '#7fa020', colossus: '#6a0808' };

// ------------------------------------------------------------ renderer --
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.light = mk(4, 4);
    this.lctx = this.light.getContext('2d');
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cw = window.innerWidth;
    this.ch = window.innerHeight;
    this.canvas.width = Math.floor(this.cw * dpr);
    this.canvas.height = Math.floor(this.ch * dpr);
    // show roughly 980 x 610 world pixels whatever the window size
    this.scale = Math.max(this.cw / 980, this.ch / 610);
    this.light.width = Math.ceil(this.cw / LIGHT_DIV);
    this.light.height = Math.ceil(this.ch / LIGHT_DIV);
  }

  // ------------------------------------------------------------ map --
  setMap(map) {
    this.map = map;
    this.theme = map.theme;
    const W = map.w * T, H = map.h * T;
    this.floor = mk(W, H);
    this.drawFloor();
    // blood & scorch marks are painted straight onto the floor (one blit per frame)
    this.dctx = this.floor.getContext('2d');
    this.rowCanvases = [];
    this.rowSpans = [];
    for (let ty = 0; ty < map.h; ty++) {
      this.rowCanvases.push(this.drawRow(ty));
      this.rowSpans.push(this.spansFor(ty));
    }
    this.minimap = this.drawMinimap();
  }

  tile(x, y) {
    const m = this.map;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) return '#';
    return m.rows[y][x];
  }

  isSolidCh(ch) { return ch === '#' || ch === 'B' || ch === 'T'; }

  drawFloor() {
    const m = this.map, th = this.theme, g = this.floor.getContext('2d');
    g.fillStyle = th.bg;
    g.fillRect(0, 0, this.floor.width, this.floor.height);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const ch = m.rows[y][x];
        const px = x * T, py = y * T;
        const base = ch === ',' ? th.floor2 : th.floor;
        const r = hash(x, y);
        g.fillStyle = shade(base, (r - 0.5) * 0.08);
        g.fillRect(px, py, T, T);
        // speckles
        for (let k = 0; k < 5; k++) {
          const rr = hash(x * 7 + k, y * 13 - k);
          g.fillStyle = rr > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
          g.fillRect(px + Math.floor(hash(x + k * 3, y) * 28), py + Math.floor(hash(x, y + k * 5) * 28), 4, 4);
        }
        if (ch === ',' && th.fence) { // grass tufts
          g.fillStyle = 'rgba(120,170,80,0.25)';
          for (let k = 0; k < 3; k++) g.fillRect(px + hash(x + k, y * 3) * 28, py + hash(x * 5, y + k) * 28, 2, 4);
        }
        g.strokeStyle = th.grid;
        g.globalAlpha = 0.35;
        g.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        g.globalAlpha = 1;
        if (ch === 'S') {
          g.save();
          g.beginPath(); g.rect(px, py, T, T); g.clip();
          g.fillStyle = 'rgba(0,0,0,0.35)';
          g.fillRect(px, py, T, T);
          g.strokeStyle = 'rgba(230,170,30,0.35)';
          g.lineWidth = 6;
          for (let k = -T; k < T * 2; k += 16) { g.beginPath(); g.moveTo(px + k, py); g.lineTo(px + k + T, py + T); g.stroke(); }
          g.restore();
        }
      }
    }
    // soft shadows cast by walls (to the south-east)
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const ch = m.rows[y][x];
        if (!this.isSolidCh(ch)) continue;
        const h = ch === '#' ? 12 : 7;
        if (!this.isSolidCh(this.tile(x + 1, y))) g.fillRect(x * T + T, y * T + 6, h * 0.6, T);
        if (!this.isSolidCh(this.tile(x, y + 1))) g.fillRect(x * T + 4, y * T + T, T, h * 0.6);
      }
    }
  }

  // contiguous runs of solid tiles in a row, so only those parts get blitted
  spansFor(ty) {
    const m = this.map, spans = [];
    let cur = null;
    for (let tx = 0; tx <= m.w; tx++) {
      const ch = tx < m.w ? m.rows[ty][tx] : '.';
      if (this.isSolidCh(ch)) {
        if (!cur) { cur = { x0: tx * T, x1: tx * T + T, top: 34, tree: false }; spans.push(cur); }
        cur.x1 = tx * T + T;
        if (ch === 'T') { cur.top = HMAX; cur.tree = true; }
      } else cur = null;
    }
    for (const sp of spans) if (sp.tree) { sp.x0 = Math.max(0, sp.x0 - 10); sp.x1 = Math.min(m.w * T, sp.x1 + 10); }
    return spans;
  }

  drawRow(ty) {
    const m = this.map, th = this.theme;
    const c = mk(m.w * T, T + HMAX);
    const g = c.getContext('2d');
    const oy = HMAX; // tile top y within canvas
    for (let tx = 0; tx < m.w; tx++) {
      const ch = m.rows[ty][tx];
      const x = tx * T;
      if (ch === '#') this.drawWall(g, tx, ty, x, oy);
      else if (ch === 'B') this.drawCrate(g, tx, ty, x, oy);
    }
    // trees / pillars last so canopies overlap neighbours nicely
    for (let tx = 0; tx < m.w; tx++) if (m.rows[ty][tx] === 'T') this.drawTree(g, tx, ty, tx * T, oy);
    return c;
  }

  drawWall(g, tx, ty, x, y) {
    const th = this.theme;
    const fence = th.fence;
    const h = fence ? 20 : 30;
    const below = this.tile(tx, ty + 1) === '#';
    const top = th.wallTop, front = th.wallFront;
    if (fence) {
      // wooden fence: posts and rails
      if (!below) {
        g.fillStyle = shade(front, -0.1);
        g.fillRect(x, y + T - h, T, h);
        g.fillStyle = shade(top, -0.05);
        g.fillRect(x, y + T - h + 4, T, 4);
        g.fillRect(x, y + T - h + 12, T, 4);
      }
      g.fillStyle = top;
      g.fillRect(x, y - h, T, T);
      g.fillStyle = shade(top, -0.15);
      for (let k = 0; k < T; k += 8) g.fillRect(x + k, y - h, 1, T);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      if (this.tile(tx, ty - 1) !== '#') g.fillRect(x, y - h, T, 2);
      if (this.tile(tx - 1, ty) !== '#') g.fillRect(x, y - h, 2, T);
      if (this.tile(tx + 1, ty) !== '#') g.fillRect(x + T - 2, y - h, 2, T);
      if (!below) g.fillRect(x, y + T - h - 2, T, 2);
      return;
    }
    if (!below) {
      const grad = g.createLinearGradient(0, y + T - h, 0, y + T);
      grad.addColorStop(0, front);
      grad.addColorStop(1, shade(front, -0.35));
      g.fillStyle = grad;
      g.fillRect(x, y + T - h, T, h);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      // bricks / panels
      if (th.roof) {
        for (let k = 0; k < 3; k++) g.fillRect(x, y + T - h + 9 + k * 8, T, 1);
        const off = (tx % 2) * 16;
        g.fillRect(x + off + 6, y + T - h + 10, 8, 10);
        g.fillStyle = 'rgba(255,220,140,0.12)';
        if (hash(tx, ty) > 0.6) g.fillRect(x + off + 7, y + T - h + 11, 6, 8);
      } else {
        g.fillRect(x, y + T - h + 10, T, 1);
        g.fillRect(x, y + T - h + 20, T, 1);
        g.fillRect(x + ((tx % 2) ? 10 : 22), y + T - h, 1, 10);
        g.fillRect(x + ((tx % 2) ? 22 : 10), y + T - h + 10, 1, 10);
        g.fillRect(x + 16, y + T - h + 20, 1, 10);
      }
    }
    // top face
    g.fillStyle = shade(top, (hash(tx, ty) - 0.5) * 0.06);
    g.fillRect(x, y - h, T, T);
    if (th.roof) {
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let k = 4; k < T; k += 8) g.fillRect(x, y - h + k, T, 2);
    } else {
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(x + 4, y - h + 4, T - 8, T - 8);
    }
    // outline where neighbours are not walls
    const L = this.tile(tx - 1, ty) !== '#', R = this.tile(tx + 1, ty) !== '#', U = this.tile(tx, ty - 1) !== '#';
    g.fillStyle = 'rgba(255,255,255,0.14)';
    if (U) g.fillRect(x, y - h, T, 2);
    if (L) g.fillRect(x, y - h, 2, T);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (U) g.fillRect(x, y - h, T, 1);
    if (L) g.fillRect(x, y - h, 1, T + (below ? 0 : h));
    if (R) g.fillRect(x + T - 1, y - h, 1, T + (below ? 0 : h));
    if (!below) g.fillRect(x, y + T - h - 1, T, 1);
  }

  drawCrate(g, tx, ty, x, y) {
    const th = this.theme;
    const h = 20, i = 2;
    const w = T - i * 2;
    const top = th.crateTop, front = th.crateFront;
    const below = this.tile(tx, ty + 1) === 'B';
    const left = this.tile(tx - 1, ty) === 'B', right = this.tile(tx + 1, ty) === 'B';
    const x0 = x + (left ? 0 : i), x1 = x + T - (right ? 0 : i);
    if (!below) {
      g.fillStyle = front;
      g.fillRect(x0, y + T - h - i, x1 - x0, h);
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.fillRect(x0, y + T - h - i + 6, x1 - x0, 1);
      g.fillRect(x0, y + T - h - i + 13, x1 - x0, 1);
    }
    g.fillStyle = top;
    g.fillRect(x0, y - h + (this.tile(tx, ty - 1) === 'B' ? 0 : i), x1 - x0, T - (this.tile(tx, ty - 1) === 'B' ? 0 : i) - (below ? 0 : i));
    // planks / details
    g.fillStyle = 'rgba(0,0,0,0.16)';
    if (th.fence) { // hay bale
      for (let k = 4; k < T; k += 5) g.fillRect(x0, y - h + k, x1 - x0, 1);
    } else if (th.roof) { // car roof
      g.fillStyle = 'rgba(160,200,230,0.35)';
      g.fillRect(x0 + 4, y - h + 6, x1 - x0 - 8, 8);
    } else {
      for (let k = 8; k < T; k += 8) g.fillRect(x0, y - h + k, x1 - x0, 1);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(x + 6, y - h + 3, 3, T - 6);
      g.fillRect(x + T - 9, y - h + 3, 3, T - 6);
    }
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y - h + i + 0.5, x1 - x0 - 1, T - i * 2 + (below ? 0 : h) - 1);
  }

  drawTree(g, tx, ty, x, y) {
    const th = this.theme;
    const cx = x + T / 2;
    if (th.pillar) {
      const h = 40, i = 5;
      g.fillStyle = shade(th.tree, -0.2);
      g.fillRect(x + i, y + T - i - h, T - 2 * i, h);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + i, y + T - i - 8, T - 2 * i, 8);
      g.fillStyle = th.treeTop;
      g.fillRect(x + i, y - h + i, T - 2 * i, T - 2 * i);
      g.fillStyle = 'rgba(230,180,40,0.6)';
      g.fillRect(x + i, y + T - i - h + 6, T - 2 * i, 3);
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.strokeRect(x + i + 0.5, y - h + i + 0.5, T - 2 * i - 1, T - 2 * i + h - 1);
      return;
    }
    // tree: trunk + layered canopy
    g.fillStyle = '#4a3220';
    g.fillRect(cx - 4, y + T - 26, 8, 22);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(cx - 4, y + T - 8, 8, 4);
    const r = 19 + hash(tx, ty) * 4;
    const cy = y + T - 34;
    g.fillStyle = shade(th.tree, -0.2);
    g.beginPath(); g.arc(cx, cy + 4, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = th.tree;
    g.beginPath(); g.arc(cx - 2, cy, r - 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = th.treeTop;
    g.beginPath(); g.arc(cx - 6, cy - 6, r * 0.55, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.arc(cx - 8, cy - 9, r * 0.25, 0, Math.PI * 2); g.fill();
    if (th.fence && hash(tx * 3, ty) > 0.4) { // fruit
      g.fillStyle = '#d0402a';
      for (let k = 0; k < 4; k++) g.fillRect(cx - 12 + hash(tx + k, ty) * 24, cy - 10 + hash(tx, ty + k) * 20, 3, 3);
    }
  }

  drawMinimap() {
    const m = this.map, s = 3;
    const c = mk(m.w * s, m.h * s);
    const g = c.getContext('2d');
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const ch = m.rows[y][x];
      g.fillStyle = ch === '#' ? '#8a8378' : ch === 'B' ? '#6d5a3f' : ch === 'T' ? '#4e6b3c' : ch === 'S' ? '#5a3a1a' : '#26231f';
      g.fillRect(x * s, y * s, s, s);
    }
    return c;
  }

  // ------------------------------------------------------- decals --
  stain(x, y, r, color, alpha = 0.8) {
    const g = this.dctx;
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }

  splat(x, y, size, color) {
    const g = this.dctx;
    g.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * size;
      g.globalAlpha = 0.5 + Math.random() * 0.4;
      const r = size * (0.25 + Math.random() * 0.35);
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  scorch(x, y, r) {
    const g = this.dctx;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(10,5,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  // --------------------------------------------------------- frame --
  begin(camX, camY) {
    const { ctx, dpr, scale } = this;
    this.camX = camX;
    this.camY = camY;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme ? this.theme.bg : '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.worldTransform();
    this.view = {
      x0: camX - this.cw / 2 / scale, y0: camY - this.ch / 2 / scale,
      x1: camX + this.cw / 2 / scale, y1: camY + this.ch / 2 / scale,
    };
  }

  worldTransform() {
    const { dpr, scale } = this;
    const ox = Math.round((this.cw / 2 - this.camX * scale) * dpr);
    const oy = Math.round((this.ch / 2 - this.camY * scale) * dpr);
    this.ctx.setTransform(dpr * scale, 0, 0, dpr * scale, ox, oy);
  }

  toScreen(x, y) {
    return [(x - this.camX) * this.scale + this.cw / 2, (y - this.camY) * this.scale + this.ch / 2];
  }

  toWorld(sx, sy) {
    return [(sx - this.cw / 2) / this.scale + this.camX, (sy - this.ch / 2) / this.scale + this.camY];
  }

  drawGround() {
    const { ctx, view } = this;
    const sx = Math.max(0, Math.floor(view.x0)), sy = Math.max(0, Math.floor(view.y0));
    const sw = Math.min(this.floor.width, Math.ceil(view.x1)) - sx;
    const sh = Math.min(this.floor.height, Math.ceil(view.y1) + HMAX) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(this.floor, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  // drawables: [{y, draw()}] sorted by y. Interleaves wall rows for correct occlusion.
  drawScene(drawables) {
    const { ctx, view, map } = this;
    drawables.sort((a, b) => a.y - b.y);
    const r0 = Math.max(0, Math.floor(view.y0 / T) - 1);
    const r1 = Math.min(map.h - 1, Math.floor((view.y1 + HMAX) / T) + 1);
    const vx0 = Math.floor(view.x0) - 2, vx1 = Math.ceil(view.x1) + 2;
    let i = 0;
    for (let ty = r0; ty <= r1; ty++) {
      const lim = (ty + 1) * T;
      while (i < drawables.length && drawables[i].y < lim) drawables[i++].draw(ctx);
      const img = this.rowCanvases[ty];
      for (const sp of this.rowSpans[ty]) {
        const x0 = Math.max(sp.x0, vx0), x1 = Math.min(sp.x1, vx1);
        if (x1 <= x0) continue;
        const h = T + sp.top;
        ctx.drawImage(img, x0, HMAX - sp.top, x1 - x0, h, x0, ty * T - sp.top, x1 - x0, h);
      }
    }
    while (i < drawables.length) drawables[i++].draw(ctx);
  }

  // ------------------------------------------------- characters --
  shadow(x, y, r) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.1, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Generic blocky humanoid. o: {x,y,a,look,shirt,hair,phase,flash,gun,down,burn,t}
  drawChar(ctx, o) {
    const L = o.look;
    const s = L.s;
    const x = o.x, y = o.y, a = o.a;
    const ca = Math.cos(a), sa = Math.sin(a);
    const fl = o.flash;
    const col = c => (fl ? '#ffffff' : c);
    const box = (bx, by, bw, bh, c) => {
      ctx.fillStyle = col(c);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    };
    if (o.down) {
      // lying on the ground
      ctx.save();
      ctx.translate(x, y);
      box(-14 * s, -6 * s, 28 * s, 10 * s, o.shirt || L.shirt);
      box(10 * s, -7 * s, 10 * s, 11 * s, L.skin);
      box(-20 * s, -4 * s, 7 * s, 7 * s, L.pants);
      ctx.restore();
      return;
    }
    const shirt = o.shirt || L.shirt;
    const bodyW = (L.fat ? 24 : L.slim ? 13 : 16) * s;
    const legH = 7 * s, bodyH = (L.fat ? 15 : 13) * s, headW = (L.fat ? 12 : 14) * s, headH = 12 * s;
    const ph = o.phase || 0;
    const lift1 = Math.max(0, Math.sin(ph)) * 3 * s, lift2 = Math.max(0, -Math.sin(ph)) * 3 * s;
    const bob = Math.abs(Math.sin(ph)) * 1.2 * s;
    const bodyTop = y - legH - bodyH - bob;
    const headTop = bodyTop - headH + 1;
    const facingUp = sa < -0.35;
    const shoulderY = bodyTop + 4 * s;

    const drawArms = () => {
      if (o.gun) {
        const len = o.gun.len * s;
        const gx = x + ca * 6 * s, gy = shoulderY + 2 * s + sa * 3 * s;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (o.gun.w + 2) * s;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + ca * len, gy + sa * len * 0.75); ctx.stroke();
        ctx.strokeStyle = col(o.gun.color);
        ctx.lineWidth = o.gun.w * s;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + ca * len, gy + sa * len * 0.75); ctx.stroke();
        if (o.gun.accent) {
          ctx.strokeStyle = col(o.gun.accent);
          ctx.lineWidth = Math.max(1, o.gun.w * s * 0.45);
          ctx.beginPath(); ctx.moveTo(gx + ca * len * 0.35, gy + sa * len * 0.26); ctx.lineTo(gx + ca * len * 0.8, gy + sa * len * 0.6); ctx.stroke();
        }
        box(gx - 2.5 * s, gy - 2.5 * s, 5 * s, 5 * s, L.skin);
      } else if (L.zombie || L.robe) {
        // reaching arms
        const reach = (L.big ? 13 : 11) * s + Math.sin((o.t || 0) * 6 + (o.id || 0)) * 1.5 * s;
        ctx.lineCap = 'butt';
        for (const side of [-1, 1]) {
          const sx = x - sa * side * (bodyW / 2 - 2 * s), sy = shoulderY + 1 * s + ca * side * 2 * s;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.lineWidth = 6 * s;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + ca * reach, sy + sa * reach * 0.75); ctx.stroke();
          ctx.strokeStyle = col(L.robe ? shirt : L.skin);
          ctx.lineWidth = 4.5 * s;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + ca * reach, sy + sa * reach * 0.75); ctx.stroke();
          if (L.robe) box(sx + ca * reach - 2 * s, sy + sa * reach * 0.75 - 2 * s, 4 * s, 4 * s, L.skin);
        }
      }
    };

    if (facingUp) drawArms();
    // legs
    if (L.robe) {
      box(x - bodyW / 2 - 1 * s, y - legH - 2 * s, bodyW + 2 * s, legH + 2 * s, shade(shirt, -0.2));
    } else {
      box(x - bodyW / 2 + 1 * s, y - legH - lift1, bodyW / 2 - 1.5 * s, legH, L.pants);
      box(x + 0.5 * s, y - legH - lift2, bodyW / 2 - 1.5 * s, legH, L.pants);
    }
    // body
    box(x - bodyW / 2, bodyTop, bodyW, bodyH, shirt);
    ctx.fillStyle = col(shade(shirt, 0.15));
    ctx.fillRect(x - bodyW / 2 + 1, bodyTop + 1, bodyW - 2, 2 * s);
    if (L.zombie && !fl) { // torn clothes / wounds
      ctx.fillStyle = L.skin;
      ctx.fillRect(x - bodyW / 2 + 3 * s, bodyTop + 6 * s, 3 * s, 3 * s);
      ctx.fillStyle = 'rgba(110,0,0,0.6)';
      ctx.fillRect(x + 2 * s, bodyTop + 8 * s, 3 * s, 2 * s);
    }
    if (L.fat && !fl) {
      ctx.fillStyle = '#d8e070';
      ctx.fillRect(x - 7 * s, bodyTop + 4 * s, 3 * s, 3 * s);
      ctx.fillRect(x + 5 * s, bodyTop + 8 * s, 4 * s, 4 * s);
      ctx.fillRect(x - 2 * s, bodyTop + 10 * s, 2 * s, 2 * s);
    }
    if (L.glow && !fl) {
      ctx.fillStyle = L.glow;
      ctx.globalAlpha = 0.6 + Math.sin((o.t || 0) * 5) * 0.3;
      ctx.fillRect(x - 3 * s, bodyTop + 4 * s, 6 * s, 6 * s);
      ctx.globalAlpha = 1;
    }
    // head
    const hx = x - headW / 2 + ca * 1.5 * s;
    if (L.horns) {
      ctx.fillStyle = col(L.horns);
      ctx.beginPath(); ctx.moveTo(hx + 1 * s, headTop + 2 * s); ctx.lineTo(hx - 2 * s, headTop - 6 * s); ctx.lineTo(hx + 4 * s, headTop); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + headW - 1 * s, headTop + 2 * s); ctx.lineTo(hx + headW + 2 * s, headTop - 6 * s); ctx.lineTo(hx + headW - 4 * s, headTop); ctx.fill();
    }
    box(hx, headTop, headW, headH, facingUp && o.hair ? o.hair : L.skin);
    // hair / scalp top
    if (o.hair) {
      ctx.fillStyle = col(o.hair);
      ctx.fillRect(hx, headTop, headW, 3.5 * s);
      if (!facingUp) {
        ctx.fillRect(hx, headTop, 2 * s, 6 * s);
        ctx.fillRect(hx + headW - 2 * s, headTop, 2 * s, 6 * s);
      }
    } else if (L.zombie) {
      ctx.fillStyle = col(shade(L.skin, -0.25));
      ctx.fillRect(hx + 2 * s, headTop + 1 * s, 4 * s, 2 * s);
    }
    if (!facingUp && !fl) {
      const ex = x + ca * 3.5 * s, ey = headTop + 5.5 * s + Math.max(0, sa) * 1.5 * s;
      ctx.fillStyle = L.eye;
      const es = (L.big ? 2.2 : 2.6) * s;
      ctx.fillRect(ex - 3.5 * s, ey, es, es);
      ctx.fillRect(ex + 1.5 * s, ey, es, es);
      if (L.zombie || L.robe) { // mouth
        ctx.fillStyle = 'rgba(40,0,0,0.7)';
        ctx.fillRect(ex - 2 * s, ey + 4 * s, 4 * s, 1.5 * s);
      }
    }
    if (!facingUp) drawArms();
    if (o.burn && !fl) {
      ctx.fillStyle = 'rgba(255,120,20,0.35)';
      ctx.fillRect(x - bodyW / 2, headTop, bodyW, y - headTop);
    }
  }

  // ------------------------------------------------- structures --
  drawBarricade(ctx, x, y, hp, t) {
    const x0 = x - 15, y0 = y - 15, h = 22;
    ctx.fillStyle = '#6b4a2b';
    ctx.fillRect(x0, y0 + 30 - h, 30, h);
    ctx.fillStyle = '#9b7243';
    ctx.fillRect(x0, y0 - h, 30, 30);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let k = 6; k < 30; k += 8) ctx.fillRect(x0, y0 - h + k, 30, 2);
    ctx.fillStyle = '#5d6168';
    ctx.fillRect(x0 + 4, y0 - h, 4, 30);
    ctx.fillRect(x0 + 22, y0 - h, 4, 30);
    ctx.fillRect(x0 + 4, y0 + 30 - h, 4, h);
    ctx.fillRect(x0 + 22, y0 + 30 - h, 4, h);
    if (hp < 66) {
      ctx.strokeStyle = 'rgba(20,10,0,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0 + 10, y0 - h + 4); ctx.lineTo(x0 + 15, y0 - h + 14); ctx.lineTo(x0 + 12, y0 - h + 24); ctx.stroke();
      if (hp < 33) { ctx.beginPath(); ctx.moveTo(x0 + 20, y0 - h + 8); ctx.lineTo(x0 + 17, y0 - h + 18); ctx.lineTo(x0 + 22, y0 + 4); ctx.stroke(); }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 - h + 0.5, 29, 30 + h - 1);
    this.miniBar(ctx, x, y0 - h - 6, hp, '#d9a441');
  }

  drawMine(ctx, x, y, t) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4a4f44';
    ctx.beginPath(); ctx.ellipse(x, y - 1, 8, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6a7060';
    ctx.beginPath(); ctx.ellipse(x, y - 2, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = (t * 3) % 1 < 0.5 ? '#ff3020' : '#501010';
    ctx.fillRect(x - 1, y - 4, 2, 2);
  }

  drawSentry(ctx, x, y, a, hp, t) {
    // tripod
    ctx.strokeStyle = '#2c2f33';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y - 12); ctx.lineTo(x - 10, y + 4);
    ctx.moveTo(x, y - 12); ctx.lineTo(x + 10, y + 4);
    ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 7);
    ctx.stroke();
    // gun head
    const ca = Math.cos(a), sa = Math.sin(a);
    const hy = y - 18;
    if (sa < 0) this.sentryBarrel(ctx, x, hy, ca, sa);
    ctx.fillStyle = '#5b6470';
    ctx.fillRect(x - 8, hy - 6, 16, 12);
    ctx.fillStyle = '#7d8896';
    ctx.fillRect(x - 8, hy - 8, 16, 4);
    ctx.fillStyle = '#ff4030';
    ctx.fillRect(x - 2 + ca * 3, hy - 2, 3, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 7.5, hy - 7.5, 15, 13);
    if (sa >= 0) this.sentryBarrel(ctx, x, hy, ca, sa);
    this.miniBar(ctx, x, y - 34, hp, '#7fd0ff');
  }

  sentryBarrel(ctx, x, hy, ca, sa) {
    ctx.strokeStyle = '#1d1f22';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x + ca * 18, hy + sa * 13); ctx.stroke();
  }

  miniBar(ctx, x, y, pct, color) {
    if (pct >= 100) return;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 13, y - 1, 26, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x - 12, y, 24 * Math.max(0, pct) / 100, 2);
  }

  // ------------------------------------------------------ items --
  drawItem(ctx, kind, x, y, t, id) {
    const bob = Math.sin(t * 3 + id) * 2.5;
    const h = 10 + bob;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
    const by = y - h;
    if (kind === 0) {
      ctx.fillStyle = '#4c5a2c'; ctx.fillRect(x - 9, by - 2, 18, 10);
      ctx.fillStyle = '#6a7d3c'; ctx.fillRect(x - 9, by - 8, 18, 6);
      ctx.fillStyle = '#e8c040';
      for (let k = 0; k < 3; k++) ctx.fillRect(x - 6 + k * 5, by, 2, 6);
    } else {
      ctx.fillStyle = '#d8d8d8'; ctx.fillRect(x - 9, by - 2, 18, 10);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 9, by - 8, 18, 6);
      ctx.fillStyle = '#e02a2a';
      ctx.fillRect(x - 2, by - 1, 4, 8);
      ctx.fillRect(x - 5, by + 1, 10, 4);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 8.5, by - 7.5, 17, 15);
  }

  // ------------------------------------------------- projectiles --
  drawProj(ctx, kind, x, y, vx, vy, t) {
    if (kind === 0) {
      const a = Math.atan2(vy, vx);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(x, y, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(x, y - 14);
      ctx.rotate(a);
      ctx.fillStyle = '#4c5638'; ctx.fillRect(-8, -3, 14, 6);
      ctx.fillStyle = '#c03020'; ctx.fillRect(6, -3, 4, 6);
      ctx.fillStyle = '#ffd060'; ctx.fillRect(-12, -2, 4, 4);
      ctx.restore();
    } else {
      const big = kind === 2;
      const r = big ? 7 : 5.5;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
      const yy = y - 14;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, yy, 0, x, yy, r * 3);
      g.addColorStop(0, big ? 'rgba(255,90,40,0.9)' : 'rgba(255,170,40,0.9)');
      g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, yy, r * 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = big ? '#ffd0b0' : '#fff2b0';
      ctx.beginPath(); ctx.arc(x, yy, r * 0.6 + Math.sin(t * 20) * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ------------------------------------------------- lighting --
  // lights: [{x,y,r,i}] world coords; ambient darkness from theme
  drawLighting(lights, extraDark = 0) {
    const { lctx, light, scale } = this;
    const dark = Math.min(0.85, (this.theme.dark || 0.3) + extraDark);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = `rgba(4,4,12,${dark})`;
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalCompositeOperation = 'destination-out';
    for (const L of lights) {
      const [sx, sy] = this.toScreen(L.x, L.y);
      const r = L.r * scale / LIGHT_DIV;
      const x = sx / LIGHT_DIV, y = sy / LIGHT_DIV;
      if (x < -r || y < -r || x > light.width + r || y > light.height + r) continue;
      const g = lctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${L.i})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(light, 0, 0, this.canvas.width, this.canvas.height);
  }
}

// ---------------------------------------------------------- weapon art --
export const GUNS = {
  pistol: { len: 9, w: 3.5, color: '#2a2a2e' },
  smg: { len: 13, w: 4.5, color: '#33363c', accent: '#555' },
  shotgun: { len: 18, w: 4, color: '#5a3d22', accent: '#2a2a2a' },
  barricade: { len: 8, w: 6, color: '#9b7243' },
  rifle: { len: 19, w: 4, color: '#2e3a2a', accent: '#151515' },
  mine: { len: 6, w: 6, color: '#4a4f44' },
  rail: { len: 21, w: 5, color: '#3a4a5c', accent: '#5ff0ff' },
  flame: { len: 16, w: 5, color: '#7a3020', accent: '#e8a030' },
  rocket: { len: 20, w: 6.5, color: '#4c5638', accent: '#c03020' },
  sentry: { len: 9, w: 6, color: '#5b6470' },
};

// Small HUD icon for each weapon, drawn in a 44x22 box centred at (x,y).
export function drawWeaponIcon(ctx, id, x, y, sc = 1, color = '#e8e0d0') {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sc, sc);
  ctx.fillStyle = color;
  const R = (a, b, c, d) => ctx.fillRect(a, b, c, d);
  switch (id) {
    case 'pistol': R(-9, -5, 16, 5); R(-9, 0, 5, 7); R(-4, 0, 2, 3); break;
    case 'smg': R(-12, -5, 22, 5); R(-4, 0, 4, 9); R(-12, 0, 4, 5); R(10, -4, 4, 2); break;
    case 'shotgun': R(-18, -4, 34, 3); R(-18, -1, 12, 3); R(-22, -3, 6, 7); R(-2, 0, 8, 2); break;
    case 'barricade': R(-9, -9, 18, 18); ctx.clearRect(-6, -6, 12, 12); R(-6, -1, 12, 2); R(-1, -6, 2, 12); break;
    case 'rifle': R(-18, -4, 30, 4); R(12, -3, 8, 2); R(-4, 0, 4, 8); R(4, 0, 3, 5); R(-22, -4, 6, 7); break;
    case 'mine': ctx.beginPath(); ctx.ellipse(0, 1, 11, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#e04030'; R(-2, -5, 4, 4); break;
    case 'rail': R(-18, -5, 34, 6); R(-22, -3, 6, 8); R(-6, 1, 4, 7); ctx.fillStyle = '#5ff0ff'; for (let k = 0; k < 4; k++) R(-12 + k * 6, -6, 3, 8); break;
    case 'flame': R(-6, -4, 22, 4); R(-14, -7, 8, 14); R(-2, 0, 4, 7); ctx.fillStyle = '#f0a030'; R(16, -5, 4, 6); break;
    case 'rocket': R(-18, -5, 32, 8); ctx.fillStyle = '#e04030'; R(14, -6, 6, 10); ctx.fillStyle = color; R(-4, 3, 4, 6); break;
    case 'sentry': R(-6, -10, 14, 9); R(8, -7, 10, 3); ctx.fillRect(-1, -1, 2, 6); R(-8, 5, 16, 2); R(-9, 7, 3, 3); R(6, 7, 3, 3); break;
  }
  ctx.restore();
}
