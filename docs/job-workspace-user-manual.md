# คู่มือผู้ใช้ Local Job Workspace UI (Dark Honey)

> สำหรับคนที่จะกดทดสอบแอปด้วยมือบน Windows
> ตรงกับโค้ดจริงบน branch `feat/job-workspace-ui` (PR #30),
> Wayfinder Map #10 ที่ล็อกแล้ว และตั๋ว implement #20–#29
> คำสั่ง ชื่อไฟล์ ชื่อฟิลด์ ชื่อปุ่ม ชื่อ state และรหัสทางเทคนิคคงเป็นภาษาอังกฤษตามโค้ด ส่วนคำอธิบายเป็นภาษาไทย
> เอกสารนี้ไม่เปลี่ยนพฤติกรรมแอป ไม่แตะ backend จริง ไม่รัน Real Upload

---

## 1. ภาพรวม: แอปนี้คืออะไร

- Local Job Workspace UI คือหน้าเว็บบนเครื่องตัวเอง (localhost) สำหรับพางานหนึ่งตัว (`Job`) เดินไปตามสายพานตั้งแต่ต้นน้ำ (Source) จนถึงปลายน้ำ (Real Upload) โดยเห็นสถานะทุกขั้นในจอเดียว
- 1 `Job` ผูกกับ 1 แหล่งข้อมูล (`source` URL + `group`) และ 1 `slug` งานจบแล้วไม่เปิดซ้ำ จะรันแหล่งเดิมอีก = สร้าง `Job` ใหม่
- สายพาน (spine) ตาม `jobs/store.mjs` (`SPINE`):
  `idle → probing → waiting_for_page_selection → scraping → waiting_for_people_review → finalizing → detecting_backend → dry_running → dry_passed → armed → uploading → done`
  ทางตันมี 2 ค่า (`TERMINALS`): `failed`, `cancelled`
- งานนี้คุมด้วย state จริงจากไฟล์ `out/<slug>/jobs/<jobId>/job.json` เท่านั้น ไม่เดา state จากไฟล์ลอยหรือข้อความใน log
- เรื่องความปลอดภัยมี 3 โหมด (`MODES` ใน `jobs/safety.mjs`): `discover` / `dry` / `real` และมีประตู 2 ชั้น (G1/G2) ก่อนแตะ backend จริง (อ่านข้อ 7)

---

## 2. Prerequisites (เตรียมเครื่องก่อนเริ่ม)

### 2.1 Node

- ต้องมี Node 18 ขึ้นไป (`uploader/package.json` ตั้ง `engines: node >= 18`, `pipeline.mjs` ระบุ `Needs: Node 18+`)
- เครื่องที่ตรวจ manual นี้ใช้ `node v24.18.0` ได้ปกติ
- ตรวจเวอร์ชัน:
  `node --version`

### 2.2 Chrome + CDP

- ใช้ Chrome แบบ headed (มีหน้าต่างจริง) ตัวที่เปิดอยู่แล้ว ต่อผ่าน CDP (Chrome DevTools Protocol)
- พอร์ตที่รองรับมี 3 ค่า ตามลำดับสแกนใน `uploader/lib/cdp-port.mjs` (`resolvePort`) และ help ของ `backup-page.mjs` / `upload-people.mjs`:
  `9333 → 9444 → 9222` (`--port auto` คือค่าสแกนตามลำดับนี้ ใส่เลขพอร์ตตรงก็ได้)
- เปิด Chrome เองแบบ persistent profile ด้วยพอร์ต debug เช่น:
  `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --user-data-dir=C:\chrome-profile-job`
  (path Chrome และโฟลเดอร์ profile ปรับตามเครื่อง)
- ตรวจว่าต่อติด: เปิดเบราว์เซอร์ไปที่ `http://127.0.0.1:9333/json/version` ต้องได้ JSON กลับมา ถ้าไม่ได้ = Chrome ยังไม่เปิดพอร์ตนั้น ให้ลอง `9444` / `9222`
- ถ้ารันคำสั่งแล้วเจอ `no CDP found on 9333/9444/9222` หรือ `CDP port <n> unreachable` แปลว่าตามนั้นเลย: ยังไม่มี Chrome เปิด debug port

### 2.3 Login / session

- เปิดแท็บ backend (หน้าที่มี `personal` ตาม `discoverBackends`) ทิ้งไว้ใน Chrome ตัวที่ต่อ CDP และ login ค้างไว้ก่อน โปรแกรมไม่เก็บรหัสผ่าน (`uploader/README.md`: login ด้วย Chrome ที่ login ค้าง ไม่เก็บรหัส)
- เปิดแท็บต้นทาง (เว็บ อบต.) ไว้ด้วยก็ได้ เผื่อเจอ Cloudflare จะได้กดแก้ในแท็บนั้นเลย
- ห้ามปิดแท็บ/ปิด Chrome กลางคันระหว่าง `scraping` / `uploading` ถ้าปิด = งานติด blocker `cdp` (อ่านข้อ 9)

### 2.4 ไฟล์/โฟลเดอร์ที่ต้องมี

รันจาก root ของ repo (`C:\Users\ACER\Desktop\my_first_scrape`) ไฟล์ตั้งต้นที่โค้ดอ่านจริง:

| ไฟล์/โฟลเดอร์ | มีไว้ทำไม |
|---|---|
| `urls.txt` | รายชื่อ URL ต้นทาง (`--from urls.txt`) |
| `sections.json` | กติกา map URL ย่อย → section (เช่น `manage.php` → `คณะผู้บริหาร`) |
| `source-groups.json` | รวมกลุ่มข้ามเว็บแบบตั้งใจ (ปกติ `{ "map": {} }` ว่างไว้ได้, zero-map workflow ไม่ต้องแก้) |
| `out/` | โฟลเดอร์ผลลัพธ์ทั้งหมด (อยู่ใน `.gitignore`, เซิร์ฟเวอร์สร้างให้ถ้ายังไม่มี) |
| `out/_staging/` | ไฟล์กลางสายพาน (`picked-links.json`, `master.json`, `summary.json`, `pick-links.html`, `master-pick.html`, โฟลเดอร์ราย slug) |
| `uploader/profiles/sts-personnel-v1.json` | ลายเซ็นฟอร์ม backend สำหรับ detect แบบ profile-first |
| `uploader/section-map.json`, `uploader/field-map.json` | ใช้เฉพาะ flow ล็อกมือแบบเก่า (ปกติไม่ต้องแตะ) |
| `uploader/maps/` | deprecated เก็บไว้ให้ของเก่าอ่านได้อย่างเดียว ห้ามใช้ใน normal workflow ใหม่ |
| `uploader/node_modules/` (+ `playwright-core`) | ต้อง `npm install` ใน `uploader/` ครั้งแรกครั้งเดียวก่อนใช้สาย backend (`upload-people.mjs`, `detect.mjs`, `map-check.mjs`) |

---

## 3. วิธี start แอป

### 3.1 ความจริงที่ต้องรู้ก่อน

- PR #30 ไม่มีปุ่มเปิดเซิร์ฟเวอร์ ไม่มี `npm start` ไม่มีไฟล์ launcher แยก โค้ดเซิร์ฟเวอร์ (`server.mjs`) เป็นแบบ importable-only: import แล้วไม่มีอะไรรันจนกว่าจะเรียก `startServer({ outDir, port })`
- เซิร์ฟเวอร์ bind ที่ `127.0.0.1` เท่านั้น (ดู `server.mjs`: `server.listen(port, "127.0.0.1", ...)`) เปิดจากเครื่องอื่นไม่ได้ ตั้งใจให้เป็น local tool
- วิธีเปิด UI คือรันคำสั่ง Node เองจาก root ของ repo

### 3.2 คำสั่งเปิด (รันที่ root ของ repo)

PowerShell ที่ `C:\Users\ACER\Desktop\my_first_scrape`:

```powershell
node -e "import('./server.mjs').then(async (m) => { const s = await m.startServer({ outDir: './out', port: 3000 }); console.log('ready ' + s.url); })"
```

- `outDir: './out'` = ใช้โฟลเดอร์ `out/` ของ repo (แก้เป็น path อื่นได้ แต่ manual นี้ใช้ `./out`)
- `port: 3000` = พอร์ตเว็บ เปลี่ยนเลขได้ ใส่ `0` = สุ่มพอร์ตว่างแล้วดู URL ที่พิมพ์ออกมา
- ห้าม `cd` ไปรันที่อื่นโดยไม่ตั้งใจ เพราะ `outDir` แบบ relative อิง `process.cwd()`

### 3.3 URL ที่คาดหวัง + วิธียืนยันว่าพร้อม

- URL คือ `http://127.0.0.1:3000/` (เลขพอร์ตตามที่ใส่ ถ้าใส่ `0` ให้ดูบรรทัด `ready http://127.0.0.1:<port>` ใน terminal)
- เช็กพร้อม 3 อย่าง:
  1. terminal พิมพ์ `ready http://127.0.0.1:3000` ไม่มี error
  2. เปิด URL ในเบราว์เซอร์แล้วเห็นหัว `Job Workspace` + แถบ `MODE local · STAGE idle`
  3. ลองเปิด `http://127.0.0.1:3000/jobs/demo-1` ต้องได้ JSON `{"job":null,...,"error":{"code":"not-found",...}}` (404 แบบนี้คือถูก = เซิร์ฟเวอร์ตอบ API แล้ว แค่ยังไม่มี job ชื่อนั้น)
- ปิดเซิร์ฟเวอร์: กด `Ctrl+C` ใน terminal ที่รันไว้

---

## 4. UI walkthrough (ทุกส่วนของจอ Dark Honey)

เปิด `web/index.html` ที่เซิร์ฟเวอร์ serve หน้าตาเป็น 3 คอลัมน์ + แถบบน + แถบล่าง (ตาม prototype A ที่ Map #10 ล็อกไว้):

### 4.1 แถบบน: `status-pill` + `stepper` + `job-bar` + `mode-bar`

- `status-pill` (`#status-pill`): ตัวอักษร `MODE <mode> · STAGE <stage> · BLOCKER <types|—>` รีเฟรชทุก 1 วินาที (`tickStatus`) เช่น `MODE dry · STAGE dry_passed · BLOCKER —` ถ้ามี blocker จะขึ้น `cloudflare` / `cdp`
- `stepper` (`#stepper`) + `workflow-list` (`#workflow-list`): เม็ดขั้นตอนของ `SPINE` ทั้ง 12 ขั้น + `failed`/`cancelled` ขั้นปัจจุบันมีไฮไลต์ (class `active` / เครื่องหมาย `←`)
- `job-bar` (`#job-bar`): ช่อง `Job` (`#job-id`) ให้พิมพ์ `jobId` (เช่น `job_...`) + ปุ่ม `Load review` (`#load-btn`) + ปุ่ม `Load safety` (`#safety-btn`) + ตัวอักษร `rev <n>` (`#rev-label`, มี `· STALE` ถ้า draft ค้าง)
- `mode-bar` (`#mode-bar`): ปุ่มโหมด 3 ปุ่ม `DISCOVER` / `DRY` / `REAL` (`data-mode="discover|dry|real"`, ปุ่มที่เลือกมี `aria-pressed="true"`) เป็นสวิตช์มุมมองด้าน client เท่านั้น ของจริงบังคับซ้ำที่เซิร์ฟเวอร์เสมอ (เปลี่ยนโหมดแล้วปุ่ม `Record dry pass` / `Arm` / `Real upload` จะเปิด-ปิดตาม)

### 4.2 คอลัมน์ซ้าย: `pane-workflow`

- รายชื่อขั้นตอน (`#workflow-list`) ตาม `SPINE` อ่านอย่างเดียว เอาไว้รู้ว่าอยู่ขั้นไหน ไม่ใช่ปุ่มกด

### 4.3 คอลัมน์กลาง: `pane-step` (กว้างพิเศษตอน review)

- หัวข้อ `#step-title` ปกติขึ้น `Current step: <stage>` แต่ตอน `waiting_for_people_review` จะขึ้น `Review people — wide` และ layout กว้างขึ้น (`body[data-stage="waiting_for_people_review"]`) เพราะตารางรูปคนต้องที่เยอะ
- ข้างในมี 2 กล่อง:
  - `review-pane` (`#review-pane`): งานรูปคน (อ่านข้อ 6)
  - `safety-pane` (`#safety-pane`): งานประตูนิรภัย + dry/arm/upload (อ่านข้อ 7–8)

### 4.4 คอลัมน์ขวา: `pane-context` (context/safety panel)

- มี 3 ช่อง: `#ctx-source` (Source/Group/slug), `#ctx-safety`, `#ctx-evidence` (โค้ดปัจจุบัน render `#ctx-source` จาก `GET /jobs/:id` ทุกวินาที อีก 2 ช่องเป็นโครงรอข้อมูล)
- ปุ่ม `Collapse context` (`#ctx-toggle`): พับ panel ได้เฉพาะก่อนถึง `dry_running` พอถึง `dry_running` ขึ้นไปปุ่มจะ disable + panel ล็อกกาง (`updatePin`) และพอถึง `dry_passed`/`armed` จะมีกรอบ honey (`body[data-pinned="true"]`) + ข้อความ `#ctx-pin-note` ว่า `Context auto-pinned at <stage> — collapse disabled.`

### 4.5 แถบล่าง: `log-strip` (bottom log)

- `#log-strip` แสดง event แบบ per-Job ผ่าน SSE (`EventSource` ไป `GET /jobs/:jobId/events`) เก็บสูงสุด 200 บรรทัดแล้วตัดหัวทิ้ง อ่านอย่างเดียว ห้ามเอา log มาตัดสิน state (state จริงต้อง `GET /jobs/:id`)
- ข้อความที่เห็น เช่น `review model rev 3`, `saved rev 4`, `save conflict: ...`, `safety: G1 GREEN ...`, `dry command: ...`, `arm command: ...`, `safety mode: dry` + event ดิบ (`artifact:written`, `review:selection-written`, ...)

---

## 5. Normal workflow (กดทีละขั้นจน Done)

> ความจริงใน PR #30: หน้าเว็บมีปุ่มจริงเฉพาะโซน review + safety (ข้อ 6–8) ขั้นอื่น (Source/Probe/Page Selection/Scrape/Finalize/Detect) ทำผ่าน CLI เดิมหรือยิง `POST /jobs/:jobId/commands` ตรง (`advance`/`retry`/`resume`) ตารางล่างนี้รวมทั้งสายพานโดยระบุว่าแต่ละขั้นกดที่ไหน

| ขั้น (stage/step) | คนกด/พิมพ์อะไร | ระบบทำอะไร | สำเร็จหน้าตาแบบไหน | ไฟล์/artifact ที่เกิด |
|---|---|---|---|---|
| Source (`idle`, เตรียม input) | เตรียม `urls.txt` 1 บรรทัด 1 URL, ตรวจ `sections.json` | ยังไม่รันอะไร | มี URL พร้อม probe | `urls.txt` |
| Probe (`probing`, step `probe`) | CLI: `node backup-page.mjs --probe --from urls.txt --out ./out` (หรือ pipeline step `probe`) | เปิด Chrome ผ่าน CDP, `Page.navigate`, รอโหลด, ตรวจ Cloudflare, เก็บรายชื่อรูปต่อหน้า | `out/_staging/master.json`, `master-pick.html`, `pick-links.html`, `picked-links.json`, `out/_staging/<slug>/probe.json` ถูกเขียน | ไฟล์ `_staging` ชุด probe + `summary.json` ตั้งต้น |
| Page Selection (`waiting_for_page_selection`, step `pick-links`/`master`/`apply-master`) | เปิด `out/_staging/master-pick.html` ติ๊กครั้งเดียว → กดปุ่มบันทึกทับไฟล์เดิม (`master.json`) แล้วกลับมากด Enter (หรือแยกหน้า `pick-links.html`/`pick-images.html`) | รวมคำติ๊กเป็น `picked-links.json` | `picked-links.json` มีลิงก์ที่ผ่านการติ๊ก | `_staging/picked-links.json`, `_staging/master.json`, `_staging/<slug>/picked-images.json` |
| Scrape (`scraping`, step `run`) | CLI: `node backup-page.mjs --run --from out/_staging/picked-links.json --out ./out` | ดูดเนื้อหา+รูปตามลำดับ DOM, ดาวน์โหลดรูป (โดน 401/403 หรือเจอ challenge บังคับผ่าน CDP), เขียน `content.json` + `review/selection.json` ตั้งต้น (keep ทั้งหมด, order ตามกลุ่มแถวภาพ) | โฟลเดอร์ `out/<slug>/` มี `content.json`, `images/*`, `review/selection.json` | `<slug>/content.json`, `<slug>/images/*`, `<slug>/review/selection.json`, `<slug>/review/index.html` (legacy), `<slug>/people.json` ตั้งต้น |
| People Review (`waiting_for_people_review`) | ใน UI: พิมพ์ `jobId` → `Load review` → ติ๊ก `keep` + ใส่ `order` → `Warning preview` → `Save (POST only)` (ละเอียดข้อ 6) | `GET /jobs/:id/review` โหลด model, `POST .../review/preview` คำนวณเตือนแบบไม่เซฟ, `POST .../review` validate + เขียนไฟล์ + ขึ้น `revision` | `save-msg` ขึ้น `saved rev <n>`, log มี `review:selection-written` + `artifact:written` | `out/<slug>/jobs/<jobId>/review/selection.json` (rev ใหม่ + fingerprint ใหม่) |
| Finalize (`finalizing`, step `finalize`) | CLI: `node backup-page.mjs --finalize out/<slug>` (หรือ `--finalize --all`, เติม `--compact-orders` ถ้าอยากบีบเลขแน่น `0..N`) | ตัดรูป/node ที่ไม่ keep, เขียนเลข order ลง `people.json`, เตือนเลขซ้ำ (`finalize: warn: duplicate orders`) | terminal พิมพ์ `finalized <dir>: kept <n> images, removed <m>` | `<dir>/content.json` (`manifest.reviewed=true`), `<dir>/people.json` ตรงกับติ๊ก |
| Detect Backend (`detecting_backend`) | CLI อ่านอย่างเดียว: `node uploader/detect.mjs --from out/<slug>/people.json` (หรือปล่อยให้ upload step discover inline) | สแกนแท็บ CDP หา backend, กดฟอร์ม filter แผนกแบบไม่ submit, เทียบ `profiles/sts-personnel-v1` ก่อน ไม่ตรงค่อย classify เต็ม | stdout ได้ JSON discovery, stderr บอก `OK <host> [profile:...]` | ปกติไม่เขียนไฟล์ (เขียนเฉพาะใส่ `--dump-map <path>` เอง) |
| Dry Run (`dry_running` → `dry_passed`) | ใน UI: โหมด `DRY` → ตรวจ `dry-input` (JSON) → `Record dry pass (DRY mode only)` (ละเอียดข้อ 7) | `POST .../commands` (`type: dry`) → `recordDryPass` ตรวจ G1 (row policy + guard) → เขียน dry report แบบ immutable + `sha256` → `advance` ไป `dry_passed` | `dry-msg` ขึ้น `dry recorded`, `G1 GREEN`, log มี `artifact:written` (dry-report) | `out/<slug>/jobs/<jobId>/dry-<dry_run_id>.json` + artifact `dry-report` + `shot` + `snapshot_id`/`dry_run_id` บน `job.json` |
| Verify + Arm (`dry_passed` → `armed`) | ใน UI: โหมด `REAL` → ติ๊ก checkbox G2 → พิมพ์ slug ตรงตัว → `Arm (click — single use)` | `POST .../commands` (`type: arm`) → `grantArmFromSafety` ตรวจ G1 สด + G2 (attestation ตรงตัว + slug ตรง + clicked) → arm ใช้ครั้งเดียว | `g2-msg` ขึ้น `PASS: armed (single use).`, `g2-attest` ขึ้น `PASS: armed (single-use arm live).` | `job.json`: `arm.state=armed`, ledger `arm:granted` |
| Real Upload (`armed` → `uploading` → `done`) | ใน UI: โหมด `REAL` + G1 เขียว → `Real upload (REAL mode only)` (อ่านข้อ 8 ก่อนกดทุกครั้ง) | `POST .../commands` (`type: begin-upload`) → ตรวจ dry proof → กิน arm → เขียน save report → ลูปเขียน backend ทีละแถว (`upload:row-finished`) | `g2-msg` ขึ้น `upload started (arm consumed).` จบสวยได้ `done` + `upload:report-written` | `out/<slug>/jobs/<jobId>/save-<save_run_id>.json` + artifact `save-report`, `uploader/report-<slug>.json`, `uploader/shots/<slug>/*.png` |
| Done (`done`) | ไม่ต้องกดอะไร | `finishUpload` ปิดงาน | stepper ชี้ `done`, งานนี้จบถาวร | `job.json` (`stage=done`, ledger `job:done`) |

---

## 6. People review (ติ๊กรูปคน)

### 6.1 เปิด model

1. พิมพ์ `jobId` ในช่อง `Job` (`#job-id`, รองรับ `?jobId=` ใน URL ด้วย)
2. กด `Load review` (`#load-btn`)
3. ระบบ `GET /jobs/<jobId>/review` ได้ `{ selection, revision, fingerprint, stale, warnings, duplicates, effectiveOrder, thumbs }`
4. ถ้า `stale=true` จะมีข้อความ `stale draft — reload before saving` อย่าเพิ่งเซฟ ให้กด `Reload` (`#reload-btn`) ก่อน

### 6.2 keep / unkeep + แก้ order

- การ์ดแต่ละใบ (`figure.card`) มีรูป (โหลดจาก HTTP pointer `/jobs/<jobId>/review/thumbs/<seq>` ไม่ใช่ `file://` ไม่ฝัง bytes), checkbox `keep` (`input[data-seq]`) และช่องตัวเลข `order` (`input[data-ord]`)
- `keep` ไม่ติ๊ก = ตัดรูปนั้นทิ้งตอน finalize
- `order` = ตำแหน่งภาพหลังบ้าน เริ่ม 0 ใส่เลขอะไรก็ได้ ค่าผิด (ติดลบ ทศนิยม ว่าง ตัวอักษร) กลายเป็น `0` ทั้งฝั่ง UI (`ordOf`) และฝั่งเซิร์ฟเวอร์ (`coerceOrder`) เงียบๆ ต้องตรวจตาตัวเอง
- กด `Warning preview` (`#preview-btn`) = ส่ง draft ไป `POST .../review/preview` ระบบรัน logic เดียวกับ finalize แล้วตอบกลับ `warnings`/`duplicates`/`effectiveOrder` โดยไม่เขียนไฟล์ (`persisted:false`) ดูผลที่ `#dup-warn` (`warn: duplicate orders: ...`) และ `#sort-preview` (`effective sort (order,seq): ...`)

### 6.3 checked-only bulk order

- ใส่เลขใน `Bulk order` (`#bulk-ord`) แล้วกด `Set checked only` (`#bulk-set`): มีผลเฉพาะใบที่ติ๊ก `keep` อยู่เท่านั้น (`input[data-seq]:checked`) ใบไม่ติ๊กไม่โดนแตะ
- เป็นงาน cosmetic ฝั่ง UI อย่างเดียว ค่าจริงยืนยันอีกทีตอน preview/save ฝั่งเซิร์ฟเวอร์

### 6.4 duplicate-order warnings

- เลขซ้ำได้ ไม่บล็อก แต่มีเตือน (`detectDuplicates`/`formatDupWarning`): กลุ่มใบ keep ที่ใช้ order เดียวกัน + พรีวิวเรียงแบบ `(order,seq)`
- ตอน finalize ฝั่ง CLI ก็เตือนเหมือนกัน (`finalize: warn: duplicate orders: ...`) แล้วเขียนเลขลง `people.json` ตามนั้น ถ้าอยากบีบเลขซ้ำให้แน่นใช้ `--compact-orders`

### 6.5 stale revision / conflict (เปิด 2 แท็บ)

- ทุกครั้งที่เซฟต้องส่ง `editedFrom` = `revision` ที่เห็นตอนโหลด (`POST .../review` body `{ selection, editedFrom }`)
- ถ้าแท็บ B เซฟด้วย revision เก่า (หรือมีโปรแกรมอื่นแก้ไฟล์บน disk จน fingerprint เพี้ยน) เซิร์ฟเวอร์ตอบ `409 { ok:false, reason:"stale-conflict", revision, fingerprint }` ไม่มีการเขียนทับแบบ last-wins
- UI แสดง `conflict: stale-conflict — reloaded rev <n>` แล้วโหลดใหม่เอง (`loadReview`) ให้ตรวจค่าอีกรอบแล้วเซฟใหม่
- อาการ fingerprint เพี้ยน (`fingerprints.review.sha256` ไม่ตรงไฟล์) ถือว่า draft `stale` เหมือนกัน ต้อง `Reload` ก่อนเซฟเสมอ

### 6.6 saving review

- ปุ่ม `Save (POST only)` (`#save-btn`) คือทางเขียนทางเดียวของ Job นี้ (`GET` ไม่เคยเขียนไฟล์) เซิร์ฟเวอร์ validate shape → เขียน `selection.json` แบบ atomic → ขึ้น `revision+1` + fingerprint ใหม่ → ยิง `review:selection-written` + `artifact:written` (kind `selection`)
- สำเร็จ: `save-msg` ขึ้น `saved rev <n>` แล้ว UI โหลด model ใหม่
- ล้มเหลว: `400 missing-revision` (ลืม `editedFrom`), `400 invalid-selection` (แถวผิด shape เช่น `seq`/`file` หาย), `409 stale-conflict` (revision เก่า), `413 body-too-large` (body เกิน ~1MB)

---

## 7. Dry Run และ Safety (อ่านก่อนแตะ backend)

### 7.1 Discover vs Dry Run vs Real Upload

| โหมด | สี/ป้ายใน UI | ทำอะไร | เขียน backend จริงไหม |
|---|---|---|---|
| `DISCOVER` | ป้าย `DISCOVER — inspect only (gray/neutral)` | ดูอย่างเดียว (detect, ดู bundle) | ไม่เขียน |
| `DRY` (`dry`) | ป้าย `DRY — fill + screenshot, never save (amber)` | กรอกฟอร์ม + screenshot + เขียน report/shots บนเครื่องตัวเองเท่านั้น | ไม่เขียน ไม่กด save ไม่สร้างแผนก |
| `REAL` (`real`) | ป้าย `REAL — danger zone: only mode that saves/creates (red fence)` + กรอบแดง `fieldset.danger` | โหมดเดียวที่กด save / สร้างแผนกได้ | เขียนจริง (มี G1+G2 คุม) |

ชื่อโหมดอยู่ในหัวข้อเสมอ ไม่ดูจากสีอย่างเดียว ฝั่ง client ล็อกปุ่ม (`gateButtons`) แต่ของจริงบังคับซ้ำที่เซิร์ฟเวอร์ทุกครั้ง

### 7.2 G1 safety gate (ประตูด่าน 1)

- กฎใน `checkGate1`: ต้องมี `snapshot_id` + `dry_run_id` คู่กัน, snapshot ต้องสด (`snapshotFresh`), dry proof ต้องตรวจผ่าน (`dryVerified`), guard ต้อง `green` (แดงหรือ unknown = ตัน), แถวต้องผ่าน `evaluateRowPolicy` (มี `failed`/`unresolved` = ตัน, `pinned` เจอ would-create = ตัน)
- UI แสดงที่ `#g1-list`: `PASS: Gate 1 green — Real danger zone may arm.` หรือ `BLOCKED: Gate 1 red — Real disabled.` + บรรทัด `BLOCKED: <reason>` / `AMBER: <warning>` / `proof: <verifyReasons>`
- `dry-partial`/`partial` = amber ผ่านได้แบบมีเตือน (ledger บันทึก `stage:amber`) ส่วน `guard-red`/`row-failed` = red ตันสนิท ต้องแก้แล้ว dry ใหม่

### 7.3 G2 confirmation (ประตูด่าน 2)

3 อย่างต้องครบ (`checkGate2` + `grantArmFromSafety`):

1. ติ๊ก checkbox (`#g2-check`) ที่ผูกกับข้อความ attestation ตรงตัว (`#g2-text` ขึ้น `exact attestation (copy verbatim): ...`)
2. พิมพ์ slug ตรงตัวเป๊ะใน `#g2-slug` (`typed !== slug` = ตัน)
3. กดปุ่ม `Arm` (`#arm-btn`) ด้วยการคลิกจริง (`clicked !== true` = ตัน)

ข้อความ attestation สร้างจาก `attestationText`: `I reviewed dry report <dry_run_id> and all <N> screenshots for snapshot <snapshot_id>`

### 7.4 `snapshot_id`, `dry_run_id`, `save_run_id` แบบภาษาคน

- `snapshot_id` (`snap_<hash16>`): ลายนิ้วมือของสิ่งที่กำลังจะยิง = เนื้อหา `people.json` + ติ๊ก keep/order + URL+group ต้นทาง + backend origin + แผนก/แผน + เวอร์ชัน mapping/profile (`computeSnapshotId`) เปลี่ยนอะไรนิดเดียว = hash เปลี่ยน = snapshot เก่าตก = ต้อง dry ใหม่
- `dry_run_id` (`dry_<hex>`): เลขรอบซ้อมของ snapshot นั้น ไม่รวมอยู่ใน hash (ซ้อมกี่รอบก็ได้ แต่รอบที่ใช้ arm ต้องเป็นรอบสดของ snapshot ปัจจุบัน)
- `save_run_id` (`save_<hex>`): เลขรอบยิงจริง ออกตอน `begin-upload` ผูกกับ dry รอบที่เกณฑ์ผ่าน (`save report` อ้าง `dry_run_id` + `dry_report_sha256` เสมอ)

### 7.5 reviewed screenshots / report

- กล่อง proofs (`#proof-list`): `dry-report` + `shot` แต่ละชิ้นมี `relPath`, `sha256` (โชว์ 16 ตัวแรก), `byteLength` ทุกชิ้น immutable เขียนแล้วห้ามทับ (`atomicWriteNew` เจอไฟล์ซ้ำโยน `proof-exists`)
- ตรวจก่อนติ๊ก G2: เปิด dry report (`jobs/<jobId>/dry-<dry_run_id>.json`) + เปิด shots ทุกใบ (`shots/...`) ให้เห็นกับตาว่าจะยิงอะไร ที่ไหน กี่แถว

### 7.6 typed slug confirmation + ทำไม Real Upload ยังกดไม่ได้

- ช่อง `#g2-slug` ต้องพิมพ์ slug ตรงตัว (ดูค่าใน `#ctx-source` หรือ `bundle.slug`) copy-paste ได้แต่ต้องตรงเป๊ะ รวมตัวเล็กใหญ่
- ปุ่ม `Arm`/`Real upload` ถูก disable (`gateButtons`) ถ้าโหมดไม่ใช่ `real` หรือ `gate1.ok` เป็นเท็จ สาเหตุยอดฮิต: ยังไม่ dry, dry เก่า (snapshot เปลี่ยน), guard แดง, มีแถว failed/unresolved, would-create ค้างในโหมด pinned, proof หาย/sha เพี้ยน
- แม้ปุ่มเปิด ฝั่งเซิร์ฟเวอร์ตรวจ G1+G2 ใหม่ทุกรอบ หลอก UI ไม่ได้ (`grantArmFromSafety`, `beginUploadWithProof` fail closed)

---

## 8. Real Upload (โซนอันตราย)

> ⚠️ คำเตือนเด่น: Real Upload เขียนข้อมูลจริงบน backend (กด save ฟอร์มบุคลากร + อาจสร้างแผนกที่ขาด) กดแล้วเรียกคืนทีละแถวไม่ได้ ต้องผ่าน G1 เขียว + G2 ครบ + ตรวจปลายทางก่อนทุกครั้ง ห้ามกดเพื่อลองเล่น

### 8.1 อะไรเปลี่ยนบน backend จริง

- กรอกฟอร์มบุคลากรทีละแถวแล้วกด save จริง (`upload:row-finished` ทีละแถว) แถวที่ไม่มี section ใช้ flex path เดิม + โน้ต partial
- ถ้าแผนกปลายทางขาด โหมด `--save` สร้างแผนกให้เอง (opt-in ชัดเจน: ต้องมี `--map` หรือ `--i-verified` ใน CLI / ผ่าน G2 ใน UI) แล้ว rediscover + re-gate + verify identity ก่อนเขียนแถว
- ทุกความพยายามยิงจริงกิน arm ทิ้งทันที (`consumeArm` ใน `beginUpload`) แม้รอบนั้นจะล้มเหลวทีหลัง ยิงซ้ำต้อง dry ใหม่ + arm ใหม่

### 8.2 ตรวจปลายทางก่อนกด

1. อ่าน visibility bundle (`#bundle-grid` 10 ช่องห้ามหาย: `source`, `group`, `destination origin`, `target departments`, `would-create`, `identity`, `unmapped / TBD`, `counts`, `per-row table`, `report + screenshot links` ช่องไหนยังไม่มี dry จะขึ้น `pending — no dry yet`)
2. เปิดแท็บ backend ใน Chrome ให้เห็นกับตาว่า origin ตรงกับ `destination origin` ถ้าเปิดหลาย backend ต้องระบุ `--backend` ให้ชัด (เจอหลาย host แล้วไม่ระบุ = fail)
3. อ่านตารางรายแถว (`#row-table`: `seq`, `name`, `group`, `target`, `status`, `detail`) + `counts` (`partial/skipped/failed/total`) แถว `failed`/`unresolved`/`skip-would-create` (โหมด pinned) ค้าง = G1 แดง กดต่อไม่ได้
4. เปิด dry report + shots ครบ (`#proof-list`) แล้วค่อยติ๊ก G2 + พิมพ์ slug + `Arm` + `Real upload`

### 8.3 หลักฐานที่ต้องดู

- `save-<save_run_id>.json` (`jobs/<jobId>/`) อ้าง `dry_run_id` + `dry_report_sha256` + `snapshot_id`
- `uploader/report-<slug>.json` + `uploader/shots/<slug>/*.png` (ฝั่ง CLI)
- ledger ใน `job.json` (`upload:started`, `upload:row-finished`, `upload:report-written` / `job:failed` / `job:cancelled`) + event ใน `log-strip`
- per-row table สถานะรายแถว (`dry`, `dry-partial`, `created-partial`, `skipped-exists`, `failed`, ...)

### 8.4 แถวล้มเหลว / partial เป็นยังไง

- แถวใดล้ม (`failed`) ระหว่าง upload = งานทั้งก้อนเข้า `failed` แถวที่เขียนไปแล้วคงไว้ตามจริง (ไม่ rollback ไม่ปิดบัง) arm โดนกินแล้ว ต้องสร้างรอบใหม่แบบ fresh dry + re-arm (ย้อนอ่านข้อ 10 ว่าทำไม resume กลางทางไม่ได้)
- `dry-partial`/`created-partial` = amber ผ่านได้แบบมี ledger เตือน (เช่น รูปหายเลยเว้นว่าง, section ไม่ได้ map เลยเว้นว่างในโหมดไม่ strict) ส่วน guard กลับแดงกลางทาง (`guard-regression`) = fail closed เหมือนแถวล้ม

---

## 9. Cloudflare และ Chrome/CDP (กำแพงที่เจอจริง)

### 9.1 เจอ Cloudflare ต้องทำอะไร

- อาการ: เนื้อหาที่ดูดมาเป็นกำแพง (`Just a moment` / `Attention Required` / Turnstile) โค้ดตรวจจาก title/body/Turnstile (`backup-page.mjs`: `CF_TITLE_RE`, `CF_BODY_MARKERS`)
- ระบบรออัตโนมัติก่อน (`--cf-wait <วินาที>`, ค่าเริ่ม 60) แล้วถ้ายังติดและไม่ได้ใส่ `--no-cf-manual` จะหยุดรอให้คนกดแก้ใน headed Chrome (`waitForEnter`: `solve Turnstile/checkbox in the headed Chrome (:<PORT>), keep the tab open, then press Enter here...`)
- วิธีแก้: ไปที่แท็บนั้นใน Chrome ตัวที่ต่อ CDP ติ๊ก checkbox Turnstile เองให้ผ่าน กลับมากด Enter ที่ terminal แล้วรันต่อ ห้ามปิดแท็บ
- รูปตอนเจอ challenge บังคับดาวน์โหลดผ่าน CDP (`via: cdp`) อัตโนมัติ
- ฝั่ง Job: event `challenge:seen` → `challenge:cleared` / `challenge:blocked` + blocker `cloudflare` เป็น blocker แบบ orthogonal: ถ้า snapshot+proof ยัง valid จะคง arm ไว้ (ไม่ disarm เพราะกำแพงอย่างเดียว)

### 9.2 Chrome หลุด (disconnect)

- อาการ: `CDP port <n> unreachable`, `connect: ...`, `no browser context`, งานค้างพร้อม blocker `cdp`
- วิธีแก้: เปิด Chrome กลับมาด้วยพอร์ตเดิม (`--remote-debugging-port=9333` ตามที่ใช้ตอนแรก) เปิดแท็บที่ต้องใช้ทิ้งไว้ ตรวจ `http://127.0.0.1:<port>/json/version` แล้ว retry จาก checkpoint เดิม (ข้อ 10) ด้วย input ชุดเดิม

### 9.3 หา CDP port ไม่เจอ

- รันแล้วเจอ `no CDP found on 9333/9444/9222 (start Chrome with --remote-debugging-port=9333)` = ไม่มี Chrome ตัวไหนเปิด debug port เลย
- วิธีแก้: ปิด Chrome ที่เปิดลอย (ถ้าเปิดแบบปกติไม่มี flag มันไม่ expose CDP) แล้วเปิดใหม่ด้วย flag `--remote-debugging-port=9333` (หรือ `9444`/`9222`) + `--user-data-dir` แยก แล้วตรวจ `/json/version` ทีละพอร์ต ถ้าระบุพอร์ตตรง (`--port 9333`) แล้วไม่ติด = ใช้พอร์ตนั้นจริงแต่ Chrome ไม่ตอบ ให้เปิดใหม่

### 9.4 ต้อง solve มือเมื่อไหร่

- ทุกครั้งที่ครบ `--cf-wait` แล้วยังเป็นกำแพง + ไม่ได้ใส่ `--no-cf-manual` + terminal เป็น TTY ระบบหยุดรอคนกดเสมอ ใส่ `--no-cf-manual` = ข้ามการรอคน (งานล้มด้วย `cloudflare challenge not cleared` ถ้าไม่ผ่าน) ใช้เฉพาะตอนรันแบบไม่เฝ้าจอและยอมให้ล้มได้

---

## 10. Retry / Resume / Cancel

> ความจริงใน PR #30: หน้าเว็บไม่มีปุ่ม Retry/Resume/Cancel โดยเฉพาะ 3 คำสั่งนี้ยิงผ่าน `POST /jobs/:jobId/commands` ตรง (ตัวอย่างด้วย PowerShell + `curl.exe` ข้างล่าง) ทุกคำสั่ง mutation ต้องมี `commandId` ที่ client สร้างเอง (ห้ามซ้ำกันใน job เดียวกัน) ส่งซ้ำด้วย `commandId` เดิมได้ผลเดิมโดยไม่รันซ้ำ (`createCommandStore`: replay คืน disposition เดิม)

แม่แบบ (เปลี่ยน `JOBID`, `CMD`, `PORT`):

```powershell
curl.exe -s "http://127.0.0.1:3000/jobs/JOBID/commands" -H "content-type: application/json" --data-binary '{"commandId":"CMD-001","type":"retry","payload":{"to":"probing","reason":"reopen probe after CDP fix"}}'
```

`commandId` สร้างใหม่ทุกครั้งที่ไม่ใช่การ retry ส่งซ้ำ (UI ใช้ `newCommandId`: `cmd_<time>_<rand>`)

### 10.1 retry

- ความหมาย: ลองใหม่แบบชัดแจ้ง (`attempts++` + ลง ledger) กลับไป checkpoint เดิมหรือย้อนหลัง (`to` ต้องเป็น stage ปัจจุบันหรือก่อนหน้า ห้ามไปข้างหน้า)
- กฎ (`retry` ใน `jobs/store.mjs`): ห้าม retry จาก `done`/`failed`/`cancelled` (terminal แล้วเปิดใหม่ไม่ได้ ต้องสร้าง Job ใหม่), `to` ห้ามเป็น terminal/`done`, ถอยออกจาก `dry_passed`/`armed` กลับขั้นก่อน = กิน arm ทิ้ง (`consumeArm`) + ต้อง dry/arm ใหม่
- ใช้เมื่อ: probe/run ล้มเพราะเน็ต/CDP/CF ชั่วคราว ซ่อมสาเหตุแล้วรันขั้นเดิมซ้ำด้วย input ชุดเดิม

### 10.2 resume หลัง restart / หลังรอ

- ความหมาย: เดินต่อแบบชัดแจ้ง ใช้ได้เฉพาะตอนงานจอดที่ wait (`WAITS`: `waiting_for_page_selection`, `waiting_for_people_review`) ไปขั้นถัดไปขั้นเดียว (`resume` ใน `jobs/store.mjs` ขั้นอื่นยิงแล้วได้ `not-waiting`)
- ใช้เมื่อ: เซิร์ฟเวอร์ restart แล้วงานค้างที่ wait, หรือ human step รอ approve (ฝั่ง pipeline: `approval-required` แล้ว approve/resume ทีหลังได้ ไม่บล็อก stdin)

### 10.3 cancel นอก upload

- ต้องส่ง `prompted:true` (เช่น `{"commandId":"...","type":"cancel","payload":{"prompted":true,"reason":"operator cancel"}}`) ไม่งั้นได้ `prompt-required`
- ผล: งานเข้า `cancelled` ทันที (idempotent กดซ้ำได้) เก็บ proofs ไว้ กิน arm ทิ้ง (`consumeArm`)

### 10.4 cancel ระหว่าง upload / `stop_requested`

- ส่ง cancel ตอน `uploading` (ไม่ต้อง `prompted`): ระบบไม่หยุดกลางแถว แต่ตั้ง `stopRequested=true` + ledger `upload:stop_requested` แล้วตอบ `stop_requested`
- เครื่อง upload อ่าน record ใหม่ทุกขอบแถว (`syncStopAndProof`) เขียนแถวปัจจุบันให้จบตามจริงก่อน แล้วค่อยเข้า `cancelled` ผ่าน `finish-row` (`finishUploadRowAndCancel`) arm โดนกิน กด cancel ซ้ำได้ (idempotent)
- ฝั่ง UI จะเห็น stage ค้าง `uploading` + `stopRequested` จนแถวจบ แล้วค่อยเปลี่ยนเป็น `cancelled`

### 10.5 ทำไม upload resume กลางทางไม่ได้

- กฎล็อก (`uploadResumePlan`): upload ไม่ resume ตรง ต้องกิน arm แล้วเริ่มรอบใหม่ขั้นต่ำ `dry_running → dry_passed → re-arm` ถ้ามีความเสี่ยงเชิงโครงสร้าง (mapping/backend เปลี่ยน) ต้อง `detecting_backend → dry_running → dry_passed → re-arm`
- เหตุผล: แถวที่เขียนไปแล้วอยู่บน backend จริง ไม่มี rollback การเสียบต่อกลางทางเสี่ยงเขียนซ้ำ/ข้าม/ผิดแผนก รอบใหม่บังคับตรวจ snapshot+proof+guard ใหม่ทั้งหมดก่อนแตะ backend อีกครั้ง

---

## 11. Restart และ recovery (ดับแล้วเปิดใหม่ข้อมูลไหนรอด)

- ความจริงของงาน (`job.json`) อยู่ที่ `out/<slug>/jobs/<jobId>/job.json` + pointer `out/<slug>/job.json` stage มาจาก record เท่านั้น ไม่เดาจากไฟล์ลอย (`readJob`: `Never infer stage from stray files`)
- ตอน boot เซิร์ฟเวอร์สแกนทุก job (`validateJobsAtBoot`): โหลด record → ตรวจ artifacts/fingerprints (`loadForRestart`) → ตรวจ dry proof ใหม่ (`verifyDryReport`) → ถ้า `dry_passed`/`armed` ตัวไหน proof/artifact/fingerprint หาย = disarm กลับ `dry_running` แบบ fail closed (`assessRestart`) แล้วเขียน record ที่โดน disarm เท่านั้น record ปกติไม่แตะ
- สิ่งที่รอด restart: `job.json` (stage/ledger/attempts/blockers/ids/arm), `review/selection.json` + `fingerprints.review` (revision ไม่หาย), dry/save report แบบ immutable + `commands.json` (กันรันซ้ำข้าม restart), ledger ทั้งหมด
- สิ่งที่บังคับ dry ใหม่: fingerprint เปลี่ยน (`notifyFingerprintChanged`), guard ถดถอย (`notifyGuardRegression`), proof หาย (`notifyProofLost`) — ทั้ง 3 ทาง disarm `dry_passed`/`armed` กลับ `dry_running`
- ฝั่ง stream: restart = epoch ใหม่ `streamId` ใหม่เสมอ ไม่มีความต่อเนื่องปลอม client ต้อง `GET /jobs/:id` แล้วต่อ SSE ใหม่ เคอร์เซอร์เก่า (`Last-Event-ID`/`?since=`) ใช้ไม่ได้จะได้ `job:resynced` (`reset` + hint `GET /jobs/:id`) แทน replay
- CF/CDP อย่างเดียวคง arm ไว้ได้ ถ้า snapshot+proof ยังตรวจผ่าน (blocker 2 ตัวนี้ orthogonal ไม่ disarm ด้วยตัวเอง)

---

## 12. Manual acceptance checklist (ติ๊กทีละข้อด้วยมือ)

### happy path

- [ ] เปิดเซิร์ฟเวอร์ (`startServer`) + เปิด UI ที่ `http://127.0.0.1:<port>/` เห็น `Job Workspace` + `status-pill`
- [ ] เดินสายพาน Source → Probe → Page Selection → Scrape → People Review → Finalize → Detect → Dry → Arm → Upload → Done ได้จบ (`stepper` ชี้ `done`)
- [ ] review: keep/unkeep + แก้ order + `Warning preview` เห็น dup + sort + `Save` ได้ `saved rev <n>`
- [ ] dry ได้ `dry_passed` + `dry-<dry_run_id>.json` + `snapshot_id`/`dry_run_id` บน record
- [ ] arm ด้วย attestation ตรงตัว + พิมพ์ slug ตรง + คลิก ได้ `armed` (arm ครั้งเดียว)
- [ ] upload ได้ `uploading` → `done` + `save-<save_run_id>.json` อ้าง dry รอบนั้น

### Cloudflare preserves arm

- [ ] งาน `armed` เจอ Cloudflare (`challenge:seen` + blocker `cloudflare`) แล้วกดผ่านมือ (`challenge:cleared`) arm ยังอยู่ + snapshot/proof ยัง valid (ไม่ disarm เพราะกำแพงอย่างเดียว)

### dry-partial amber

- [ ] dry ที่มีแถว `dry-partial` ผ่าน G1 แบบ amber (`AMBER: dry-partial amber: ...` + ledger `stage:amber`) ได้ `dry_passed`

### guard-red blocks upload

- [ ] guard แดง (`guardStatus: red`) dry ไม่ผ่าน (`gate1-failed`, `G1 red`) + `Real upload` ถูก disable + เซิร์ฟเวอร์ปฏิเสธ `arm`/`begin-upload` แม้โหมด `real`

### arm single-use

- [ ] `Arm` แล้ว `begin-upload` ครั้งแรกกิน arm ครั้งที่สอง (หรือ retry ถอยขั้น) ต้อง dry+arm ใหม่ (`not-armed` ถ้าฝืนยิง)

### restart / resync

- [ ] restart เซิร์ฟเวอร์แล้ว `GET /jobs/:id` ได้ record เดิม + `dry_passed`/`armed` ที่ proof หายถูก disarm กลับ `dry_running` + SSE ได้ `streamId` ใหม่ + เคอร์เซอร์เก่าได้ `job:resynced` ไม่ใช่ replay ปลอม
- [ ] kill SSE กลาง upload แล้ว `GET` resync ได้ state ถูกโดยไม่เดาจาก log

### two-tab stale conflict

- [ ] เปิด review 2 แท็บ แท็บ A เซฟก่อน แท็บ B เซฟด้วย revision เก่าได้ `409 stale-conflict` ไม่มีการทับแบบ last-wins โหลดใหม่แล้วเซฟใหม่ได้

### cancel during upload

- [ ] cancel ตอน `uploading` ได้ `stop_requested` แถวปัจจุบันจบตามจริงแล้วเข้า `cancelled` arm โดนกิน กด cancel ซ้ำ idempotent

### CLI parity

- [ ] `node pipeline.mjs --from urls.txt --steps probe,...,upload` ยังเดินแบบไฟล์เดิมได้
- [ ] `node backup-page.mjs --probe/--run/--finalize` + `node uploader/upload-people.mjs --dry/--save` (พร้อม `--dry-proof` + `--i-verified`) พฤติกรรมเหมือนเดิม ไฟล์ contract (`picked-links.json`, `master.json`, `content.json`, `selection.json`, `people.json`, `summary.json`, `report-<slug>.json`, `shots/`) ครบ

---

## 13. Troubleshooting (อาการ → สาเหตุน่าใช่ → ทางแก้)

| อาการ | สาเหตุน่าใช่ | ทางแก้ |
|---|---|---|
| `no CDP found on 9333/9444/9222` | ไม่มี Chrome เปิด debug port | เปิด Chrome ใหม่ด้วย `--remote-debugging-port=9333` + `--user-data-dir` แยก แล้วตรวจ `/json/version` |
| `CDP port <n> unreachable` / `connect: ...` | Chrome ปิด/พอร์ตผิด/แท็บหาย | เปิด Chrome พอร์ตเดิม เปิดแท็บที่ต้องใช้ทิ้งไว้ แล้ว `retry` ขั้นเดิม |
| ดูดมาได้แต่กำแพง CF / `cloudflare challenge not cleared` | Turnstile ยังไม่ผ่าน | ไปติ๊กใน headed Chrome แท็บนั้น กลับมากด Enter (ถ้า CLI รอ) แล้วรันซ้ำ อย่าใส่ `--no-cf-manual` ตอนเฝ้าจอ |
| `Load review` ขึ้น `no review draft for job` | `jobId` ผิด หรือยังไม่มี `selection.json` ของ job นั้น | ตรวจ `jobId` + `out/<slug>/jobs/<jobId>/review/selection.json` ว่าอยู่จริง รัน scrape/seed มาก่อน |
| `stale draft — reload before saving` / `409 stale-conflict` | อีกแท็บเซฟไปก่อน หรือไฟล์บน disk โดนแก้ข้างนอก | กด `Reload` ตรวจค่าใหม่แล้วเซฟใหม่ อย่าฝืนส่ง revision เก่า |
| `400 missing-revision` / `invalid-selection` | body ขาด `editedFrom` หรือแถวผิด shape | โหลด model ใหม่แล้วเซฟผ่าน UI ปกติ (UI ใส่ `editedFrom` ให้เอง) |
| `dry-msg: refused: gate1-failed` / `G1 red` | snapshot เก่า / proof หาย / guard แดง / แถว failed/unresolved/would-create ค้าง | อ่าน `g1-list` ทีละบรรทัด แก้สาเหตุ (re-dry, เคลียร์แถว, rediscover) แล้ว dry ใหม่ |
| ปุ่ม `Arm`/`Real upload` กดไม่ได้ | โหมดไม่ใช่ `real` หรือ G1 ยังแดง | สลับ `mode-bar` เป็น `REAL` + ทำ G1 ให้เขียว + ติ๊ก G2 + พิมพ์ slug + คลิก |
| `refused: g2-required` / `typed slug mismatch` / `attestation copy mismatch` | ติ๊ก/พิมพ์/คลิกไม่ครบ หรือข้อความไม่ตรงตัว | copy attestation จาก `#g2-text` ตรงตัว พิมพ์ slug ตรงเป๊ะ แล้วกด `Arm` ด้วยคลิก |
| `refused: not-armed` | arm โดนกิน/หมดอายุ/disarm ไปแล้ว | dry ใหม่ (ถ้า snapshot เปลี่ยน) + `Arm` ใหม่ แล้วค่อย `Real upload` |
| `refused: single-flight` | มี engine op อีกตัวรันอยู่ (lock ระดับ global ตัวเดียว) | รอตัวที่รันอยู่จบก่อน แล้วส่งคำสั่งเดิมซ้ำ (refusal แบบนี้ไม่ถูก cache ส่ง `commandId` เดิมได้) |
| ส่งคำสั่งซ้ำแล้วกลัวรันเบิ้ล | ความจริง: `commandId` ซ้ำ = ได้ผลเดิมไม่รันซ้ำ | ส่งซ้ำด้วย `commandId` เดิมได้เลย ตรวจ `commands.json` ข้าง job ได้ |
| SSE เงียบ / log ไม่ขยับ | stream หลุดหรือ epoch เปลี่ยนหลัง restart | `GET /jobs/:id` แล้วต่อ `GET /jobs/:id/events` ใหม่ ถ้าได้ `job:resynced` = ปกติ (resync แล้วเดินต่อ) |
| upload ค้าง `uploading` หลังกด cancel | กำลังจบแถวปัจจุบัน (`stop_requested`) | รอแถวจบ ระบบเข้า `cancelled` เอง อย่ากดยิงซ้ำกลางทาง |
| `failed`/`cancelled` แล้วอยากเดินต่อ | terminal เปิดใหม่ไม่ได้ (`done`/`failed`/`cancelled` never reopen) | สร้าง Job ใหม่สำหรับ source เดิม |
| `--save` โดนปฏิเสธ (`refusing --save without --dry-proof ...` / `without --map ... or --i-verified`) | ขาด dry proof สด หรือขาดการยืนยัน map | dry ใหม่ เอา report มาป้อน `--dry-proof` + มี `--map` ที่ตรวจแล้วหรือ `--i-verified` แล้วรันใหม่ |

---

## 14. CLI fallback / legacy workflow (ของเก่ายังใช้ได้)

ใช้ CLI เมื่อ: อยากเดินสายพานแบบไฟล์ล้วน, UI เปิดไม่ติด, อยากได้ `summary.json`/report ไฟล์จับต้องได้, หรือขั้นนั้นยังไม่มีปุ่มใน UI (probe/run/finalize/detect ใน PR #30)

```powershell
# สายเดียวจบ (เลือก/ข้ามขั้นได้)
node pipeline.mjs --from urls.txt
node pipeline.mjs --from urls.txt --steps probe,run,finalize,upload --yes --limit 3

# ดูดต้นทาง
node backup-page.mjs --probe --from urls.txt
node backup-page.mjs --apply-master out/_staging/master.json
node backup-page.mjs --run --from out/_staging/picked-links.json

# finalize (รวมหมู่)
node backup-page.mjs --finalize --all
# ใส่ --compact-orders ถ้าอยากบีบเลข order ให้แน่น 0..N

# backend แบบอ่านอย่างเดียว
node uploader/detect.mjs --from out/<slug>/people.json

# ยิง backend: dry ก่อน (default = dry ไม่ save)
node uploader/upload-people.mjs --from out/<slug>/people.json --limit 3
# ของจริง (ต้องมี dry proof สด + ยืนยัน map)
node uploader/upload-people.mjs --from out/<slug>/people.json --save --i-verified --dry-proof <dry-report.json>
```

กติกาฝั่ง CLI ที่ยังบังคับเหมือนเดิม: `--save` ต้องมี `--dry-proof <dry-report.json>` สด + (`--map` ที่ตรวจแล้ว หรือ `--i-verified`) + พิมพ์ slug ตรงตัวแบบ interactive (`--yes` เป็นแค่ non-interactive confirm ไม่ bypass ประตูไหนทั้งนั้น) + ไม่ทน stale finalize (`people.json` vs `review/selection.json` ไม่ตรง = ต้อง finalize ใหม่ เว้นแต่จงใจ `--ignore-selection-check`)

---

## 15. Known limitations (ข้อจำกัดที่ PR #30 ยังมี — ไม่อำ)

1. หน้าเว็บมีปุ่มจริงเฉพาะโซน review + safety (`Load review`, `Load safety`, `Warning preview`, `Save`, `Set checked only`, `Record dry pass`, `Arm`, `Real upload`) ไม่มีปุ่ม/ช่อง Source, Probe, Page Selection, Scrape, Finalize, Detect, Retry, Resume, Cancel ใน `web/index.html` ขั้นพวกนั้นต้องใช้ CLI หรือยิง `POST /jobs/:jobId/commands` ตรง (`advance`/`retry`/`resume`/`cancel`/`finish-row`)
2. ไม่มีปุ่มสร้าง Job ใน UI และไม่มี route `POST /jobs` (`GET /jobs` ตอบ `{ jobs: [] }` เสมอ) `jobId` ต้องมีมาก่อน (จาก job ops/pipeline/CLI + record ใน `out/<slug>/jobs/<jobId>/`) แล้วเอามาพิมพ์ในช่อง `Job` เอง
3. ช่อง `dry-input` (`#dry-input`) ตั้งต้นเป็น JSON ตัวอย่าง (`DRY_TEMPLATE`: `https://example.go.th/p1`, `https://backend.invalid/`) ไม่ใช่ข้อมูลจริง กด `Record dry pass` ทั้งที่เป็น template ได้ `dry-recorded` แบบข้อมูลสมมติ ต้องวาง payload จริงของ snapshot ตัวเองก่อนใช้ผล (ดู shape ใน `recordDryPass`: `snapshotInput|snapshotId`, `rows`, `mapMode`, `guardStatus`, `listedPath`, `destinationOrigin`, `targetDepts`, `wouldCreate`, `identity`, `unmapped`, `shots`)
4. งาน browser จริง (scrape/upload ผ่าน CDP/Playwright) ไม่อยู่บนเส้นทาง UI (`server.mjs` import ได้แค่ node builtins + relative path ห้าม engine/browser/`spawnSync`) ฝั่ง `jobs/pipeline.mjs` ถ้าไม่มี in-process runner จะตรวจ contract แล้วคืน `deferred` + ledger `pipeline:deferred` (browser work deferred) ไม่ใช่งาน browser จริง
5. `single-flight v1`: engine op รันพร้อมกันได้ตัวเดียวทั้ง process งานอื่นต้องรอ (`single-flight` ไม่ใช่คิว)
6. SSE ต่อ 1 Job ที่เลือกเท่านั้น (`GET /jobs/:jobId/events`) ไม่มี global bus/broadcast หลาย job ต้องเปิดแยกกัน buffer ใน memory ~200/job (`BUFFER_LIMIT`) ไม่ใช่การันตี หลุดแล้วต้อง resync ผ่าน `GET /jobs/:id`
7. `GET /jobs/:jobId/events` ตอบแบบ finite (`?once=1`/`?live=0` หรือ job ไม่รู้จัก) ได้เฉพาะ replay แล้วปิด ที่เหลือเป็น live stream ยาว
8. แก้ `order` ผิดกลายเป็น `0` เงียบๆ ทั้ง UI และเซิร์ฟเวอร์ ต้องตรวจตาก่อนเซฟ
9. `sections.json` / `source-groups.json` / backend-map config แก้ในไฟล์เท่านั้น ไม่มี editor ใน UI (Map #10 ระบุว่า graduates ทีหลัง)
10. นอกขอบเขตตาม Map #10: ไม่มี cloud/multi-user/auth/remote farm/analytics/billing/mobile, ไม่มี mirror-offline/non-CDP fetcher, ไม่เปลี่ยน batch semantics, ไม่ทำ packaging/installer (`startServer` seam อย่างเดียว)
11. `uploader/maps/` ว่าง/deprecated (`--map` เป็น reader รุ่นเก่า 1 version) normal workflow ใหม่ใช้ zero-map discovery ตอนรัน
12. Thai error copy + per-step retry UX ใน UI ยังเป็น graduate item (มีเฉพาะข้อความอังกฤษใน `g1-list`/`g2-msg`/`save-msg` + เหตุผลแบบโค้ด เช่น `gate1-failed`, `stale-conflict`, `single-flight`)

---

## 16. ไฟล์อ้างอิงใน repo (เผื่อเปิดโค้ดตาม)

- UI: `web/index.html` (ปุ่ม/โหมด/pin/log ทั้งหมดใน manual นี้)
- เซิร์ฟเวอร์: `server.mjs` (routes + `startServer` + `validateJobsAtBoot`)
- state: `jobs/store.mjs` (`SPINE`, `STAGE_POLICY`, `retry`/`resume`/`requestCancel`/`grantArm`/`beginUpload`, `single-flight`)
- safety: `jobs/safety.mjs` (`MODES`, `VISIBILITY_SECTIONS`, `evaluateRowPolicy`, `checkGate1`/`checkGate2`, `recordDryPass`, `verifyDryReport`, `grantArmFromSafety`, `beginUploadWithProof`, `safetyModel`)
- review: `jobs/review.mjs` (`coerceOrder`, `applyBulkAssign`, `effectiveSort`, `detectDuplicates`, `validateForFinalize`, `buildWarningPreview`, `saveReviewState` + `stale-conflict`, `loadReviewModel`, `selectionPathFor`)
- transport: `jobs/commands.mjs` (`SUPPORTED`, `ENGINE_OPS`, `COMMAND_LOG_LIMIT`, `commands.json`), `jobs/events.mjs` (`KNOWN_TYPES`, `BUFFER_LIMIT`, envelope `v:1`)
- pipeline: `jobs/pipeline.mjs` (`ALL`, `HUMAN_STEPS`, `STEP_STAGES`, `STAGING_CONTRACT`, `runPipelineAsJobOps`, `uploadResumePlan` ผ่าน store)
- แผนล็อก: `job-workspace-implementation-plan.md`, Map #10, PR #30, CLI: `pipeline.mjs`, `backup-page.mjs`, `uploader/upload-people.mjs`, `uploader/detect.mjs`, `uploader/README.md`, `SPEC.md`, `README.md`
