## ทางลัด: เว็บ UI (แนะนำ)

ไม่ต้องจำคำสั่ง — คุมทุกขั้นตอนในหน้าเดียว + ลากวางไฟล์ได้

```bash
node ui/server.mjs
# เปิด http://localhost:4173
```

รายละเอียด: [ui/README.md](ui/README.md) · ขั้นตอน 0–9 ด้านล่างคือโหมด CLI (ยังใช้ได้เหมือนเดิม)

---

## สิ่งที่ต้องมี (คนที่ clone มาครั้งแรก)

- **Node 22 ขึ้นไป** — สคริปต์คุยกับ Chrome ผ่าน `WebSocket` ที่มีในตัวตั้งแต่ Node 22 (Node 18/20 จะพังกลางทาง; ทุกสคริปต์เช็คให้ตั้งแต่เปิด พร้อมบอกวิธีแก้)
- **Chrome หรือ Chromium** — สคริปต์หาตำแหน่งเองตาม OS (Windows/macOS/Linux) ถ้าหาไม่เจอต้องเปิดเองค้างไว้
- **`playwright-core` ติดตั้งครั้งเดียว** — เฉพาะขั้น upload (สคริปต์ root อย่าง `backup-page.mjs`, `pipeline.mjs`, `ui/server.mjs` ไม่ใช้ dependency ใด ๆ)

```bash
cd uploader && npm install && cd ..   # ครั้งแรกครั้งเดียว (มี package-lock.json → ใช้ npm ci ก็ได้)
```

## 0. เตรียม

```bash
rm -rf ./out            # Windows PowerShell: Remove-Item -Recurse -Force .\out
```

เปิด Chrome แบบ headed ค้างไว้ (หน้าต่างนี้ใช้ login backend ที่จะอัปโหลดด้วย) — `--remote-allow-origins=*` จำเป็นสำหรับ Chrome 111+:

> **ใช้เว็บ UI อยู่? ข้ามขั้นนี้ได้** — กดปุ่ม **“เปิด Chrome”** มุมขวาบนของแดชบอร์ด แล้วระบบจะเปิด Chrome headed ที่พอร์ต/โปรไฟล์เดียวกันกับคำสั่งด้านล่างให้เอง
> (มีปุ่ม **“ดึงหน้าต่างขึ้น”** และ **“ปิด Chrome”** ด้วย · คำสั่งด้านล่างยังใช้ได้เหมือนเดิมเมื่อรัน UI ไม่ได้)

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir="$HOME/.chrome-cdp-9333"

# Linux
google-chrome --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir="$HOME/.chrome-cdp-9333"
```

```bat
:: Windows (cmd)
start "" "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir="%USERPROFILE%\.chrome-cdp-9333"
```

```powershell
# Windows (PowerShell)
& "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir="$env:USERPROFILE\.chrome-cdp-9333"
```

`--user-data-dir` = โปรไฟล์แยกสำหรับงานนี้ เก็บ login ค้างไว้และไม่ไปยุ่งโปรไฟล์ Chrome ปกติ · ถ้าไม่มี Chrome ที่ 9333 สคริปต์จะเปิด headless ให้เอง (ใช้กับเว็บติด Cloudflare ไม่ได้)

1. PROBE
   node backup-page.mjs --probe --from urls.txt --out ./out
   → เช็ค out/probe.json (caption/sections/tops)

2. PICK LINKS (manual)
   - เปิด pick-links.html → ติ๊ก link ที่ต้องการ
   - ถ้าหลายหน้า → ติ๊ก master-pick ด้วย
   - กด "บันทึกทับไฟล์เดิม" → ได้ out/_staging/picked-links.json
   - ถ้าใช้ master: node backup-page.mjs --apply-master out/_staging/master.json

3. RUN
   node backup-page.mjs --run --from out/_staging/picked-links.json --out ./out --page-sections sections.json
   → เช็ค summary.json: ok + ตรวจเลขกลุ่ม auto

4. REVIEW (manual)
   - เปิด review ทีละ slug → ตัดหน้าซ้ำ/แถวว่าง/noise + เช็คเลข
   - "บันทึกทับไฟล์เดิม"
   - ถ้า grouping ผิด → ห้ามไปต่อ

5. FINALIZE
   node backup-page.mjs --finalize --all --out ./out --compact-orders
   → เช็ค people order ตรง selection (duplicate warn = ปกติ)

6. ลบแถวเก่าที่สร้างไว้บน backend (manual)

7. UPLOAD dry-run (ทีละ slug)
   (ครั้งแรกต้อง `cd uploader && npm install` ก่อน — ดูหัวข้อ "สิ่งที่ต้องมี")
   node uploader/upload-people.mjs --from out/<slug>/people.json --backend <host>
   → เช็ค report: dry, ไม่มี partial/failed/unresolved

8. UPLOAD จริง
   node uploader/upload-people.mjs --from out/<slug>/people.json --save --i-verified

9. UPLOAD ทุกอัน

node pipeline.mjs --from urls.txt --steps upload --order officer7,house --limit 3

node pipeline.mjs --from urls.txt --steps upload --save --i-verified

9. VERIFY (manual)
   - แถวครบ เลขถูก form ถูกหน้า + จัดกลุ่ม display ถูก