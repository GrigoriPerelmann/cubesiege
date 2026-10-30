// Procedural sound effects with WebAudio. No asset files needed.
let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
const last = {};

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { return; }
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.55;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 6;
  master.connect(comp).connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.55;
  return muted;
}

function noise(t, dur, { freq = 1000, q = 1, type = 'bandpass', vol = 0.5, attack = 0.002, sweep = null } = {}, out) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

function tone(t, dur, { freq = 440, to = null, type = 'sine', vol = 0.3, attack = 0.005 } = {}, out) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const SOUNDS = {
  pistol: (t, o) => { noise(t, 0.12, { freq: 1800, q: 0.8, vol: 0.5 }, o); tone(t, 0.08, { freq: 300, to: 90, type: 'square', vol: 0.12 }, o); },
  smg: (t, o) => { noise(t, 0.07, { freq: 2200, q: 0.9, vol: 0.32 }, o); tone(t, 0.05, { freq: 260, to: 100, type: 'square', vol: 0.07 }, o); },
  shotgun: (t, o) => { noise(t, 0.35, { freq: 900, q: 0.5, vol: 0.8, sweep: 200 }, o); tone(t, 0.18, { freq: 140, to: 40, type: 'square', vol: 0.25 }, o); },
  rifle: (t, o) => { noise(t, 0.13, { freq: 1300, q: 0.7, vol: 0.5 }, o); tone(t, 0.09, { freq: 220, to: 60, type: 'sawtooth', vol: 0.12 }, o); },
  rail: (t, o) => { tone(t, 0.4, { freq: 2400, to: 120, type: 'sawtooth', vol: 0.18 }, o); tone(t, 0.3, { freq: 900, to: 3000, type: 'sine', vol: 0.15 }, o); noise(t, 0.25, { freq: 5000, q: 2, vol: 0.2 }, o); },
  flame: (t, o) => { noise(t, 0.12, { freq: 500, q: 0.4, vol: 0.18, type: 'lowpass', attack: 0.02 }, o); },
  rocket: (t, o) => { noise(t, 0.6, { freq: 400, q: 0.6, vol: 0.4, sweep: 1600, attack: 0.03 }, o); tone(t, 0.2, { freq: 90, to: 50, type: 'square', vol: 0.15 }, o); },
  sentry: (t, o) => { noise(t, 0.06, { freq: 2600, q: 1.2, vol: 0.22 }, o); },
  explode: (t, o) => { noise(t, 1.1, { freq: 700, q: 0.4, vol: 1.0, type: 'lowpass', sweep: 60, attack: 0.005 }, o); tone(t, 0.6, { freq: 80, to: 25, type: 'sine', vol: 0.6 }, o); },
  hit: (t, o) => { noise(t, 0.06, { freq: 700 + Math.random() * 400, q: 2, vol: 0.18 }, o); },
  splat: (t, o) => { noise(t, 0.22, { freq: 420, q: 1.2, vol: 0.4, sweep: 120 }, o); tone(t, 0.15, { freq: 120, to: 50, type: 'triangle', vol: 0.2 }, o); },
  groan: (t, o) => {
    const f = 70 + Math.random() * 50;
    tone(t, 0.9, { freq: f, to: f * 0.7, type: 'sawtooth', vol: 0.06, attack: 0.15 }, o);
    noise(t, 0.8, { freq: 500, q: 5, vol: 0.05, attack: 0.2, sweep: 300 }, o);
  },
  roar: (t, o) => { tone(t, 1.4, { freq: 60, to: 35, type: 'sawtooth', vol: 0.3, attack: 0.1 }, o); noise(t, 1.2, { freq: 300, q: 2, vol: 0.3, attack: 0.1, sweep: 120 }, o); },
  orb: (t, o) => { tone(t, 0.35, { freq: 500, to: 180, type: 'triangle', vol: 0.16 }, o); tone(t, 0.3, { freq: 760, to: 260, type: 'sine', vol: 0.1 }, o); },
  bite: (t, o) => { noise(t, 0.1, { freq: 300, q: 1.5, vol: 0.25 }, o); },
  hurt: (t, o) => { tone(t, 0.25, { freq: 200, to: 70, type: 'square', vol: 0.18 }, o); noise(t, 0.15, { freq: 300, q: 1, vol: 0.3 }, o); },
  pickup: (t, o) => { tone(t, 0.09, { freq: 660, type: 'square', vol: 0.12 }, o); tone(t + 0.08, 0.14, { freq: 990, type: 'square', vol: 0.12 }, o); },
  heal: (t, o) => { tone(t, 0.12, { freq: 520, type: 'triangle', vol: 0.2 }, o); tone(t + 0.1, 0.12, { freq: 780, type: 'triangle', vol: 0.2 }, o); tone(t + 0.2, 0.2, { freq: 1040, type: 'triangle', vol: 0.2 }, o); },
  unlock: (t, o) => { [523, 659, 784, 1046].forEach((f, i) => tone(t + i * 0.09, 0.25, { freq: f, type: 'square', vol: 0.12 }, o)); },
  wave: (t, o) => { tone(t, 1.2, { freq: 110, to: 104, type: 'sawtooth', vol: 0.18, attack: 0.08 }, o); tone(t, 1.2, { freq: 165, to: 156, type: 'sawtooth', vol: 0.12, attack: 0.08 }, o); },
  clear: (t, o) => { [392, 523, 659].forEach((f, i) => tone(t + i * 0.12, 0.35, { freq: f, type: 'triangle', vol: 0.2 }, o)); },
  place: (t, o) => { noise(t, 0.15, { freq: 250, q: 1, vol: 0.5 }, o); tone(t, 0.12, { freq: 150, to: 80, type: 'square', vol: 0.12 }, o); },
  break: (t, o) => { noise(t, 0.4, { freq: 600, q: 0.7, vol: 0.5, sweep: 150 }, o); },
  down: (t, o) => { [440, 370, 311, 262].forEach((f, i) => tone(t + i * 0.13, 0.2, { freq: f, type: 'square', vol: 0.12 }, o)); },
  revive: (t, o) => { [262, 330, 392, 523].forEach((f, i) => tone(t + i * 0.08, 0.2, { freq: f, type: 'triangle', vol: 0.18 }, o)); },
  click: (t, o) => { tone(t, 0.03, { freq: 1200, type: 'square', vol: 0.05 }, o); },
  empty: (t, o) => { tone(t, 0.04, { freq: 900, type: 'square', vol: 0.08 }, o); },
  over: (t, o) => { [392, 349, 311, 262, 196].forEach((f, i) => tone(t + i * 0.22, 0.5, { freq: f, type: 'sawtooth', vol: 0.12 }, o)); },
};

// play(name, volume 0..1, pan -1..1)
export function play(name, vol = 1, pan = 0, minGap = 0.035) {
  if (!ctx || muted || vol < 0.02) return;
  const now = ctx.currentTime;
  if (last[name] && now - last[name] < minGap) return;
  last[name] = now;
  const g = ctx.createGain();
  g.gain.value = vol;
  let out = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(master);
  } else {
    g.connect(master);
  }
  try { SOUNDS[name] && SOUNDS[name](now, out); } catch (e) { /* ignore */ }
}
