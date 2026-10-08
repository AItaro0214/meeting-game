// WebAudio による効果音の合成（音声ファイルは使わない）
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('kt_muted') === '1'; } catch (e) { /* ignore */ }

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('kt_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
}
function ac() {
  if (muted) return null;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch (e) { return null; }
}
const r = (a, b) => a + Math.random() * (b - a);

function noise(a, dur, decay) {
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  return buf;
}
function noiseBurst(a, t, { dur = 0.4, decay = 2, hp = 2500, gain = 0.5, type = 'highpass' }) {
  const src = a.createBufferSource();
  src.buffer = noise(a, dur, decay);
  const f = a.createBiquadFilter();
  f.type = type; f.frequency.value = hp;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}
function ping(a, t, freq, dur, gain) {
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * r(0.97, 1.03), t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

// ヒビが入る音
export function crack() {
  const a = ac(); if (!a) return;
  const t = a.currentTime;
  [0, 0.06, 0.13, 0.19].forEach(o => noiseBurst(a, t + o, { dur: 0.05, decay: 3, hp: r(3500, 6000), gain: 0.25 }));
  ping(a, t, r(1800, 2600), 0.15, 0.05);
}
// パリン！
export function shatter() {
  const a = ac(); if (!a) return;
  const t = a.currentTime;
  noiseBurst(a, t, { dur: 0.55, decay: 2.2, hp: r(2200, 3200), gain: 0.55 });
  noiseBurst(a, t, { dur: 0.15, decay: 1.5, hp: 600, gain: 0.35, type: 'bandpass' });
  const n = 7 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) ping(a, t + r(0, 0.22), r(2200, 7800), r(0.15, 0.6), r(0.03, 0.09));
}
// 判子のドン
export function thud() {
  const a = ac(); if (!a) return;
  const t = a.currentTime;
  noiseBurst(a, t, { dur: 0.25, decay: 3, hp: 400, gain: 0.7, type: 'lowpass' });
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
  const g = a.createGain();
  g.gain.setValueAtTime(0.8, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + 0.35);
}
// 付箋に「解決」を押す軽い音
export function stampSoft() {
  const a = ac(); if (!a) return;
  noiseBurst(a, a.currentTime, { dur: 0.1, decay: 3, hp: 700, gain: 0.3, type: 'lowpass' });
}
