// แทนที่ window.claude ของ claude.ai ด้วยการเชื่อมต่อเซิร์ฟเวอร์ของเราเอง (REST + Server-Sent Events)
(function () {
  const listeners = {}; const colListeners = {}; const cache = {}; let es = null; let ready = false;
  const snap = m => ({ id: m.path.split('/')[1], exists: !!m.exists, data: () => (m.exists ? m.data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  const colSnap = col => { const docs = Object.values(cache).filter(m => m.exists && m.path.startsWith(col + '/')).map(snap); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
  function connect() {
    if (es) return;
    es = new EventSource('api/stream');
    es.onmessage = e => {
      const m = JSON.parse(e.data); cache[m.path] = m;
      (listeners[m.path] || []).forEach(fn => fn(snap(m)));
      const col = m.path.split('/')[0];
      if (ready) (colListeners[col] || []).forEach(fn => fn(colSnap(col)));
    };
    es.addEventListener('ready', () => { ready = true; Object.keys(colListeners).forEach(col => colListeners[col].forEach(fn => fn(colSnap(col)))); });
  }
  async function send(method, path, body) {
    let r;
    try { r = await fetch('api/doc/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw { code: 'unavailable', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }; }
    if (r.status === 401 || r.status === 403 || r.status === 400) throw { code: 'invalid_argument', message: 'บันทึกไม่ได้' };
    if (!r.ok) throw { code: 'unavailable', message: 'HTTP ' + r.status };
  }
  const docRef = path => ({
    id: path.split('/')[1], path,
    onSnapshot(next) {
      (listeners[path] ||= []).push(next); connect();
      if (cache[path]) setTimeout(() => next(snap(cache[path])), 0);
      return () => { listeners[path] = (listeners[path] || []).filter(f => f !== next); };
    },
    async get() { const r = await fetch('api/doc/' + path); return snap(await r.json()); },
    update: body => send('PATCH', path, body),
    set: body => send('PUT', path, body),
    delete: () => send('DELETE', path)
  });
  const db = {
    doc: docRef,
    collection(col) {
      return {
        path: col,
        doc: id => docRef(col + '/' + id),
        onSnapshot(next) {
          (colListeners[col] ||= []).push(next); connect();
          if (ready) setTimeout(() => next(colSnap(col)), 0);
          return () => { colListeners[col] = (colListeners[col] || []).filter(f => f !== next); };
        }
      };
    }
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 10000);
      return { status: 'saved' };
    }
  };
  // AI ช่วยร่าง ผ่านเซิร์ฟเวอร์ (/api/ai) ใช้ได้เมื่อตั้ง ANTHROPIC_API_KEY
  function parseJson(text) {
    try { return JSON.parse(text); } catch (_) {}
    const f = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (_) {} }
    const a = Math.min(...['{', '['].map(c => { const i = text.indexOf(c); return i < 0 ? Infinity : i; }));
    const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (a < b) { try { return JSON.parse(text.slice(a, b + 1)); } catch (_) {} }
    throw { code: 'invalid_json', message: 'AI ตอบไม่ตรงรูปแบบ', text };
  }
  async function sample(input, opts) {
    const prompt = typeof input === 'string' ? input : input.map(t => t.content).join('\n\n');
    let r;
    try { r = await fetch('api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, web: !!(opts && opts.web) }) }); }
    catch (e) { throw { code: 'unavailable', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 501 ? 'not_granted' : 'unavailable', message: j.error || ('HTTP ' + r.status) };
    return { text: j.text || '', truncated: !!j.truncated };
  }
  sample.json = async (input, opts) => { const r = await sample(input, opts); if (r.truncated) throw { code: 'invalid_json', message: 'คำตอบยาวเกินไป', text: r.text }; return parseJson(r.text); };

  const info = fetch('api/info').then(r => r.json()).catch(() => ({}));
  // ให้หน้าเว็บรู้ว่ามีเซิร์ฟเวอร์เรนเดอร์ (LibreOffice) หรือไม่ — ถามใหม่ทุกครั้งที่ส่งออก เพราะ LibreOffice อาจเพิ่งพร้อม
  Object.defineProperty(window, 'ttServer', { get: () => fetch('api/info').then(r => r.json()).catch(() => ({})) });
  // เตือนเมื่อเซิร์ฟเวอร์ไม่มีที่เก็บข้อมูลถาวร
  info.then(i => {
    if (i.persistent !== false) return;
    const show = () => {
      const b = document.createElement('div');
      b.setAttribute('role', 'alert');
      b.style.cssText = 'background:#B8332F;color:#fff;padding:10px 16px;font:15px/1.5 system-ui,sans-serif;text-align:center';
      b.textContent = 'คำเตือน: เซิร์ฟเวอร์ยังไม่ได้ผูก Volume ข้อมูลจะหายเมื่อ deploy ใหม่ ให้ Attach Volume ใน Railway และดาวน์โหลดไฟล์สำรองไว้ก่อน (แท็บ ตั้งค่า / ส่งออก)';
      document.body.prepend(b);
    };
    document.body ? show() : document.addEventListener('DOMContentLoaded', show);
  });
  window.claude = { use: async name => name === 'db' ? db : name === 'downloads' ? downloads : name === 'sample' ? ((await info).ai ? sample : null) : null };
})();
