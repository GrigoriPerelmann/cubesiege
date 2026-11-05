// Touch controls for phones and tablets: twin sticks drawn over the game, plus a few buttons.
//   left half of the screen   floating move stick
//   right half of the screen  floating fire stick: hold to shoot, drag to aim (aim-assist still applies).
//                             Building weapons aim while you drag and place when you let go.
// The controls only feed the same inputs the keyboard uses (see sync), so the game code stays input-agnostic.
// Touching the game turns them on; using a real keyboard or mouse (a tablet with a keyboard) turns them off.
import * as A from './audio.js';

const RADIUS = 52;          // how far a stick travels, in CSS pixels
const MOVE_DEAD = 8;        // ignore a resting thumb
const AIM_DEAD = 16;        // less than this keeps the current aim, so a plain hold fires where you face
const PLACE_PULSE = 0.12;   // seconds of trigger when a building weapon is released (spans a few input packets)
const GHOST_MS = 800;       // mouse events this soon after a touch are the browser's emulated ones

const $ = id => document.getElementById(id);

function makeStick(id) {
  const el = $(id);
  return { el, knob: el.firstElementChild, id: null, x0: 0, y0: 0, dx: 0, dy: 0 };
}

export class TouchControls {
  // hooks: { game(), openChat(), closeChat(), openMenu() }
  constructor(canvas, hooks) {
    this.hooks = hooks;
    this.move = makeStick('stickL');
    this.aim = makeStick('stickR');
    this.useHeld = false;
    this.useKind = 0;
    this.pulse = 0;
    this.lastTouch = -1e9;
    this.active = false;
    this.setActive(window.matchMedia('(pointer: coarse)').matches);

    canvas.addEventListener('touchstart', e => this.onStart(e), { passive: false });
    canvas.addEventListener('touchmove', e => this.onMove(e), { passive: false });
    canvas.addEventListener('touchend', e => this.onEnd(e, true), { passive: false });
    canvas.addEventListener('touchcancel', e => this.onEnd(e, false), { passive: false });

    this.useBtn = $('tUse');
    const hold = v => e => { e.preventDefault(); this.lastTouch = performance.now(); this.useHeld = v; };
    this.useBtn.addEventListener('touchstart', hold(true), { passive: false });
    this.useBtn.addEventListener('touchend', hold(false), { passive: false });
    this.useBtn.addEventListener('touchcancel', hold(false), { passive: false });

    const tap = (id, fn) => { $(id).onclick = () => { A.initAudio(); A.play('click'); fn(); }; };
    tap('tMenu', () => hooks.openMenu());
    tap('tChat', () => hooks.openChat());
    tap('tScores', () => { const g = hooks.game(); if (g) g.showScores = !g.showScores; });

    // iPhones have no fullscreen API, so the button only exists where it can work
    const root = document.documentElement;
    const enter = root.requestFullscreen || root.webkitRequestFullscreen;
    if (enter) {
      tap('tFull', () => {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        const on = document.fullscreenElement || document.webkitFullscreenElement;
        Promise.resolve(on ? exit.call(document) : enter.call(root)).catch(() => {});
      });
    } else $('tFull').classList.add('hidden');
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    document.body.classList.toggle('touch', on);
    if (on) return;
    this.reset();
    const g = this.hooks.game();
    if (g) { g.touch = false; g.clearInput(); }
  }

  // false for the mouse events a browser emulates after a touch; a real mouse switches the touch UI off
  realMouse() {
    if (performance.now() - this.lastTouch < GHOST_MS) return false;
    this.setActive(false);
    return true;
  }

  reset() {
    this.release(this.move);
    this.release(this.aim);
    this.useHeld = false;
    this.pulse = 0;
  }

  grab(s, t) {
    s.id = t.identifier;
    s.x0 = Math.max(RADIUS + 6, Math.min(window.innerWidth - RADIUS - 6, t.clientX));
    s.y0 = Math.max(RADIUS + 6, Math.min(window.innerHeight - RADIUS - 6, t.clientY));
    s.el.classList.add('on');
    s.el.style.left = `${s.x0}px`;
    s.el.style.top = `${s.y0}px`;
    this.drag(s, t);
  }

  drag(s, t) {
    let dx = t.clientX - s.x0, dy = t.clientY - s.y0;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      // the base follows the thumb, so turning back answers at once
      s.x0 += dx * (1 - RADIUS / d);
      s.y0 += dy * (1 - RADIUS / d);
      dx = t.clientX - s.x0;
      dy = t.clientY - s.y0;
      s.el.style.left = `${s.x0}px`;
      s.el.style.top = `${s.y0}px`;
    }
    s.dx = dx;
    s.dy = dy;
    s.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  release(s) {
    s.id = null;
    s.dx = s.dy = 0;
    s.el.classList.remove('on');
    s.el.style.left = s.el.style.top = '';
    s.knob.style.transform = '';
  }

  onStart(e) {
    e.preventDefault();
    this.lastTouch = performance.now();
    this.setActive(true);
    const g = this.hooks.game();
    if (!g) return;
    if (g.chatting) this.hooks.closeChat();
    // a touch can vanish without an end event (system gestures, the keyboard opening)
    const alive = [...e.touches].map(t => t.identifier);
    for (const s of [this.move, this.aim]) if (s.id !== null && !alive.includes(s.id)) this.release(s);
    for (const t of e.changedTouches) {
      if (g.clickUI(t.clientX, t.clientY)) continue;
      const s = t.clientX < window.innerWidth / 2 ? this.move : this.aim;
      if (s.id === null) this.grab(s, t);
    }
  }

  onMove(e) {
    e.preventDefault();
    this.lastTouch = performance.now();
    for (const t of e.changedTouches) {
      if (t.identifier === this.move.id) this.drag(this.move, t);
      else if (t.identifier === this.aim.id) this.drag(this.aim, t);
    }
  }

  onEnd(e, lifted) {
    e.preventDefault();
    this.lastTouch = performance.now();
    for (const t of e.changedTouches) {
      if (t.identifier === this.move.id) this.release(this.move);
      else if (t.identifier === this.aim.id) {
        const g = this.hooks.game();
        if (lifted && g && g.ws[g.weapon].kind === 'place') this.pulse = PLACE_PULSE;
        this.release(this.aim);
      }
    }
  }

  // once a frame: turn the stick positions into the game's inputs
  sync(g, dt) {
    g.touch = this.active;
    if (!this.active) return;
    g.aimMode = 'keys';
    const { move, aim } = this;
    const ml = Math.hypot(move.dx, move.dy);
    g.touchMove = ml > MOVE_DEAD ? { x: move.dx / ml, y: move.dy / ml, gait: Math.min(1, ml / (RADIUS * 0.6)) } : null;
    const held = aim.id !== null;
    const place = g.ws[g.weapon].kind === 'place';
    g.touchAim = held && Math.hypot(aim.dx, aim.dy) > AIM_DEAD ? Math.atan2(aim.dy, aim.dx) : null;
    this.pulse = Math.max(0, this.pulse - dt);
    g.fireKey = (held && !place) || this.pulse > 0;
    g.lockKey = held && place;
    // the use button only shows when there is something to use
    const kind = g.myState === 0 ? g.priv.uk || 0 : 0;
    if (kind !== this.useKind) {
      this.useKind = kind;
      this.useBtn.classList.toggle('show', kind > 0);
      if (kind) this.useBtn.textContent = g.useText(kind);
      else this.useHeld = false;   // a button that just vanished may never see its touchend
    }
    g.useKey = this.useHeld;
  }
}
