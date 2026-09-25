// ระบบจัดตารางเรียน-ตารางสอน : เซิร์ฟเวอร์ (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const DOCS = ['tt/master', 'tt/plan'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const fileOf = p => path.join(DATA_DIR, p.replace('/', '_') + '.json');
const store = {};
for (const p of DOCS) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(fileOf(p), 'utf8')); }
  catch (e) {
    try { data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', p.split('/')[1] + '.json'), 'utf8')); } catch (_) {}
  }
  store[p] = { data, version: 1 };
}

const timers = {};
function persist(p) {
  clearTimeout(timers[p]);
  timers[p] = setTimeout(() => {
    const tmp = fileOf(p) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store[p].data));
    fs.renameSync(tmp, fileOf(p));
  }, 300);
}
function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deepMerge(t[k], v);
    else t[k] = v;
  }
}

const clients = new Set();
function payload(p) { return JSON.stringify({ path: p, exists: !!store[p].data, data: store[p].data, version: store[p].version }); }
function broadcast(p) { const msg = 'data: ' + payload(p) + '\n\n'; for (const res of clients) res.write(msg); }

function authOk(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, pw] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === APP_USER && pw === APP_PASSWORD;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  if (!authOk(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="timetable", charset="UTF-8"' });
    return res.end('ต้องเข้าสู่ระบบ');
  }
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    for (const p of DOCS) res.write('data: ' + payload(p) + '\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  const m = url.pathname.match(/^\/api\/doc\/(tt\/(?:master|plan))$/);
  if (m) {
    const p = m[1];
    try {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(payload(p)); }
      const body = await readBody(req);
      if (typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
      if (req.method === 'PUT') store[p].data = body;
      else if (req.method === 'PATCH') { if (!store[p].data) store[p].data = {}; deepMerge(store[p].data, body); }
      else { res.writeHead(405); return res.end(); }
      store[p].version++;
      persist(p); broadcast(p);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: store[p].version }));
    } catch (e) { res.writeHead(400); return res.end('bad request'); }
  }

  if (url.pathname === '/api/health') { res.writeHead(200); return res.end('ok'); }

  // static files
  let f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('Timetable running on port ' + PORT + ' · data: ' + DATA_DIR));
