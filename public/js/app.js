import { loadManifest } from './api.js';
import { h } from './util.js';
import { mountHome } from './home.js';
import { mountSetup } from './setup.js';
import { mountPlay } from './play.js';

const root = document.getElementById('app');
const ctx = {
  manifest: null,
  manifestError: null,
  intro: null,                       // 立件直後の「事件発生」演出を出す事件 id
  go: hash => { location.hash = hash; },
};
let cleanup = null;
let seq = 0;

export function manifestMissing(back = true) {
  return h('div', { class: 'notice-box' },
    h('h2', null, '画像セットが未生成です'),
    h('p', null, '（README.md の「画像セットの作り直し」を参照）'),
    back ? h('a', { class: 'btn ghost', href: '#/' }, '事件簿へ戻る') : null);
}

async function route() {
  const my = ++seq;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  root.innerHTML = '';
  document.body.className = '';
  const hash = location.hash || '#/';
  let view;
  try {
    if (hash.startsWith('#/new')) view = mountSetup(root, ctx);
    else if (hash.startsWith('#/case/')) view = mountPlay(root, ctx, decodeURIComponent(hash.slice(7).split('?')[0]));
    else view = mountHome(root, ctx);
    const c = await view;
    if (my !== seq) { if (c) c(); return; }
    cleanup = c || null;
  } catch (e) {
    console.error(e);
    root.append(h('div', { class: 'notice-box' }, h('h2', null, 'エラーが発生しました'), h('p', null, String(e && e.message || e)),
      h('a', { class: 'btn ghost', href: '#/' }, '事件簿へ戻る')));
  }
}

async function start() {
  try { ctx.manifest = await loadManifest(); } catch (e) { ctx.manifestError = String(e && e.message || e); }
  window.addEventListener('hashchange', route);
  route();
}
start();
