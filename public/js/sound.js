// 効果音・音楽・ナレーション。音声ファイル（assets/audio/manifest.json）があればそれを、なければ WebAudio 合成音を鳴らす
let ctx = null;
let sfxBus = null, musicBus = null, voiceBus = null, duck = null;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
let sfxOn = lsGet('kt_sfx') !== null ? lsGet('kt_sfx') !== '0' : lsGet('kt_muted') !== '1';
let voiceOn = lsGet('kt_voice') !== '0';

export const isSfxOn = () => sfxOn;
export const isVoiceOn = () => voiceOn;
export function setSfxOn(v) {
  sfxOn = !!v; lsSet('kt_sfx', sfxOn ? '1' : '0');
  if (!sfxOn) { stopMusic(0.1); activeSfx.forEach(s => { try { s.stop(); } catch (e) { /* ignore */ } }); activeSfx.clear(); }
}
export function setVoiceOn(v) {
  voiceOn = !!v; lsSet('kt_voice', voiceOn ? '1' : '0');
  if (!voiceOn) stopVoice();
}

// ---------- AudioContext / バス ----------
function ensureCtx() {
  if (ctx) return ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    duck = ctx.createGain(); duck.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.connect(duck);
    voiceBus = ctx.createGain(); voiceBus.connect(ctx.destination);
  } catch (e) { ctx = null; }
  return ctx;
}
function ac() {
  const a = ensureCtx();
  if (!a) return null;
  if (a.state === 'suspended') a.resume().catch(() => {});
  return a;
}
function unlock() { const a = ensureCtx(); if (a && a.state === 'suspended') a.resume().catch(() => {}); }
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, unlock, { capture: true, passive: true }));

// ---------- manifest / バッファ ----------
let manifest = null;
const bufs = new Map();      // path -> AudioBuffer
const loading = new Map();   // path -> Promise
function loadBuf(path) {
  if (bufs.has(path)) return Promise.resolve(bufs.get(path));
  if (loading.has(path)) return loading.get(path);
  const p = (async () => {
    try {
      const a = ensureCtx(); if (!a) return null;
      const res = await fetch(path);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      const buf = await new Promise((ok, ng) => {
        const r = a.decodeAudioData(data, ok, ng);
        if (r && r.then) r.then(ok, ng);
      });
      bufs.set(path, buf);
      return buf;
    } catch (e) { return null; }
  })();
  loading.set(path, p);
  return p;
}
const sfxFiles = cat => (manifest && manifest.sfx && Array.isArray(manifest.sfx[cat]) ? manifest.sfx[cat] : []);
const voiceEntries = cat => (manifest && manifest.voice && Array.isArray(manifest.voice[cat]) ? manifest.voice[cat] : []);

(async function init() {
  try {
    const res = await fetch('assets/audio/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const m = await res.json();
    if (!m || typeof m !== 'object') return;
    manifest = m;
  } catch (e) { return; }
  const first = [];
  Object.values(manifest.sfx || {}).forEach(l => (Array.isArray(l) ? l : []).forEach(f => first.push(f)));
  Object.values(manifest.music || {}).forEach(f => { if (typeof f === 'string') first.push(f); });
  await Promise.all(first.map(loadBuf));
  // voice はアイドル時に順次
  const files = [];
  Object.values(manifest.voice || {}).forEach(l => (Array.isArray(l) ? l : []).forEach(e => e && e.file && files.push(e.file)));
  const idle = window.requestIdleCallback ? f => window.requestIdleCallback(f, { timeout: 3000 }) : f => setTimeout(f, 300);
  const next = () => { const f = files.shift(); if (!f) return; loadBuf(f).then(() => idle(next)); };
  idle(next);
})();

// ---------- ランダム選択（カテゴリごとに直近 2 件を避ける） ----------
const recent = {};
function pickAvoid(key, list, idOf) {
  if (!list.length) return null;
  const rec = recent[key] || (recent[key] = []);
  let cand = list.filter(x => !rec.includes(idOf(x)));
  if (!cand.length) cand = list.filter(x => idOf(x) !== rec[rec.length - 1]);
  if (!cand.length) cand = list;
  const x = cand[Math.floor(Math.random() * cand.length)];
  rec.push(idOf(x)); while (rec.length > 2) rec.shift();
  return x;
}

// ---------- ファイル再生 ----------
const activeSfx = new Set();
// 戻り値 true: 処理済み（鳴らした or OFF）/ false: ファイルなし → 合成音へ
function playSfxFile(cat, rateJitter = 0) {
  if (!sfxOn) return true;
  const f = pickAvoid('sfx:' + cat, sfxFiles(cat).filter(p => bufs.has(p)), p => p);
  if (!f) return false;
  const a = ac(); if (!a) return false;
  const src = a.createBufferSource();
  src.buffer = bufs.get(f);
  if (rateJitter) src.playbackRate.value = 1 - rateJitter + Math.random() * rateJitter * 2;
  src.connect(sfxBus);
  activeSfx.add(src);
  src.onended = () => activeSfx.delete(src);
  src.start();
  return true;
}

let music = null;   // { src, g }
export function stopMusic(fade = 0.25) {
  if (!music) return;
  const m = music; music = null;
  try {
    const t = ctx.currentTime;
    m.g.gain.cancelScheduledValues(t); m.g.gain.setValueAtTime(m.g.gain.value, t);
    m.g.gain.linearRampToValueAtTime(0, t + fade);
    m.src.stop(t + fade + 0.02);
  } catch (e) { /* ignore */ }
}
export function playMusic(name) {
  if (!sfxOn) return false;
  const f = manifest && manifest.music && manifest.music[name];
  if (!f || !bufs.has(f)) return false;
  const a = ac(); if (!a) return false;
  stopMusic(0.2);
  const src = a.createBufferSource(); src.buffer = bufs.get(f);
  const g = a.createGain();
  src.connect(g).connect(musicBus);
  const m = { src, g }; music = m;
  src.onended = () => { if (music === m) music = null; };
  src.start();
  return true;
}

// ---------- ナレーション ----------
let voiceCur = null;   // { src, entry }
let voiceToken = 0;
let subHandler = null;
// fn({text, duration}) で表示、fn(null) で消す
export function setSubtitleHandler(fn) { subHandler = fn; }
function duckMusic(on) {
  if (!duck || !ctx) return;
  const t = ctx.currentTime;
  duck.gain.cancelScheduledValues(t);
  duck.gain.setValueAtTime(duck.gain.value, t);
  duck.gain.linearRampToValueAtTime(on ? 0.4 : 1, t + (on ? 0.15 : 0.5));   // 約 -8dB
}
export function stopVoice() {
  voiceToken++;
  const v = voiceCur; voiceCur = null;
  if (v) { v.src.onended = null; try { v.src.stop(); } catch (e) { /* ignore */ } }
  duckMusic(false);
  if (subHandler) subHandler(null);
}
export async function playVoice(cat) {
  if (!voiceOn) return false;
  const e = pickAvoid('voice:' + cat, voiceEntries(cat).filter(x => x && x.file), x => x.id || x.file);
  if (!e) return false;
  const my = ++voiceToken;
  const buf = await loadBuf(e.file);
  if (!buf || my !== voiceToken || !voiceOn) return false;
  const a = ac(); if (!a) return false;
  if (voiceCur) { voiceCur.src.onended = null; try { voiceCur.src.stop(); } catch (er) { /* ignore */ } voiceCur = null; }
  const src = a.createBufferSource(); src.buffer = buf; src.connect(voiceBus);
  const cur = { src, entry: e }; voiceCur = cur;
  duckMusic(true);
  src.onended = () => {
    if (voiceCur !== cur) return;
    voiceCur = null; duckMusic(false);
    if (subHandler) subHandler(null);
  };
  src.start();
  if (subHandler) subHandler({ text: e.text || '', duration: buf.duration || e.duration || 2 });
  return true;
}
export function stopAll() {
  stopVoice(); stopMusic(0.2);
  activeSfx.forEach(s => { try { s.stop(); } catch (e) { /* ignore */ } }); activeSfx.clear();
}

// ---------- 合成音（ファイルがないときのフォールバック） ----------
function synthOk() { return sfxOn ? ac() : null; }
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
  src.connect(f).connect(g).connect(sfxBus);
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
  o.connect(g).connect(sfxBus);
  o.start(t); o.stop(t + dur + 0.05);
}

// ヒビが入る音
export function crack() {
  if (playSfxFile('crack')) return;
  const a = synthOk(); if (!a) return;
  const t = a.currentTime;
  [0, 0.06, 0.13, 0.19].forEach(o => noiseBurst(a, t + o, { dur: 0.05, decay: 3, hp: r(3500, 6000), gain: 0.25 }));
  ping(a, t, r(1800, 2600), 0.15, 0.05);
}
// パリン！
export function shatter() {
  if (playSfxFile('shatter', 0.05)) return;
  const a = synthOk(); if (!a) return;
  const t = a.currentTime;
  noiseBurst(a, t, { dur: 0.55, decay: 2.2, hp: r(2200, 3200), gain: 0.55 });
  noiseBurst(a, t, { dur: 0.15, decay: 1.5, hp: 600, gain: 0.35, type: 'bandpass' });
  const n = 7 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) ping(a, t + r(0, 0.22), r(2200, 7800), r(0.15, 0.6), r(0.03, 0.09));
}
// 判子のドン
export function thud() {
  if (playSfxFile('thud')) return;
  const a = synthOk(); if (!a) return;
  const t = a.currentTime;
  noiseBurst(a, t, { dur: 0.25, decay: 3, hp: 400, gain: 0.7, type: 'lowpass' });
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
  const g = a.createGain();
  g.gain.setValueAtTime(0.8, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(sfxBus);
  o.start(t); o.stop(t + 0.35);
}
// 付箋に「解決」を押す軽い音
export function stampSoft() {
  if (playSfxFile('stamp')) return;
  const a = synthOk(); if (!a) return;
  noiseBurst(a, a.currentTime, { dur: 0.1, decay: 3, hp: 700, gain: 0.3, type: 'lowpass' });
}
