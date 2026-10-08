import { listCases, deleteCase, putCase, isLocalStorageMode } from './api.js';
import { h, fmtDate, confirmModal } from './util.js';

const STATUS = {
  setup: ['準備中', 'st-setup'],
  investigating: ['捜査中', 'st-inv'],
  solved: ['全解決', 'st-solved'],
  closed: ['CASE CLOSED', 'st-closed'],
};

export async function mountHome(root, ctx) {
  const modeNote = h('p', { class: 'mode-note', hidden: true }, '※ この環境では事件ファイルはこのブラウザ内に保存されます。別の端末へ持ち出すときは、振り返り画面の「JSON をダウンロード」を使ってください。');
  isLocalStorageMode().then(ls => { modeNote.hidden = !ls; });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    try {
      const c = JSON.parse(await f.text());
      if (!c || typeof c.id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(c.id) || !Array.isArray(c.items) || !c.items.length || !c.scene)
        throw new Error('invalid');
      await putCase(c);
      ctx.go('#/case/' + encodeURIComponent(c.id));
    } catch { alert('事件ファイルを読み込めませんでした（会議探偵の JSON を選んでください）'); }
  } });
  const grid = h('div', { class: 'case-grid' });
  const page = h('div', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-sub' }, 'MEETING DETECTIVE'),
        h('h1', null, '会議探偵'),
        h('p', null, '決めごと事件簿 ― 打ち合わせの「決めたいこと」を、事件の手がかりとして解き明かせ。')),
      h('div', { class: 'home-actions' },
        h('a', { class: 'btn primary big', href: '#/new' }, '新しい事件を立件する'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => fileIn.click() }, '事件ファイル（JSON）を読み込む'))),
    modeNote,
    ctx.manifestError ? h('div', { class: 'banner-warn' }, '画像セットが未生成です（README.md の「画像セットの作り直し」を参照）') : null,
    h('h2', { class: 'section-title' }, '事件簿'),
    grid, fileIn);
  root.append(page);

  let list = [];
  try { list = await listCases(); }
  catch (e) { grid.append(h('p', { class: 'empty' }, '事件簿を読み込めませんでした。')); return; }

  const empty = h('p', { class: 'empty' }, 'まだ事件はありません。「新しい事件を立件する」から最初の事件を始めましょう。');
  if (!list.length) grid.append(empty);

  for (const c of list) {
    const [label, cls] = STATUS[c.status] || STATUS.setup;
    const pct = c.total ? Math.round(c.solved / c.total * 100) : 0;
    const card = h('article', { class: 'case-card ' + cls, tabindex: '0', role: 'link',
      onclick: () => ctx.go('#/case/' + encodeURIComponent(c.id)),
      onkeydown: e => { if (e.key === 'Enter') ctx.go('#/case/' + encodeURIComponent(c.id)); } },
      h('div', { class: 'card-stamp' }, label),
      h('div', { class: 'card-no' }, 'FILE No. ' + c.id.slice(0, 8)),
      h('h3', null, c.title || '(無題の事件)'),
      h('div', { class: 'card-meta' }, fmtDate(c.updatedAt || c.createdAt)),
      h('div', { class: 'card-prog' },
        h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })),
        h('span', null, `解決 ${c.solved}/${c.total}`)),
      h('div', { class: 'card-open' }, c.status === 'closed' ? '振り返る' : '捜査を再開'),
      h('button', { class: 'card-del', title: '削除', 'aria-label': '削除',
        onclick: async e => {
          e.stopPropagation();
          const ok = await confirmModal({
            title: '事件ファイルを削除', message: `「${c.title}」を削除します。元に戻せません。`,
            okLabel: '削除する', cancelLabel: 'やめる', danger: true });
          if (!ok) return;
          try { await deleteCase(c.id); card.remove(); if (!grid.querySelector('.case-card')) grid.append(empty); }
          catch (err) { alert('削除に失敗しました'); }
        } }, '×'));
    grid.append(card);
  }
}
