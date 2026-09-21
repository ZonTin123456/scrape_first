#!/usr/bin/env node
// tools/stub-backend.mjs — DEV-ONLY isolated loopback backend for #43 E2E.
// Serves an STS-shaped personnel backend plus a tiny source board, so the
// REAL probe/scrape/detect/upload logic runs without contacting any real
// municipality backend. Never imported by production modules (server.mjs,
// jobs/*, web/*); dev harness only.
//
// Safety: binds 127.0.0.1 only (refuses --host overrides); every save lands
// in receipts.jsonl next to this run's --out dir. Human preflight: confirm
// the printed origin is loopback before pointing any --save at it.
//
// Usage:
//   node tools/stub-backend.mjs [--port 18731] [--dept <job-slug>] [--out <dir>]
//   - /board            source board (1 person, extractor-compatible TBD live)
//   - /board/i0.png     1x1 PNG bytes
//   - /personal         department list (one link whose text is --dept)
//   - /personal/person/1  STS form (img_path/p_name/p_position/p_detail/
//                         prarent_id + in-form submit); POST records a receipt
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const PORT = Number(opt("--port", "18731")) || 18731;
const DEPT = opt("--dept", "test-dept");
const OUT = opt("--out", join(process.cwd(), "out-stub"));
if (argv.includes("--host")) {
  console.error("stub-backend: --host overrides refused (loopback only)");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const RECEIPTS = join(OUT, "receipts.jsonl");

const PNG = makePng(200, 240, 32, 120, 200);

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Solid-color truecolor PNG generated at runtime (no binary fixtures).
function makePng(w, h, r, g, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      raw[y * (w * 3 + 1) + 1 + x * 3] = r;
      raw[y * (w * 3 + 1) + 1 + x * 3 + 1] = g;
      raw[y * (w * 3 + 1) + 1 + x * 3 + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const boardHtml = () => `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Test Board</title></head>
<body>
<h1>Test Board</h1>
<div class="person">
<img src="/board/i0.png" width="100" height="120" alt="Test Person photo">
<h2>Test Person</h2>
<p>Test Position</p>
</div>
</body></html>`;

const listHtml = () => `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Personnel</title></head>
<body>
<h1>Personnel</h1>
<table><tr><td><a href="/personal/person/1">${DEPT}</a></td></tr></table>
</body></html>`;

const formHtml = () => `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Person 1</title></head>
<body>
<h1>Person 1</h1>
<form action="/personal/person/1" method="post" enctype="multipart/form-data">
<input type="file" name="img_path">
<input type="text" name="p_name" value="">
<input type="text" name="p_position" value="">
<input type="text" name="p_detail" value="">
<input type="text" name="prarent_id" value="">
<button type="submit" id="save">Save</button>
</form>
</body></html>`;

// Minimal multipart parser (stdlib only): field values + file byte lengths.
function parseMultipart(body, boundary) {
  const fields = {};
  const files = {};
  const sep = Buffer.from(`--${boundary}`);
  let start = 0;
  for (;;) {
    const i = body.indexOf(sep, start);
    if (i < 0) break;
    const hEnd = body.indexOf("\r\n\r\n", i);
    if (hEnd < 0) break;
    const head = body.slice(i, hEnd).toString("latin1");
    const name = (/name="([^"]+)"/.exec(head) || [])[1] || null;
    const filename = (/filename="([^"]*)"/.exec(head) || [])[1] || null;
    const nEnd = body.indexOf(sep, hEnd);
    if (nEnd < 0) break;
    let data = body.slice(hEnd + 4, nEnd);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, data.length - 2);
    }
    if (name && filename != null) files[name] = { filename, bytes: data.length };
    else if (name) fields[name] = data.toString("utf8");
    start = nEnd;
    if (body.slice(nEnd, nEnd + sep.length + 2).toString() === `--${boundary}--`) break;
  }
  return { fields, files };
}

const server = createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const send = (code, type, body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(code, { "content-type": type, "content-length": buf.length });
    res.end(buf);
  };
  if (req.method === "GET" && u.pathname === "/board") return send(200, "text/html; charset=utf-8", boardHtml());
  if (req.method === "GET" && u.pathname === "/board/i0.png") return send(200, "image/png", PNG);
  if (req.method === "GET" && u.pathname === "/personal") return send(200, "text/html; charset=utf-8", listHtml());
  if (req.method === "GET" && u.pathname === "/personal/person/1") return send(200, "text/html; charset=utf-8", formHtml());
  if (req.method === "POST" && u.pathname === "/personal/person/1") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      const m = /boundary=(.+)$/.exec(ct);
      const { fields, files } = m ? parseMultipart(body, m[1]) : { fields: {}, files: {} };
      const receipt = { at: new Date().toISOString(), path: u.pathname, fields, files };
      appendFileSync(RECEIPTS, JSON.stringify(receipt) + "\n");
      send(200, "text/html; charset=utf-8", `<!doctype html><html><body><h1>Saved</h1><p>${fields.p_name || ""}</p></body></html>`);
    });
    return;
  }
  send(404, "text/plain; charset=utf-8", "stub-backend: not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-backend: TEST ONLY on http://127.0.0.1:${PORT} (dept=${DEPT}) receipts=${RECEIPTS}`);
});
