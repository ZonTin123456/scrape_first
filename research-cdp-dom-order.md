# Research: คุม Chrome ผ่าน CDP ดึงข้อความ+รูปตามลำดับ DOM (เว็บ อบต. template ไทย)

Part of #1 · ตอบ issue #2 · Scope: ศึกษา+สรุปวิธีเท่านั้น ไม่ implement

## 1. วิธีคุม Chrome ผ่าน CDP (2 แบบ)

- **A. เกาะ Chrome ที่รันอยู่ (port 9444):** `GET http://127.0.0.1:9444/json/list` ได้ targets (`type: page|iframe`, `url`, `webSocketDebuggerUrl`) แล้วเปิด WS ต่อ target ที่ต้องการ ส่ง JSON `{id, method, params}` — ยืนยันแล้วว่าเห็น 5 หน้า main + iframe sharethis/maps/hotmenu จริง (ดู §5)
- **B. โปรแกรมเปิด headless เอง:** `chrome --headless=new --remote-debugging-port=9444 --remote-allow-origins=* --no-first-run about:blank` แล้วใช้ `Page.navigate` + รอ `Page.loadEventFired` / `Page.lifecycleEvent(networkIdle)` ก่อนสกัด — แนะนำแบบ B สำหรับโปรแกรมจริง (คุม lifecycle ได้, ไม่พึ่งเบราว์เซอร์คน)
- คุมด้วย WS client ใดก็ได้ (Node native WebSocket / Python websocket) — ทดสอบด้วย Node ไม่มี dependency ต่อ WS จริงแล้ว

## 2. Domains ที่ต้องใช้ (และที่ไม่ต้อง)

| Domain | ใช้ทำอะไร | สถานะ |
|---|---|---|
| `Page` | `navigate`, `getFrameTree` (แจง iframe), รอ `loadEventFired`/`lifecycleEvent`, `captureScreenshot` (proof) | stable — หลัก |
| `Runtime` | `evaluate` รัน TreeWalker สกัด text+img ตามลำดับ DOM (`returnByValue:true`) | stable — หลัก |
| `DOM` | สำรอง (`getDocument/querySelector`) — ระวัง: เก็บ text กับ img แยกกันแล้วลำดับหาย ต้อง TreeWalker เท่านั้น | stable — เสริม |
| `DOMSnapshot` | `captureSnapshot` ได้ DOM+iframe แบบ flattened ทีเดียว (string table) แต่ experimental + payload ใหญ่ | experimental — ทางเลือก |
| `Network` | `enable` + `getResponseBody` เฉพาะเมื่อต้องการ bytes ดิบ (เช่น ตรวจ encoding) | stable — เสริม |
| `Fetch` | ไม่ต้อง — ใช้เฉพาะดัก/แก้ request ซึ่งงาน backup ไม่ต้องการ | ไม่ใช้ |

## 3. สูตรสกัดลำดับ DOM (พิสูจน์แล้วกับของจริง)

`Runtime.evaluate` ด้วย `document.createTreeWalker(document.body, SHOW_ELEMENT|SHOW_TEXT)` รับเฉพาะ text node ไม่ว่าง (ตัด `SCRIPT/STYLE/NOSCRIPT`) กับ `IMG` — เดินครั้งเดียว ลำดับ interleave ถูกต้องตาม DOM:
- ทดสอบ `talingchanlocal.go.th/manage.php`: ได้ 60 nodes แรกสลับ `img→text→img…` ถูกต้อง (เช่น `../images/picc.png` → "ประชาสัมพันธ์ เชิญชวน…" → `:อ่าน 11 คน` → เมนู "ข้อมูลพื้นฐาน/หน้าแรก/ประวัติความเป็นมา…")
- ทดสอบ `raikaocity.go.th/house.php`: 60 nodes แรกถูกต้องเช่นกัน (`logo69.gif` → "ก-/ก/ก+" → เมนูเทศบาล)
- `Page.getFrameTree` บน talingchan ได้ 5 frames: main + `title_head.html` + `wave-an.html` + `about:blank` + `manage.php` (nested) — iframe same-origin อ่านจาก main context ได้

## 4. Render / lazy-load / iframe / รูปความละเอียดจริง

- **Rendered JS:** รอ `loadEventFired` + `networkIdle` ก่อน evaluate; หน้า template นี้เป็น server-render + JS ตกแต่ง (stmenu.js, Google Translate) ไม่มี SPA — รอ network idle ครั้งเดียวพอ
- **Lazy-load:** ตรวจแล้ว **ไม่มี** (`loading=lazy`/`data-src`/`data-original` = 0 ทั้ง 2 หน้าที่ probe: 118 รูป talingchan / 40 รูป raikaocity) — แต่สูตรกันไว้: loop `el.scrollIntoViewIfNeeded()` (CDP `DOM.scrollIntoViewIfNeeded`) + รอ `img.complete||onload` + เช็ค `currentSrc` (ตัวแก้ srcset อัตโนมัติ)
- **URL เต็ม:** เอา `img.currentSrc` (absolute, ผ่าน srcset/sizes แล้ว) fallback `new URL(src||data-src, document.baseURI)`; เก็บ `naturalWidth/Height` ไว้กรอง noise (เจอ `cleardot.gif` 1×1, `icon3.gif` 13×11 ซ้ำทั้งเมนู)
- **รูปความละเอียดจริง:** `currentSrc` = ไฟล์ที่เบราว์เซอร์โหลดจริง; ถ้ารูปย่อห่อด้วย `<a href=รูปใหญ่>` (lightbox pattern) ให้เก็บ `parent A.href` เป็น candidate full-res — ต้องตรวจรายหน้าในขั้น prototype
- **iframe:** `sharethis` (t.sharethis.com), `google maps embed`, `hotmenu cjworld` (trang/ranong) เป็น cross-origin → SOP อ่านข้ามไม่ได้จาก main context; วิธี: เปิด WS แยกต่อ `webSocketDebuggerUrl` ของ target `type:iframe` ใน `/json/list` (มีครบทุกตัว) หรือเก็บ placeholder `{src, title}` แล้วข้าม — เสนอเก็บ placeholder เป็น default (ตัด noise วิจิตภายนอก) ให้ map ตัดสินใจ (#3)

## 5. ข้อจำกัดเว็บตัวอย่างที่พบ (ของจริง)

- **Encoding ทุกเว็บ = windows-874 ไม่ใช่ UTF-8:** talingchan/klongchelom/kumpuan ส่ง HTTP `Content-Type: text/html` ไม่มี charset ต้องดู `<meta charset=windows-874>`; wangang ส่ง `charset=windows-874` ใน header; `document.characterSet` รายงาน `windows-874` ทั้งหมด — ดึง bytes ดิบแล้ว decode เป็น UTF-8 = เพี้ยนทันที
- **CDP ไม่มีปัญหานี้:** `Runtime.evaluate` คืน string ที่ decode แล้ว (title ภาษาไทยอ่านถูกทั้ง 2 หน้า) — กฎ: ห้าม decode bytes เองเมื่อใช้ CDP; ถ้าใช้ `Network.getResponseBody` กับ HTML ให้ decode ด้วย windows-874/cp874 (superset ของ TIS-620)
- **raikaocity บล็อก scraper ธรรมดา:** `urllib` โดน `403 Forbidden` แต่ Chrome/CDP เปิดได้ปกติ — อีกเหตุผลที่ต้องใช้ CDP ตามสเปก
- **Noise เยอะ:** Google Translate widget (`cleardot.gif`, "เลือกภาษา/▼"), `about:blank` iframe ว่าง, icon เมนูซ้ำ — ขั้น output ต้องมี allowlist/denylist (ยกให้ #4 prototype)

## 6. ข้อเสนอสำหรับ spec (ส่งต่อ map)

1. ทางหลัก: self-launched headless + `Page.navigate` → รอ idle → `Page.getFrameTree` → `Runtime.evaluate` (TreeWalker) → resolve URL + เก็บขนาดรูป
2. iframe cross-origin: default เก็บ placeholder ไม่ตามเข้าไป (sharethis/maps/hotmenu) — ข้อยกเว้นค่อยเพิ่มรายตัว
3. กฎรูป: ตัด 1×1/tracking (`cleardot`), dedupe ด้วย absolute URL, เก็บ candidate full-res จาก parent link
4. กฎ encoding: output เป็น UTF-8 JSON เสมอ; ห้ามมีขั้นตอน decode bytes เองใน path หลัก

## Sources (primary)

- CDP method refs (stable): `Runtime.evaluate`, `Page.navigate`, `Network.getResponseBody` — https://chromedevtools.github.io/devtools-protocol/tot/Runtime , /tot/Page , /tot/Network (mirror เนื้อหา: https://teachmeskills.dev/cdp/snippets/Runtime.evaluate.html , Page.navigate.html , Network.getResponseBody.html)
- `DOMSnapshot.captureSnapshot` (experimental, flattened รวม iframe): https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot
- `DOM` read ops + iframe-owner note: https://chromedevtools.github.io/devtools-protocol/tot/DOM
- Live evidence: `http://127.0.0.1:9444/json/list` (5 pages + sharethis/maps/hotmenu iframes, 14 ก.ย. 2026) + WS probe `Page.getFrameTree`/`Runtime.evaluate` 2 หน้า (ผลใน §3–§5) + HTTP header/meta probe (windows-874)
- Charset registry: TIS-620 (http://www.iana.org/assignments/charset-reg/tis-620), windows-874 (http://www.iana.org/assignments/charset-reg/windows-874 — "UTF-8 is preferred…when permissible")
