// 項目数 N に応じた「ちょうどいい現場」を生成する
import { rnd, ri, pick, clamp, lerp, shuffle } from './util.js';

export const NOTE_W = 0.135;                 // 付箋の幅（ステージ幅比）
export const NOTE_H = NOTE_W * 1.5;          // 付箋の高さ（ステージ高さ比。正方形なので 3:2 換算）
export const STAGE_ASPECT = 1.5;
const COLORS = ['yellow', 'pink', 'blue', 'green'];

function weightedPick(list) {
  const total = list.reduce((s, t) => s + (t.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const t of list) { r -= (t.weight ?? 1); if (r <= 0) return t; }
  return list[list.length - 1];
}

export function generateTitle(manifest, themeId) {
  const theme = manifest.themes.find(t => t.id === themeId) || weightedPick(manifest.themes);
  const place = pick(theme.titlePlaces?.length ? theme.titlePlaces : ['社内']);
  const noun = pick(theme.titleNouns?.length ? theme.titleNouns : ['謎']);
  return { title: `${place}の${noun}事件`, themeId: theme.id };
}

function pickAssets(all, themeId, count) {
  const fit = shuffle(all.filter(a => !a.themes || a.themes.includes(themeId) || a.themes.includes('any')));
  const rest = shuffle(all.filter(a => !fit.includes(a)));
  const pool = [...fit, ...rest];
  const out = pool.slice(0, count);
  while (out.length < count && pool.length) out.push(pick(pool));   // 素材不足時のみ重複を許す
  return out;
}

const aspectOf = a => (a && a.width && a.height) ? a.width / a.height : 0.5;
// ステージ幅に対する target の幅の割合
const widthFrac = (a, h) => h * aspectOf(a) / STAGE_ASPECT;

export function generateScene(manifest, n, preferredThemeId) {
  const theme = manifest.themes.find(t => t.id === preferredThemeId) || weightedPick(manifest.themes);
  const bgs = manifest.backgrounds.filter(b => b.theme === theme.id);
  const bg = pick(bgs.length ? bgs : manifest.backgrounds);
  const floorY = bg.floorY ?? 0.85;

  // 人物数 c
  let c;
  if (n === 1) c = Math.random() < 0.5 ? 1 : 0;
  else c = clamp(Math.round(n * rnd(0.4, 0.6)), 1, Math.min(n, 5));
  const m = n - c;

  const chars = pickAssets(manifest.characters, theme.id, c);
  const items = pickAssets(manifest.items, theme.id, m);
  const targets = [];

  // 人物：床ラインに沿って横に分散
  const charXs = [];
  for (let k = 0; k < c; k++) {
    const base = c === 1 ? 0.5 + rnd(-0.12, 0.12) : lerp(0.2, 0.8, k / (c - 1)) + rnd(-0.035, 0.035);
    const back = k % 2 === 1;
    let hh = lerp(0.62, 0.42, (c - 1) / 4) * (back ? 0.92 : 1);
    let y = clamp(floorY + (back ? -0.035 : 0.015), 0.5, 0.95);
    if (y - hh < 0.1) hh = y - 0.1;
    const w = widthFrac(chars[k], hh);
    const x = clamp(base, w / 2 + 0.02, 1 - w / 2 - 0.02);
    charXs.push(x);
    targets.push({ type: 'character', assetId: chars[k].id, x: +x.toFixed(3), y: +y.toFixed(3), h: +hh.toFixed(3), flip: Math.random() < 0.5, z: back ? 2 : 3 });
  }

  // 道具：手前（y 0.90〜0.97）で人物の間に
  if (m > 0) {
    const sorted = charXs.slice().sort((a, b) => a - b);
    // 人物の間を優先し、足りなければ人物から離れた位置を足す
    const mids = [];
    for (let i = 0; i + 1 < sorted.length; i++) mids.push((sorted[i] + sorted[i + 1]) / 2);
    const extra = [0.14, 0.86, 0.32, 0.68, 0.5].filter(x => sorted.every(cx => Math.abs(cx - x) > 0.09));
    const even = [];
    for (let j = 0; j < m; j++) even.push(0.12 + 0.76 * (j + 0.5) / m);
    // 道具どうしが重ならないよう間隔を空けて拾う（足りなければ均等配置で補う）
    const xs = [];
    for (const x of [...shuffle(mids), ...shuffle(extra), ...even]) {
      if (xs.length >= m) break;
      if (xs.every(p => Math.abs(p - x) > 0.1)) xs.push(x);
    }
    for (const x of even) { if (xs.length >= m) break; xs.push(x); }
    if (m === 1 && c === 0) xs[0] = 0.5 + rnd(-0.15, 0.15);
    const baseH = m === 1 ? (c === 0 ? 0.36 : 0.24) : lerp(0.2, 0.13, (m - 1) / 7);
    xs.forEach((cx, j) => {
      // 横長の道具は長辺基準で大きさを揃える
      const hh = clamp(baseH * rnd(0.92, 1.05), 0.13, 0.38) / Math.max(1, aspectOf(items[j]) * 0.8);
      const w = widthFrac(items[j], hh);
      const jit = m > 4 ? 0.012 : 0.03;
      const x = clamp(cx + rnd(-jit, jit), w / 2 + 0.02, 1 - w / 2 - 0.02);
      targets.push({ type: 'item', assetId: items[j].id, x: +x.toFixed(3), y: +rnd(0.9, 0.97).toFixed(3), h: +hh.toFixed(3), flip: Math.random() < 0.4, z: 6 });
    });
  }

  // targets と項目の対応は毎回ランダム
  const ordered = shuffle(targets);
  const notes = layoutNotes(ordered, manifest);
  return { themeId: theme.id, backgroundId: bg.id, targets: ordered, notes };
}

// 付箋：targets と重なりにくい候補スロットから選ぶ
function layoutNotes(targets, manifest) {
  const slots = [];
  // 左上は事件名プレートがあるので少し下げる
  [[0.11, 0.24], [0.29, 0.22], [0.47, 0.19], [0.65, 0.19], [0.84, 0.19]].forEach(([x, y]) => slots.push({ x, y }));
  [[0.075, 0.46], [0.075, 0.67], [0.925, 0.46], [0.925, 0.67]].forEach(([x, y]) => slots.push({ x, y }));
  const boxes = targets.map(t => {
    const a = manifest._byId?.[t.assetId] || manifest.characters.concat(manifest.items).find(q => q.id === t.assetId);
    const w = widthFrac(a, t.h);
    return { x0: t.x - w / 2, x1: t.x + w / 2, y0: t.y - t.h, y1: t.y, cx: t.x, cy: t.y - t.h / 2 };
  });
  const used = new Set();
  const colors = [];
  while (colors.length < targets.length) colors.push(...shuffle(COLORS));
  const notes = new Array(targets.length);
  const order = shuffle(targets.map((_, i) => i));
  for (const i of order) {
    const b = boxes[i];
    let best = -1, bestScore = Infinity;
    slots.forEach((s, si) => {
      if (used.has(si)) return;
      let overlap = 0;
      for (const o of boxes) {
        const ox = Math.max(0, Math.min(s.x + NOTE_W / 2, o.x1) - Math.max(s.x - NOTE_W / 2, o.x0));
        const oy = Math.max(0, Math.min(s.y + NOTE_H / 2, o.y1) - Math.max(s.y - NOTE_H / 2, o.y0));
        overlap += ox * oy;
      }
      const dist = Math.hypot((s.x - b.cx) * STAGE_ASPECT, s.y - b.cy);
      const score = overlap * 25 + dist * 0.5 + Math.random() * 0.08;
      if (score < bestScore) { bestScore = score; best = si; }
    });
    used.add(best);
    const s = slots[best];
    notes[i] = {
      x: +clamp(s.x + rnd(-0.012, 0.012), NOTE_W / 2 + 0.005, 1 - NOTE_W / 2 - 0.005).toFixed(3),
      y: +(s.y + rnd(-0.015, 0.015)).toFixed(3),
      rot: +rnd(-7, 7).toFixed(1),
      color: colors[i],
    };
  }
  return notes;
}
