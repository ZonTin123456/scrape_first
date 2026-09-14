# SPEC: โปรแกรม backup หน้าเว็บ อบต. หน้าเดียวผ่าน CDP

Status: draft for review · ที่มา: [Wayfinder map](https://github.com/ZonTin123456/scrape_first/issues/1) (Decisions ครบ 4 ใบ)
หลักฐาน: `research/cdp-dom-order`, `prototype/output-structure`, `task/encoding-survey` (branches)

## 1. เป้าหมาย

รับ **URL 1 หน้า**ของเว็บ อบต. template ไทย → คุม Chrome ผ่าน CDP → สกัดข้อความ+รูป**ตามลำดับ DOM** → เก็บเป็นโฟลเดอร์อย่างเป็นระเบียบ (UTF-8) พร้อมส่งต่อทำระบบอื่น

## 2. ขอบเขต (ล็อกจาก ticket #3)

- หน้าเดียวพอ: ไม่ crawl, ไม่ตามลิงก์ไปหน้าอื่น
- เนื้อหาหลัก + รูป: เก็บเต็ม
- nav/header/footer: **text-only** — เก็บข้อความ (เมนู, ที่อยู่/โทร), ตัดรูปไอคอนตกแต่ง + บรรทัด Powered By
- iframe ข้าม origin (google maps, sharethis, hotmenu): **placeholder** ไม่ตามเข้าไป
- iframe same-origin / `about:blank`: เก็บ entry / ตัดทิ้งตามลำดับ
- ตัดอัตโนมัติ: Google Translate widget (รูป + ข้อความ), รูป tracking 1×1, iframe ว่าง, ไอคอนเมนูซ้ำ
- รูปย่อห่อลิงก์รูปใหญ่ (lightbox): เก็บ URL รูปใหญ่เป็น `fullres_candidate` ด้วย
- **Out of scope**: batch หลายเว็บ, mirror HTML offline, ระบบต่อยอด, fetcher แบบไม่ใช้ CDP

## 3. วิธีดึง (ล็อกจาก ticket #2)

1. เปิด headless Chrome เอง (`--remote-debugging-port=<port>`) — ไม่พึ่งเบราว์เซอร์คน
2. `Page.navigate` → รอ `loadEventFired` + network idle
3. `Page.getFrameTree` — แจง iframe (proof + ประกอบ placeholder)
4. `Runtime.evaluate` ด้วย TreeWalker (`SHOW_ELEMENT|SHOW_TEXT`) เดิน `document.body` **ครั้งเดียว**: text node ไม่ว่าง (ข้าม `SCRIPT/STYLE/NOSCRIPT/TEMPLATE`) + `IMG` + `IFRAME` → ได้ interleave ตาม DOM ถูกต้อง
5. รูปเต็ม: `img.currentSrc` (ผ่าน srcset แล้ว) → absolute URL + `naturalWidth/Height`; parent `a[href]` ที่เป็นไฟล์รูป = `fullres_candidate`
6. Encoding: **ห้าม decode bytes เอง** — CDP คืน string ไทยถูกแล้ว (ทุกเว็บคือ windows-874, header ส่วนใหญ่ไม่ประกาศ)
7. ดาวน์โหลดรูป: direct fetch ด้วย browser UA + Referer ก่อน; ถ้าโดนบล็อก (เช่น 403) และรูปอยู่ same-origin ให้ดึงผ่านหน้าเว็บเองด้วย `Runtime.evaluate` fetch→dataURL (ใช้ cookies/TLS ของ render)

## 4. โครง output (ล็อกจาก ticket #4, v2)

```text
<slug>/                      # เช่น talingchanlocalgo-manage
├── content.json             # {manifest, nodes} UTF-8
└── images/
    └── {seq:04d}-{w}x{h}.{ext}   # เช่น 0014-280x100.jpg
```

### 4.1 manifest

| field | ความหมาย |
|---|---|
| `source_url` | URL ที่ใส่เข้ามา |
| `source_title` | `document.title` |
| `captured_at` | ISO-8601 เวลาดึง |
| `extractor_version` | เวอร์ชันโปรแกรมดึง |
| `counts` | จำนวน node แยก type (`text/image/placeholder/iframe-sameorigin/cut`) |
| `rules` | กฎที่ใช้ (snapshot ข้อ 5) |

### 4.2 nodes (เรียง DOM, `seq` = ตำแหน่งเดิม)

| type | fields |
|---|---|
| `text` | `seq, type, chrome, text` |
| `image` | `seq, type, chrome, file, width, height, bytes[, alt][, fullres_candidate][, error]` |
| `placeholder` | `seq, type, kind:"iframe", provider (maps/sharethis/hotmenu/other), label, src, title` |
| `iframe-sameorigin` | `seq, type, chrome, src` |

`chrome: true` = อยู่ใน header/nav/footer (text-only: เก็บเฉพาะ text) · ตัวอย่างจริงดู `prototype-output/` บน branch `prototype/output-structure`

## 5. กฎกรอง (ล็อกจาก ticket #3 + #5)

หลักฐาน ticket #5 (5 หน้า): รูปรวม 502 ไฟล์ → unique ~126 → เนื้อหาจริงราว 60–80; ไอคอนซ้ำ 40–90 ครั้ง/หน้า (icon3.gif×91, icc6.png×82); โหลดล้มเหลว 0; ขนาดรวม <1MB/หน้า

1. **Image denylist** (substring, case-insensitive): `cleardot`, `blank.gif`, `j1.gif`, `rblue.gif`, `spacer`, `pixel` + ไฟล์ ≤70 bytes
2. **Text denylist**: text node ใน `#goog-te-*` / `.goog-te-*` + ข้อความตรงตัว `เลือกภาษา`
3. **Dedupe**: ด้วย absolute URL (เก็บครั้งแรกครั้งเดียว)
4. **Minimum size**: ตัดรูปที่ `naturalWidth < 12` **หรือ** `naturalHeight < 12`
5. **Placeholder**: iframe cross-origin ทุกตัว (provider ดูจาก host: `google.com/maps`→maps, `sharethis`→sharethis, `cjworld`→hotmenu, อื่น→other)
6. **Failures**: ดาวน์โหลดรูป retry 2 ครั้ง → ยังล้มเหลวให้เก็บ node ไว้พร้อม `error` แล้วไปต่อ (ไม่ fail ทั้งงาน)

## 6. CLI (เสนอ)

```text
backup-page <url> [--out ./out] [--port 9444] [--timeout 60]
# exit 0 + พิมพ์ path โฟลเดอร์ผลลัพธ์; exit != 0 พร้อมเหตุผลเมื่อ navigate/evaluate ล้มเหลว
```

## 7. Acceptance (ตรวจกับ 5 หน้าตัวอย่างใน CDP :9444)

- [ ] `content.json` เปิดอ่านไทยถูกทุกหน้า (ไม่มีเพี้ยน)
- [ ] ลำดับ textสลับรูปตรงกับที่เห็นในเบราว์เซอร์ (สุ่มตรวจ 20 nodes/หน้า)
- [ ] ไม่มีรูป denylist / ไอคอนซ้ำ / tracking ใน `images/`
- [ ] iframe ภายนอกทุกตัวกลายเป็น placeholder (เช็ค maps/sharethis/hotmenu)
- [ ] raikaocity (บล็อก fetch ธรรมดา 403) ดึงผ่าน
- [ ] รูปทุกรูปเปิดได้ (sniff magic bytes: png/jpg/gif/webp/svg), ขนาดรวมรายงานใน manifest (หน้าตัวอย่าง 0.2–5.5MB), งานไม่ล้มเมื่อรูปบางรูปโหลดเสีย
