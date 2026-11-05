// Client-side game: interpolation, local movement prediction, effects and HUD.
import { T, LOOKS, CHARS, BLOOD, GUNS, VIP_LOOK, drawWeaponIcon, shade, eliteLook } from './render.js';
import * as A from './audio.js';

const INTERP = 0.11;          // seconds of interpolation delay
const SEND_RATE = 1 / 30;
const HAIR = ['#3a2a1e', '#d0a040', '#1a1a1a', '#8a3a1a', '#e8dcc0', '#5a3a2a', '#2a2a3a', '#b0602a'];
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const PERK_KEYS = ['z', 'x', 'c'];
const USE_TEXT = { 1: 'Take apart', 2: 'Hack', 3: 'Drop fuel' };
// objective spots: label for the off-screen arrows, and colour of the floor ring
const SITE_INFO = {
  term: { label: 'HACK', color: '#5ff0ff' },
  gen: { label: 'GENERATOR', color: '#ffd030' },
  hold: { label: 'HOLD', color: '#c890ff', ring: '200,144,255' },
  evac: { label: 'EXTRACT', color: '#7fff8f', ring: '127,255,143' },
  fix: { label: 'DOOR', color: '#5ff0ff' },
};
const TASK_TEXT = {
  clear: ['CLEAR THE ZONE', 'Kill every undead to open the door'],
  nests: ['DESTROY THE NESTS', 'They keep hatching until you burn them out'],
  hack: ['HACK THE TERMINAL', 'Hold [F] next to it. You can\'t shoot while you work: have someone guard you'],
  fuel: ['RESTART THE GENERATOR', 'Carry the fuel cans to it. Your hands are full: pistol only'],
  hold: ['HOLD THE CIRCLE', 'Keep at least one survivor inside until it fills up'],
  charge: ['GUARD THE BREACH CHARGE', 'It will blow the door. Don\'t let them reach it'],
  fix: ['COVER DR. BLOCK', 'They work on the door, but stop whenever an undead gets close'],
  boss: ['KILL THE BOSS', 'The door stays shut until it is dead'],
  extract: ['GET TO THE EXTRACTION POINT', 'Everyone still standing has to be inside the circle'],
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, f) => a + (b - a) * f;
function lerpAngle(a, b, f) {
  let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * f;
}

export class ClientGame {
  constructor(renderer, net, start, roster, hooks) {
    this.r = renderer;
    this.net = net;
    this.hooks = hooks;           // { openChat() }
    this.vip = start.vip || null;
    this.ffOn = !!start.ff && start.ff !== 'off';
    this.menuOpen = false;
    this.ffNoteT = 0;
    this.myId = start.you;
    this.map = start.map;
    this.weapons = start.weapons;
    this.upgrades = start.upgrades;
    this.diff = start.diff;
    this.ups = 0;
    this.ws = this.weapons;        // weapon stats with my upgrades applied (fire rate, ammo cap)
    this.etypes = start.enemies;
    this.mode = start.mode || 'classic';
    this.mission = start.mission;
    this.perkDefs = start.perks || [];
    this.mutDefs = Object.fromEntries((start.mutators || []).map(m => [m.id, m]));
    this.perks = this.perkDefs.map(() => 0);
    this.offer = null;            // three PERKS indices to pick from
    this.picks = 0;
    this.perkRects = [];          // screen rects of the perk cards (for clicks)
    this.weaponRects = [];        // screen rects of the weapon slots (touch only): [x, y, w, h, weapon]
    this.touch = false;           // touch controls in use: the HUD makes room for the thumbs
    this.touchMove = null;        // move stick: { x, y, gait } with x, y a unit vector and gait 0-1
    this.touchAim = null;         // fire stick direction in radians, null when it isn't being dragged
    this.paused = false;
    this.isHost = false;
    this.switchT = 0;             // weapon-switch popup timer
    this.speed = start.speed;
    this.pr = start.pr;
    this.roster = roster;
    renderer.setMap(this.map);
    const m = this.map;
    this.solid = new Uint8Array(m.w * m.h);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const ch = m.rows[y][x];
      if (ch === '#' || ch === 'B' || ch === 'T' || ch === 'D') this.solid[y * m.w + x] = 1;
    }
    this.doorMask = 0;
    this.fogX = this.fogTarget();     // world x where the hidden part of the map starts
    this.structTiles = new Set();
    this.snaps = [];
    this.evq = [];
    this.off = null;
    this.me = { x: 0, y: 0, a: 0, init: false };
    this.weapon = 0;
    this.un = 1;
    this.priv = { am: this.weapons.map((w, i) => (i ? 0 : -1)), k: 0, ps: 0, cb: 0, ct: 0 };
    this.lastTp = -1;
    this.keys = new Set();
    this.mouse = { x: renderer.cw / 2, y: renderer.ch / 2, down: false };
    this.aimMode = 'keys';       // 'keys' (Space fires where you face) until the mouse is used
    this.fireKey = false;
    this.lockKey = false;        // Shift: hold the keyboard aim without firing
    this.useKey = false;         // F
    this.useMouse = false;       // right mouse button
    this.keyAim = 0;
    this.assist = null;          // enemy the keyboard aim-assist locked on to
    this.particles = [];
    this.texts = [];
    this.tracers = [];
    this.lights = [];
    this.announces = [];
    this.chatLines = [];
    this.anim = new Map();
    this.flash = new Map();
    this.shake = 0;
    this.cam = null;
    this.fireCd = 0;
    this.sendT = 0;
    this.time = 0;
    this.hurtT = 0;
    this.groanT = 2;
    this.showScores = false;
    this.chatting = false;
    this.recoil = 0;
    this.ping = 0;
    this.latest = null;
    this.view = null;
    this.myState = 2;
  }

  // ------------------------------------------------------------ network --
  onSnapshot(s) {
    if (this.paused && !s.pz) this.off = null;   // resumed: the server clock jumped ahead of ours
    this.paused = !!s.pz;
    const now = performance.now() / 1000;
    const sample = s.tm - now;
    if (this.off === null || sample > this.off) this.off = sample;
    else this.off += (sample - this.off) * 0.02;
    s.P = new Map(s.p.map(a => [a[0], a]));
    s.E = new Map(s.e.map(a => [a[0], a]));
    s.R = new Map(s.pr.map(a => [a[0], a]));
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    if (s.ev.length) this.evq.push(s);
    if (this.evq.length > 30) this.evq.splice(0, this.evq.length - 30);
    this.latest = s;
    // structure tiles block movement locally too
    this.structTiles.clear();
    for (const st of s.st) if (st[1] !== 1) this.structTiles.add(Math.floor(st[3] / T) * this.map.w + Math.floor(st[2] / T));
    const me = s.me || {};
    if (me.am) this.priv = me;
    if (me.up !== undefined) this.ups = me.up;
    // weapon stats / perks are only sent when they change
    if (me.ws) this.ws = this.weapons.map((w, i) => ({ ...w, rate: me.ws[i][0], ammo: me.ws[i][1] }));
    if (me.sp) this.speed = me.sp;
    if (me.pk) this.perks = me.pk;
    if (me.po !== undefined) { this.offer = me.po || null; this.picks = me.pp || 0; }
    this.un = s.un;
    if (!(this.un >> this.weapon & 1) || me.cr) this.weapon = 0;
    if (s.dm !== undefined && s.dm !== this.doorMask) this.openDoors(s.dm);
    const mine = s.P.get(this.myId);
    if (mine) {
      this.myState = mine[6];
      if (!this.me.init) {
        this.me.x = mine[1]; this.me.y = mine[2]; this.me.init = true;
      }
    }
    if (me.tp && me.tp[2] !== this.lastTp) {
      this.lastTp = me.tp[2];
      this.me.x = me.tp[0];
      this.me.y = me.tp[1];
      this.me.init = true;
    }
  }

  // doors the host opened stop being solid here too
  openDoors(mask) {
    const m = this.map;
    (m.zones || []).forEach((z, i) => {
      if (!z.door || !(mask >> i & 1) || this.doorMask >> i & 1) return;
      const d = z.door;
      for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) this.solid[y * m.w + x] = 0;
    });
    this.doorMask = mask;
  }

  fogTarget() {
    const zs = this.map.zones;
    if (!zs) return Infinity;
    const z = zs.find((q, i) => q.door && !(this.doorMask >> i & 1));
    return z ? (z.door.x + z.door.w) * T : Infinity;
  }

  // everyone in the snapshots, including Dr. Block who isn't in the room's roster
  who(id) {
    if (this.vip && id === this.vip.id) return { ...this.vip, look: VIP_LOOK };
    return this.roster.get(id) || { color: '#888', name: '?' };
  }

  serverNow() {
    return performance.now() / 1000 + (this.off || 0);
  }

  // ------------------------------------------------------- interpolate --
  interp(rt) {
    const S = this.snaps;
    if (!S.length) return null;
    let a = S[0], b = S[0];
    for (let i = S.length - 1; i >= 0; i--) {
      if (S[i].tm <= rt) { a = S[i]; b = S[i + 1] || S[i]; break; }
    }
    const f = b === a ? 0 : clamp((rt - a.tm) / (b.tm - a.tm), 0, 1);
    const players = b.p.map(p => {
      const q = a.P.get(p[0]);
      const ang = p[3] / 100;
      return {
        id: p[0], x: q ? lerp(q[1], p[1], f) : p[1], y: q ? lerp(q[2], p[2], f) : p[2],
        a: q ? lerpAngle(q[3] / 100, ang, f) : ang, hp: p[4], w: p[5], state: p[6], rev: p[7],
        shooting: p[8], mult: p[9], downT: p[10], kills: p[11], score: p[12], maxhp: p[13] || 100, carry: p[14] & 1, busy: p[14] & 2,
      };
    });
    const enemies = b.e.map(e => {
      const q = a.E.get(e[0]);
      return {
        id: e[0], type: this.etypes[e[1]], x: q ? lerp(q[2], e[2], f) : e[2], y: q ? lerp(q[3], e[3], f) : e[3],
        a: q ? lerpAngle(q[4] / 10, e[4] / 10, f) : e[4] / 10, hp: e[5], burn: e[6],
        elite: e[7] & 1, mode: (e[7] >> 1) & 3, shield: e[7] & 8,
      };
    });
    const projs = b.pr.map(p => {
      const q = a.R.get(p[0]);
      return { id: p[0], kind: p[1], x: q ? lerp(q[2], p[2], f) : p[2], y: q ? lerp(q[3], p[3], f) : p[3],
        vx: q ? p[2] - q[2] : 1, vy: q ? p[3] - q[3] : 0 };
    });
    return { players, enemies, projs, items: b.it, structs: b.st, hazards: b.hz || [], sites: b.zs || [] };
  }

  // ------------------------------------------------------------- input --
  keyDown(e) {
    const k = e.key.toLowerCase();
    if (k === 'tab') { this.showScores = true; e.preventDefault(); return; }
    if (k === ' ') { this.fireKey = true; this.aimMode = 'keys'; return; }
    if (k === 'shift') { this.lockKey = true; this.aimMode = 'keys'; return; }
    if (k === 'f') { this.useKey = true; return; }
    this.keys.add(k);
    const pi = PERK_KEYS.indexOf(k);
    if (pi >= 0 && this.offer && this.offer[pi] !== undefined) { this.pickPerk(pi); return; }
    const idx = KEYS.indexOf(e.key);
    if (idx >= 0) this.select(idx);
    else if (k === 'q') this.cycle(-1);
    else if (k === 'e') this.cycle(1);
    else if (k === 'm') {
      const muted = A.toggleMute();
      this.announce(muted ? 'SOUND OFF' : 'SOUND ON', '', 1.2, true);
    } else if (k === 'enter') { e.preventDefault(); this.hooks.openChat(); }
  }

  keyUp(e) {
    const k = e.key.toLowerCase();
    if (k === 'tab') { this.showScores = false; e.preventDefault(); }
    if (k === ' ') this.fireKey = false;
    if (k === 'shift') this.lockKey = false;
    if (k === 'f') this.useKey = false;
    this.keys.delete(k);
  }

  clearInput() {
    this.keys.clear();
    this.mouse.down = false;
    this.fireKey = false;
    this.lockKey = false;
    this.useKey = false;
    this.useMouse = false;
    this.showScores = false;
    this.touchMove = null;
    this.touchAim = null;
  }

  pickPerk(i) {
    this.net.send({ t: 'perk', i });
    this.offer = null;     // hide until the host confirms (and maybe sends the next offer)
    A.play('click', 1);
  }

  // click on a HUD element (perk cards, and weapon slots on touch); true if the click was used
  clickUI(x, y) {
    const inside = r => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    const i = this.offer ? this.perkRects.findIndex(inside) : -1;
    if (i >= 0) { this.pickPerk(i); return true; }
    const slot = this.weaponRects.find(inside);
    if (slot) { this.select(slot[4]); return true; }
    return false;
  }

  // label of the use button for what the host says it would do right now
  useText(kind) { return USE_TEXT[kind] || 'Use'; }

  // on-screen hints name the keys; rephrase them when playing by touch
  hint(s) {
    if (!this.touch || !s) return s;
    return s.replace(/ \[Z\] \[X\] \[C\]( or click a card)?/, '').replace(/\s*\[\d\]/, '').replace(/\[F\]/, 'USE');
  }

  select(i) {
    if (i < 0 || i >= this.weapons.length || !(this.un >> i & 1) || i === this.weapon) return;
    if (this.priv.cr) { this.announce('HANDS FULL', 'Only the pistol while you carry fuel. [F] drops it', 1.4, true); return; }
    this.weapon = i;
    this.switchT = 1.3;
    this.fireCd = Math.max(this.fireCd, 0.12);
    A.play('click', 0.7);
  }

  cycle(dir) {
    const n = this.weapons.length;
    for (let k = 1; k < n; k++) {
      const i = (this.weapon + dir * k + n * 2) % n;
      if (this.un >> i & 1) { this.select(i); return; }
    }
  }

  autoSwitch() {
    for (let i = this.weapons.length - 1; i >= 0; i--) {
      if (this.un >> i & 1 && this.priv.am[i] !== 0 && this.weapons[i].kind !== 'place') { this.select(i); return; }
    }
  }

  // ----------------------------------------------------------- collide --
  isSolid(tx, ty) {
    const m = this.map;
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const i = ty * m.w + tx;
    return this.solid[i] === 1 || this.structTiles.has(i);
  }

  collide(x, y, r) {
    for (let it = 0; it < 3; it++) {
      let moved = false;
      const tx0 = Math.floor((x - r) / T), tx1 = Math.floor((x + r) / T);
      const ty0 = Math.floor((y - r) / T), ty1 = Math.floor((y + r) / T);
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.isSolid(tx, ty)) continue;
        const cx = clamp(x, tx * T, tx * T + T), cy = clamp(y, ty * T, ty * T + T);
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          x += dx / d * (r - d); y += dy / d * (r - d);
        } else {
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

  // ------------------------------------------------------------ update --
  update(dt) {
    this.time += dt;
    if (!this.latest) return;
    const rt = this.serverNow() - INTERP;
    while (this.evq.length && (this.evq[0].tm <= rt || this.evq.length > 6)) this.handleEvents(this.evq.shift().ev);
    this.view = this.interp(rt);
    this.switchT = Math.max(0, this.switchT - dt);
    this.ffNoteT = Math.max(0, this.ffNoteT - dt);
    const alive = this.myState === 0 && !this.paused;
    const frozen = this.chatting || this.menuOpen;
    const r = this.r;
    const target = this.fogTarget();
    if (target === Infinity) this.fogX = this.fogX < Infinity ? this.fogX + dt * 900 : Infinity;
    else this.fogX += clamp(target - this.fogX, -dt * 900, dt * 900);
    if (this.fogX > this.map.w * T + 80) this.fogX = Infinity;

    // --- local movement
    if (alive && this.me.init) {
      let mx = 0, my = 0;
      if (!frozen) {
        if (this.keys.has('w') || this.keys.has('arrowup')) my -= 1;
        if (this.keys.has('s') || this.keys.has('arrowdown')) my += 1;
        if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
        if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
        if (this.touchMove) { mx = this.touchMove.x; my = this.touchMove.y; }
      }
      const l = Math.hypot(mx, my);
      // Holding Space (or Shift) locks the aim: the keys only move you, so you can strafe and back away
      if (l > 0 && !this.fireKey && !this.lockKey) this.keyAim = Math.atan2(my, mx);
      if (l > 0) {
        const step = this.speed * dt / l * (this.touchMove ? this.touchMove.gait : 1);
        const n = Math.max(1, Math.ceil(this.speed * dt / 8));
        let x = this.me.x, y = this.me.y;
        for (let i = 0; i < n; i++) [x, y] = this.collide(x + mx * step / n, y + my * step / n, this.pr);
        this.me.x = x; this.me.y = y;
      } else {
        [this.me.x, this.me.y] = this.collide(this.me.x, this.me.y, this.pr);
      }
    }
    // --- aim
    if (this.touchAim !== null) this.keyAim = this.touchAim;
    let wx, wy;
    if (this.aimMode === 'keys') {
      if (this.ws[this.weapon].kind === 'place') {
        // building goes exactly where you face, never towards the nearest enemy
        this.assist = null;
        this.me.a = this.keyAim;
      } else {
        this.me.a = this.assistAim(this.keyAim);
        // while firing the aim tracks the locked target, so strafing around it doesn't lose it
        if (this.fireKey && this.assist) this.keyAim = this.me.a;
      }
      wx = this.me.x + Math.cos(this.keyAim) * 380;
      wy = this.me.y + Math.sin(this.keyAim) * 380;
    } else {
      this.assist = null;
      [wx, wy] = r.toWorld(this.mouse.x, this.mouse.y);
      this.me.a = Math.atan2(wy - (this.me.y - 14), wx - this.me.x);
    }
    const trigger = (this.mouse.down || this.fireKey) && !frozen;
    const using = (this.useKey || this.useMouse) && !frozen;

    // --- local fire feedback (server is authoritative for hits)
    const w = this.ws[this.weapon];
    this.fireCd -= dt;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    const busy = using && this.priv.uk > 0 && this.priv.uk < 3;
    if (alive && trigger && !busy) {
      const ammo = this.priv.am[this.weapon];
      if (ammo === 0) {
        if (this.fireCd <= 0) { A.play('empty', 0.8); this.fireCd = 0.3; this.autoSwitch(); }
      } else if (w.kind !== 'place') {
        let guard = 0;
        while (this.fireCd <= 0 && guard++ < 4) { this.fireCd += w.rate; this.localShot(w); }
      }
    } else if (this.fireCd < 0) this.fireCd = 0;

    // --- send input
    this.sendT -= dt;
    if (this.sendT <= 0 && !this.paused) {
      this.sendT = SEND_RATE;
      this.net.send({ t: 'in', x: +this.me.x.toFixed(1), y: +this.me.y.toFixed(1), a: +this.me.a.toFixed(3),
        f: alive && trigger ? 1 : 0, i: alive && using ? 1 : 0, w: this.weapon });
    }

    // --- ambient effects from state
    if (this.view) {
      for (const p of this.view.players) {
        const isMe = p.id === this.myId;
        const wid = isMe ? this.weapon : p.w;
        const firing = isMe ? alive && trigger && !busy && this.priv.am[wid] !== 0 : p.shooting;
        if (this.weapons[wid] && this.weapons[wid].id === 'flame' && firing && p.state === 0) {
          const px = isMe ? this.me.x : p.x, py = isMe ? this.me.y : p.y, pa = isMe ? this.me.a : p.a;
          this.flameFx(px, py, pa);
        }
      }
      for (const e of this.view.enemies) {
        if (e.type === 'wraith' && Math.random() < dt * 6) this.addP({ t: 'smoke', x: e.x + (Math.random() - 0.5) * 16, y: e.y - 6, z: 8, vx: 0, vy: 0, vz: 12, life: 0.9, size: 4, grow: 6, color: '#8ac8e8' });
        if (e.burn && Math.random() < dt * 14) this.addP({ t: 'fire', x: e.x + (Math.random() - 0.5) * 14, y: e.y, z: 10 + Math.random() * 14, vx: 0, vy: 0, vz: 40, life: 0.4, size: 5 });
      }
      for (const p of this.view.projs) {
        if (p.kind === 0 && Math.random() < 0.9) this.addP({ t: 'smoke', x: p.x, y: p.y, z: 14, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, vz: 5, life: 0.7, size: 4, grow: 14 });
      }
      this.groanT -= dt;
      if (this.groanT <= 0 && this.view.enemies.length) {
        this.groanT = 1.2 + Math.random() * 2.5;
        const e = this.view.enemies[Math.floor(Math.random() * this.view.enemies.length)];
        this.sound(e.type === 'colossus' ? 'roar' : 'groan', e.x, e.y, 0.8);
      }
    }
    this.updateParticles(dt);
    this.hurtT = Math.max(0, this.hurtT - dt * 1.5);

    // --- camera
    let fx = this.me.x, fy = this.me.y;
    if (this.myState === 2 && this.view) {
      const mate = this.view.players.find(p => p.state === 0);
      if (mate) { fx = mate.x; fy = mate.y; this.spectating = mate.id; }
    } else this.spectating = null;
    const look = this.myState === 0 ? 0.18 : 0;
    const tx = fx + (wx - fx) * look, ty = fy + (wy - fy) * look;
    if (!this.cam) this.cam = { x: tx, y: ty };
    const k = 1 - Math.exp(-dt * 10);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  // Keyboard aiming: shoot where you face, but snap to an enemy close to that direction.
  assistAim(base) {
    const prev = this.assist;
    this.assist = null;
    if (!this.view) return base;
    let best = null, bestScore = 1e9;
    for (const e of this.view.enemies) {
      const dx = e.x - this.me.x, dy = e.y - this.me.y, d = Math.hypot(dx, dy);
      if (d > 560 || d < 1) continue;
      let diff = Math.abs(Math.atan2(dy, dx) - base) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      const cone = d < 70 ? 0.9 : 0.38;    // very close enemies get a wider cone
      if (diff > cone) continue;
      // stay on the current target while it is still a decent choice, so the aim doesn't flicker
      const score = d * (1 + diff * 4) * (e.id === prev ? 0.6 : 1);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (!best) return base;
    this.assist = best.id;
    return Math.atan2(best.y - this.me.y, best.x - this.me.x);
  }

  localShot(w) {
    const x = this.me.x, y = this.me.y, a = this.me.a;
    const id = w.id;
    if (id === 'flame') { A.play('flame', 0.7, 0, 0.09); return; }
    A.play(id, id === 'smg' ? 0.7 : 0.9);
    const gx = x + Math.cos(a) * 22, gy = y + Math.sin(a) * 16;
    this.muzzle(gx, gy, a, id === 'shotgun' || id === 'rocket' ? 1.5 : 1, id === 'rail' ? '#7ff8ff' : null);
    if (id !== 'rocket' && id !== 'rail') {
      this.addP({ t: 'shell', x, y, z: 16, vx: -Math.sin(a) * 60 + (Math.random() - 0.5) * 30, vy: Math.cos(a) * 40, vz: 90, life: 1.2, size: 2, grav: 400, stamp: false });
    }
    const kick = { pistol: 1.2, smg: 0.8, shotgun: 4, rifle: 1.5, rail: 5, rocket: 5 }[id] || 1;
    this.shake = Math.max(this.shake, kick);
    this.recoil = 1;
  }

  muzzle(x, y, a, size = 1, color = null) {
    this.lights.push({ x, y, r: 170 * size, i: 0.9, life: 0.06, max: 0.06 });
    this.addP({ t: 'flash', x, y, z: 14, vx: 0, vy: 0, vz: 0, life: 0.05, size: 7 * size, a, color });
  }

  flameFx(x, y, a) {
    for (let i = 0; i < 2; i++) {
      const s = a + (Math.random() - 0.5) * 0.5, sp = 380 + Math.random() * 180;
      this.addP({ t: 'fire', x: x + Math.cos(a) * 18, y: y + Math.sin(a) * 12, z: 14, vx: Math.cos(s) * sp, vy: Math.sin(s) * sp, vz: 10, life: 0.38 + Math.random() * 0.12, size: 5, drag: 3.5, grow: 16 });
    }
    if (Math.random() < 0.5) this.lights.push({ x: x + Math.cos(a) * 80, y: y + Math.sin(a) * 60, r: 240, i: 0.7, life: 0.06, max: 0.06 });
  }

  sound(name, x, y, vol = 1) {
    if (!this.cam) return;
    const d = Math.hypot(x - this.cam.x, y - this.cam.y);
    const v = vol * clamp(1 - d / 950, 0, 1);
    A.play(name, v, clamp((x - this.cam.x) / 600, -1, 1));
  }

  // ------------------------------------------------------------ events --
  handleEvents(evs) {
    const r = this.r;
    for (const e of evs) {
      switch (e[0]) {
        case 'tr': {
          const [, x1, y1, x2, y2, w, pid] = e;
          const wid = w >= 0 ? this.weapons[w].id : 'sentry';
          const mine = pid === this.myId && w >= 0;
          this.tracers.push({ x1, y1, x2, y2, life: wid === 'rail' ? 0.4 : 0.07, max: wid === 'rail' ? 0.4 : 0.07, rail: wid === 'rail', sentry: w < 0 });
          if (!mine) {
            if (wid !== 'smg' || Math.random() < 0.6) this.sound(wid, x1, y1, 0.75);
            const a = Math.atan2(y2 - y1, x2 - x1);
            this.muzzle(x1, y1, a, wid === 'shotgun' ? 1.4 : w < 0 ? 0.6 : 1, wid === 'rail' ? '#7ff8ff' : null);
          }
          // impact dust / sparks
          for (let i = 0; i < 2; i++) this.addP({ t: 'spark', x: x2, y: y2, z: 12, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160, vz: 0, life: 0.12, size: 2 });
          break;
        }
        case 'hit': {
          const [, id, x, y, tid] = e;
          const type = this.etypes[tid];
          this.flash.set(id, this.time + 0.07);
          const col = BLOOD[type];
          for (let i = 0; i < 4; i++) this.addP({ t: 'blood', x, y, z: 12 + Math.random() * 8, vx: (Math.random() - 0.5) * 140, vy: (Math.random() - 0.5) * 140, vz: 40 + Math.random() * 80, life: 2, size: 2 + Math.random() * 2, grav: 500, color: col, stamp: true });
          if (Math.random() < 0.5) this.sound('hit', x, y, 0.5);
          break;
        }
        case 'die': {
          const [, x, y, tid, pts, mult, pid] = e;
          const type = this.etypes[tid];
          const L = LOOKS[type];
          const big = type === 'colossus' || type === 'juggernaut' ? 3 : type === 'brute' || type === 'nest' ? 1.8 : type === 'splitling' ? 0.6 : 1;
          r.splat(x, y, 10 * big, BLOOD[type]);
          for (let i = 0; i < 9 * big; i++) {
            const colr = [L.skin, L.shirt, L.pants, BLOOD[type]][i % 4];
            this.addP({ t: 'gib', x, y, z: 14 * big, vx: (Math.random() - 0.5) * 260, vy: (Math.random() - 0.5) * 260, vz: 80 + Math.random() * 160, life: 3, size: (3 + Math.random() * 3) * Math.sqrt(big), grav: 600, color: colr, stamp: true });
          }
          for (let i = 0; i < 8; i++) this.addP({ t: 'blood', x, y, z: 14, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, vz: 60 + Math.random() * 120, life: 2, size: 3, grav: 500, color: BLOOD[type], stamp: true });
          this.sound('splat', x, y, type === 'colossus' ? 1 : 0.6);
          if (type === 'colossus' || type === 'juggernaut') { this.shake = 14; this.announce(`${type.toUpperCase()} SLAIN`, '', 2.5); }
          if (pts > 0) {
            const info = this.who(pid);
            this.texts.push({ x, y: y - 30, text: `+${pts}` + (mult > 1 ? ` x${mult}` : ''), color: pid ? info.color : '#fff', life: 1.1, max: 1.1, big: pid === this.myId });
          }
          this.anim.delete(e[8]);
          this.flash.delete(e[8]);
          break;
        }
        case 'ex': {
          const [, x, y, rad] = e;
          r.scorch(x, y, rad * 0.55);
          this.lights.push({ x, y, r: rad * 4, i: 1, life: 0.35, max: 0.35 });
          this.addP({ t: 'ring', x, y, z: 0, vx: 0, vy: 0, vz: 0, life: 0.3, size: rad });
          for (let i = 0; i < 26; i++) {
            const a = Math.random() * Math.PI * 2, sp = Math.random() * rad * 2.4;
            this.addP({ t: 'fire', x, y, z: 8 + Math.random() * 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8, vz: 30 + Math.random() * 60, life: 0.35 + Math.random() * 0.3, size: 8 + Math.random() * 6, drag: 4, grow: 20 });
          }
          for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2, sp = Math.random() * rad;
            this.addP({ t: 'smoke', x: x + Math.cos(a) * 10, y: y + Math.sin(a) * 10, z: 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8, vz: 20, life: 1 + Math.random() * 0.8, size: 10, grow: 30, drag: 2 });
          }
          for (let i = 0; i < 8; i++) this.addP({ t: 'gib', x, y, z: 6, vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300, vz: 100 + Math.random() * 150, life: 2, size: 3, grav: 600, color: '#2a2622', stamp: true });
          const d = this.cam ? Math.hypot(x - this.cam.x, y - this.cam.y) : 0;
          this.shake = Math.max(this.shake, clamp(14 - d / 50, 2, 14));
          this.sound('explode', x, y, 1);
          break;
        }
        case 'rk': if (e[1] !== this.myId) { const p = this.latest.P.get(e[1]); if (p) this.sound('rocket', p[1], p[2]); } break;
        case 'orb': this.sound('orb', e[1], e[2], 0.8); break;
        case 'pop':
          for (let i = 0; i < 8; i++) this.addP({ t: 'spark', x: e[1], y: e[2], z: 14, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, vz: 0, life: 0.25, size: 3, color: e[3] === 2 ? '#ff6030' : '#ffb030' });
          this.lights.push({ x: e[1], y: e[2], r: 120, i: 0.7, life: 0.12, max: 0.12 });
          break;
        case 'place': {
          const [, type, x, y] = e;
          this.sound('place', x, y, 0.9);
          for (let i = 0; i < 8; i++) this.addP({ t: 'smoke', x: x + (Math.random() - 0.5) * 26, y: y + 12, z: 2, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 20, vz: 10, life: 0.6, size: 5, grow: 10, color: '#8a7a60' });
          break;
        }
        case 'sx': {
          const [, type, x, y] = e;
          if (type !== 1) {
            this.sound('break', x, y, 1);
            for (let i = 0; i < 14; i++) this.addP({ t: 'gib', x, y, z: 12, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, vz: 60 + Math.random() * 120, life: 2.5, size: 3 + Math.random() * 3, grav: 600, color: type === 0 ? '#9b7243' : '#5b6470', stamp: true });
          }
          break;
        }
        case 'ph': {
          const [, pid, dmg] = e;
          this.flash.set('p' + pid, this.time + 0.1);
          if (pid === this.myId) {
            this.hurtT = Math.min(1, this.hurtT + 0.35 + dmg / 60);
            this.shake = Math.max(this.shake, 4);
            A.play('hurt', 0.9, 0, 0.12);
          }
          const p = this.latest.P.get(pid);
          if (p) for (let i = 0; i < 4; i++) this.addP({ t: 'blood', x: p[1], y: p[2], z: 16, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 120, vz: 60, life: 2, size: 2.5, grav: 500, color: '#a01010', stamp: true });
          break;
        }
        case 'bite': if (Math.random() < 0.6) { const en = this.latest.E.get(e[1]); if (en) this.sound('bite', en[2], en[3], 0.6); } break;
        case 'roar': { const en = this.latest.E.get(e[1]); if (en) { this.sound('roar', en[2], en[3], 1); this.shake = Math.max(this.shake, 5); } break; }
        case 'leap': { const en = this.latest.E.get(e[1]); if (en) this.sound('leap', en[2], en[3], 0.8); break; }
        case 'slam':
          this.shake = Math.max(this.shake, 10);
          this.sound('slam', e[1], e[2], 1);
          for (let i = 0; i < 16; i++) this.addP({ t: 'smoke', x: e[1] + (Math.random() - 0.5) * 40, y: e[2] + (Math.random() - 0.5) * 20, z: 6, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 60, vz: 20, life: 0.9, size: 7, grow: 14, drag: 3, color: '#7a7060' });
          break;
        case 'shd':
          this.sound('clank', e[1], e[2], 0.5);
          for (let i = 0; i < (e[3] ? 14 : 3); i++) this.addP({ t: 'spark', x: e[1], y: e[2], z: 16, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, vz: 0, life: 0.18, size: 2.5, color: '#cfe8ff' });
          if (e[3]) {
            this.sound('break', e[1], e[2], 0.8);
            for (let i = 0; i < 6; i++) this.addP({ t: 'gib', x: e[1], y: e[2], z: 14, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, vz: 80 + Math.random() * 80, life: 2, size: 4, grav: 600, color: '#55657a', stamp: true });
          }
          break;
        case 'heal':
          this.sound('mend', e[1], e[2], 0.7);
          this.addP({ t: 'ring', x: e[1], y: e[2], z: 0, vx: 0, vy: 0, vz: 0, life: 0.5, size: 170, color: '120,255,140' });
          for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2, d = Math.random() * 150;
            this.addP({ t: 'spark', x: e[1] + Math.cos(a) * d, y: e[2] + Math.sin(a) * d * 0.7, z: 10, vx: 0, vy: 0, vz: 40, life: 0.7, size: 3, color: '#7fff8f' });
          }
          this.lights.push({ x: e[1], y: e[2], r: 200, i: 0.5, life: 0.4, max: 0.4 });
          break;
        case 'spit': this.sound('spit', e[1], e[2], 0.7); break;
        case 'acid':
          this.sound('acid', e[1], e[2], 0.6);
          for (let i = 0; i < 10; i++) this.addP({ t: 'blood', x: e[1], y: e[2], z: 8, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 120, vz: 60 + Math.random() * 60, life: 1.5, size: 3, grav: 500, color: '#9ae040', stamp: true });
          break;
        case 'perk': {
          const pk = this.perkDefs[e[2]];
          if (!pk) break;
          if (e[1] === this.myId) {
            A.play('unlock', 0.8);
            this.announce(`${pk.name.toUpperCase()}`, pk.desc, 2.2, true);
          } else this.sysChat(`${this.name(e[1])} took ${pk.name}.`);
          break;
        }
        case 'ff':
          // only nag the shooter now and then; their victim sees the damage flash anyway
          if (e[1] === this.myId && e[2] !== this.myId && this.ffNoteT <= 0) {
            this.ffNoteT = 2.5;
            this.announce('FRIENDLY FIRE!', `You hit ${this.name(e[2])}`, 1.4, true, '#ff8a50');
          }
          break;
        case 'dm': {
          const [, pid, type, refund] = e;
          const p = this.latest.P.get(pid);
          if (p) {
            this.sound('break', p[1], p[2], 0.5);
            if (pid === this.myId) this.texts.push({ x: p[1], y: p[2] - 30, text: refund ? 'TAKEN APART +1' : 'TAKEN APART', color: '#d9a441', life: 1, max: 1 });
          }
          break;
        }
        case 'zone': {
          const zs = this.map.zones.length;
          A.play('wave', 1);
          this.announce(`ZONE ${e[1] + 1} / ${zs}`, e[2] || '', 2.6);
          break;
        }
        case 'task': {
          const tx = TASK_TEXT[e[1]];
          if (tx) this.announce(tx[0], tx[1], 4, true, '#8af0a0');
          break;
        }
        case 'task_ok':
          A.play('task', 0.9);
          this.lights.push({ x: e[1], y: e[2], r: 200, i: 0.7, life: 0.4, max: 0.4 });
          for (let i = 0; i < 16; i++) this.addP({ t: 'spark', x: e[1], y: e[2], z: 16, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, vz: 30, life: 0.5, size: 3, color: '#7fff8f' });
          break;
        case 'door': {
          const d = this.map.zones[e[1]].door;
          A.play('door', 1);
          this.shake = Math.max(this.shake, 9);
          for (let y = d.y; y < d.y + d.h; y++) {
            for (let i = 0; i < 12; i++) this.addP({ t: 'smoke', x: (d.x + Math.random() * d.w) * T, y: (y + Math.random()) * T, z: 6, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 80, vz: 25, life: 1.2, size: 8, grow: 16, drag: 2, color: '#7a7060' });
            this.lights.push({ x: (d.x + 1) * T, y: y * T, r: 220, i: 0.6, life: 0.5, max: 0.5 });
          }
          break;
        }
        case 'zclr':
          A.play('clear', 1);
          this.announce('THE DOOR IS OPEN', 'Pick a perk [Z] [X] [C], restock, then move up', 3.4, false, '#8af0a0');
          break;
        case 'sw':
          A.play('revive', e[1] === this.myId ? 1 : 0.4);
          if (e[1] === this.myId) this.announce('SECOND WIND', 'Back on your feet!', 2, true);
          else this.sysChat(`${this.name(e[1])} got back up (Second Wind).`);
          break;
        case 'win':
          A.play('win', 1);
          this.announce('MISSION COMPLETE', this.mission ? this.mission.name : '', 3, false, '#7fff8f');
          break;
        case 'sum':
          for (let i = 0; i < 20; i++) this.addP({ t: 'smoke', x: e[1] + (Math.random() - 0.5) * 60, y: e[2] + (Math.random() - 0.5) * 40, z: 4, vx: 0, vy: 0, vz: 30, life: 1.2, size: 8, grow: 16, color: '#5a2a6a' });
          break;
        case 'down': {
          const n = this.name(e[1]);
          const by = e[2] && e[2] !== e[1] ? this.name(e[2]) : null;
          if (e[1] === this.myId) { A.play('down', 1); this.announce('YOU ARE DOWN', by ? `Shot by ${by}! A teammate must stand next to you to revive you` : 'A teammate must stand next to you to revive you', 3); }
          else {
            this.sysChat(by ? `${by} shot ${n} down! Go revive them.` : `${n} is down! Go revive them.`);
            A.play('down', 0.6);
            if (this.vip && e[1] === this.vip.id) this.announce(`${n.toUpperCase()} IS DOWN`, 'Revive them or the mission fails!', 3);
          }
          break;
        }
        case 'rev':
          A.play('revive', e[1] === this.myId || e[2] === this.myId ? 1 : 0.4);
          this.sysChat(`${this.name(e[2])} revived ${this.name(e[1])}.`);
          break;
        case 'dead': this.sysChat(`${this.name(e[1])} bled out.`); break;
        case 'pk': {
          const [, pid, kind, x, y, u] = e;
          if (kind === 5) {
            A.play('pickup', pid === this.myId ? 1 : 0.5);
            if (pid === this.myId) this.announce('FUEL PICKED UP', 'Bring it to the generator. Hands full: pistol only', 2.2, true, '#ff8a50');
            break;
          }
          if (kind === 3) {
            A.play('unlock', pid === this.myId ? 1 : 0.6);
            const ob = this.latest && this.latest.ob;
            this.announce('FUEL CAN FOUND', ob ? `${ob[1]} / ${ob[2]}${pid !== this.myId ? ` · ${this.name(pid)}` : ''}` : '', 2, true);
            this.texts.push({ x, y: y - 20, text: '+FUEL', color: '#ff8a50', life: 1.2, max: 1.2, big: true });
            break;
          }
          if (kind === 2) {
            const up = this.upgrades[u];
            const wname = this.weapons[up.w].name;
            if (pid === this.myId) {
              A.play('unlock', 1);
              this.announce(`UPGRADE: ${up.name.toUpperCase()}`, `${wname} · ${up.desc}`, 3.2);
              this.texts.push({ x, y: y - 20, text: up.name, color: '#f2b33a', life: 1.4, max: 1.4, big: true });
            } else this.sysChat(`${this.name(pid)} got ${up.name} (${wname}).`);
            break;
          }
          if (pid === this.myId) {
            A.play(kind === 1 ? 'heal' : 'pickup', 0.9);
            this.texts.push({ x, y: y - 20, text: kind === 1 ? '+HEALTH' : '+AMMO', color: kind === 1 ? '#ff7070' : '#e8d060', life: 1, max: 1 });
          }
          break;
        }
        case 'unl': {
          const w = this.weapons[e[1]];
          A.play('unlock', 1);
          this.announce('NEW WEAPON', `${w.name}  [${KEYS[e[1]]}]`, 3);
          break;
        }
        case 'wave': {
          A.play('wave', 1);
          const bosses = Array.isArray(e[2]) ? e[2].map(t => this.etypes[t]) : [];
          const sub = bosses.length > 1 ? 'Multiple bosses are coming!' : bosses[0] === 'juggernaut' ? 'The Juggernaut is coming! Dodge its charge.'
            : bosses[0] ? 'A Colossus is coming!' : 'Here they come...';
          if (this.map.zones) this.sysChat(sub);
          else this.announce(`WAVE ${e[1]}`, sub, 2.8);
          const muts = (e[3] || []).map(id => this.mutDefs[id]).filter(Boolean);
          if (muts.length && this.mode === 'gauntlet') {
            this.announce(muts.map(m => m.name.toUpperCase()).join(' + '), muts.map(m => m.desc).join(' · '), 3.4, true, '#c890ff');
          }
          break;
        }
        case 'clear':
          A.play('clear', 1);
          this.announce('WAVE CLEARED', this.mode === 'classic' ? 'Fallen survivors are back. Grab the supplies!' : 'Pick a perk! [Z] [X] [C] or click a card', 2.8);
          break;
      }
    }
  }

  name(id) {
    const info = this.who(id);
    return info.name === '?' ? 'Someone' : info.name;
  }

  sysChat(text) {
    this.chatLines.push({ from: '', text, t: this.time });
    if (this.chatLines.length > 8) this.chatLines.shift();
  }

  chat(from, color, text) {
    this.chatLines.push({ from, color, text, t: this.time });
    if (this.chatLines.length > 8) this.chatLines.shift();
  }

  announce(title, sub, dur, small = false, color = null) {
    this.announces = this.announces.filter(a => a.small !== small || small);
    this.announces.push({ title, sub: this.hint(sub), life: dur, max: dur, small, color });
    if (this.announces.length > 3) this.announces.shift();
  }

  // --------------------------------------------------------- particles --
  addP(p) {
    if (this.particles.length > 1800) this.particles.splice(0, 200);
    p.max = p.life;
    this.particles.push(p);
  }

  updateParticles(dt) {
    const r = this.r;
    const ps = this.particles;
    let j = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const drag = p.drag ? Math.exp(-p.drag * dt) : 1;
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grav) {
        p.vz -= p.grav * dt;
        p.z += p.vz * dt;
        if (p.z <= 0) {
          p.z = 0;
          if (p.stamp) {
            if (p.t === 'gib') {
              r.dctx.fillStyle = shade(p.color, -0.2);
              r.dctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
            } else r.stain(p.x, p.y, p.size * 0.9, p.color, 0.75);
            continue;
          }
          p.vz *= -0.35; p.vx *= 0.5; p.vy *= 0.5;
          if (Math.abs(p.vz) < 20) { p.grav = 0; p.vz = 0; p.vx = 0; p.vy = 0; }
        }
      } else {
        p.z += p.vz * dt;
      }
      if (p.grow) p.size += p.grow * dt;
      ps[j++] = p;
    }
    ps.length = j;
    for (const t of this.tracers) t.life -= dt;
    this.tracers = this.tracers.filter(t => t.life > 0);
    for (const l of this.lights) l.life -= dt;
    this.lights = this.lights.filter(l => l.life > 0);
    for (const t of this.texts) { t.life -= dt; t.y -= 30 * dt; }
    this.texts = this.texts.filter(t => t.life > 0);
    for (const a of this.announces) a.life -= dt;
    this.announces = this.announces.filter(a => a.life > 0);
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      const f = p.life / p.max;
      const y = p.y - p.z;
      switch (p.t) {
        case 'blood':
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, y - p.size / 2, p.size, p.size);
          break;
        case 'gib':
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, y - p.size / 2, p.size, p.size);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(p.x - p.size / 2, y, p.size, p.size / 2);
          break;
        case 'shell':
          ctx.fillStyle = '#d8b040';
          ctx.fillRect(p.x - 1.5, y - 1, 3, 2);
          break;
        case 'smoke':
          ctx.globalAlpha = f * 0.45;
          ctx.fillStyle = p.color || '#555';
          ctx.beginPath(); ctx.arc(p.x, y, p.size, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          break;
        case 'ring':
          ctx.strokeStyle = `rgba(${p.color || '255,220,160'},${f * 0.6})`;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size * (1.1 - f), p.size * (1.1 - f) * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
          break;
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const f = p.life / p.max;
      const y = p.y - p.z;
      if (p.t === 'fire') {
        ctx.fillStyle = f > 0.6 ? `rgba(255,230,140,${f * 0.7})` : f > 0.3 ? `rgba(255,140,40,${f * 0.8})` : `rgba(200,50,20,${f})`;
        ctx.beginPath(); ctx.arc(p.x, y, p.size * (0.6 + (1 - f) * 0.6), 0, Math.PI * 2); ctx.fill();
      } else if (p.t === 'spark') {
        ctx.fillStyle = p.color || '#ffe0a0';
        ctx.globalAlpha = f;
        ctx.fillRect(p.x - p.size / 2, y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      } else if (p.t === 'flash') {
        ctx.save();
        ctx.translate(p.x, y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.color || '#fff0b0';
        ctx.beginPath();
        ctx.moveTo(0, -p.size * 0.5); ctx.lineTo(p.size * 2.2, 0); ctx.lineTo(0, p.size * 0.5); ctx.fill();
        ctx.fillStyle = 'rgba(255,200,80,0.6)';
        ctx.beginPath(); ctx.arc(0, 0, p.size, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    // tracers
    for (const t of this.tracers) {
      const f = t.life / t.max;
      if (t.rail) {
        ctx.strokeStyle = `rgba(90,240,255,${f * 0.5})`;
        ctx.lineWidth = 9 * f;
        ctx.beginPath(); ctx.moveTo(t.x1, t.y1 - 14); ctx.lineTo(t.x2, t.y2 - 14); ctx.stroke();
        ctx.strokeStyle = `rgba(230,255,255,${f})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(t.x1, t.y1 - 14); ctx.lineTo(t.x2, t.y2 - 14); ctx.stroke();
      } else {
        const g = ctx.createLinearGradient(t.x1, t.y1, t.x2, t.y2);
        g.addColorStop(0, 'rgba(255,240,180,0)');
        g.addColorStop(1, t.sentry ? `rgba(160,220,255,${f})` : `rgba(255,230,150,${f})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(t.x1, t.y1 - 14); ctx.lineTo(t.x2, t.y2 - 14); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ render --
  render() {
    const r = this.r;
    const v = this.view;
    if (!v || !this.cam) {
      r.ctx.setTransform(1, 0, 0, 1, 0, 0);
      r.ctx.fillStyle = '#000';
      r.ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
      return;
    }
    const sh = this.shake;
    r.begin(this.cam.x + (Math.random() - 0.5) * sh, this.cam.y + (Math.random() - 0.5) * sh);
    const ctx = r.ctx;
    r.drawGround();
    const t = this.time;
    const drawables = [];
    const lights = [];

    // acid pools and mines (flat, on ground)
    for (const h of v.hazards) {
      r.drawHazard(ctx, h[1], h[2], h[3], h[4], t, h[0]);
      lights.push({ x: h[1], y: h[2], r: 70, i: 0.35 });
    }
    for (const s of v.structs) if (s[1] === 1) r.drawMine(ctx, s[2], s[3], t + s[0]);
    // standing areas are painted on the floor; consoles stand in the scene with everything else
    for (const s of v.sites) {
      const [kind, x, y, rad, pct, stalled] = s;
      if (kind === 'hold' || kind === 'evac') {
        r.drawRing(ctx, x, y, rad, pct, t, SITE_INFO[kind].ring);
        lights.push({ x, y, r: rad * 2.4, i: 0.55 });
      } else if (kind === 'term' || kind === 'fix') {
        drawables.push({ y: y + 12, draw: c => r.drawTerminal(c, x, y, pct, t, stalled) });
        lights.push({ x, y: y - 16, r: 120, i: 0.75 });
      } else if (kind === 'gen') {
        r.shadow(x, y + 6, 18);
        drawables.push({ y: y + 15.5, draw: c => r.drawGenerator(c, x, y, 100, pct >= 100 ? t : 0) });
        lights.push({ x, y: y - 10, r: 200, i: 0.7 });
      }
    }
    // blast doors, one tile row at a time so characters sort correctly against them
    (this.map.zones || []).forEach((z, i) => {
      const d = z.door;
      if (!d || this.doorMask >> i & 1) return;
      for (let ty = d.y; ty < d.y + d.h; ty++) {
        drawables.push({ y: (ty + 1) * T - 0.5, draw: c => r.drawDoor(c, d.x * T, ty * T, d.w * T, ty === d.y + d.h - 1, t) });
      }
      lights.push({ x: (d.x + d.w / 2) * T, y: (d.y + d.h / 2) * T, r: 150, i: 0.55 });
    });

    // players
    for (const p of v.players) {
      if (p.state === 2) continue;
      const isMe = p.id === this.myId;
      const x = isMe && p.state === 0 ? this.me.x : p.x;
      const y = isMe && p.state === 0 ? this.me.y : p.y;
      const a = isMe ? this.me.a : p.a;
      const info = this.who(p.id);
      const ph = this.walk('p' + p.id, x, y, 0.2);
      const wid = isMe ? this.weapons[this.weapon].id : this.weapons[p.w].id;
      const flash = (this.flash.get('p' + p.id) || 0) > t;
      r.shadow(x, y, 12);
      const rec = isMe ? this.recoil * 3 : 0;
      const look = info.look || CHARS[info.char] || CHARS[0];
      const gun = info.look || p.busy ? null : GUNS[wid];   // Dr. Block is unarmed, and working a console takes both hands
      drawables.push({ y, draw: c => r.drawChar(c, { x: x - Math.cos(a) * rec, y: y - Math.sin(a) * rec, a, look, shirt: info.color, hair: look.hair ? HAIR[p.id % HAIR.length] : null, phase: ph, gun, down: p.state === 1, flash, t, id: p.id }) });
      lights.push({ x, y: y - 10, r: isMe ? 380 : 300, i: isMe ? 0.95 : 0.8 });
    }
    // enemies
    for (const e of v.enemies) {
      if (e.type === 'nest') {
        r.shadow(e.x, e.y, 20);
        const fl = (this.flash.get(e.id) || 0) > t;
        drawables.push({ y: e.y, draw: c => r.drawNest(c, e.x, e.y, e.hp, t, e.id, fl) });
        lights.push({ x: e.x, y: e.y - 20, r: 120, i: 0.6 });
        continue;
      }
      const L = e.elite ? eliteLook(e.type) : LOOKS[e.type];
      const ph = this.walk(e.id, e.x, e.y, e.type === 'sprinter' || e.type === 'splitling' ? 0.3 : 0.18);
      if (!L.ghost) r.shadow(e.x, e.y, 10 * L.s * (L.fat ? 1.3 : 1));
      if (e.elite) {
        ctx.strokeStyle = `rgba(255,200,60,${0.55 + Math.sin(t * 6 + e.id) * 0.25})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(e.x, e.y, 15 * L.s, 7 * L.s, 0, 0, Math.PI * 2); ctx.stroke();
        lights.push({ x: e.x, y: e.y - 10, r: 90, i: 0.5 });
      }
      // wind-up telegraph: blink red
      const flash = (this.flash.get(e.id) || 0) > t || (e.mode === 1 && (t * 12) % 1 < 0.5);
      const boss = e.type === 'colossus' || e.type === 'juggernaut';
      drawables.push({ y: e.y, draw: c => {
        r.drawChar(c, { x: e.x, y: e.y, a: e.a, look: L, phase: e.mode === 3 ? 0 : ph, flash, burn: e.burn, t, id: e.id, shieldUp: e.shield });
        if (e.hp < 100) r.miniBar(c, e.x, e.y - 44 * L.s - 4, e.hp, boss ? '#ff5a2a' : e.elite ? '#ffc040' : '#d84030');
      } });
      if (boss) lights.push({ x: e.x, y: e.y - 30, r: 200, i: 0.6 });
      if (e.type === 'warlock' || e.type === 'shaman' || e.type === 'spitter') lights.push({ x: e.x, y: e.y - 20, r: 70, i: 0.5 });
      if (e.type === 'wraith') lights.push({ x: e.x, y: e.y - 20, r: 60, i: 0.35 });
    }
    // structures
    for (const s of v.structs) {
      if (s[1] === 0) drawables.push({ y: s[3] + 15.5, draw: c => r.drawBarricade(c, s[2], s[3], s[4], t) });
      else if (s[1] === 2) {
        r.shadow(s[2], s[3] + 4, 12);
        drawables.push({ y: s[3] + 15.5, draw: c => r.drawSentry(c, s[2], s[3] + 8, s[5] / 10, s[4], t) });
        lights.push({ x: s[2], y: s[3], r: 110, i: 0.5 });
      } else if (s[1] === 3) {
        r.shadow(s[2], s[3] + 6, 18);
        drawables.push({ y: s[3] + 15.5, draw: c => r.drawGenerator(c, s[2], s[3], s[4], t) });
        lights.push({ x: s[2], y: s[3] - 10, r: 260, i: 0.8 });
      }
    }
    // items
    for (const it of v.items) {
      drawables.push({ y: it[3], draw: c => r.drawItem(c, it[1], it[2], it[3], t, it[0]) });
      lights.push({ x: it[2], y: it[3], r: it[1] >= 2 ? 130 : 70, i: it[1] >= 2 ? 0.8 : 0.5 });
    }
    // projectiles
    for (const p of v.projs) {
      drawables.push({ y: p.y, draw: c => r.drawProj(c, p.kind, p.x, p.y, p.vx, p.vy, t) });
      lights.push({ x: p.x, y: p.y - 14, r: p.kind === 0 ? 140 : p.kind === 3 ? 50 : p.kind === 4 ? 80 : 110, i: 0.8 });
    }
    r.drawScene(drawables);
    this.drawParticles(ctx);
    if (this.fogX !== Infinity) r.drawFog(ctx, this.fogX, t);

    // fire particles light up the scene
    let fl = 0;
    for (const p of this.particles) if (p.t === 'fire' && (fl++ & 3) === 0) lights.push({ x: p.x, y: p.y, r: 90, i: 0.5 });
    for (const l of this.lights) lights.push({ x: l.x, y: l.y, r: l.r, i: l.i * (l.life / l.max) });
    const dark = this.latest.mu && this.latest.mu.includes('dark') ? 0.3 : 0;
    r.drawLighting(lights, (this.myState === 2 ? 0.15 : 0) + dark);

    // world-space overlays (above lighting so they stay readable)
    r.worldTransform();
    this.drawOverlays(ctx, v);
    this.drawHUD(ctx, v);
  }

  walk(key, x, y, k) {
    let a = this.anim.get(key);
    if (!a) { a = { x, y, ph: 0 }; this.anim.set(key, a); }
    const d = Math.hypot(x - a.x, y - a.y);
    if (d > 0.05 && d < 40) a.ph += d * k;
    else if (d <= 0.05) a.ph += (Math.round(a.ph / Math.PI) * Math.PI - a.ph) * 0.2;
    a.x = x; a.y = y;
    return a.ph;
  }

  drawOverlays(ctx, v) {
    const r = this.r;
    ctx.textAlign = 'center';
    this.drawPlacement(ctx);
    if (this.aimMode === 'keys' && this.myState === 0) {
      // facing indicator around the player and a bracket on the aim-assist target
      const a = this.me.a, cx = this.me.x, cy = this.me.y - 8;
      const px = cx + Math.cos(a) * 30, py = cy + Math.sin(a) * 30;
      const locked = this.fireKey || this.lockKey;
      if (locked) {
        // aim locked: show the firing line so it is clear where the shots go while strafing
        ctx.setLineDash([7, 8]);
        ctx.strokeStyle = this.assist ? 'rgba(255,110,90,0.55)' : 'rgba(255,225,150,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx + Math.cos(a) * 280, cy + Math.sin(a) * 280); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = locked ? '#ffd36a' : 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * 7, py + Math.sin(a) * 7);
      ctx.lineTo(px + Math.cos(a + 2.4) * 6, py + Math.sin(a + 2.4) * 6);
      ctx.lineTo(px + Math.cos(a - 2.4) * 6, py + Math.sin(a - 2.4) * 6);
      ctx.fill();
      const tgt = this.assist && v.enemies.find(e => e.id === this.assist);
      if (tgt) {
        const L = LOOKS[tgt.type], h = 40 * L.s, w2 = 14 * L.s;
        ctx.strokeStyle = 'rgba(255,90,70,0.85)';
        ctx.lineWidth = 1.5;
        const x0 = tgt.x - w2, x1 = tgt.x + w2, y0 = tgt.y - h, y1 = tgt.y + 4, k = 5;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + k, y0);
        ctx.moveTo(x1 - k, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + k);
        ctx.moveTo(x0, y1 - k); ctx.lineTo(x0, y1); ctx.lineTo(x0 + k, y1);
        ctx.moveTo(x1 - k, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - k);
        ctx.stroke();
      }
    }
    // attack telegraphs and stunned bosses
    for (const e of v.enemies) {
      const L = LOOKS[e.type];
      const top = e.y - 48 * L.s * (e.elite ? 1.15 : 1);
      if (e.mode === 1) {
        ctx.font = `900 ${e.type === 'juggernaut' ? 22 : 14}px Rubik, sans-serif`;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText('!', e.x + 1, top - 2 + 1);
        ctx.fillStyle = (this.time * 10) % 1 < 0.5 ? '#ff4030' : '#ffd040';
        ctx.fillText('!', e.x, top - 2);
      } else if (e.mode === 3) {
        for (let k = 0; k < 3; k++) {
          const a = this.time * 5 + k * Math.PI * 2 / 3;
          ctx.fillStyle = '#ffe060';
          ctx.fillRect(e.x + Math.cos(a) * 16 - 2, top + 6 + Math.sin(a) * 5 - 2, 4, 4);
        }
      }
    }
    for (const p of v.players) {
      if (p.state === 2) continue;
      const isMe = p.id === this.myId;
      const x = isMe && p.state === 0 ? this.me.x : p.x;
      const y = isMe && p.state === 0 ? this.me.y : p.y;
      const info = this.who(p.id);
      if (p.state === 0 && p.carry) r.drawItem(ctx, 3, x, y - 38, this.time, p.id);
      if (!isMe && p.state === 0 && p.busy) {
        ctx.font = '800 9px Rubik, sans-serif';
        ctx.fillStyle = '#5ff0ff';
        ctx.fillText('WORKING: COVER ME', x, y - 54);
      }
      if (isMe && p.state === 0 && this.priv.uk) this.drawUsePrompt(ctx, x, y);
      if (isMe && this.switchT > 0 && p.state === 0) {
        // weapon name pops up over your head when you switch
        const w = this.weapons[this.weapon];
        ctx.globalAlpha = Math.min(1, this.switchT * 3);
        ctx.font = '400 11px Bungee, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillText(w.name.toUpperCase(), x + 1, y - 52 + 1);
        ctx.fillStyle = '#f2b33a';
        ctx.fillText(w.name.toUpperCase(), x, y - 52);
        ctx.globalAlpha = 1;
      }
      if (!isMe) {
        ctx.font = '600 9px Rubik, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText(info.name, x + 0.7, y - 45 + 0.7);
        ctx.fillStyle = info.color;
        ctx.fillText(info.name, x, y - 45);
      }
      if (p.state === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 13, y - 42, 26, 4);
        const f = p.hp / p.maxhp;
        ctx.fillStyle = f > 0.5 ? '#49c46b' : f > 0.25 ? '#e8b030' : '#e8423f';
        ctx.fillRect(x - 12, y - 41, 24 * f, 2);
      } else if (p.state === 1) {
        // revive ring
        const pulse = 0.5 + Math.sin(this.time * 6) * 0.5;
        ctx.strokeStyle = `rgba(255,80,60,${0.4 + pulse * 0.4})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y, 46, 30, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#7fff8f';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y - 30, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.rev / 100); ctx.stroke();
        ctx.font = '800 9px Rubik, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(`${p.downT}`, x, y - 27);
        if (!isMe) {
          ctx.fillStyle = '#ffb0a0';
          ctx.fillText('REVIVE ME', x, y - 54);
        }
      }
    }
    // objective labels in the world
    ctx.font = '800 9px Rubik, sans-serif';
    for (const [kind, x, y, rad, pct, stalled] of v.sites) {
      const info = SITE_INFO[kind];
      if (!info) continue;
      const top = rad ? y - rad * 0.8 - 8 : y - 44;
      const label = kind === 'gen' ? `${info.label}: BRING FUEL` : stalled ? 'INTERRUPTED' : `${info.label} ${pct}%`;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(label, x + 0.7, top + 0.7);
      ctx.fillStyle = stalled ? '#ff6050' : info.color;
      ctx.fillText(label, x, top);
    }
    // upgrade crate labels
    ctx.font = '700 8px Rubik, sans-serif';
    for (const it of v.items) {
      if (it[1] !== 2 || !this.upgrades[it[4]]) continue;
      const owned = this.ups >> it[4] & 1;
      const label = this.upgrades[it[4]].name + (owned ? ' (owned)' : '');
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(label, it[2] + 0.7, it[3] - 30 + 0.7);
      ctx.fillStyle = owned ? '#8a8070' : '#ffd36a';
      ctx.fillText(label, it[2], it[3] - 30);
    }
    // floating texts
    for (const t of this.texts) {
      const f = t.life / t.max;
      ctx.globalAlpha = Math.min(1, f * 2);
      ctx.font = `800 ${t.big ? 13 : 10}px Rubik, sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(t.text, t.x + 1, t.y + 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  // ghost tile where a barricade or sentry would land: green if it fits, red if not
  drawPlacement(ctx) {
    const w = this.weapons[this.weapon];
    if (this.myState !== 0 || w.kind !== 'place' || w.id === 'mine' || !this.priv.am[this.weapon]) return;
    const a = this.me.a;
    const tx = Math.floor((this.me.x + Math.cos(a) * 34) / T), ty = Math.floor((this.me.y + Math.sin(a) * 34) / T);
    const inside = tx === Math.floor(this.me.x / T) && ty === Math.floor(this.me.y / T);
    const bad = this.isSolid(tx, ty) || inside || this.map.rows[ty]?.[tx] === 'S';
    ctx.fillStyle = bad ? 'rgba(232,66,63,0.22)' : 'rgba(127,255,143,0.2)';
    ctx.strokeStyle = bad ? 'rgba(232,66,63,0.8)' : 'rgba(127,255,143,0.8)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(tx * T + 1, ty * T + 1, T - 2, T - 2);
    ctx.strokeRect(tx * T + 1, ty * T + 1, T - 2, T - 2);
  }

  drawUsePrompt(ctx, x, y) {
    const pct = this.priv.up2 || 0, label = `${this.touch ? '' : '[F] '}${USE_TEXT[this.priv.uk] || ''}`;
    const top = y - 66;
    ctx.font = '800 10px Rubik, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(label, x + 0.8, top + 0.8);
    ctx.fillStyle = '#ffd36a';
    ctx.fillText(label, x, top);
    if (pct > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x - 22, top + 3, 44, 5);
      ctx.fillStyle = '#ffd36a';
      ctx.fillRect(x - 21, top + 4, 42 * pct / 100, 3);
    }
  }

  // --------------------------------------------------------------- HUD --
  objectiveText(ob) {
    if (ob[0] === 'run') {
      switch (ob[3]) {
        case 'move': return ob[1] === 1 ? 'Get ready...' : 'The way is open: move up!';
        case 'clear': return 'Clear the zone to open the door';
        case 'nests': return `Destroy the nests: ${ob[4]} left`;
        case 'hack': return ob[5] > 1 ? `Hack the terminals: ${ob[4]} / ${ob[5]}` : `Hack the terminal: ${ob[6]}%`;
        case 'fuel': return `Fuel the generator: ${ob[4]} / ${ob[5]}`;
        case 'hold': return `Hold the circle: ${ob[4]}%`;
        case 'charge': return `Guard the charge: ${ob[4]}s · ${ob[5]}% health`;
        case 'fix': return ob[5] ? 'Dr. Block is under attack!' : `Dr. Block is fixing the door: ${ob[4]}%`;
        case 'boss': return 'Kill the boss to open the way';
        case 'extract': return `Everyone to the extraction point (${ob[4]}s)`;
      }
      return '';
    }
    switch (ob[0]) {
      case 'waves': return ob[1] ? `Objective: survive wave ${ob[1]} of ${ob[2]}` : `Objective: survive ${ob[2]} waves`;
      case 'defend': return `Generator ${ob[1]}%  ·  wave ${ob[3]} of ${ob[2]}`;
      case 'collect': return `Fuel cans found: ${ob[1]} / ${ob[2]}`;
      case 'holdout': return `Hold out: ${Math.floor(ob[1] / 60)}:${String(ob[1] % 60).padStart(2, '0')}`;
    }
    return '';
  }

  drawHUD(ctx, v) {
    const r = this.r;
    const W = r.cw, H = r.ch;
    const u = clamp(Math.min(W / 1280, H / 760), 0.7, 1.25);
    const touch = this.touch;
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    const s = this.latest;
    const me = v.players.find(p => p.id === this.myId);

    // vignette + damage overlay are CSS layers (cheap for the compositor)
    const lowHp = me && me.state === 0 && me.hp < me.maxhp * 0.35 ? (0.25 + Math.sin(this.time * 5) * 0.12) : 0;
    const hurt = Math.max(this.hurtT * 0.6, lowHp, me && me.state === 1 ? 0.45 : 0);
    this.hooks.setHurt(Math.min(1, hurt * 1.6));

    // on small screens the panels sit over the action, so let more of it show through
    const panel = (x, y, w, h, bg = touch ? 'rgba(14,12,10,0.42)' : 'rgba(14,12,10,0.72)', line = 'rgba(255,255,255,0.08)') => {
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    };
    const text = (str, x, y, size, color, align = 'left', weight = 800, font = 'Rubik') => {
      ctx.font = `${weight} ${size}px ${font}, sans-serif`;
      ctx.textAlign = align;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(str, x + Math.max(1, size / 14), y + Math.max(1, size / 14));
      ctx.fillStyle = color;
      ctx.fillText(str, x, y);
    };
    const hpColor = f => (f > 0.5 ? '#49c46b' : f > 0.25 ? '#e8b030' : '#e8423f');

    // --- wave / objective panel (top-left)
    const pad = 14 * u;
    const ob = s.ob;
    const muts = (s.mu || []).map(id => this.mutDefs[id]).filter(Boolean);
    const lw = 240 * u;
    const panH = (74 + (ob ? 20 : 0) + muts.length * 16) * u;
    panel(pad, pad, lw, panH);
    const inRun = ob && ob[0] === 'run';
    text(inRun ? `ZONE ${ob[1]}/${ob[2]}` : s.wv ? `WAVE ${s.wv}` : 'GET READY', pad + 12 * u, pad + 32 * u, 26 * u, '#f2b33a', 'left', 400, 'Bungee');
    const waitText = inRun ? (ob[1] === 1 ? `Starting in ${Math.ceil(s.wt)}s` : `Zone wakes up in ${Math.ceil(s.wt)}s, or when you go in`) : `Next wave in ${Math.ceil(s.wt)}s`;
    text(s.ws ? `${s.left} undead ${inRun ? 'around' : 'remaining'}` : waitText, pad + 12 * u, pad + 52 * u, (inRun && !s.ws ? 11 : 13) * u, '#efe6d8', 'left', 600);
    text(`TEAM SCORE ${s.sc.toLocaleString()}`, pad + 12 * u, pad + 67 * u, 11 * u, '#9c917f', 'left', 600);
    const tag = this.mission ? `#${this.mission.num}` : this.mode.toUpperCase();
    text(`${tag} · ${(this.diff || '').toUpperCase()}${this.ffOn ? ' · FF' : ''}`, pad + lw - 12 * u, pad + 67 * u, 9 * u, '#6b6255', 'right', 800);
    let ly = pad + 67 * u;
    if (ob) {
      ly += 20 * u;
      const warn = ob[0] === 'defend' && ob[1] < 35 && (this.time * 3) % 1 < 0.5;
      text(this.objectiveText(ob), pad + 12 * u, ly, 12 * u, warn ? '#ff6050' : '#8af0a0', 'left', 800);
    }
    for (const m of muts) {
      ly += 16 * u;
      text(`☠ ${m.name.toUpperCase()}`, pad + 12 * u, ly, 10.5 * u, '#c890ff', 'left', 800);
      text(m.desc, pad + lw - 12 * u, ly, 9 * u, '#8a7aa0', 'right', 600);
    }

    // --- team list
    let ty = pad + panH + 10 * u;
    for (const p of v.players) {
      const info = this.who(p.id);
      panel(pad, ty, lw, 26 * u);
      ctx.fillStyle = info.color;
      ctx.fillRect(pad + 6 * u, ty + 6 * u, 14 * u, 14 * u);
      text(info.name + (p.id === this.myId ? ' (you)' : ''), pad + 26 * u, ty + 13 * u, 11 * u, '#efe6d8', 'left', 600);
      const bx = pad + 26 * u, bw = 130 * u;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, ty + 16 * u, bw, 5 * u);
      if (p.state === 0) {
        ctx.fillStyle = hpColor(p.hp / p.maxhp);
        ctx.fillRect(bx, ty + 16 * u, bw * p.hp / p.maxhp, 5 * u);
        if (p.mult > 1) text(`x${p.mult}`, pad + lw - 10 * u, ty + 19 * u, 13 * u, '#f2b33a', 'right', 800);
      } else {
        text(p.state === 1 ? `DOWN ${p.downT}s` : 'DEAD', pad + lw - 10 * u, ty + 19 * u, 11 * u, p.state === 1 ? '#ff7060' : '#888', 'right', 800);
      }
      ty += 30 * u;
    }

    // --- combo (top-right)
    const mult = me ? me.mult : 1;
    const cx = W - pad - 170 * u;
    const topY = touch ? pad + 46 : pad;    // on touch the buttons (see #tTop) take the corner
    const covered = touch && this.offer && me;   // the perk offer sits right below on small screens
    panel(cx, topY, 170 * u, 74 * u);
    text(`x${mult}`, cx + 14 * u, topY + 44 * u, 36 * u, mult > 1 ? '#f2b33a' : '#6b6255', 'left', 400, 'Bungee');
    text(`${this.priv.cb || 0} chain`, cx + 156 * u, topY + 26 * u, 12 * u, '#efe6d8', 'right', 600);
    text(`${(this.priv.ps || 0).toLocaleString()} pts`, cx + 156 * u, topY + 44 * u, 12 * u, '#9c917f', 'right', 600);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx + 14 * u, topY + 56 * u, 142 * u, 6 * u);
    ctx.fillStyle = '#f2b33a';
    ctx.fillRect(cx + 14 * u, topY + 56 * u, 142 * u * (this.priv.ct || 0) / 100, 6 * u);
    if (!covered) text(`${this.ping | 0} ms`, W - pad, topY + 90 * u, 10 * u, '#6b6255', 'right', 600);
    // owned perks
    let px = W - pad;
    this.perkDefs.forEach((pk, i) => {
      const rk = this.perks[i];
      if (!rk || covered) return;
      const sz = 24 * u;
      px -= sz + 4 * u;
      panel(px, topY + 98 * u, sz, sz, 'rgba(14,12,10,0.8)', pk.color);
      text(pk.icon, px + sz / 2, topY + 98 * u + 17 * u, 15 * u, pk.color, 'center', 800);
      if (rk > 1) text(`${rk}`, px + sz - 2 * u, topY + 98 * u + sz - 2 * u, 9 * u, '#fff', 'right', 800);
    });

    // --- perk offer (right side)
    this.perkRects = [];
    if (this.offer && me) {
      const cw = 270 * u, ch = 64 * u;
      const x0 = W - pad - cw;
      let y0 = touch ? topY + 78 * u : Math.max(pad + 132 * u, H * 0.3);
      const pulse = 0.5 + Math.sin(this.time * 5) * 0.5;
      text(`CHOOSE A PERK${this.picks > 1 ? ` (${this.picks})` : ''}`, x0 + cw, y0 + 12 * u, 15 * u, `rgba(242,179,58,${0.7 + pulse * 0.3})`, 'right', 400, 'Bungee');
      y0 += 22 * u;
      this.offer.forEach((k, i) => {
        const pk = this.perkDefs[k];
        if (!pk) return;
        const rk = this.perks[k];
        const hover = this.mouse.x >= x0 && this.mouse.x <= x0 + cw && this.mouse.y >= y0 && this.mouse.y <= y0 + ch;
        panel(x0, y0, cw, ch, hover ? 'rgba(60,44,14,0.95)' : 'rgba(22,18,12,0.92)', hover ? '#f2b33a' : 'rgba(242,179,58,0.45)');
        if (!touch) panel(x0 + 8 * u, y0 + ch / 2 - 13 * u, 26 * u, 26 * u, 'rgba(242,179,58,0.18)', '#f2b33a');
        if (!touch) text(PERK_KEYS[i].toUpperCase(), x0 + 21 * u, y0 + ch / 2 + 6 * u, 15 * u, '#f2b33a', 'center', 400, 'Bungee');
        text(pk.icon, x0 + 54 * u, y0 + ch / 2 + 9 * u, 26 * u, pk.color, 'center', 800);
        text(pk.name, x0 + 74 * u, y0 + 22 * u, 13 * u, '#efe6d8', 'left', 800);
        text(pk.max > 1 ? `Lv ${rk + 1}/${pk.max}` : 'ONCE', x0 + cw - 10 * u, y0 + 22 * u, 10 * u, '#9c917f', 'right', 800);
        // wrap the description onto two lines
        ctx.font = `600 ${10.5 * u}px Rubik, sans-serif`;
        const words = pk.desc.split(' '), lines = [''];
        for (const wd of words) {
          const t = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${wd}` : wd;
          if (ctx.measureText(t).width > cw - 86 * u && lines[lines.length - 1]) lines.push(wd); else lines[lines.length - 1] = t;
        }
        lines.slice(0, 2).forEach((ln, j) => text(ln, x0 + 74 * u, y0 + (38 + j * 13) * u, 10.5 * u, '#b8ad98', 'left', 600));
        this.perkRects.push([x0, y0, cw, ch]);
        y0 += ch + 6 * u;
      });
    }

    // --- weapon bar (bottom-centre)
    // on touch: only what you own, squeezed in between the thumbs, and the slots are buttons
    const n = this.weapons.length;
    const slots = touch ? this.weapons.filter((w, i) => this.un >> i & 1).length : n;
    const room = W - 2 * 110;
    const gap = 5 * u, shh = 56 * u;
    const sw = touch ? Math.min(64 * u, (room - (slots - 1) * gap) / slots) : 64 * u;
    const iconU = Math.min(u, sw / 64);
    const total = slots * sw + (slots - 1) * gap;
    let wx = W / 2 - total / 2;
    this.weaponRects = [];
    const wy = H - pad - shh;
    // next unlock progress
    const next = this.weapons.findIndex((w, i) => !(this.un >> i & 1));
    if (next >= 0) {
      const w = this.weapons[next];
      const prev = Math.max(...this.weapons.filter((x, i) => this.un >> i & 1).map(x => x.unlock));
      const f = clamp((s.sc - prev) / (w.unlock - prev), 0, 1);
      const bw = Math.min(touch ? room : total, 360 * u);
      const uy = wy - (touch ? 32 : 20) * u;   // on touch the health bar sits below it
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(W / 2 - bw / 2, uy, bw, (touch ? 3 : 6) * u);
      ctx.fillStyle = '#5fb0ff';
      ctx.fillRect(W / 2 - bw / 2, uy, bw * f, (touch ? 3 : 6) * u);
      text(`Next unlock: ${w.name} at ${w.unlock.toLocaleString()} team pts`, W / 2, uy - 6 * u, 11 * u, '#bcd8f0', 'center', 600);
    }
    for (let i = 0; i < n; i++) {
      const w = this.weapons[i];
      const unl = this.un >> i & 1;
      if (touch && !unl) continue;
      if (touch) this.weaponRects.push([wx - gap / 2, wy - 14 * u, sw + gap, H - wy + 14 * u, i]);
      const sel = i === this.weapon;
      const y0 = wy - (sel ? 10 * u : 0);
      if (sel) {
        ctx.save();
        ctx.shadowColor = 'rgba(242,179,58,0.8)';
        ctx.shadowBlur = 14 * u;
        ctx.fillStyle = 'rgba(90,64,16,0.95)';
        ctx.fillRect(wx, y0, sw, shh + 10 * u);
        ctx.restore();
      } else {
        ctx.fillStyle = touch ? 'rgba(20,17,14,0.5)' : unl ? 'rgba(20,17,14,0.85)' : 'rgba(14,12,10,0.6)';
        ctx.fillRect(wx, y0, sw, shh);
      }
      ctx.strokeStyle = sel ? '#ffd36a' : unl ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      ctx.lineWidth = sel ? 2.5 : 1;
      ctx.strokeRect(wx + 0.5, y0 + 0.5, sw - 1, (sel ? shh + 10 * u : shh) - 1);
      if (!touch) text(KEYS[i], wx + 5 * u, y0 + 13 * u, (sel ? 12 : 10) * u, sel ? '#ffd36a' : '#9c917f', 'left', 800);
      if (unl) {
        const am = this.priv.am[i];
        drawWeaponIcon(ctx, w.id, wx + sw / 2, y0 + 26 * u, iconU * (sel ? 1.2 : 1.05), am === 0 ? '#6b6255' : sel ? '#fff4d8' : '#d8cfbe');
        text(am < 0 ? '∞' : `${am}`, wx + sw / 2, y0 + 49 * u, (sel ? 13 : 11.5) * u, am === 0 ? '#e8423f' : touch && sel && am > 0 && am <= this.ws[i].ammo * 0.2 ? '#ff7050' : sel ? '#ffffff' : '#d8cfbe', 'center', 800);
        let pip = 0;
        this.upgrades.forEach((up, k) => {
          if (up.w !== i || !(this.ups >> k & 1)) return;
          ctx.fillStyle = '#f2b33a';
          ctx.fillRect(wx + sw - (8 + pip * 7) * u, y0 + 5 * u, 5 * u, 5 * u);
          pip++;
        });
      } else {
        drawWeaponIcon(ctx, w.id, wx + sw / 2, y0 + 26 * u, u * 1.05, '#3a352e');
        text(w.unlock >= 1000 ? `${(w.unlock / 1000).toFixed(1).replace('.0', '')}k pts` : `${w.unlock} pts`, wx + sw / 2, y0 + 49 * u, 9 * u, '#6b6255', 'center', 800);
      }
      wx += sw + gap;
    }

    // --- current weapon + health card (bottom-left)
    let cardTop = touch ? H * 0.72 : H - pad;
    if (me && touch) {
      // on touch the big card would cover the undead: the weapon bar already shows the gun and its ammo,
      // so all that's left is a slim health bar right above it
      const bw = Math.min(room, 360 * u), bx = W / 2 - bw / 2, by = wy - 24 * u, bh = 9 * u;
      const hp = me.state === 0 ? me.hp : 0, f = hp / me.maxhp;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = hpColor(f);
      ctx.fillRect(bx, by, bw * f, bh);
      text(me.state === 0 ? `${me.hp}` : me.state === 1 ? 'DOWN' : 'DEAD', bx - 6 * u, by + bh, 14 * u, f > 0.25 ? '#efe6d8' : '#ff7050', 'right', 800);
    } else if (me) {
      const w = this.weapons[this.weapon];
      const ws = this.ws[this.weapon];
      const mods = this.upgrades.filter((up, k) => up.w === this.weapon && this.ups >> k & 1).map(up => up.name);
      const cw = 280 * u, ch = (mods.length ? 122 : 108) * u;
      const hx = pad, hy = H - pad - ch;
      cardTop = hy;
      panel(hx, hy, cw, ch, 'rgba(14,12,10,0.8)', this.switchT > 0 ? `rgba(242,179,58,${0.3 + this.switchT * 0.5})` : 'rgba(255,255,255,0.1)');
      // big icon
      const am = this.priv.am[this.weapon];
      panel(hx + 8 * u, hy + 8 * u, 96 * u, 58 * u, 'rgba(0,0,0,0.45)', 'rgba(255,255,255,0.06)');
      drawWeaponIcon(ctx, w.id, hx + 56 * u, hy + 38 * u, u * 2.1, am === 0 ? '#6b6255' : '#fff4d8');
      text(w.name.toUpperCase(), hx + 114 * u, hy + 26 * u, 14 * u, '#f2b33a', 'left', 400, 'Bungee');
      const low = am >= 0 && ws.ammo > 0 && am <= ws.ammo * 0.2;
      const blink = (this.time * 4) % 1 < 0.6;
      const amColor = am === 0 ? '#e8423f' : low ? (blink ? '#ff7050' : '#efe6d8') : '#ffffff';
      text(am < 0 ? '∞' : `${am}`, hx + 114 * u, hy + 56 * u, 26 * u, amColor, 'left', 400, 'Bungee');
      if (am >= 0) {
        ctx.font = `400 ${26 * u}px Bungee, sans-serif`;
        const aw = ctx.measureText(`${am}`).width;
        text(am === 0 ? 'EMPTY' : low ? 'LOW AMMO' : `/ ${ws.ammo}`, hx + 120 * u + aw, hy + 55 * u, 11 * u, am === 0 || low ? '#ff7050' : '#9c917f', 'left', 800);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(hx + 114 * u, hy + 62 * u, 156 * u, 4 * u);
        ctx.fillStyle = low || am === 0 ? '#e8423f' : '#e8d060';
        ctx.fillRect(hx + 114 * u, hy + 62 * u, 156 * u * clamp(am / ws.ammo, 0, 1), 4 * u);
      }
      if (mods.length) text(`★ ${mods.join(' · ')}`, hx + 10 * u, hy + 84 * u, 10.5 * u, '#ffd36a', 'left', 700);
      // health
      const hb = hy + ch - 22 * u;
      const hp = me.state === 0 ? me.hp : 0;
      text('HEALTH', hx + 10 * u, hb - 5 * u, 10 * u, '#9c917f', 'left', 800);
      text(me.state === 0 ? `${me.hp} / ${me.maxhp}` : me.state === 1 ? 'DOWN' : 'DEAD', hx + cw - 10 * u, hb - 5 * u, 11 * u, '#efe6d8', 'right', 800);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(hx + 10 * u, hb, cw - 20 * u, 12 * u);
      ctx.fillStyle = hpColor(hp / me.maxhp);
      ctx.fillRect(hx + 10 * u, hb, (cw - 20 * u) * hp / me.maxhp, 12 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(hx + 10 * u, hb, (cw - 20 * u) * hp / me.maxhp, 3 * u);
    }

    // --- chat
    let cy = cardTop - 14 * u;
    const lines = this.chatLines.filter(c => this.time - c.t < 10 || this.chatting);
    for (let i = lines.length - 1; i >= 0; i--) {
      const c = lines[i];
      const a = this.chatting ? 1 : clamp((10 - (this.time - c.t)) / 1.5, 0, 1);
      ctx.globalAlpha = a;
      if (c.from) {
        ctx.font = `800 ${12 * u}px Rubik, sans-serif`;
        const nw = ctx.measureText(c.from + ': ').width;
        text(c.from + ':', pad, cy, 12 * u, c.color || '#fff', 'left', 800);
        text(c.text, pad + nw, cy, 12 * u, '#efe6d8', 'left', 400);
      } else text(c.text, pad, cy, 12 * u, '#c8bca8', 'left', 600);
      ctx.globalAlpha = 1;
      cy -= 17 * u;
    }

    // --- minimap
    const mm = r.minimap;
    const ms = Math.min(170 * u / mm.width, 130 * u / mm.height);
    const mw = mm.width * ms, mh = mm.height * ms;
    const mx0 = W - pad - mw, my0 = touch ? topY + 128 * u : H - pad - mh;
    if (touch ? H >= 560 && W >= 700 && !this.offer : W > 900) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(mx0 - 4, my0 - 4, mw + 8, mh + 8);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mm, mx0, my0, mw, mh);
      ctx.imageSmoothingEnabled = true;
      const k = ms * mm.width / (this.map.w * T);
      if (this.fogX !== Infinity) {
        ctx.fillStyle = '#0a0908';
        ctx.fillRect(mx0 + this.fogX * k, my0, mw - this.fogX * k, mh);
      }
      for (const st of v.sites) {
        if ((this.time * 3 | 0) % 2) continue;
        ctx.fillStyle = (SITE_INFO[st[0]] || { color: '#fff' }).color;
        ctx.fillRect(mx0 + st[1] * k - 3, my0 + st[2] * k - 3, 6, 6);
      }
      for (const e of v.enemies) {
        const big = e.type === 'colossus' || e.type === 'juggernaut';
        ctx.fillStyle = e.elite ? '#ffc040' : '#ff4a3a';
        ctx.fillRect(mx0 + e.x * k - 1, my0 + e.y * k - 1, big ? 5 : 2.5, big ? 5 : 2.5);
      }
      for (const it of v.items) {
        if ((it[1] === 3 || it[1] === 5) && (this.time * 3 | 0) % 2) continue;
        const big = it[1] >= 2 ? 4.5 : 2.5;
        ctx.fillStyle = it[1] === 3 || it[1] === 5 ? '#ff7a40' : it[1] === 2 ? '#ffb020' : '#e8d060';
        ctx.fillRect(mx0 + it[2] * k - big / 2, my0 + it[3] * k - big / 2, big, big);
      }
      for (const st of v.structs) {
        if (st[1] !== 3) continue;
        ctx.fillStyle = '#000';
        ctx.fillRect(mx0 + st[2] * k - 4, my0 + st[3] * k - 4, 8, 8);
        ctx.fillStyle = '#ffd030';
        ctx.fillRect(mx0 + st[2] * k - 3, my0 + st[3] * k - 3, 6, 6);
      }
      for (const p of v.players) {
        if (p.state === 2) continue;
        const info = this.who(p.id);
        const ppx = p.id === this.myId ? this.me.x : p.x, ppy = p.id === this.myId ? this.me.y : p.y;
        ctx.fillStyle = '#000';
        ctx.fillRect(mx0 + ppx * k - 3, my0 + ppy * k - 3, 6, 6);
        ctx.fillStyle = p.state === 1 && (this.time * 4 | 0) % 2 ? '#fff' : info.color;
        ctx.fillRect(mx0 + ppx * k - 2, my0 + ppy * k - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    // --- pointers to off-screen objectives and downed teammates
    const marks = [];
    for (const it of v.items) if (it[1] === 3 || it[1] === 5) marks.push([it[2], it[3], '#ff7a40', 'FUEL']);
    for (const st of v.structs) if (st[1] === 3) marks.push([st[2], st[3], '#ffd030', this.map.zones ? 'CHARGE' : 'GEN']);
    for (const st of v.sites) if (SITE_INFO[st[0]]) marks.push([st[1], st[2], SITE_INFO[st[0]].color, SITE_INFO[st[0]].label]);
    for (const e of v.enemies) if (e.type === 'nest') marks.push([e.x, e.y, '#ff5a8a', 'NEST']);
    const vipView = this.vip && v.players.find(p => p.id === this.vip.id);
    if (vipView && vipView.state === 0) marks.push([vipView.x, vipView.y, '#f2efe6', 'DR. BLOCK']);
    if (s.ws === 0 && inRun && ob[1] > 1) {
      const z = this.map.zones[ob[1] - 1];
      marks.push([(z.x0 + 1) * T, (z.entry[1] + 0.5) * T, '#8af0a0', 'DOOR']);
    }
    for (const p of v.players) if (p.state === 1 && p.id !== this.myId) marks.push([p.x, p.y, '#ff5040', 'REVIVE']);
    const m0 = 34 * u;
    for (const [x, y, color, label] of marks) {
      const [sx, sy] = r.toScreen(x, y);
      if (sx > m0 && sx < W - m0 && sy > m0 && sy < H - m0) continue;
      const dx = sx - W / 2, dy = sy - H / 2;
      const f = Math.min((W / 2 - m0) / Math.abs(dx || 1e-6), (H / 2 - m0) / Math.abs(dy || 1e-6));
      const ax = W / 2 + dx * f, ay = H / 2 + dy * f, ang = Math.atan2(dy, dx);
      const bob = Math.sin(this.time * 6) * 3 * u;
      ctx.save();
      ctx.translate(ax + Math.cos(ang) * bob, ay + Math.sin(ang) * bob);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.moveTo(15 * u, 0); ctx.lineTo(-9 * u, -11 * u); ctx.lineTo(-9 * u, 11 * u); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(12 * u, 0); ctx.lineTo(-7 * u, -8 * u); ctx.lineTo(-7 * u, 8 * u); ctx.fill();
      ctx.restore();
      text(label, ax - Math.cos(ang) * 22 * u, ay - Math.sin(ang) * 22 * u + 4 * u, 9 * u, color, 'center', 800);
    }

    // --- announcements
    // kept in the top third, clear of the player and the prompts over their head
    let ay = H * 0.15;
    for (const a of this.announces) {
      const f = a.life / a.max;
      const alpha = Math.min(1, (1 - f) * 8, f * 4);
      const pop = 1 + Math.max(0, (f - 0.85)) * 2;
      ctx.globalAlpha = alpha;
      const col = a.color || (a.title.startsWith('WAVE C') || a.title.startsWith('NEW') ? '#f2b33a' : '#e8423f');
      text(a.title, W / 2, ay, (a.small ? 22 : 46) * u * pop, col, 'center', 400, 'Bungee');
      if (a.sub) text(a.sub, W / 2, ay + 28 * u, 16 * u, '#efe6d8', 'center', 600);
      ctx.globalAlpha = 1;
      ay += (a.sub ? 66 : 44) * u;
    }

    // --- walled in: say how to get out
    if (me && me.state === 0 && this.priv.bx) {
      const pulse = 0.75 + Math.sin(this.time * 4) * 0.25;
      ctx.globalAlpha = pulse;
      text('YOU ARE WALLED IN', W / 2, H * 0.72, 18 * u, '#ffb040', 'center', 400, 'Bungee');
      ctx.globalAlpha = 1;
      text(this.hint('The undead break through faster the longer you sit here. Hold [F] next to a wall to take it down.'), W / 2, H * 0.72 + 20 * u, 13 * u, '#efe6d8', 'center', 600);
    }

    // --- state overlays
    if (me && me.state === 1) {
      text(`Bleeding out: ${me.downT}s`, W / 2, H * 0.62, 20 * u, '#ff8070', 'center', 800);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(W / 2 - 120 * u, H * 0.62 + 12 * u, 240 * u, 8 * u);
      ctx.fillStyle = '#7fff8f';
      ctx.fillRect(W / 2 - 120 * u, H * 0.62 + 12 * u, 240 * u * me.rev / 100, 8 * u);
    } else if (me && me.state === 2) {
      text('YOU DIED', W / 2, H * 0.6, 30 * u, '#e8423f', 'center', 400, 'Bungee');
      const mate = this.spectating ? this.name(this.spectating) : null;
      text(`You will respawn when the wave is cleared${mate ? `  ·  Spectating ${mate}` : ''}`, W / 2, H * 0.6 + 26 * u, 14 * u, '#efe6d8', 'center', 600);
    }

    // --- scoreboard
    if (this.showScores) {
      const rows = v.players.filter(p => !this.vip || p.id !== this.vip.id).sort((a, b) => b.score - a.score);
      const bw = 460 * u, bh = (70 + rows.length * 30) * u;
      const bx = W / 2 - bw / 2, by = H / 2 - bh / 2;
      panel(bx, by, bw, bh);
      text('SCOREBOARD', bx + 18 * u, by + 30 * u, 18 * u, '#f2b33a', 'left', 400, 'Bungee');
      text('KILLS', bx + bw - 140 * u, by + 30 * u, 11 * u, '#9c917f', 'right', 800);
      text('SCORE', bx + bw - 18 * u, by + 30 * u, 11 * u, '#9c917f', 'right', 800);
      rows.forEach((p, i) => {
        const info = this.who(p.id);
        const yy = by + (62 + i * 30) * u;
        ctx.fillStyle = info.color;
        ctx.fillRect(bx + 18 * u, yy - 11 * u, 12 * u, 12 * u);
        text(info.name, bx + 38 * u, yy, 14 * u, '#efe6d8', 'left', 600);
        text(`${p.kills}`, bx + bw - 140 * u, yy, 14 * u, '#efe6d8', 'right', 800);
        text(p.score.toLocaleString(), bx + bw - 18 * u, yy, 14 * u, '#efe6d8', 'right', 800);
      });
    }

    // --- pause screen
    if (this.paused && !this.menuOpen) {
      ctx.fillStyle = 'rgba(6,5,4,0.6)';
      ctx.fillRect(0, 0, W, H);
      text('PAUSED', W / 2, H * 0.42, 64 * u, '#f2b33a', 'center', 400, 'Bungee');
      text('The host paused the game. Waiting for them to resume...', W / 2, H * 0.42 + 40 * u, 18 * u, '#efe6d8', 'center', 600);
      text(touch ? 'Chat and perk picks still work' : 'Chat (Enter) and perk picks still work', W / 2, H * 0.42 + 66 * u, 13 * u, '#9c917f', 'center', 600);
    }

    // --- crosshair
    if (!this.chatting && this.aimMode === 'mouse') {
      const { x, y } = this.mouse;
      const spread = 6 + this.recoil * 6 + (this.weapons[this.weapon].id === 'shotgun' ? 6 : 0);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const cross = () => {
        ctx.beginPath();
        ctx.moveTo(x - spread - 6, y); ctx.lineTo(x - spread, y);
        ctx.moveTo(x + spread, y); ctx.lineTo(x + spread + 6, y);
        ctx.moveTo(x, y - spread - 6); ctx.lineTo(x, y - spread);
        ctx.moveTo(x, y + spread); ctx.lineTo(x, y + spread + 6);
        ctx.stroke();
      };
      cross();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      cross();
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}
