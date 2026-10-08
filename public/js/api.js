// 保存先: ローカルサーバー（server.js）があればそこへ、無ければ（GitHub Pages など）ブラウザの localStorage へ
async function json(res) {
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const LS_KEY = 'kaigi-tantei:cases';
let serverMode = null;   // true: server.js / false: localStorage

async function hasServer() {
  if (serverMode !== null) return serverMode;
  try {
    const res = await fetch('/api/cases', { cache: 'no-store' });
    serverMode = res.ok && (res.headers.get('content-type') || '').includes('application/json');
  } catch { serverMode = false; }
  return serverMode;
}
export const isLocalStorageMode = async () => !(await hasServer());

function lsAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function lsSave(all) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); }
  catch { throw new Error('ブラウザへの保存に失敗しました'); }
}
const summarize = c => ({
  id: c.id, title: c.title, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt,
  total: (c.items || []).length, solved: (c.items || []).filter(i => i.solvedAt).length,
});

export async function listCases() {
  if (await hasServer()) return fetch('/api/cases').then(json);
  return Object.values(lsAll()).map(summarize)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
export async function getCase(id) {
  if (await hasServer()) return fetch('/api/cases/' + encodeURIComponent(id)).then(json);
  const c = lsAll()[id];
  if (!c) throw new Error('HTTP 404');
  return c;
}
export async function putCase(c, keepalive = false) {
  if (await hasServer()) {
    return fetch('/api/cases/' + encodeURIComponent(c.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c), keepalive,
    }).then(json);
  }
  const all = lsAll(); all[c.id] = c; lsSave(all);
  return { ok: true };
}
export async function deleteCase(id) {
  if (await hasServer()) return fetch('/api/cases/' + encodeURIComponent(id), { method: 'DELETE' }).then(json);
  const all = lsAll(); delete all[id]; lsSave(all);
  return { ok: true };
}

export async function loadManifest() {
  const m = await fetch('assets/manifest.json', { cache: 'no-cache' }).then(json);
  if (!m || !Array.isArray(m.themes) || !m.themes.length || !Array.isArray(m.backgrounds) || !m.backgrounds.length ||
      !Array.isArray(m.characters) || !Array.isArray(m.items)) throw new Error('manifest invalid');
  m._byId = {};
  for (const a of [...m.characters, ...m.items]) m._byId[a.id] = a;
  m._bg = {};
  for (const b of m.backgrounds) m._bg[b.id] = b;
  return m;
}
