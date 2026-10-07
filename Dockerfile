# Railway build จากไฟล์นี้อัตโนมัติ: Node.js + LibreOffice (สำหรับเลขหน้าสารบัญและ PDF คุณภาพพิมพ์) + ฟอนต์ TH Sarabun New
# Debian 13 (trixie): LibreOffice 25.x — รุ่น 7.4 ของ bookworm จัดกระจายแบบไทยผิด (สระ/วรรณยุกต์ท้ายบรรทัดหลุดไปขอบขวา)
FROM node:20-trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer-nogui python3-uno python3 python3-fitz fontconfig poppler-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY fonts/ /usr/share/fonts/truetype/thsarabun/
# เอกสารที่ระบุฟอนต์ TH SarabunPSK ให้ใช้ TH Sarabun New แทน (ขนาดตัวอักษรเท่ากัน) ไม่ตกไปใช้ฟอนต์อื่น
RUN mkdir -p /etc/fonts/conf.d && printf '%s\n' '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' '<fontconfig>' \
  '<alias binding="same"><family>TH SarabunPSK</family><prefer><family>TH Sarabun New</family></prefer></alias>' \
  '<alias binding="same"><family>TH Sarabun PSK</family><prefer><family>TH Sarabun New</family></prefer></alias>' \
  '</fontconfig>' \
  > /etc/fonts/conf.d/60-thsarabun.conf && fc-cache -f && fc-list | grep -q "TH Sarabun New"
COPY . .
ENV NODE_ENV=production SOFFICE_BIN=soffice
CMD ["node", "server.js"]
