// 小さなDOMヘルパーとモーダル
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const rnd = (a, b) => a + Math.random() * (b - a);
export const ri = (a, b) => Math.floor(rnd(a, b + 1));
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

export function genId() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---- モーダル ----
export function openModal(content, { onClose, className = '' } = {}) {
  const overlay = h('div', { class: 'modal-overlay ' + className });
  const box = h('div', { class: 'modal-box', role: 'dialog', 'aria-modal': 'true' }, content);
  overlay.append(box);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('shown');
    setTimeout(() => overlay.remove(), 180);
    if (onClose) onClose(result);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('shown'));
  return { close, box, overlay };
}

export function confirmModal({ title, message, okLabel = 'OK', cancelLabel = 'やめる', danger = false }) {
  return new Promise(resolve => {
    let m;
    const done = v => { m.close(v); };
    const body = h('div', { class: 'confirm' },
      h('h3', { class: 'modal-title' }, title),
      h('p', null, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => done(false) }, cancelLabel),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => done(true) }, okLabel)));
    m = openModal(body, { onClose: v => resolve(v === true) });
  });
}
