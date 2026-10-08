import { getCase, putCase } from './api.js';
import { h, sleep, fmtDate, openModal, reducedMotion } from './util.js';
import { generateScene } from './scene.js';
import { buildStage } from './stage.js';
import * as sound from './sound.js';
import { manifestMissing } from './app.js';

export async function mountPlay(root, ctx, id) {
  const manifest = ctx.manifest;
  if (!manifest) { root.append(manifestMissing()); return; }
  let c;
  try { c = await getCase(id); }
  catch (e) {
    root.append(h('div', { class: 'notice-box' }, h('h2', null, '事件ファイルが見つかりません'), h('a', { class: 'btn ghost', href: '#/' }, '事件簿へ戻る')));
    return;
  }
  // 正規化
  c.items = Array.isArray(c.items) ? c.items : [];
  c.summary = c.summary || '';
  c.status = c.status || 'investigating';
  const sceneOk = c.scene && Array.isArray(c.scene.targets) && c.scene.targets.length === c.items.length &&
    Array.isArray(c.scene.notes) && c.scene.notes.length === c.items.length &&
    c.scene.targets.every(t => manifest._byId[t.assetId]) && manifest._bg[c.scene.backgroundId];
  let sceneRegenerated = false;
  if (!sceneOk && c.items.length) { c.scene = generateScene(manifest, c.items.length, c.scene && c.scene.themeId); sceneRegenerated = true; }
  if (!c.items.length) {
    root.append(h('div', { class: 'notice-box' }, h('h2', null, '手がかりのない事件です'), h('a', { class: 'btn ghost', href: '#/' }, '事件簿へ戻る')));
    return;
  }

  const isClosed = () => c.status === 'closed';
  const allSolved = () => c.items.every(i => i.solvedAt);
  const solvedCount = () => c.items.filter(i => i.solvedAt).length;

  let disposed = false;
  let busy = 0;   // 演出中の数

  // ---------- 保存 ----------
  let saveTimer = null;
  const indicator = h('span', { class: 'save-ind' }, '');
  function setInd(state) {
    indicator.className = 'save-ind ' + state;
    indicator.textContent = state === 'saving' ? '保存中…' : state === 'saved' ? '✓ 保存済み' : state === 'error' ? '保存に失敗' : '';
  }
  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    try { await putCase(c); if (!saveTimer) setInd('saved'); }
    catch (e) { setInd('error'); }
  }
  function touch(immediate = false) {
    c.updatedAt = new Date().toISOString();
    setInd('saving');
    clearTimeout(saveTimer);
    if (immediate) flush(); else saveTimer = setTimeout(flush, 400);
  }
  if (sceneRegenerated) touch(true);

  // ---------- ステージ ----------
  const stageObj = buildStage({
    caseData: c, manifest,
    isRevealed: i => !!c.items[i].solvedAt || isClosed(),
    onOpen: i => openInterrogation(i),
  });
  const wrap = h('main', { class: 'stage-wrap' }, stageObj.el);
  const ro = new ResizeObserver(() => stageObj.fit(wrap));

  // ---------- ヘッダー ----------
  const progText = h('span', { class: 'prog-text' });
  const progBar = h('i');
  const sfxBtn = h('button', { class: 'btn small', type: 'button', title: '効果音', onclick: () => { sound.setSfxOn(!sound.isSfxOn()); syncToggles(); } });
  const voiceBtn = h('button', { class: 'btn small', type: 'button', title: 'ナレーション', onclick: () => { sound.setVoiceOn(!sound.isVoiceOn()); syncToggles(); } });
  function syncToggles() {
    sfxBtn.textContent = sound.isSfxOn() ? '🔊 効果音' : '🔇 効果音';
    sfxBtn.setAttribute('aria-pressed', String(sound.isSfxOn()));
    voiceBtn.textContent = sound.isVoiceOn() ? '🎙 ナレーション' : '🎙✕ ナレーション';
    voiceBtn.setAttribute('aria-pressed', String(sound.isVoiceOn()));
    if (!sound.isVoiceOn()) showSubtitle(null);
  }
  // 字幕
  let subTimer = null;
  function showSubtitle(s) {
    const el = stageObj.subtitle;
    clearTimeout(subTimer);
    if (!s || !sound.isVoiceOn()) { el.classList.remove('show'); return; }
    el.textContent = s.text;
    el.style.setProperty('--sub-dur', Math.max(0.5, s.duration) + 's');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    subTimer = setTimeout(() => el.classList.remove('show'), s.duration * 1000 + 300);
  }
  sound.setSubtitleHandler(showSubtitle);
  const later = (ms, fn) => setTimeout(() => { if (!disposed) fn(); }, ms);
  let skippedSolve = 0;   // 解決ボイスを連続でスキップした回数
  function solveVoice() {
    const remain = c.items.filter(i => !i.solvedAt).length;
    if (remain === 0) return;
    if (remain === 1) { sound.playVoice('lastOne'); return; }
    if (skippedSolve >= 2 || Math.random() < 0.65) { skippedSolve = 0; sound.playVoice('solve'); }
    else skippedSolve++;
  }
  const actions = h('div', { class: 'bar-actions' });
  const bar = h('header', { class: 'play-bar' },
    h('a', { class: 'btn small', href: '#/' }, '← 事件簿'),
    h('div', { class: 'progress' }, progText, h('span', { class: 'pbar' }, progBar)),
    h('div', { class: 'bar-right' }, indicator, actions, sfxBtn, voiceBtn));

  function refreshChrome() {
    const n = solvedCount();
    progText.textContent = `手がかり ${n}/${c.items.length} 解明`;
    progBar.style.width = (n / c.items.length * 100) + '%';
    actions.innerHTML = '';
    if (isClosed()) {
      actions.append(
        h('button', { class: 'btn small', type: 'button', onclick: downloadMd }, 'Markdown をダウンロード'),
        h('button', { class: 'btn small', type: 'button', onclick: downloadJson }, 'JSON をダウンロード'),
        h('button', { class: 'btn small primary', type: 'button', onclick: reopen }, '捜査を再開'));
    }
    playEl.classList.toggle('review', isClosed());
    tab.hidden = !(allSolved() || isClosed()) || panelOpen;
    tab.textContent = isClosed() ? '事件の全貌を読む' : '事件の全貌を書く';
    renderPanel();
  }

  // ---------- 事件の全貌パネル ----------
  let panelOpen = false;
  const panel = h('section', { class: 'case-panel', 'aria-label': '事件の全貌' });
  const tab = h('button', { class: 'panel-tab', type: 'button', hidden: true, onclick: () => setPanel(true) }, '');
  function setPanel(open) {
    panelOpen = open;
    panel.classList.toggle('open', open);
    tab.hidden = open || !(allSolved() || isClosed());
  }
  function renderPanel() {
    panel.innerHTML = '';
    const closed = isClosed();
    const ta = h('textarea', { class: 'summary-ta', rows: '5', placeholder: 'この事件の結末を、ひとことでまとめましょう。（例：リリースは3月15日。担当は田中、レビューは金曜まで。）', readOnly: closed });
    ta.value = c.summary;
    ta.addEventListener('input', () => { c.summary = ta.value; touch(); });
    panel.append(
      h('div', { class: 'panel-inner' },
        h('div', { class: 'panel-head' },
          h('h2', null, '事件の全貌'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => setPanel(false) }, 'たたむ ▼')),
        h('div', { class: 'panel-body' },
          h('ol', { class: 'decision-list' }, c.items.map(it =>
            h('li', null, h('b', null, it.title), h('span', { class: 'arrow' }, ' → '), h('span', null, it.decision || '（決定事項なし）')))),
          h('div', { class: 'summary-col' },
            h('label', { class: 'tw-label' }, 'まとめ / SUMMARY'), ta,
            closed ? null : h('button', { class: 'btn primary big', type: 'button', onclick: () => closeCase(ta.value) }, '事件を閉じる')))));
  }

  async function closeCase(summary) {
    c.summary = summary;
    c.status = 'closed';
    touch(true);
    setPanel(false);
    refreshChrome();
    stageObj.targetEls.forEach((_, i) => stageObj.reveal(i));
    await caseClosedStamp();
  }
  async function caseClosedStamp() {
    const ov = h('div', { class: 'closed-overlay' }, h('div', { class: 'closed-stamp' }, h('span', null, 'CASE'), h('span', null, 'CLOSED')));
    playEl.append(ov);
    await sleep(reducedMotion() ? 0 : 230);
    sound.thud();
    sound.playMusic('closed');
    later(800, () => sound.playVoice('closed'));
    ov.classList.add('hit');
    await sleep(reducedMotion() ? 900 : 2000);
    ov.classList.add('out');
    await sleep(500);
    ov.remove();
  }
  function reopen() {
    c.status = allSolved() ? 'solved' : 'investigating';
    touch(true);
    refreshChrome();
    if (allSolved()) setPanel(true);
  }

  // ---------- 取り調べモーダル ----------
  function openInterrogation(i) {
    const it = c.items[i];
    const ro = isClosed();
    const solved = !!it.solvedAt;
    const ta = h('textarea', { class: 'decision-ta', rows: '4', placeholder: 'ここで決まったこと（決定事項）を書く', readOnly: ro });
    ta.value = it.decision || '';
    let m;
    const submit = () => {
      const v = ta.value.trim();
      if (!v) { ta.focus(); ta.classList.add('need'); return; }
      m.close();
      if (solved) { it.decision = v; stageObj.refreshNote(i); touch(); refreshChrome(); }
      else solve(i, v);
    };
    ta.addEventListener('input', () => { ta.classList.remove('need'); okBtn && (okBtn.disabled = !ta.value.trim()); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !ro) { e.preventDefault(); submit(); } });
    const okBtn = ro ? null : h('button', { class: 'btn stamp-btn', type: 'button', onclick: submit, disabled: !ta.value.trim() },
      solved ? '決定事項を更新' : '解決！');
    const body = h('div', { class: 'interrogation' },
      h('div', { class: 'itg-tag' }, `手がかり No.${i + 1}` + (solved ? '　【解決済み】' : '')),
      h('h3', { class: 'itg-title' }, it.title),
      it.detail ? h('p', { class: 'itg-detail' }, it.detail) : h('p', { class: 'itg-detail dim' }, '（詳細なし）'),
      h('label', { class: 'tw-label' }, '決定事項 / DECISION'),
      ta,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, '閉じる'),
        okBtn));
    m = openModal(body, { className: 'itg-modal' });
    setTimeout(() => { if (!ro) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 60);
  }

  async function solve(i, text) {
    const it = c.items[i];
    it.decision = text;
    it.solvedAt = new Date().toISOString();
    if (c.status === 'setup') c.status = 'investigating';
    stageObj.refreshNote(i, { stampAnim: true });
    sound.stampSoft();
    touch(true);
    refreshChrome();
    busy++;
    try { await stageObj.shatter(i, () => later(700, solveVoice)); }
    finally { busy--; }
    if (disposed) return;
    if (allSolved() && c.status === 'investigating') {
      c.status = 'solved';
      touch(true);
      refreshChrome();
      await sleep(500);
      if (!disposed && !busy) {
        setPanel(true);
        sound.playMusic('reveal');
        later(500, () => sound.playVoice('allSolved'));
      }
    }
  }

  // ---------- ダウンロード ----------
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const safeName = () => (c.title || 'case').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  function downloadMd() {
    const lines = [`# ${c.title}`, '', `- 立件: ${fmtDate(c.createdAt)}`, `- 更新: ${fmtDate(c.updatedAt)}`, `- 解決: ${solvedCount()}/${c.items.length}`, '', '## 手がかりと決定事項', ''];
    c.items.forEach((it, i) => {
      lines.push(`### ${i + 1}. ${it.title}`, '');
      if (it.detail) lines.push(it.detail.split('\n').map(l => '> ' + l).join('\n'), '');
      lines.push(`**決定事項:** ${it.decision ? it.decision.replace(/\n/g, '\n  ') : '（未決）'}`, '');
    });
    lines.push('## 事件の全貌', '', c.summary || '（記載なし）', '');
    download(`${safeName()}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
  function downloadJson() { download(`${safeName()}.json`, JSON.stringify(c, null, 2), 'application/json'); }

  // ---------- 組み立て ----------
  const playEl = h('div', { class: 'play' }, bar, wrap, panel, tab, stageObj.subtitle);   // 字幕は全貌パネルより前面に出す
  root.append(playEl);
  ro.observe(wrap);
  stageObj.fit(wrap);
  refreshChrome();
  setInd('');
  syncToggles();

  const intro = ctx.intro === id;
  ctx.intro = null;
  stageObj.el.classList.add('entering');
  if (intro) {
    const ov = h('div', { class: 'intro-overlay' },
      h('div', { class: 'intro-k' }, 'CASE FILE OPENED'),
      h('div', { class: 'intro-h' }, '事件発生'),
      h('div', { class: 'intro-t' }, c.title));
    playEl.append(ov);
    stageObj.el.style.visibility = 'hidden';
    sound.playMusic('intro');
    later(600, () => sound.playVoice('start'));
    (async () => {
      await sleep(reducedMotion() ? 600 : 1500);
      if (disposed) return;
      stageObj.el.style.visibility = '';
      stageObj.el.classList.add('enter');
      ov.classList.add('out');
      await sleep(600);
      ov.remove();
    })();
  } else {
    stageObj.el.classList.add('enter');
  }

  return () => {
    disposed = true;
    clearTimeout(subTimer);
    sound.setSubtitleHandler(null);
    sound.stopAll();
    ro.disconnect();
    if (saveTimer) { clearTimeout(saveTimer); putCase(c, true).catch(() => {}); }
    document.querySelectorAll('.modal-overlay').forEach(e => e.remove());
  };
}
