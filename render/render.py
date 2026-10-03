#!/usr/bin/env python3
"""แปลง DOCX แผนการจัดการเรียนรู้ → (DOCX ที่เติมเลขหน้าสารบัญแล้ว, PDF) ด้วย LibreOffice (UNO)
ใช้: render.py in.docx outdir [port]
ขั้นตอน: เปิด DOCX → จัดหน้า → อ่านเลขหน้าของทุก PAGEREF (bookmark) ตามรูปแบบเลขหน้าของ section (ก ข / 1 2)
       → เขียนเลขหน้าลงผลลัพธ์ของฟิลด์ใน DOCX (Word/LibreOffice/Google Docs เห็นเลขหน้าทันทีโดยไม่ต้องอัปเดต)
       → เปิด DOCX ใหม่ → ส่งออก PDF (ข้อความจริง ฝังฟอนต์) → ตรวจฟอนต์ใน PDF
พิมพ์ JSON ผลลัพธ์ทาง stdout"""
import sys, os, re, json, time, zipfile, shutil, subprocess
import uno
from com.sun.star.beans import PropertyValue

def P(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

def connect(port):
    local = uno.getComponentContext()
    res = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    last = None
    for _ in range(100):
        try:
            ctx = res.resolve(f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext")
            return ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        except Exception as e:
            last = e; time.sleep(0.3)
    raise RuntimeError('LibreOffice not reachable: %s' % last)

def load(desk, path):
    doc = desk.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(path)), "_blank", 0, (P("Hidden", True), P("UpdateDocMode", 1)))
    if doc is None: raise RuntimeError('cannot open docx')
    return doc

def layout(doc):
    try:
        vc = doc.getCurrentController().getViewCursor(); vc.jumpToLastPage(); n = vc.getPage(); vc.jumpToFirstPage(); return n
    except Exception:
        return 0

THAI_LETTERS = 'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผพฟภมยรลวศษสหฬอฮ'

def refs(doc):
    out = {}
    en = doc.getTextFields().createEnumeration()
    while en.hasMoreElements():
        f = en.nextElement()
        if f.supportsService('com.sun.star.text.TextField.GetReference'):
            try:
                v = f.getPresentation(False)
                # ส่วนหน้า (คำนำ/สารบัญ) ใช้เลขหน้าอักษรไทย ก ข … ตามรูปแบบ section — LibreOffice คืนค่าเป็นตัวเลข
                if f.SourceName.startswith('_Toc_lpF') and v.isdigit() and 0 < int(v) <= len(THAI_LETTERS):
                    v = THAI_LETTERS[int(v) - 1]
                out[f.SourceName] = v
            except Exception: pass
    return out

def inject(src, dst, pages):
    """เขียนเลขหน้าลงช่องผลลัพธ์ของฟิลด์ PAGEREF (begin / instr / separate / ผลลัพธ์ / end)"""
    zin = zipfile.ZipFile(src)
    zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)
    miss = []
    pat = re.compile(r'( PAGEREF (\S+) \\h </w:instrText></w:r><w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:fldChar w:fldCharType="separate"/></w:r><w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t xml:space="preserve">)([^<]*)(</w:t>)')
    def sub(m):
        v = pages.get(m.group(2))
        if v is None:
            miss.append(m.group(2)); v = m.group(3)
        return m.group(1) + v + m.group(4)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'word/document.xml':
            data = pat.sub(sub, data.decode('utf8')).encode('utf8')
        zout.writestr(item, data)
    zout.close()
    return miss

def lo_version():
    """รุ่น LibreOffice (major, minor) จาก soffice --version (เครื่องเดียวกับตัวเรนเดอร์)"""
    try:
        out = subprocess.run([os.environ.get('SOFFICE_BIN', 'soffice'), '--version'], capture_output=True, text=True, timeout=30).stdout
        m = re.search(r'LibreOffice\s+(\d+)\.(\d+)', out)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    except Exception:
        return (0, 0)

# LibreOffice รุ่นเก่า (เช่น 7.4 ของ Debian 12; ตรวจแล้วว่า 24.2 ขึ้นไปถูกต้อง) จัดกระจายเต็มบรรทัดภาษาไทยแล้วสระ/วรรณยุกต์ท้ายบรรทัดหลุดไปขอบขวา
# จึงจัดกระจายเฉพาะรุ่นที่แสดงผลถูกต้อง (รุ่นเก่าคงชิดซ้ายใน PDF; ไฟล์ Word ไม่เปลี่ยน)
THAI_JUSTIFY_OK = None
def thai_justify_ok():
    global THAI_JUSTIFY_OK
    if THAI_JUSTIFY_OK is None:
        THAI_JUSTIFY_OK = lo_version() >= (24, 2)
    return THAI_JUSTIFY_OK

def justify_thai(doc):
    """ย่อหน้า style ThaiJustify (w:jc thaiDistribute ใน Word) — LibreOffice นำเข้าเป็นชิดซ้าย จึงตั้งเป็นกระจายเต็มบรรทัดก่อนส่งออก PDF
    (บรรทัดสุดท้ายของย่อหน้าชิดซ้าย) ไฟล์ Word ไม่ถูกแก้"""
    n = 0
    if not thai_justify_ok():
        return 0
    en = doc.getText().createEnumeration()
    while en.hasMoreElements():
        p = en.nextElement()
        try:
            if p.supportsService('com.sun.star.text.Paragraph') and p.ParaStyleName in ('ThaiJustify', 'Thai Justify'):
                p.ParaAdjust = 2; p.ParaLastLineAdjust = 0; n += 1
        except Exception:
            pass
    return n

def pdf_fonts(pdf):
    try: out = subprocess.run(['pdffonts', pdf], capture_output=True, text=True, timeout=60).stdout
    except Exception: return None
    names = [l.split()[0] for l in out.splitlines()[2:] if l.strip()]
    return sorted(set(re.sub(r'^[A-Z]{6}\+', '', n) for n in names))

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    port = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('SOFFICE_PORT', '2002')
    os.makedirs(outdir, exist_ok=True)
    desk = connect(port)
    doc = load(desk, src)
    try:
        justify_thai(doc)
        layout(doc); doc.getTextFields().refresh(); layout(doc)
        pages = refs(doc)
    finally:
        doc.close(True)
    out_docx = os.path.join(outdir, 'out.docx'); out_pdf = os.path.join(outdir, 'out.pdf')
    miss = inject(src, out_docx, pages)
    doc = load(desk, out_docx)
    try:
        # ส่งออก PDF ก่อน refresh ฟิลด์ เพื่อคงเลขหน้าที่ใส่ไว้ (LibreOffice คำนวณเลขหน้าอักษรไทยของส่วนหน้าเป็นตัวเลข)
        justify_thai(doc)
        n = layout(doc)
        # เฉพาะ PDF: แทนฟิลด์อ้างอิงหน้าส่วนหน้า (lpF) ด้วยข้อความ ก/ข (DOCX ยังเป็นฟิลด์ Word แสดงอักษรไทยเอง)
        en = doc.getTextFields().createEnumeration(); fx = []
        while en.hasMoreElements():
            f = en.nextElement()
            if f.supportsService('com.sun.star.text.TextField.GetReference') and f.SourceName.startswith('_Toc_lpF') and pages.get(f.SourceName): fx.append(f)
        for f in fx:
            a = f.getAnchor(); a.getText().insertString(a, pages[f.SourceName], True)
        doc.storeToURL(uno.systemPathToFileUrl(os.path.abspath(out_pdf)), (P("FilterName", "writer_pdf_Export"), P("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", tuple([P("EmbedStandardFonts", True), P("UseTaggedPDF", True), P("IsSkipEmptyPages", True)])))))
        doc.getTextFields().refresh(); layout(doc)
        pages2 = {k: (THAI_LETTERS[int(v) - 1] if k.startswith('_Toc_lpF') and v.isdigit() and 0 < int(v) <= len(THAI_LETTERS) else v) for k, v in refs(doc).items()}
    finally:
        doc.close(True)
    fonts = pdf_fonts(out_pdf)
    font_ok = None if fonts is None else all('Sarabun' in f for f in fonts)
    # ตรวจคุณภาพอัตโนมัติจาก PDF ที่เรนเดอร์จาก DOCX ไฟล์สุดท้าย
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'qa'))
        from check_export import check
        qa = check(out_pdf, out_docx)
    except Exception as e:
        qa = {'pages': 0, 'issues': ['ตรวจอัตโนมัติไม่สำเร็จ: %s' % e], 'info': []}
    if miss:
        qa['issues'].append('สารบัญ: หาเลขหน้าไม่ได้ %d รายการ' % len(miss))
    print(json.dumps({'pages': pages, 'stable': all(pages2.get(k) == v for k, v in pages.items() if not k.startswith('_Toc_lpF')), 'missing': miss, 'pageCount': n, 'fonts': fonts, 'fontOk': font_ok, 'qa': qa}, ensure_ascii=False))

if __name__ == '__main__':
    main()
