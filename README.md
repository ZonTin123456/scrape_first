# คำสั่งเดียวจบสาย (เลือก/เรียงขั้นได้, ข้ามขั้นได้):
node pipeline.mjs --from urls.txt
node pipeline.mjs --from urls.txt --steps probe,run,finalize,upload --yes --limit 3
# --serve เปิดเองอัตโนมัติให้ติ๊กในเบราว์เซอร์ (ปุ่ม "บันทึกเลย" เขียนไฟล์ตรง)

# 0. เปิดแท็บหลังบ้านเว็บนั้นทิ้งไว้ใน Chrome (login ค้าง)
# 1. ดูดต้นทาง
node backup-page.mjs --probe --from urls.txt
node backup-page.mjs --serve   # เปิด http://127.0.0.1:9334/ ติ๊กแล้วกด "บันทึกเลย" (ไม่ต้อง export ทับ)
# ติ๊ก pick-links.html + pick-images.html แล้ว
node backup-page.mjs --run --from out/_staging/picked-links.json

# 2. ยิงเลย (หา port+backend+ฟอร์มเอง)
node uploader/upload-people.mjs --from out/<slug>/people.json --limit 3
# ดู shots/ ถูก → ของจริง:
node uploader/upload-people.mjs --from out/<slug>/people.json --save --i-verified

node uploader/upload-people.mjs --from out/nathamnuaego-officer3-php/people.json --save --i-verified

Remove-Item .\out\* -Recurse -Force