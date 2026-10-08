// パリン！演出：黒塗りシルエットがガラスのように割れて、下の本物が現れる
import { h, rnd, ri, sleep, reducedMotion } from './util.js';
import * as sound from './sound.js';

const TAU = Math.PI * 2;
const CRACK_MS = 250;
const BURST_MS = 900;

// シルエット（brightness(0)）を描いたオフスクリーン canvas を作る
function makeSilhouette(img, flip, cw, ch, pad, w, hgt, dpr) {
  const off = document.createElement('canvas');
  off.width = Math.ceil(cw * dpr); off.height = Math.ceil(ch * dpr);
  const o = off.getContext('2d');
  o.setTransform(dpr, 0, 0, dpr, 0, 0);
  o.save();
  o.translate(pad + (flip ? w : 0), pad);
  if (flip) o.scale(-1, 1);
  if ('filter' in o) {
    o.filter = 'brightness(0)';
    o.drawImage(img, 0, 0, w, hgt);
  } else {
    o.drawImage(img, 0, 0, w, hgt);
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = '#000';
    o.fillRect(0, 0, w, hgt);
  }
  o.restore();
  return off;
}

function buildCracks(ix, iy, size) {
  const nLines = ri(10, 14), K = 14;
  const lines = [];
  const base = rnd(0, TAU);
  for (let i = 0; i < nLines; i++) {
    let a = base + (i + rnd(-0.3, 0.3)) * TAU / nLines;
    const len = size * rnd(0.55, 1.0), step = len / K;
    const pts = [[ix, iy]];
    let x = ix, y = iy;
    for (let k = 0; k < K; k++) {
      a += rnd(-0.22, 0.22);
      x += Math.cos(a) * step * rnd(0.8, 1.2);
      y += Math.sin(a) * step * rnd(0.8, 1.2);
      pts.push([x, y]);
    }
    lines.push({ a: i, pts });
  }
  // 同心円状のヒビ（隣り合う放射線の同じ段を結ぶ）
  const rings = [];
  [3, 6, 9, 12].forEach(k => {
    for (let i = 0; i < nLines; i++) {
      if (Math.random() < 0.3) continue;
      rings.push({ k, p: lines[i].pts[k], q: lines[(i + 1) % nLines].pts[k] });
    }
  });
  return { lines, rings, K };
}

function drawCracks(ctx, cr, p) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(190,225,255,0.95)';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.8;
  const reach = p * cr.K;
  for (const l of cr.lines) {
    ctx.beginPath();
    ctx.moveTo(l.pts[0][0], l.pts[0][1]);
    const full = Math.floor(reach);
    for (let k = 1; k <= full && k < l.pts.length; k++) ctx.lineTo(l.pts[k][0], l.pts[k][1]);
    if (full < cr.K) {
      const f = reach - full, a = l.pts[full], b = l.pts[full + 1];
      if (a && b) ctx.lineTo(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const r of cr.rings) {
    if (r.k > reach - 0.5) continue;
    ctx.moveTo(r.p[0], r.p[1]); ctx.lineTo(r.q[0], r.q[1]);
  }
  ctx.stroke();
  ctx.restore();
}

function buildShards(ix, iy, bounds) {
  const A = ri(14, 18), R = ri(3, 4);
  const maxR = Math.max(
    Math.hypot(bounds.x0 - ix, bounds.y0 - iy), Math.hypot(bounds.x1 - ix, bounds.y0 - iy),
    Math.hypot(bounds.x0 - ix, bounds.y1 - iy), Math.hypot(bounds.x1 - ix, bounds.y1 - iy)) * 1.08;
  const ang = [];
  for (let a = 0; a < A; a++) ang.push((a + rnd(-0.28, 0.28)) * TAU / A + rnd(0, 0.01));
  const V = [];
  for (let k = 1; k <= R; k++) {
    const row = [];
    const rr = maxR * Math.pow(k / R, 1.55);
    for (let a = 0; a < A; a++) {
      const rj = k === R ? rnd(0.98, 1.05) : rnd(0.86, 1.14);
      const aj = ang[a] + (k === R ? 0 : rnd(-0.06, 0.06));
      row.push([ix + Math.cos(aj) * rr * rj, iy + Math.sin(aj) * rr * rj]);
    }
    V.push(row);
  }
  const polys = [];
  for (let a = 0; a < A; a++) {
    const b = (a + 1) % A;
    polys.push([[ix, iy], V[0][a], V[0][b]]);
    for (let k = 0; k < R - 1; k++) polys.push([V[k][a], V[k][b], V[k + 1][b], V[k + 1][a]]);
  }
  const shards = [];
  for (const poly of polys) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, cx = 0, cy = 0;
    for (const [x, y] of poly) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); cx += x; cy += y; }
    cx /= poly.length; cy /= poly.length;
    // シルエットに全く触れない破片は捨てる
    if (maxx < bounds.x0 || minx > bounds.x1 || maxy < bounds.y0 || miny > bounds.y1) continue;
    const d = Math.hypot(cx - ix, cy - iy) || 1;
    const speed = (620 - 380 * Math.min(1, d / maxR)) * rnd(0.7, 1.25);
    shards.push({
      poly, cx, cy,
      vx: (cx - ix) / d * speed + rnd(-60, 60),
      vy: (cy - iy) / d * speed - rnd(60, 280),
      va: rnd(-4.5, 4.5), a0: 0,
      fadeAt: rnd(0.35, 0.55),
    });
  }
  return shards;
}

function sparkle(ctx, x, y, s, a, rot) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.globalAlpha = Math.max(0, a);
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(255,240,170,1)'; ctx.shadowBlur = 8;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 === 0 ? s : s * 0.28, t = i * Math.PI / 4;
    ctx.lineTo(Math.cos(t) * rr, Math.sin(t) * rr);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// stage: ステージ要素 / targetEl: .target 要素 / info: { label, cx, top }（ステージ割合）
export async function shatterTarget(stage, targetEl, info) {
  const img = targetEl.querySelector('.timg');
  targetEl.classList.add('shattering');
  const quick = reducedMotion();
  showPop(stage, info, quick);
  if (quick) {
    sound.shatter();
    targetEl.classList.add('flash-soft');
    await sleep(500);
    targetEl.classList.remove('flash-soft');
    return;
  }

  const flip = targetEl.dataset.flip === '1';
  const w = targetEl.offsetWidth, hgt = targetEl.offsetHeight;
  const pad = Math.round(Math.max(w, hgt) * 0.65);
  const cw = w + pad * 2, ch = hgt + pad * 2;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = h('canvas', { class: 'shatter-canvas' });
  canvas.width = Math.ceil(cw * dpr); canvas.height = Math.ceil(ch * dpr);
  canvas.style.cssText = `position:absolute;left:${-pad}px;top:${-pad}px;width:${cw}px;height:${ch}px;pointer-events:none;z-index:8`;
  targetEl.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const sil = makeSilhouette(img, flip, cw, ch, pad, w, hgt, dpr);
  const ix = pad + w * rnd(0.4, 0.6), iy = pad + hgt * rnd(0.35, 0.55);
  const cracks = buildCracks(ix, iy, Math.max(w, hgt) * 0.75);
  const raf = () => new Promise(r => requestAnimationFrame(r));

  // ① ヒビ
  sound.crack();
  let t0 = performance.now();
  for (;;) {
    const t = performance.now() - t0, p = Math.min(1, t / CRACK_MS);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(sil, 0, 0, cw, ch);
    drawCracks(ctx, cracks, p);
    canvas.style.transform = `translate(${rnd(-2, 2)}px,${rnd(-2, 2)}px)`;
    if (p >= 1) break;
    await raf();
  }
  canvas.style.transform = '';

  // ② 破裂
  sound.shatter();
  stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
  const shards = buildShards(ix, iy, { x0: pad, y0: pad, x1: pad + w, y1: pad + hgt });
  const flashR = Math.max(w, hgt) * 0.9;
  const sparks = [];
  for (let i = 0; i < 44; i++) {
    const a = rnd(0, TAU), sp = rnd(160, 760);
    sparks.push({ x: ix + rnd(-8, 8), y: iy + rnd(-8, 8), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: rnd(0.45, 1.0), s: rnd(2.5, 6.5), r: rnd(0, TAU), tw: rnd(8, 18) });
  }
  const G = 1500;
  t0 = performance.now();
  for (;;) {
    const t = (performance.now() - t0) / 1000, p = t / (BURST_MS / 1000);
    if (p >= 1) break;
    ctx.clearRect(0, 0, cw, ch);
    for (const s of shards) {
      const fp = p < s.fadeAt ? 1 : Math.max(0, 1 - (p - s.fadeAt) / (1 - s.fadeAt));
      const dx = s.vx * t, dy = s.vy * t + 0.5 * G * t * t, rot = s.va * t;
      ctx.save();
      ctx.globalAlpha = fp;
      ctx.translate(s.cx + dx, s.cy + dy);
      ctx.rotate(rot);
      ctx.translate(-s.cx, -s.cy);
      ctx.beginPath();
      s.poly.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath();
      ctx.save();
      ctx.clip();
      ctx.drawImage(sil, 0, 0, cw, ch);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();
    }
    // 白いフラッシュ
    if (t < 0.22) {
      const fa = 1 - t / 0.22;
      const g = ctx.createRadialGradient(ix, iy, 0, ix, iy, flashR);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * fa})`);
      g.addColorStop(0.35, `rgba(220,240,255,${0.5 * fa})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    }
    // キラキラ
    for (const k of sparks) {
      if (t > k.life) continue;
      const x = k.x + k.vx * t, y = k.y + k.vy * t + 300 * t * t;
      const tw = 0.6 + 0.4 * Math.sin(t * k.tw);
      sparkle(ctx, x, y, k.s * (1 - t / k.life * 0.5), (1 - t / k.life) * tw + 0.1, k.r + t * 3);
    }
    await raf();
  }
  canvas.remove();
}

function showPop(stage, info, quick) {
  const cx = Math.min(0.85, Math.max(0.15, info.cx));
  const pop = h('div', { class: 'pop-sfx' + (quick ? ' quick' : ''), style: { left: (cx * 100) + '%', top: (info.cy * 100) + '%' } }, 'パリン！');
  const topY = Math.max(0.1, info.top - 0.02);
  const banner = h('div', { class: 'reveal-banner' + (quick ? ' quick' : ''), style: { left: (cx * 100) + '%', top: (topY * 100) + '%' } },
    h('span', { class: 'rb-k' }, '正体：'), h('span', { class: 'rb-v' }, info.label || '？？？'));
  stage.append(pop, banner);
  setTimeout(() => pop.remove(), 1500);
  setTimeout(() => banner.remove(), 2300);
}
