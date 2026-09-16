# uploader — Playwright: people.json -> ฟอร์มบุคลากรหลังบ้าน STS

> ZERO-MAP workflow (default): ไม่ต้องมี map ไฟล์ — discovery ตอนรัน + scored section match + fail-closed.
> `maps/` deprecated (reader เก็บไว้ 1 version เพื่อของเก่า) ห้ามใช้ใน normal workflow ใหม่.

อ่าน `out/<slug>/people.json` อย่างเดียว **ไม่เขียนทับ `out/` เด็ดขาด**
login ด้วย Chrome ที่ login ค้าง (connect CDP) ไม่เก็บรหัส
`--port auto` (default): หา CDP เอง `9333 -> 9444 -> 9222`

## 0. auto-detect (หลายเว็บ ไม่ต้องล็อกมือ)
```text
node detect.mjs --from ..\out\<slug>\people.json
# สแกนแท็บ CDP หา */personal → กด filter แผนกเอง → ลงชั้น person/{id} → เทียบลายเซ็น profiles/sts-personnel-v1 ก่อน ไม่ตรงค่อย classify เต็ม
# ได้ uploader/maps/<host>.json แล้วหยุดให้ตรวจ (ไม่บันทึกอะไร)
```
`maps/` เก็บแยก host ไม่ปนกัน แต่ละ section มี `inventory` (field ไหนเติมจาก people key ไหน / click / skip) — ฟอร์มใหม่แค่รัน detect ใหม่ ไม่ต้องแก้โค้ด ฟิลด์ไม่รู้จักจะโผล่ใน report ว่า UNMAPPED

## 1. ยิงแบบไม่ต้องมี map (profile ตรง)
```text
node upload-people.mjs --from ..\out\<slug>\people.json
# หา port + backend จากแท็บเอง → detect inline (ไม่เซฟไฟล์) → dry ทันที
# --save ต้องมี --map หรือ --i-verified (กันมือลั่น)
```

## 2. ล็อก field-map มือ (กรณี detect ไม่เจอ)
1. เปิดแท็บฟอร์ม **เพิ่ม/แก้ไขบุคลากร** บน Chrome ที่ login แล้ว
2. `npm install` (ครั้งแรกครั้งเดียว)
3. `node map-check.mjs` -> ได้ `field-dump.json`
4. เอา selector จาก dump ใส่ `field-map.json` ทุกช่อง + `success_mark` แล้วตั้ง `_status: "locked"` จากนั้นใช้ `--map field-map.json`
5. เติม `section-map.json`: `section` (จาก people.json) -> ข้อความ option แผนกในฟอร์ม

## 3. ยิงแบบมี map (ตรวจแล้ว)
```text
node upload-people.mjs --map uploader/maps/<host>.json --from ..\out\<slug>\people.json --limit 3
node upload-people.mjs --map uploader/maps/<host>.json --from ..\out\<slug>\people.json --save   # ของจริง
```
- รูปหาย -> `failed` ไปต่อคนถัดไป / section ไม่ได้ map -> อัปโหลดเลยเว้นว่าง (`created-partial`, ไม่เดาค่า) / `--strict-sections` กลับไปโหมดปฏิเสธทั้งล็อตแบบเดิม
- ชื่อว่าง -> อัปโหลดเลยเว้นว่าง (`created-partial`) — ติ๊กแล้วได้ลงทุกแถว เหลือแค่รูปหายที่เป็น `failed`
- ชื่อมีบนหน้าลิสต์แล้ว -> `skipped-exists`
- เบอร์โทร + ข้อความต่อท้ายลงช่อง `รายละเอียด` (`p_detail`) ต่อด้วย `<br>` ถ้าไม่มีทั้งคู่เว้นว่างไว้ / `ตำแหน่งภาพ` <- order (0-based ตามลำดับหน้าเว็บ)
- report: `report-<slug>.json` + รูป proof `shots/<slug>/`
