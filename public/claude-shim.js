// แทนที่ window.claude ของ claude.ai ด้วยการเชื่อมต่อเซิร์ฟเวอร์ของเราเอง (REST + Server-Sent Events)
(function () {
  const listeners = {}; const cache = {}; let es = null;
  const snap = m => ({ id: m.path.split('/')[1], exists: !!m.exists, data: () => m.data || undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  function connect() {
    if (es) return;
    es = new EventSource('api/stream');
    es.onmessage = e => {
      const m = JSON.parse(e.data); cache[m.path] = m;
      (listeners[m.path] || []).forEach(fn => fn(snap(m)));
    };
  }
  async function send(method, path, body) {
    let r;
    try { r = await fetch('api/doc/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { throw { code: 'unavailable', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' }; }
    if (r.status === 401 || r.status === 403) throw { code: 'invalid_argument', message: 'ไม่มีสิทธิ์' };
    if (!r.ok) throw { code: 'unavailable', message: 'HTTP ' + r.status };
  }
  const db = {
    doc(path) {
      return {
        id: path.split('/')[1], path,
        onSnapshot(next) {
          (listeners[path] ||= []).push(next); connect();
          if (cache[path]) setTimeout(() => next(snap(cache[path])), 0);
          return () => { listeners[path] = (listeners[path] || []).filter(f => f !== next); };
        },
        async get() { const r = await fetch('api/doc/' + path); return snap(await r.json()); },
        update: body => send('PATCH', path, body),
        set: body => send('PUT', path, body)
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
  // เตือนเมื่อเซิร์ฟเวอร์ไม่มีที่เก็บข้อมูลถาวร
  fetch('api/info').then(r => r.json()).then(info => {
    if (info.persistent) return;
    const show = () => {
      const b = document.createElement('div');
      b.setAttribute('role', 'alert');
      b.style.cssText = 'background:#B8332F;color:#fff;padding:10px 16px;font:15px/1.5 system-ui,sans-serif;text-align:center';
      b.textContent = 'คำเตือน: เซิร์ฟเวอร์ยังไม่ได้ผูก Volume ข้อมูลจะหายเมื่อ deploy ใหม่ ให้ Attach Volume ใน Railway และดาวน์โหลดไฟล์สำรองไว้ก่อน (แท็บ ตั้งค่า / ส่งออก)';
      document.body.prepend(b);
    };
    document.body ? show() : document.addEventListener('DOMContentLoaded', show);
  }).catch(() => {});
  window.claude = { use: async name => name === 'db' ? db : name === 'downloads' ? downloads : null };
})();
