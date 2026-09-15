# 0. เปิดแท็บหลังบ้านเว็บนั้นทิ้งไว้ใน Chrome (login ค้าง)
# 1. ดูดต้นทาง
node backup-page.mjs --probe --from urls.txt
# ติ๊ก pick-links.html + pick-images.html แล้ว
node backup-page.mjs --run --from out/_staging/picked-links.json

# 2. ยิงเลย (หา port+backend+ฟอร์มเอง)
node uploader/upload-people.mjs --from out/<slug>/people.json --limit 3
# ดู shots/ ถูก → ของจริง:
node uploader/upload-people.mjs --from out/<slug>/people.json --save --i-verified

node uploader/upload-people.mjs --from out/pulohpuyogo-officer2-php/people.json --save --i-verified