// ステージ（背景 + targets + 付箋 + 赤い糸）の構築
import { h } from './util.js';
import { NOTE_W, NOTE_H } from './scene.js';
import { shatterTarget } from './shatter.js';

const SVG = 'http://www.w3.org/2000/svg';
const VW = 1500, VH = 1000;

// opts: { caseData, manifest, isRevealed(i), onOpen(i) }
export function buildStage({ caseData, manifest, isRevealed, onOpen }) {
  const { scene, items } = caseData;
  const bg = manifest._bg[scene.backgroundId] || manifest.backgrounds[0];
  const stage = h('div', { class: 'stage' });
  stage.append(h('img', { class: 'stage-bg', src: bg.file, alt: '', draggable: 'false' }));
  stage.append(h('div', { class: 'stage-vignette' }));

  const targetEls = [], noteEls = [], threadEls = [];

  // ---- targets ----
  scene.targets.forEach((t, i) => {
    const a = manifest._byId[t.assetId];
    const ratio = a && a.width && a.height ? a.width / a.height : 0.5;
    const revealed = isRevealed(i);
    const el = h('div', {
      class: 'target ' + t.type + (revealed ? ' revealed' : ' unsolved'),
      'data-flip': t.flip ? '1' : '0',
      style: { left: (t.x * 100) + '%', top: (t.y * 100) + '%', height: (t.h * 100) + '%', aspectRatio: String(ratio), zIndex: String(t.z || 3), '--th': String(t.h) },
      onclick: () => onOpen(i),
    });
    const img = h('img', { class: 'timg', src: a ? a.file : '', alt: a ? a.label : '', draggable: 'false' });
    if (t.flip) img.style.transform = 'scaleX(-1)';
    el.append(img, h('div', { class: 'qmark' }, '？'), h('div', { class: 'tag' }, a ? a.label : '？'));
    if (t.type === 'item') el.append(h('div', { class: 'marker' }, h('span', null, String(i + 1))));
    stage.append(el);
    targetEls.push(el);
  });

  // ---- 糸（SVG） ----
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'threads');
  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  scene.targets.forEach((t, i) => {
    const n = scene.notes[i];
    const x1 = n.x * VW, y1 = (n.y - NOTE_H / 2) * VH + 10;
    const x2 = t.x * VW, y2 = (t.y - t.h / 2) * VH;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const bend = ((i % 2) ? 1 : -1) * Math.min(40, len * 0.08);
    const cx = mx + (-dy / len) * bend, cy = my + (dx / len) * bend + Math.min(70, len * 0.14);   // わずかにたわむ
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', 'thread');
    const sh = document.createElementNS(SVG, 'path');
    sh.setAttribute('d', d); sh.setAttribute('class', 'thread-shadow'); sh.setAttribute('pathLength', '1');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d); p.setAttribute('class', 'thread-line'); p.setAttribute('pathLength', '1');
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', x2); dot.setAttribute('cy', y2); dot.setAttribute('r', 6); dot.setAttribute('class', 'thread-dot');
    g.append(sh, p, dot);
    svg.append(g);
    threadEls.push(g);
  });
  stage.append(svg);

  // ---- 付箋 ----
  scene.notes.forEach((n, i) => {
    const el = h('div', {
      class: `note c-${n.color}` + (i % 2 ? ' taped' : ''),
      role: 'button', tabindex: '0',
      style: { left: (n.x * 100) + '%', top: (n.y * 100) + '%', width: (NOTE_W * 100) + '%', '--rot': n.rot + 'deg', '--delay': (i * 0.09) + 's' },
      onclick: () => onOpen(i),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i); } },
    });
    el.append(
      h('div', { class: 'paper' },
        h('span', { class: 'num' }, String(i + 1)),
        h('div', { class: 'ntitle' }),
        h('div', { class: 'ndetail' }),
        h('div', { class: 'ndecision' })),
      h('div', { class: 'pin' }),
      h('div', { class: 'stamp' }, '解決'));
    stage.append(el);
    noteEls.push(el);
  });

  // ---- 装飾 ----
  stage.append(
    h('div', { class: 'plate' }, h('span', { class: 'plate-k' }, 'CASE FILE'), h('span', { class: 'plate-t' }, caseData.title)),
    h('div', { class: 'keepout' }, h('span', null, 'KEEP OUT • KEEP OUT • KEEP OUT • KEEP OUT • KEEP OUT • KEEP OUT •')));

  function refreshNote(i, { stampAnim = false } = {}) {
    const it = items[i], el = noteEls[i];
    const solved = !!it.solvedAt;
    el.querySelector('.ntitle').textContent = it.title;
    el.querySelector('.ndetail').textContent = it.detail || '';
    el.querySelector('.ndecision').textContent = it.decision || '';
    el.classList.toggle('solved', solved);
    el.classList.toggle('has-detail', !!it.detail);
    threadEls[i].classList.toggle('solved', solved);
    if (solved && stampAnim) {
      const st = el.querySelector('.stamp');
      st.classList.remove('slam'); void st.offsetWidth; st.classList.add('slam');
    }
  }
  items.forEach((_, i) => refreshNote(i));

  function reveal(i) {
    targetEls[i].classList.remove('unsolved', 'shattering');
    targetEls[i].classList.add('revealed');
  }
  async function shatter(i) {
    const el = targetEls[i], t = scene.targets[i];
    const a = manifest._byId[t.assetId];
    await shatterTarget(stage, el, { label: a ? a.label : '？？？', cx: t.x, cy: t.y - t.h / 2, top: t.y - t.h });
    reveal(i);
  }

  // ステージを親要素に収まる最大の 3:2 にする
  function fit(container) {
    const cw = container.clientWidth - 24, ch = container.clientHeight - 24;
    const w = Math.max(320, Math.floor(Math.min(cw, ch * 1.5)));
    stage.style.width = w + 'px';
    stage.style.height = Math.round(w / 1.5) + 'px';
    stage.style.setProperty('--u', (w / 1000) + 'px');
  }

  return { el: stage, targetEls, noteEls, refreshNote, reveal, shatter, fit };
}
