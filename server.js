'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5178, HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CASES = path.join(ROOT, 'data', 'cases');
fs.mkdirSync(CASES, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}
const err = (res, code, msg) => send(res, code, { ok: false, error: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  const m = pathname.match(/^\/api\/cases(?:\/([^/]+))?$/);
  if (!m) return err(res, 404, 'not found');
  const id = m[1];
  if (!id) {
    if (req.method !== 'GET') return err(res, 405, 'method not allowed');
    const list = [];
    for (const f of fs.readdirSync(CASES)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8'));
        const items = Array.isArray(c.items) ? c.items : [];
        list.push({
          id: c.id || f.slice(0, -5), title: c.title || '', status: c.status || 'setup',
          createdAt: c.createdAt || '', updatedAt: c.updatedAt || '',
          total: items.length, solved: items.filter(i => i && i.solvedAt).length,
        });
      } catch (e) { /* skip broken file */ }
    }
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return send(res, 200, list);
  }
  if (!ID_RE.test(id)) return err(res, 400, 'bad id');
  const file = path.join(CASES, id + '.json');
  if (req.method === 'GET') {
    if (!fs.existsSync(file)) return err(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(file));
  }
  if (req.method === 'PUT') {
    let text;
    try { text = await readBody(req, 2 * 1024 * 1024); } catch (e) { return err(res, e.code || 400, e.message); }
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return err(res, 400, 'invalid json'); }
    if (!obj || typeof obj !== 'object') return err(res, 400, 'invalid body');
    if (obj.id !== undefined && obj.id !== id) return err(res, 400, 'id mismatch');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') return err(res, 500, 'delete failed'); }
    return send(res, 200, { ok: true });
  }
  return err(res, 405, 'method not allowed');
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'method not allowed');
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return err(res, 400, 'bad path'); }
  if (p.includes('\0')) return err(res, 400, 'bad path');
  if (p.endsWith('/')) p += 'index.html';
  const full = path.normalize(path.join(PUBLIC, p));
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return err(res, 403, 'forbidden');
  const type = MIME[path.extname(full).toLowerCase()];
  if (!type) return err(res, 404, 'not found');
  fs.readFile(full, (e, data) => {
    if (e) return err(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch(e => err(res, 500, String(e && e.message)));
  } else serveStatic(req, res, pathname);
}).listen(PORT, HOST, () => console.log(`会議探偵 http://${HOST}:${PORT}`));
