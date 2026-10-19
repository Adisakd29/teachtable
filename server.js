// ระบบจัดตารางเรียน-ตารางสอน : เซิร์ฟเวอร์ (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ใช้ Node.js 18 ขึ้นไป)
const http = require('http');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Railway ตั้ง RAILWAY_VOLUME_MOUNT_PATH ให้อัตโนมัติเมื่อผูก Volume ไว้ จึงใช้เป็นค่าเริ่มต้น
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PERSISTENT = !ON_RAILWAY || !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const GPT_KEY = process.env.OPENAI_API_KEY || '';
const GPT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const PUBLIC = path.join(__dirname, 'public');

// เอกสารที่อนุญาต: tt/master, tt/plan (ตาราง) และ lp/<id> (แผนการจัดการเรียนรู้)
const PATH_RE = /^(tt\/(?:master|plan)|lp\/[A-Za-z0-9_-]{1,64})$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
const fileOf = p => path.join(DATA_DIR, p.replace('/', '_') + '.json');
const store = {}; // path -> {data, version}
for (const p of ['tt/master', 'tt/plan']) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(fileOf(p), 'utf8')); }
  catch (e) { try { data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', p.split('/')[1] + '.json'), 'utf8')); } catch (_) {} }
  store[p] = { data, version: 1 };
}
for (const f of fs.readdirSync(DATA_DIR)) {
  const m = f.match(/^lp_([A-Za-z0-9_-]{1,64})\.json$/);
  if (m) { try { store['lp/' + m[1]] = { data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')), version: 1 }; } catch (_) {} }
}

const timers = {};
function persist(p) {
  clearTimeout(timers[p]);
  timers[p] = setTimeout(() => {
    const f = fileOf(p);
    if (!store[p] || store[p].data == null) { try { fs.unlinkSync(f); } catch (_) {} return; }
    fs.writeFileSync(f + '.tmp', JSON.stringify(store[p].data));
    fs.renameSync(f + '.tmp', f);
  }, 300);
}
function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deepMerge(t[k], v);
    else t[k] = v;
  }
}

const clients = new Set();
function payload(p) { const s = store[p] || {}; return JSON.stringify({ path: p, exists: s.data != null, data: s.data ?? null, version: s.version || 0 }); }
function broadcast(p) { const msg = 'data: ' + payload(p) + '\n\n'; for (const res of clients) res.write(msg); }

function authOk(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, pw] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === APP_USER && pw === APP_PASSWORD;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    // รวมเป็น Buffer ก่อนแปลงเป็นข้อความ ป้องกันอักษรไทย (3 ไบต์) ถูกตัดกลางตัวจนกลายเป็น �
    const chunks = []; let n = 0;
    req.on('data', c => { chunks.push(c); n += c.length; if (n > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

// ---- เรนเดอร์เอกสาร (LibreOffice): เติมเลขหน้าสารบัญใน DOCX และสร้าง PDF คุณภาพพิมพ์จาก DOCX ตัวเดียวกัน ----
const SOFFICE = process.env.SOFFICE_BIN || 'soffice';
const SOFFICE_PORT = process.env.SOFFICE_PORT || '2002';
let renderReady = false, office = null;
function startOffice() {
  try {
    office = spawn(SOFFICE, ['--headless', '--invisible', '--norestore', '--nologo', '--nodefault', '--nolockcheck', `-env:UserInstallation=file://${path.join(os.tmpdir(), 'lo-profile-' + SOFFICE_PORT)}`, `--accept=socket,host=127.0.0.1,port=${SOFFICE_PORT};urp;`], { stdio: 'ignore' });
    office.on('error', () => { office = null; renderReady = false; console.log('LibreOffice: ไม่พบโปรแกรม (ส่งออก PDF คุณภาพพิมพ์ใช้ไม่ได้ ให้ deploy ด้วย Dockerfile)'); });
    office.on('exit', code => { console.warn('LibreOffice หยุดทำงาน (code ' + code + ')'); const was = renderReady; renderReady = false; office = null; if (was) setTimeout(startOffice, 2000); });
    // พร้อมเมื่อพอร์ต UNO เปิดรับการเชื่อมต่อ
    let tries = 0;
    const probe = () => { if (!office) return; const s = net.connect(+SOFFICE_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); renderReady = true; console.log('LibreOffice พร้อมเรนเดอร์เอกสาร'); });
      s.on('error', () => { if (++tries < 120) setTimeout(probe, 1000); }); };
    setTimeout(probe, 1000);
  } catch (e) { renderReady = false; }
}
let renderQueue = Promise.resolve();
function renderDocx(buf) {
  const job = renderQueue.then(() => new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
    const inp = path.join(dir, 'in.docx'); fs.writeFileSync(inp, buf);
    execFile('python3', [path.join(__dirname, 'render', 'render.py'), inp, dir, SOFFICE_PORT], { timeout: 240000, maxBuffer: 8e6 }, (err, stdout, stderr) => {
      try {
        if (err) throw new Error((stderr || err.message).split('\n').filter(Boolean).slice(-1)[0]);
        const meta = JSON.parse(stdout.trim().split('\n').pop());
        resolve({ ...meta, docx: fs.readFileSync(path.join(dir, 'out.docx')).toString('base64'), pdf: fs.readFileSync(path.join(dir, 'out.pdf')).toString('base64') });
      } catch (e) { reject(e); }
      finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
    });
  }));
  renderQueue = job.catch(() => {});
  return job;
}

// ให้ AI ช่วยร่าง (ต้องตั้ง ANTHROPIC_API_KEY)
const MODELS = [...new Set([AI_MODEL, 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'])];
let goodModel = '';
// web: true → เปิดเครื่องมือค้นเว็บของ Claude (web_search) ใช้ค้นข้อมูลบรรณานุกรมจากแหล่งจริง
async function askClaude(prompt, opts = {}) {
  let lastErr;
  for (const model of goodModel ? [goodModel] : MODELS) {
    const messages = [{ role: 'user', content: opts.pdf ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opts.pdf } }, { type: 'text', text: prompt }]
      : prompt + (opts.raw ? '' : '\n\nตอบเป็น JSON อย่างเดียว ไม่ต้องมีคำอธิบายอื่น') }];
    const body = { model, max_tokens: 16000, messages };
    if (opts.web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
    let r, j, text = '';
    for (let turn = 0; turn < 4; turn++) {
      r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      j = await r.json().catch(() => ({}));
      if (!r.ok) break;
      text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      // การค้นเว็บที่ใช้เวลานานอาจหยุดกลางทาง (pause_turn) → ส่งต่อให้ทำต่อ
      if (j.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: j.content });
    }
    if (r.ok) { if (!goodModel) { goodModel = model; console.log('AI model: ' + model); } return { text, truncated: j.stop_reason === 'max_tokens' }; }
    lastErr = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    if (opts.web && /web_search|tool/i.test(lastErr.message)) lastErr = new Error('บัญชี API ยังไม่เปิดการค้นเว็บ (เปิด Web search ที่ console.anthropic.com → Settings → Privacy/Features)');
    // ลองรุ่นถัดไปเฉพาะเมื่อไม่พบชื่อรุ่น
    if (!(r.status === 404 || (j.error && j.error.type === 'not_found_error'))) break;
  }
  throw lastErr;
}

// ให้ ChatGPT ออกแบบหน่วยการเรียนรู้ (ต้องตั้ง OPENAI_API_KEY) — ลองรุ่นถัดไปเมื่อบัญชีไม่มีรุ่นที่ระบุ
const GPT_MODELS = [...new Set([GPT_MODEL, 'gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-5-mini', 'gpt-4.1'])];
let goodGpt = '';
async function askGpt(prompt) {
  let lastErr;
  for (const model of goodGpt ? [goodGpt] : GPT_MODELS) {
    const r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GPT_KEY },
      body: JSON.stringify({ model, max_completion_tokens: 16000, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt + '\n\nตอบเป็น JSON object เดียวเท่านั้น' }] })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { if (!goodGpt) { goodGpt = model; console.log('ChatGPT model: ' + model); } const c = (j.choices || [])[0] || {}; return { text: (c.message && c.message.content) || '', truncated: c.finish_reason === 'length', model }; }
    lastErr = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    if (!(r.status === 404 || (j.error && /model_not_found|does not exist|not have access/i.test((j.error.code || '') + ' ' + (j.error.message || ''))))) break;
  }
  throw lastErr;
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
    for (const p of Object.keys(store)) res.write('data: ' + payload(p) + '\n\n');
    res.write('event: ready\ndata: {}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  const m = url.pathname.match(/^\/api\/doc\/(.+)$/);
  if (m) {
    const p = decodeURIComponent(m[1]);
    if (!PATH_RE.test(p)) return json(res, 400, { error: 'bad path' });
    try {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(payload(p)); }
      if (!store[p]) store[p] = { data: null, version: 0 };
      if (req.method === 'DELETE') store[p].data = null;
      else {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
        if (req.method === 'PUT') store[p].data = body;
        else if (req.method === 'PATCH') { if (!store[p].data) store[p].data = {}; deepMerge(store[p].data, body); }
        else return json(res, 405, { error: 'method' });
      }
      store[p].version++;
      persist(p); broadcast(p);
      if (store[p].data == null && p.startsWith('lp/')) delete store[p];
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: 'bad request' }); }
  }

  if (url.pathname === '/api/ai' && req.method === 'POST') {
    if (!AI_KEY) return json(res, 501, { error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY' });
    try { const body = await readBody(req, 200000); return json(res, 200, await askClaude(String(body.prompt || ''), { web: !!body.web })); }
    catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }
  if (url.pathname === '/api/render' && req.method === 'POST') {
    if (!renderReady) return json(res, 501, { error: 'เซิร์ฟเวอร์ไม่มี LibreOffice' });
    try {
      const body = await readBody(req, 40e6);
      const buf = Buffer.from(String(body.docx || ''), 'base64');
      if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) return json(res, 400, { error: 'ไม่ใช่ไฟล์ DOCX' });
      const r = await renderDocx(buf);
      return json(res, 200, { docx: r.docx, pdf: body.want === 'docx' ? undefined : r.pdf, fontOk: r.fontOk, fonts: r.fonts, pages: r.pages, missing: r.missing, qa: r.qa });
    } catch (e) { return json(res, 500, { error: 'เรนเดอร์ไม่สำเร็จ: ' + String(e.message || e) }); }
  }
  if (url.pathname === '/api/gpt' && req.method === 'POST') {
    if (!GPT_KEY) return json(res, 501, { error: 'ยังไม่ได้ตั้งค่า OPENAI_API_KEY' });
    try { const body = await readBody(req, 200000); return json(res, 200, await askGpt(String(body.prompt || ''))); }
    catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }
  // อ่านข้อความจากไฟล์ PDF ที่อัปโหลด (มาตรฐาน/หลักสูตร): pdftotext ก่อน ถ้าเป็นไฟล์สแกน (ไม่มีข้อความ) และตั้ง ANTHROPIC_API_KEY ไว้ ให้ AI ถอดข้อความตามต้นฉบับ
  if (url.pathname === '/api/extract' && req.method === 'POST') {
    try {
      const body = await readBody(req, 36e6);
      const buf = Buffer.from(String(body.data || ''), 'base64');
      if (buf.length < 100 || buf.slice(0, 5).toString() !== '%PDF-') return json(res, 400, { error: 'ไม่ใช่ไฟล์ PDF' });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-')); const inp = path.join(dir, 'in.pdf'); fs.writeFileSync(inp, buf);
      const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 60000, maxBuffer: 30e6 }, (err, out) => r(err ? '' : out)));
      let text = await run('pdftotext', ['-raw', '-enc', 'UTF-8', inp, '-']);
      const pages = +((await run('pdfinfo', [inp])).match(/Pages:\s*(\d+)/) || [])[1] || 0;
      fs.rm(dir, { recursive: true, force: true }, () => {});
      const s = text.replace(/\s/g, ''); const thai = s.length ? (s.match(/[\u0E00-\u0E7F]/g) || []).length / s.length : 0;
      if (s.length > 200 && thai > 0.2) return json(res, 200, { text, pages, method: 'pdftotext' });
      if (!AI_KEY) return json(res, 200, { text, pages, method: 'pdftotext', warn: 'ไฟล์นี้อ่านข้อความได้น้อยมาก (อาจเป็นไฟล์สแกน) — ตั้ง ANTHROPIC_API_KEY เพื่อให้ AI ถอดข้อความ หรือคัดลอกข้อความมาวาง' });
      if (pages > 100 || buf.length > 30e6) return json(res, 200, { text, pages, method: 'pdftotext', warn: 'ไฟล์สแกนยาวเกิน 100 หน้า — ตัดเฉพาะหน้าที่ต้องการก่อนอัปโหลด' });
      const r = await askClaude('ถอดข้อความจากเอกสารนี้ทุกบรรทัดตามต้นฉบับ (ภาษาไทย) คงเลขข้อและลำดับเดิม ห้ามสรุป ห้ามแก้ถ้อยคำ ห้ามเพิ่มข้อความที่ไม่มีในเอกสาร ส่วนที่อ่านไม่ออกให้ใส่ [อ่านไม่ออก] ตอบเป็นข้อความล้วน', { pdf: buf.toString('base64'), raw: true });
      return json(res, 200, { text: r.text, pages, method: 'ai', warn: 'ข้อความถอดด้วย AI จากไฟล์สแกน ต้องตรวจทานกับต้นฉบับ' });
    } catch (e) { return json(res, 500, { error: 'อ่านไฟล์ไม่สำเร็จ: ' + String(e.message || e) }); }
  }
  if (url.pathname === '/api/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/info') return json(res, 200, { persistent: PERSISTENT, onRailway: ON_RAILWAY, ai: !!AI_KEY, gpt: !!GPT_KEY, render: renderReady });

  // static files
  const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => {
  if (process.env.RENDER !== 'off') startOffice();
  console.log('Timetable running on port ' + PORT + ' · data: ' + DATA_DIR + ' · AI: ' + (AI_KEY ? AI_MODEL : 'off') + ' · ChatGPT: ' + (GPT_KEY ? GPT_MODEL : 'off'));
  if (!PERSISTENT) console.warn('คำเตือน: ยังไม่ได้ผูก Volume บน Railway ข้อมูลจะหายทุกครั้งที่ deploy ใหม่ (Attach Volume แล้ว deploy อีกครั้ง)');
  if (ON_RAILWAY && process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.DATA_DIR && !process.env.DATA_DIR.startsWith(process.env.RAILWAY_VOLUME_MOUNT_PATH))
    console.warn('คำเตือน: DATA_DIR (' + process.env.DATA_DIR + ') ไม่ได้อยู่ใน Volume (' + process.env.RAILWAY_VOLUME_MOUNT_PATH + ')');
});
