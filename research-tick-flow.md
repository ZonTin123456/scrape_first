# Ticket #7 — สำรวจไฟล์และ flow ขั้นคนจิ้มปัจจุบัน (research, evidence-only)

Map: #6 (สเปก UI dark admin คุมขั้นคนจิ้มทั้งเส้น pipeline). Branch นี้เป็นหลักฐานอย่างเดียว ไม่แตะ schema/โค้ด main.
Sources: `backup-page.mjs`, `pipeline.mjs`, `sectioning.mjs`, `uploader/upload-people.mjs`, `sections.json`, `SPEC.md`, `README.md` + live `out/` sample (obtthakham 6 หน้า, 2026-09-17).

## 1. Shape ไฟล์ + field ที่เป็น truth

- `out/_staging/master.json` — `{generated_at, extractor_version, pages:[{slug,url}], decisions:[{src,keep}]}` เขียนโดย probe (`backup-page.mjs:1002-1004`) default `keep = มีชื่อ && !likely_header` รวมรูปข้ามเพจด้วย absolute `src` เรียงตามจำนวนเพจมาก→น้อย (`backup-page.mjs:586-607`). **truth = `decisions[].keep` keyed by `src`.**
- `out/_staging/picked-links.json` — `[{url,slug,keep}]` เขียนโดย probe (`backup-page.mjs:996-997`) default `keep = !error`. `--run` อ่านเฉพาะ `keep!==false` (`backup-page.mjs:921`); pipeline step `run` บังคับต้องมีไฟล์นี้ (`pipeline.mjs:102-104`). **truth = `keep` keyed by `url`.**
- `out/_staging/<slug>/picked-images.json` — `[{seq,src,keep}]` เขียนโดย probeOne (`backup-page.mjs:482-483`) default `keep = !!(name && !likely_header)`. `--run` แปลงเป็น `url→Set(seq)` (`backup-page.mjs:946-959`); ไม่มีไฟล์ = keep all. `--apply-master` เขียนทับ `keep` โดย match `src` (`backup-page.mjs:639-673`). **truth = `keep` keyed by `seq` (src ตอน apply).**
- `out/<slug>/review/selection.json` — `[{seq,file,keep,order}]` เขียนโดย `writeReview` หลังทุก scrape (`backup-page.mjs:691-699`); `order` ตั้งต้น = กลุ่มแถวภาพ (top เดียวกัน ±25px เลขเดียวกัน, `suggestOrders`, `backup-page.mjs:681-690`). finalize ใช้ `keep` ตัดสินลบไฟล์/โหนด และ `order` เขียนลง people.json (`backup-page.mjs:750-824`), ตั้ง `manifest.reviewed=true`. **truth ของขั้นคน = `keep` + `order` keyed by `seq`.**
- `out/<slug>/people.json` — `[{seq,order,photo,name,position,phone,note,section,section_from,group_warn,section_evidence,likely_header,vacant,width,height,alt,source_url,source_group}]` สร้างโดย `buildPeople` (`sectioning.mjs:277-294`): `photo=file` (โหมด run) / `=src` (โหมด probe preview), `order` ตั้งต้น = index DOM แล้ว finalize เขียนทับจาก selection (fill เลขว่างน้อยสุด, `--compact-orders` บีบ dense, sort `order→seq`). **truth สำหรับ upload = `source_url`+`source_group` (identity เป้าหมาย; `section` เป็นแค่ evidence ไม่ใช่ identity — `upload-people.mjs:154-165`, `sectioning.mjs:274-276`), ผูกกลับ selection ด้วย `seq`+`order`; `photo` ต้องมีไฟล์จริงไม่งั้น row ล้ม (`upload-people.mjs:317-321`).**
- `summary.json` (มี 2 ฉบับ) — `{generated_at,extractor_version,total,ok,failed,results}` เขียนโดย `writeSummary` (`backup-page.mjs:829-842`): ฉบับ `out/_staging/` (ผล probe: `results[].{url,slug,dir,title,counts,images}`) กับฉบับ `out/` (ผล run: `results[].{url,slug,dir,title,counts,candidates,people}|{url,error}`). pipeline ใช้ฉบับ `out/` เป็นคิว: finalize หา dir (`pipeline.mjs:108-112`), upload กรอง `!error && dir` (`pipeline.mjs:121-124`). **truth = `dir`+`slug`+`url` สำหรับเดินคิว; `counts` เป็น diagnostic.** Sample จริง: `out/summary.json` ok 6/6 (เช่น personnal3975: image 15/people 15), `content.json` manifest มี `picked:true, reviewed:true, order_overrides:true`.

## 2. HTML จิ้มแต่ละไฟล์อ่าน/เขียนอะไร

ทุกหน้ามีปุ่มดาวน์โหลด + ปุ่ม File Picker ("เปิดไฟล์เดิม"/"บันทึกทับไฟล์เดิม", picker ครั้งเดียวต่อ session แล้วคลิกเดียว; เบราว์เซอร์ไม่รองรับซ่อนปุ่ม picker เหลือปุ่มดาวน์โหลด — `filePickerBtn`, `backup-page.mjs:497-518`).
- `out/_staging/pick-links.html` ← `pickLinksHTML` (`backup-page.mjs:520-548`): `META=[{url,slug}]`; `collect()→[{url,slug,keep}]`, `applyTicks` เทียบ `url`; **เขียนทับ `staging/picked-links.json`** แล้วรัน `--run --from picked-links.json`.
- `out/_staging/<slug>/pick-images.html` ← `pickImagesHTML` (`backup-page.mjs:550-580`): `collect()→[{seq,src,keep}]`, `applyTicks` เทียบ `seq`; **เขียนทับ `staging/<slug>/picked-images.json`**.
- `out/_staging/master-pick.html` ← `masterPickHTML` (`backup-page.mjs:609-637`): `collect()→{generated_at,pages,decisions:[{src,keep}]}`, `applyTicks` เทียบ `src`; **เขียนทับ `staging/master.json`** แล้วรัน `--apply-master` กระจาย `keep` ตาม `src` ลงทุก `picked-images.json`.
- `out/<slug>/review/index.html` ← `reviewHTML` (`backup-page.mjs:701-748`): `collect()→[{seq,file,keep,order}]`, `applyTicks` เทียบ `seq` (คืนทั้ง keep+order), มีช่องเลขตำแหน่งภาพทุกใบ + ปุ่ม bulk-set (ตั้งเลขใบที่ติ๊ก; เลขซ้ำได้แต่ finalize เตือน); **เขียนทับ `review/selection.json`** แล้วรัน `--finalize <dir>`.

## 3. Pipeline หยุดรอคนตรงไหน

`pipeline.mjs:90-133` (`pause()` ข้ามทุกจุดเมื่อ `--yes`; ลำดับ default `probe,pick-links,master,apply-master,run,pick-images,finalize,upload`, `pick-images` ยังแยกเป็น step ทางเลือกแทน master ได้):
- `pick-links` — pause เปิด `staging/pick-links.html` ติ๊ก → บันทึกทับ `picked-links.json` → Enter.
- `master` — pause เปิด `staging/master-pick.html` ติ๊กครั้งเดียว → บันทึกทับ `master.json` → Enter (step ถัดไป `apply-master` อ่านไฟล์นี้; ไม่มีไฟล์ = fail).
- `pick-images` — pause หลัง `run` เปิดทีละ `staging/<slug>/pick-images.html` ติ๊ก → บันทึกทับ → Enter.
- `finalize` ไม่ใช่ pause แต่คาดว่า `review/index.html→selection.json` เสร็จก่อน (โหมด URL เดียวมี hint พิมพ์บอก, `backup-page.mjs:980`); dir ไหนไม่มี `selection.json` pipeline ข้ามพร้อม log (keep-all default จาก run, `pipeline.mjs:114-117`) ส่วน `--finalize` ตรงๆ บังคับต้องมี `content.json`+`selection.json` (`backup-page.mjs:750-752`). แยกอีกชั้นคือ pause แก้ Cloudflare Turnstile ใน headed Chrome ใน `backup-page` (`waitForChallengeClear`, ยกเว้น `--no-cf-manual`).

## 4. Upload safety (`--save`, `--i-verified`, stale-finalize)

Flags ส่งผ่าน pipeline (`pipeline.mjs:48-53`): `--backend --map --limit --save --i-verified --strict-sections`.
- Default = dry: fill + screenshot ลง `uploader/shots/<slug>/` ไม่กด save (`upload-people.mjs:3,32,430-431`).
- `--save` = เขียนจริง: auto-create แผนกที่ขาด → rediscover → verify identity แล้วค่อยอัปโหลด ล้มตรงไหนหยุดทั้งรัน (`upload-people.mjs:34-36,262-307`).
- `--map` / `--i-verified`: ไม่มี `--map` = discovery ชั่วคราว (ไม่เขียนไฟล์); dry ฟรี แต่ `--save` ต้องมี `--map` (locked) หรือ `--i-verified` ไม่งั้น refuse (`upload-people.mjs:29-30,191`); map ปักหมุดสร้างแผนกเพิ่มไม่ได้ ต้องกลับไป zero-map discovery (`upload-people.mjs:259-261`).
- Stale-finalize check F1 (`upload-people.mjs:100-140`): `--save` จะ refuse ถ้า `people.json` ไม่ตรง `review/selection.json` (ทุก seq ที่ keep ต้องอยู่ใน people + `order` ตรงกัน, ห้ามมี seq เกิน, `content.json manifest.reviewed` ต้อง true) เว้นแต่ `--ignore-selection-check` (log เตือนดังๆ); ไม่มี `selection.json` = แค่ warn แล้วข้าม.
- ประตูอื่น fail-closed: source-identity (uniform `source_url`, มี `source_group`, ตรง key ของ URL ตัวเอง — `upload-people.mjs:145-148`), host-gate (`--backend` กับ `--map` ต้อง origin เดียวกัน, `74-77`), กลุ่มที่ resolve ไม่ได้ dry โชว์ `WOULD-CREATE` แบบ zero-write / save สร้างแล้ว re-resolve (`236-256`), รายแถวรูปหาย = failed, `verifyPageIdentity` ก่อน fill (`365-371`), field-gate (`204-207`, backend ว่างเลื่อนไปหลัง bootstrap `212-214`), `--to <personUrl>` เป็นทางลัดบังคับฟอร์มเดียวข้าม resolution (`48,232`). รายงาน `uploader/report-<slug>.json` (`mode/total/by_status/plan/results`); มี failed = exit 1 (`472-486`).

## 5. ประกอบเสริม (prototype/flow ควรรู้)

- `sections.json` = `{url-substring → section}` override หน้าเว็บนั้น ลำดับความสำคัญรองจาก H1-H3 เหนือกว่าเดาจากตำแหน่ง (`pageSectionFor`, `backup-page.mjs:905-911`; pipeline ส่งไฟล์ repo ให้ step run ชัดเจน `pipeline.mjs:42-47`; ไม่โหลดให้ไฟล์ `picked-*.json`).
- กฎคน (`README.md:7-12`): name/position = ข้อความ 2 ตัวแรกหลังรูป, phone = เบอร์แรก, note = ข้อความที่เหลือต่อ `<br>`, detail หลังบ้าน = `phone+note` ต่อ `<br>` (`upload-people.mjs:153`).
