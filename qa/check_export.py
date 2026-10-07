#!/usr/bin/env python3
"""ตรวจคุณภาพไฟล์แผนการจัดการเรียนรู้ที่ส่งออก: เรนเดอร์ DOCX เป็น PDF (ไฟล์เดียวกับที่ผู้ใช้ได้) แล้วตรวจทุกหน้า
ใช้เดี่ยว:  python3 qa/check_export.py out.pdf out.docx
ใช้ในโปรแกรม: from check_export import check; check(pdf, docx) -> {'pages', 'issues', 'info'}
ตรวจ: ฟอนต์, หน้าปก 1 หน้า, หน้าว่าง/หน้าที่มี 1-2 บรรทัด, ข้อความ/ตารางล้นขอบ, ตัวอักษรถูกตัด, หัวข้อค้างท้ายหน้า,
      เลขหน้าหาย/ซ้ำ/ไม่ต่อเนื่อง, ภาษาไทยเพี้ยน (cluster ซ้ำ, ◌, �), สารบัญ/สารบัญภาคผนวกชี้หน้าถูก, บรรณานุกรม, ภาคผนวก ก-จ,
      DOCX: style ID ซ้ำ, จำนวน section/header, ฟอนต์ฝัง + fontTable relationship"""
import sys, re, subprocess, zipfile, collections
try:
    import pymupdf
except ImportError:  # Debian/Ubuntu: python3-fitz
    import fitz as pymupdf

THAI_LETTERS = 'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผพฟภมยรลวศษสหฬอฮ'
MARKS = 'ัิ-ฺ็-๎'
CLUSTER_DUP = re.compile(r'([ก-ฮ][%s]+)\1' % MARKS)


def lines_of(page):
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if t.strip():
                out.append({'text': t, 'bbox': l['bbox'], 'bold': any('Bold' in s['font'] for s in l['spans']),
                            'size': max(s['size'] for s in l['spans'])})
    return out


def docx_text(docx):
    z = zipfile.ZipFile(docx)
    x = z.read('word/document.xml').decode('utf8')
    # ZWSP (จุดตัดคำที่ระบบใส่ให้) ไม่นับเป็นข้อความ
    return ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', x)).replace(chr(0x200B), '').replace(chr(0x2060), ''), z, x


def check(pdf, docx=None):
    d = pymupdf.open(pdf)
    issues, info = [], []
    # ---- ฟอนต์ ----
    fonts = subprocess.run(['pdffonts', pdf], capture_output=True, text=True).stdout.splitlines()[2:]
    names = sorted(set(re.sub(r'^[A-Z]{6}\+', '', f.split()[0]) for f in fonts if f.strip()))
    other = [n for n in names if 'Sarabun' not in n]
    if other:
        issues.append(f'มีฟอนต์อื่นปน (ภาษาไทยอาจเพี้ยน/บรรทัดเลื่อน): {", ".join(other)}')
    if any(re.search(r'\sno\s+(yes|no)\s+(yes|no)\s', f) for f in fonts):
        issues.append('มีฟอนต์ที่ไม่ได้ฝังใน PDF')
    pages = [lines_of(p) for p in d]
    W = [p.rect.width for p in d]
    H = [p.rect.height for p in d]
    # ---- เลขหน้า (หัวกระดาษมุมขวาบน) ----
    label = []
    for i, ls in enumerate(pages):
        top = [l for l in ls if l['bbox'][1] < 62 and l['bbox'][0] > W[i] * 0.7]
        label.append(top[0]['text'].strip() if top else '')
    # ---- หน้าปก ----
    first_preface = next((i for i, ls in enumerate(pages) if any(l['text'].strip() == 'คำนำ' and l['size'] >= 18 for l in ls)), None)
    if first_preface is None:
        issues.append('ไม่พบหน้า “คำนำ”')
    elif first_preface != 1:
        issues.append(f'หน้าปกยาว {first_preface} หน้า (ควรเป็น 1 หน้า)')
    if label and label[0]:
        issues.append('หน้าปกมีเลขหน้า')
    # ---- รายหน้า ----
    for i, (p, ls) in enumerate(zip(d, pages)):
        w, h = W[i], H[i]
        body = [l for l in ls if l['bbox'][1] >= 62]
        if not body and i > 0:
            issues.append(f'หน้า {i + 1}: หน้าว่าง')
            continue
        ys = sorted(set(round(l['bbox'][1]) for l in body))
        if 0 < len(ys) <= 2 and i > 0:
            issues.append(f'หน้า {i + 1}: มีข้อความเพียง {len(ys)} บรรทัด “{body[0]["text"][:30]}”')
        for l in ls:
            x0, y0, x1, y1 = l['bbox']
            if x1 > w - 30 or x0 < 30:
                issues.append(f'หน้า {i + 1}: ข้อความล้นขอบซ้าย/ขวา “{l["text"][:30]}”')
            if y1 > h - 18 or y0 < 18:
                issues.append(f'หน้า {i + 1}: ข้อความชิดขอบบน/ล่างจนอาจถูกตัด “{l["text"][:30]}”')
        for dr in p.get_drawings():
            r = dr['rect']
            if r.x1 > w - 30 or r.x0 < 30 or r.y1 > h - 18:
                issues.append(f'หน้า {i + 1}: ตาราง/เส้นล้นขอบกระดาษ')
                break
        if body:
            last = max(body, key=lambda l: l['bbox'][3])
            heading_like = last['bold'] and (re.match(r'^\s*\d+(\.\d+)*\.?\s', last['text']) or last['size'] >= 18) and not re.search(r'\.{4,}\s*\S*$', last['text'])
            if heading_like and last['bbox'][3] > h * 0.82:
                issues.append(f'หน้า {i + 1}: หัวข้อค้างท้ายหน้า “{last["text"][:30]}”')
        # หมึกในแถบขอบขวา (นอกพื้นที่ข้อความ): สระ/วรรณยุกต์ท้ายบรรทัดหลุดออกนอกขอบ (บั๊กจัดกระจายของ LibreOffice รุ่นเก่า)
        try:
            pm = p.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY, clip=pymupdf.Rect(w - 52, 62, w - 8, h - 30))
            if sum(1 for b in pm.samples if b < 180) > 2:
                issues.append(f'หน้า {i + 1}: มีตัวอักษร/สระหลุดเกินขอบขวา')
        except Exception:
            pass
        txt = ''.join(l['text'] for l in ls)
        if '�' in txt or '◌' in txt:
            issues.append(f'หน้า {i + 1}: มีอักษรเสีย/วงกลมประ (◌)')
    # ---- เลขหน้าต่อเนื่อง ----
    nums = [(i, lab) for i, lab in enumerate(label) if i > 0]
    missing = [i + 1 for i, lab in nums if not lab]
    if missing:
        issues.append(f'ไม่มีเลขหน้า: หน้า PDF {missing[:10]}')
    seq = [lab for _, lab in nums if lab]
    dup = [k for k, v in collections.Counter(seq).items() if v > 1]
    if dup:
        issues.append(f'เลขหน้าซ้ำ: {dup[:10]}')
    front = [x for x in seq if x in THAI_LETTERS]
    body_nums = [int(x) for x in seq if x.isdigit()]
    if front and front != list(THAI_LETTERS[:len(front)]):
        issues.append(f'เลขหน้าส่วนหน้าไม่ต่อเนื่อง: {front}')
    if body_nums and body_nums != list(range(1, len(body_nums) + 1)):
        gaps = [b for a, b in zip(body_nums, body_nums[1:]) if b != a + 1]
        issues.append(f'เลขหน้าเนื้อหาไม่ต่อเนื่อง (เช่น {gaps[:5]})')
    # ---- สารบัญ: "ชื่อ......เลขหน้า" ----
    toc = []
    for i, ls in enumerate(pages):
        for l in ls:
            m = re.match(r'^(.*?)\s*\.{5,}\s*([0-9]+|[%s])\s*$' % THAI_LETTERS, l['text'])
            if m and m.group(1).strip():
                toc.append((i + 1, m.group(1).strip(), m.group(2)))
    bad = 0
    norm = lambda t: t.replace(' ', '')
    for _, title, num in toc:
        cand = [k for k, lab in enumerate(label) if lab == num]
        m = re.match(r'^หน่วยที่ (\d+) เรื่อง/งาน (.*)$', title)
        keys = [re.sub(r'\s*\(ถ้ามี\)$', '', title)] if not m else ['หน่วยที่ ' + m.group(1), m.group(2)]
        ok = any(all(any(norm(kk)[:22] in norm(x['text']) for x in pages[k]) for kk in keys) for k in cand)
        if not ok:
            bad += 1
            issues.append(f'สารบัญ: “{title[:40]}” ระบุหน้า {num} แต่หน้านั้นไม่มีหัวข้อนี้')
    info.append(f'สารบัญ {len(toc)} รายการ ตรงกับหน้าจริง {len(toc) - bad} รายการ')
    # ---- บรรณานุกรม / ภาคผนวก ----
    alltext = [''.join(l['text'] for l in ls) for ls in pages]
    k = next((i for i, ls in enumerate(pages) if i > 3 and any(l['text'].strip() == 'บรรณานุกรม' and l['size'] >= 18 for l in ls)), None)
    if k is None:
        issues.append('ไม่พบหน้าบรรณานุกรม')
    for ch in 'กขคงจ':
        if not any(re.search(r'ภาคผนวก\s*%s\s' % ch, t) for t in alltext):
            issues.append(f'ไม่พบภาคผนวก {ch}')
    # ---- เอกสารราชการฉบับสมบูรณ์: ห้ามมีข้อความสถานะการทำงานของระบบ ----
    flat = [re.sub(r'\s+', ' ', ' '.join(l['text'] for l in ls)).replace(chr(0x200B), '').replace(chr(0x2060), '') for ls in pages]
    for i, t in enumerate(flat):
        for bad in ('ยังไม่ได้เชื่อมโยง', 'รอข้อมูล', 'Mapping ไม่พบ', 'ยังไม่ได้กำหนด', 'TODO', 'Missing', 'ยังไม่มีรายการ', 'ยังไม่มีเฉลย'):
            if bad in t.replace(' ', '') or bad in t:
                issues.append(f'หน้า {i + 1}: มีข้อความสถานะของระบบ “{bad}” ในเอกสาร')
    # ---- ตารางวิเคราะห์: ไม่ซ้ำหัวคอลัมน์ (งานหลัก n / งานย่อยที่ n.n) ----
    for i, t in enumerate(flat):
        if re.search(r'งานหลัก\s*(ที่\s*)?\d', t) or re.search(r'งานย่อย\s*ที่', t):
            issues.append(f'หน้า {i + 1}: ชื่องานหลัก/งานย่อยซ้ำคำกับหัวคอลัมน์')
    # ---- เลขเอกสารประกอบต้องเป็นรูปแบบเดียวกับสารบัญ (เช่น ใบงานที่ 1.1) ----
    doc_re = r'(ใบมอบหมายงาน|ใบความรู้|ใบกิจกรรม|ใบงาน)'
    toc_ids = set()
    for _, title, _n in toc:
        m = re.match(doc_re + r'ที่ (\d+\.\d+)', title.replace(chr(0x200B), ''))
        if m: toc_ids.add(m.group(1) + ' ' + m.group(2))
    odd, unknown = set(), set()
    lines_flat = [[l['text'].replace(chr(0x200B), '').replace(chr(0x2060), '') for l in ls] for ls in pages]
    for i, lt in enumerate(lines_flat):
      for t in lt:
        for m in re.finditer(doc_re + r'[ \t]*(ที่)?[ \t]*(\d+)([ \t]*\.[ \t]*\d+)?(?![ \t]*\.[ \t]*[^\d.])(?![ \t]*ใบ(?!ความรู้|งาน|กิจกรรม|มอบหมายงาน))', t):
            if not m.group(4) or not m.group(2):
                odd.add(f'หน้า {i + 1}: “{m.group(0).strip()}”')
            elif toc_ids:
                key = m.group(1) + ' ' + m.group(3) + m.group(4).replace(' ', '')
                if key not in toc_ids: unknown.add(f'{m.group(1)}ที่ {m.group(3)}{m.group(4).strip()}')
    if odd: issues.append(f'อ้างถึงเอกสารประกอบไม่ตรงรูปแบบสารบัญ: {sorted(odd)[:5]}')
    if unknown: issues.append(f'อ้างถึงเอกสารที่ไม่มีในสารบัญ: {sorted(unknown)[:5]}')
    # ---- กันการถดถอย: หน้าปก/ผลลัพธ์รายวิชา/สารบัญ ก ข/ชื่อหน่วย ----
    if flat and 'กลุ่มอาชีพ' not in flat[0]: issues.append('หน้าปกไม่มี “กลุ่มอาชีพ”')
    if not any('ผลลัพธ์การเรียนรู้ระดับรายวิชา' in t for t in flat[:6]): issues.append('หน้าหลักสูตรรายวิชาไม่มี “ผลลัพธ์การเรียนรู้ระดับรายวิชา”')
    if not any(n == 'ก' for _, _t, n in toc) or not any(n == 'ข' for _, _t, n in toc): issues.append('สารบัญไม่มีเลขหน้า ก/ข ของคำนำ/สารบัญ')
    if any(re.search(r'หน่วยที่ \d+ เรื่อง/งาน หน่วยที่', t) for t in flat): issues.append('ชื่อหน่วยซ้ำคำว่า “หน่วยที่”')
    # ---- ภาษาไทย: cluster ซ้ำที่ไม่มีในต้นฉบับ (อาการ “ขั้นขั้ ตอน”) ----
    pdf_txt = ''.join(alltext).replace(chr(0x200B), '').replace(chr(0x2060), '')
    if docx:
        src, z, x = docx_text(docx)
        src_dup = collections.Counter(m.group(0) for m in CLUSTER_DUP.finditer(src))
        pdf_dup = collections.Counter(m.group(0) for m in CLUSTER_DUP.finditer(pdf_txt))
        extra = [k2 for k2, v in pdf_dup.items() if v > src_dup.get(k2, 0)]
        if extra:
            issues.append(f'ข้อความไทยใน PDF มีพยางค์ซ้ำที่ไม่มีในต้นฉบับ: {extra[:6]}')
        # ---- โครงสร้าง DOCX ----
        sty = z.read('word/styles.xml').decode('utf8')
        ids = collections.Counter(re.findall(r'<w:style [^>]*w:styleId="([^"]+)"', sty))
        dups = [k2 for k2, v in ids.items() if v > 1]
        if dups:
            issues.append(f'DOCX: style ID ซ้ำ {dups}')
        rels = z.read('word/_rels/document.xml.rels').decode('utf8')
        if 'relationships/fontTable' not in rels:
            issues.append('DOCX: ไม่มี relationship ของ fontTable (ฟอนต์ที่ฝังจะไม่ถูกใช้)')
        if not any(n.endswith('.odttf') for n in z.namelist()):
            issues.append('DOCX: ไม่ได้ฝังฟอนต์')
        headers = [n for n in z.namelist() if re.match(r'word/header\d*\.xml', n)]
        info.append(f'DOCX: {x.count("<w:sectPr")} section · {len(headers)} header · page break {x.count("<w:pageBreakBefore")} · '
                    f'หัวตารางซ้ำ {x.count("<w:tblHeader")} · cantSplit {x.count("<w:cantSplit")} · keepNext {x.count("<w:keepNext")} · PAGEREF {x.count("PAGEREF")}')
    info.append(f'PDF {len(d)} หน้า · ฟอนต์ {", ".join(names)}')
    return {'pages': len(d), 'issues': issues, 'info': info}


if __name__ == '__main__':
    r = check(*sys.argv[1:3])
    for s in r['info']:
        print('  ·', s)
    print(f'ปัญหา {len(r["issues"])} รายการ')
    for s in r['issues']:
        print('  ✗', s)
    sys.exit(1 if r['issues'] else 0)
