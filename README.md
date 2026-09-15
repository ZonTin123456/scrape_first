# คำสั่งเดียวจบสาย (เลือก/เรียงขั้นได้, ข้ามขั้นได้):
node pipeline.mjs --from urls.txt
node pipeline.mjs --from urls.txt --steps probe,run,finalize,upload --yes --limit 3
# ยิงรวมเลือกลำดับ: --order officer7,house (จับคู่ชื่อ slug ที่เหลือต่อท้าย)
# ขั้นคน (pick-links/master) หยุดรอ Enter — เปิดไฟล์ HTML จากดิสก์ ติ๊ก กด "บันทึกทับไฟล์เดิม"

# กฎข้อมูล: name/position = ข้อความ 2 ตัวแรกหลังรูป, phone = เบอร์ตัวแรก,
# note = ข้อความที่เหลือต่อด้วย <br> (หยุดที่ตัวคั่นขยะ) -> ลงรายละเอียดเป็น "เบอร์<br>note"
# order = ลำดับรูปตามหน้าเว็บ เริ่ม 0 (ตำแหน่งภาพหลังบ้านเริ่ม 0)
# review/index.html มีช่องตำแหน่งภาพทุกใบ: ติ๊กหลายใบใส่เลขเดียวแล้วกดตั้งเลขใบที่ติ๊ก
# (เลขซ้ำได้ finalize เตือน; finalize เขียนเลขลง people.json)
# finalize หมู่: node backup-page.mjs --finalize --all (หรือระบุหลายโฟลเดอร์)

# 0. เปิดแท็บหลังบ้านเว็บนั้นทิ้งไว้ใน Chrome (login ค้าง)

# 1. ดูดต้นทาง
node backup-page.mjs --probe --from urls.txt
# ติ๊กรวมทีเดียว: เปิด out/_staging/master-pick.html ติ๊ก กด "บันทึกทับไฟล์เดิม" (master.json)
node backup-page.mjs --apply-master out/_staging/master.json
# หรือติ๊กแยกหน้า: pick-links.html + pick-images.html (ปุ่ม File Picker บันทึกทับไฟล์เดิมได้เลย)
# ติ๊กแล้ว
node backup-page.mjs --run --from out/_staging/picked-links.json

# 2. ยิงเลย (หา port+backend+ฟอร์มเอง)
node uploader/upload-people.mjs --from out/<slug>/people.json --limit 3
# ดู shots/ ถูก → ของจริง:
node uploader/upload-people.mjs --from out/<slug>/people.json --save --i-verified

node uploader/upload-people.mjs --from out/nathamnuaego-officer3-php/people.json --save --i-verified

Remove-Item .\out\* -Recurse -Force