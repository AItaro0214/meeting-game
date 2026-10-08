import { putCase } from './api.js';
import { h, genId } from './util.js';
import { generateScene, generateTitle } from './scene.js';
import { manifestMissing } from './app.js';

const MAX = 8;

export function mountSetup(root, ctx) {
  const manifest = ctx.manifest;
  if (!manifest) { root.append(manifestMissing()); return; }

  let diceTheme = null;
  const rows = [];
  const rowsEl = h('div', { class: 'clue-rows' });
  const errEl = h('div', { class: 'form-error', role: 'alert' });

  const titleInput = h('input', { class: 'type-input title-input', type: 'text', maxlength: '60', placeholder: '例：給湯室のプリン消失事件', 'aria-label': '事件タイトル' });
  titleInput.addEventListener('input', () => { diceTheme = null; });
  const dice = h('button', { class: 'btn dice', type: 'button', title: 'タイトルをランダム生成', 'aria-label': 'タイトルをランダム生成',
    onclick: () => {
      const r = generateTitle(manifest);
      titleInput.value = r.title; diceTheme = r.themeId;
      dice.classList.remove('rolling'); void dice.offsetWidth; dice.classList.add('rolling');
    } }, '🎲');

  const addBtn = h('button', { class: 'btn ghost add-row', type: 'button', onclick: () => { addRow(); } }, '＋ 手がかりを追加');
  const startBtn = h('button', { class: 'btn primary big', type: 'button', onclick: start }, '捜査開始（打ち合わせ開始）');

  function renumber() {
    rows.forEach((r, i) => { r.num.textContent = String(i + 1).padStart(2, '0'); r.del.disabled = rows.length <= 1; });
    addBtn.disabled = rows.length >= MAX;
    count.textContent = `${rows.length} / ${MAX}`;
  }
  const count = h('span', { class: 'clue-count' });

  function addRow(focus = true) {
    if (rows.length >= MAX) return;
    const num = h('div', { class: 'clue-num' });
    const t = h('input', { class: 'type-input', type: 'text', maxlength: '80', placeholder: '決めたいこと・確認したいこと（必須）', 'aria-label': '項目' });
    const d = h('textarea', { class: 'type-input', rows: '2', maxlength: '1000', placeholder: '詳細・背景メモ（任意）', 'aria-label': '詳細' });
    const del = h('button', { class: 'btn icon', type: 'button', title: 'この手がかりを削除', 'aria-label': '削除',
      onclick: () => { if (rows.length <= 1) return; rows.splice(rows.indexOf(row), 1); el.remove(); renumber(); } }, '×');
    const el = h('div', { class: 'clue-row' }, num, h('div', { class: 'clue-fields' }, t, d), del);
    const row = { el, num, t, d, del };
    rows.push(row);
    rowsEl.append(el);
    renumber();
    if (focus) t.focus();
  }

  async function start() {
    errEl.textContent = '';
    const items = rows.map(r => ({ title: r.t.value.trim(), detail: r.d.value.trim() })).filter(i => i.title);
    if (!items.length) { errEl.textContent = '手がかりを1つ以上入力してください（項目は必須です）。'; rows[0].t.focus(); return; }
    let title = titleInput.value.trim();
    let themeId = diceTheme;
    if (!title) { const r = generateTitle(manifest); title = r.title; themeId = r.themeId; }
    const now = new Date().toISOString();
    const c = {
      id: genId(), title, createdAt: now, updatedAt: now, status: 'investigating',
      items: items.map(i => ({ title: i.title, detail: i.detail, decision: '', solvedAt: null })),
      summary: '',
      scene: generateScene(manifest, items.length, themeId),
    };
    startBtn.disabled = true;
    try { await putCase(c); }
    catch (e) { errEl.textContent = '保存に失敗しました。'; startBtn.disabled = false; return; }
    ctx.intro = c.id;
    ctx.go('#/case/' + encodeURIComponent(c.id));
  }

  root.append(h('div', { class: 'setup' },
    h('a', { class: 'back-link', href: '#/' }, '← 事件簿へ'),
    h('div', { class: 'folder' },
      h('div', { class: 'clip' }),
      h('div', { class: 'folder-tab' }, 'NEW CASE FILE'),
      h('section', { class: 'paper-sheet' },
        h('div', { class: 'tw-label' }, '事件名 / CASE TITLE'),
        h('div', { class: 'title-row' }, titleInput, dice),
        h('div', { class: 'tw-label clue-head' }, '手がかり / CLUES ', count),
        h('p', { class: 'hint' }, '打ち合わせで決めたいこと・確認したいことを書き出します（最大 8 個）。決まるたびに、黒塗りの容疑者や証拠品が割れて正体を現します。'),
        rowsEl, addBtn, errEl,
        h('div', { class: 'setup-actions' }, startBtn)))));

  addRow(false); addRow(false); addRow(false);
  rows[0].t.focus();
}
