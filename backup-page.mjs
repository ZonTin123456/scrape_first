#!/usr/bin/env node
// backup-page: backup 1 Thai local-gov page via Chrome CDP. Implements SPEC.md.
// Usage: node backup-page.mjs <url> [--out ./out] [--port 9444] [--timeout 60]
//        node backup-page.mjs --finalize <outdir>   (prune images per review/selection.json)
// Needs: Node 18+, Chrome (uses running instance on --port, else launches headless).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "1.1.0";
const IMG_DENY = /(cleardot|blank\.gif|j1\.gif|rblue\.gif|spacer|pixel)/i;
const TEXT_DENY_EXACT = new Set(["เลือกภาษา"]);
const MIN_PX = 12, RETRY = 2;
const CAND_MIN_W = 130, CAND_MIN_H = 100; // review candidates: photo-size (catches portraits ~140x180, drops menu strips)

function usage() {
  console.log("Usage: node backup-page.mjs <url> [--out ./out] [--port 9444] [--timeout 60]");
  console.log("       node backup-page.mjs --finalize <outdir>");
  process.exit(2);
}
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage();
if (argv[0] === "--finalize") {
  if (!argv[1]) fail("usage: node backup-page.mjs --finalize <outdir>");
  finalize(argv[1]);
  process.exit(0);
}
const url = argv[0].startsWith("http") ? argv[0] : `https://${argv[0]}`;
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = opt("--out", "./out");
const PORT = Number(opt("--port", "9444"));
const TIMEOUT_S = Number(opt("--timeout", "60"));
const fail = (msg) => { console.error("backup-page: " + msg); process.exit(1); };

async function cdp(path, method = "GET") {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  if (!r.ok) throw new Error(`CDP ${path}: http ${r.status}`);
  return r.json();
}
async function ensureChrome() {
  try { await cdp("/json/version"); return; } catch { /* launch */ }
  const cands = [
    process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const bin = cands.find((p) => existsSync(p));
  if (!bin) fail(`no Chrome on port ${PORT} and no chrome.exe found (use --port of a running instance)`);
  spawn(bin, [`--headless=new`, `--remote-debugging-port=${PORT}`,
    `--remote-allow-origins=*`, `--no-first-run`, `about:blank`],
    { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await cdp("/json/version"); return; } catch { /* wait */ }
  }
  fail("launched Chrome but CDP did not come up");
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map(), waiters = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method && waiters.has(m.method)) { waiters.get(m.method)(m); waiters.delete(m.method); }
  };
  return {
    open: () => new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }),
    send: (method, params = {}) => new Promise((res) => {
      const mid = ++id; pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
    waitEvent: (method, ms) => new Promise((res) => {
      const t = setTimeout(() => { waiters.delete(method); res(null); }, ms);
      waiters.set(method, (m) => { clearTimeout(t); res(m); });
    }),
    close: () => { try { ws.close(); } catch { /* noop */ } },
  };
}

const EXPR = `(() => {
  const out = [];
  const skip = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"]);
  const chromeOf = (el) => {
    let n = el.nodeType === 3 ? el.parentElement : el;
    while (n && n !== document.body) {
      const t = n.tagName;
      if (t === "HEADER" || t === "NAV" || t === "FOOTER") return true;
      n = n.parentElement;
    }
    return false;
  };
  const goog = (el) => {
    let n = el.nodeType === 3 ? el.parentElement : el;
    return !!(n && n.closest && n.closest("[id^='goog-te'], [class*='goog-te']"));
  };
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) {
      const text = n.nodeValue.replace(/\\s+/g, " ").trim();
      if (!text) continue;
      const p = n.parentElement;
      if (p && skip.has(p.tagName)) continue;
      out.push({ t: "text", text, chrome: chromeOf(n), goog: goog(n) });
    } else if (n.tagName === "IMG") {
      const a = n.closest("a[href]");
      out.push({ t: "img", src: abs(n.currentSrc || n.getAttribute("src") || ""),
        w: n.naturalWidth || 0, h: n.naturalHeight || 0,
        alt: (n.getAttribute("alt") || "").slice(0, 200),
        chrome: chromeOf(n), full: a ? abs(a.getAttribute("href")) : null });
    } else if (n.tagName === "IFRAME") {
      const src = n.getAttribute("src") || "";
      out.push({ t: "iframe", src, abs: src ? abs(src) : "",
        title: (n.getAttribute("title") || "").slice(0, 200), chrome: chromeOf(n) });
    }
  }
  return { origin: location.origin, title: document.title, nodes: out };
})()`;

function sameOrigin(src, origin) {
  try { return new URL(src).origin === origin; } catch { return false; }
}
function providerOf(src) {  if (/google\.com\/maps|maps\/embed/.test(src)) return ["maps", "แผนที่ Google Maps"];
  if (/sharethis/.test(src)) return ["sharethis", "ปุ่มแชร์ (sharethis)"];
  if (/cjworld.*hotmenu/.test(src)) return ["hotmenu", "เมนูลัดจังหวัด (hotmenu)"];
  return ["other", "เนื้อหาฝังภายนอก"];
}
function slugOf(u) {
  const x = new URL(u);
  const host = x.hostname.replace(/^www\./, "").split(".").slice(0, -1).join("");
  const path = x.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "index";
  return `${host}-${path}`.toLowerCase();
}
async function fetchBuf(u, referer, tries = RETRY + 1) {
  let last = "unknown";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        referer, accept: "image/*,*/*;q=0.8" } });
      if (!r.ok) { last = `http ${r.status}`; continue; }
      return { buf: Buffer.from(await r.arrayBuffer()), ct: (r.headers.get("content-type") || "").toLowerCase() };
    } catch (e) { last = String(e.message || e).slice(0, 80); }
  }
  return { error: last };
}
async function cdpFetchImage(c, src) {
  // same-origin images: fetch inside the page (page's cookies/headers/TLS beat bot-blocks)
  const expr = `(async (u) => { try {
      const r = await fetch(u);
      if (!r.ok) return { error: "http " + r.status };
      const b = await r.blob();
      if (b.size > 8000000) return { error: "too large" };
      const d = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("read"));
        fr.readAsDataURL(b);
      });
      return { dataUrl: d, ct: b.type || "" };
    } catch (e) { return { error: String(e.message || e).slice(0, 80) }; } })(${JSON.stringify(src)})`;
  const ev = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  const v = ev.result?.result?.value;
  if (!v || v.error) return { error: v?.error || "cdp fetch failed" };
  const m = /^data:(.*?);base64,(.*)$/s.exec(v.dataUrl || "");
  if (!m) return { error: "bad dataURL" };
  return { buf: Buffer.from(m[2], "base64"), ct: (v.ct || m[1] || "").toLowerCase() };
}
const extOf = (buf, ct, u) => {
  const head = buf.slice(0, 512).toString("latin1");
  if (/<svg[\s>]/.test(head)) return "svg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 3).toString() === "GIF") return "gif";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  return ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp"
  : /\.png($|\?)/i.test(u) ? "png" : /\.gif($|\?)/i.test(u) ? "gif" : /\.webp($|\?)/i.test(u) ? "webp" : "jpg";
};

const t0 = Date.now();
await ensureChrome();
const target = await cdp("/json/new?about:blank", "PUT");
const c = client(target.webSocketDebuggerUrl);
await c.open();
const deadline = t0 + TIMEOUT_S * 1000;
try {
  await c.send("Page.enable");
  await c.send("Page.navigate", { url });
  await c.waitEvent("Page.loadEventFired", deadline - Date.now());
  await new Promise((r) => setTimeout(r, 2500)); // settle JS/widgets
  const frames = await c.send("Page.getFrameTree").catch(() => null);
  const ev = await c.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
  if (ev.result?.subtype === "error" || !ev.result?.result?.value) fail("evaluate failed");
  const { origin, title, nodes } = ev.result.result.value;

  const stats = { text: 0, image: 0, placeholder: 0, "iframe-sameorigin": 0, cut: 0 };
  const kept = [], queue = [], seen = new Set();
  const cut = () => stats.cut++;
  nodes.forEach((n, i) => {
    if (n.t === "text") {
      if (n.goog || TEXT_DENY_EXACT.has(n.text)) return cut();
      stats.text++;
      kept.push({ seq: i, type: "text", chrome: n.chrome, text: n.text });
    } else if (n.t === "img") {
      if (IMG_DENY.test(n.src)) return cut();
      if (n.w < MIN_PX || n.h < MIN_PX) return cut();
      if (n.chrome) return cut(); // text-only chrome
      if (seen.has(n.src)) return cut();
      seen.add(n.src);
      stats.image++;
      const rec = { seq: i, type: "image", chrome: false, file: null, src: n.src, width: n.w, height: n.h };
      if (n.alt) rec.alt = n.alt;
      if (n.full && n.full !== n.src && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(n.full)) rec.fullres_candidate = n.full;
      kept.push(rec); queue.push(rec);
    } else if (n.t === "iframe") {
      if (!n.abs || n.abs === "about:blank") return cut();
      let cross = true;
      try { cross = new URL(n.abs).origin !== origin; } catch { /* placeholder */ }
      if (!cross) {
        stats["iframe-sameorigin"]++;
        kept.push({ seq: i, type: "iframe-sameorigin", chrome: n.chrome, src: n.abs });
        return;
      }
      const [provider, label] = providerOf(n.abs);
      stats.placeholder++;
      kept.push({ seq: i, type: "placeholder", kind: "iframe", provider, label, src: n.abs, title: n.title || null });
    }
  });

  const dir = join(OUT, slugOf(url)), imgDir = join(dir, "images");
  mkdirSync(imgDir, { recursive: true });
  let k = 0, imgErrors = 0;
  for (const rec of queue) {
    let got = await fetchBuf(rec.src, url);
    if (got.error && sameOrigin(rec.src, origin)) {
      // bot-blocked host: retry through the page itself (cookies/TLS of the render)
      const g2 = await cdpFetchImage(c, rec.src).catch((e) => ({ error: String(e.message || e).slice(0, 80) }));
      if (!g2.error) { got = g2; rec.via = "cdp"; }
    }
    if (got.error) { rec.file = null; rec.error = got.error; imgErrors++; }
    else {
      if (got.buf.length <= 70) { kept.splice(kept.indexOf(rec), 1); stats.image--; cut(); continue; }
      k++;
      const file = `images/${String(rec.seq).padStart(4, "0")}-${rec.width}x${rec.height}.${extOf(got.buf, got.ct, rec.src)}`;
      writeFileSync(join(dir, file), got.buf);
      rec.file = file; rec.bytes = got.buf.length;
    }
    delete rec.src;
  }
  const manifest = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
    extractor_version: VERSION, counts: { ...stats, imgErrors },
    childFrames: frames?.result?.frameTree ? "see CDP getFrameTree" : "n/a",
    rules: ["text-only chrome", "image denylist + <=70B filter", "text denylist (goog-te, เลือกภาษา)",
      `dedupe by absolute URL`, `min size ${MIN_PX}px`, "cross-origin iframes -> placeholder",
      "UTF-8 JSON output", `image retry x${RETRY}`] };
  writeFileSync(join(dir, "content.json"), JSON.stringify({ manifest, nodes: kept }, null, 1), "utf8");
  const nCands = writeReview(dir, kept);
  console.log(dir);
  console.log(`review: ${nCands} candidates in review/ — open review/index.html, tick people photos, save selection.json, then: node backup-page.mjs --finalize ${dir}`);
} finally {
  c.close();
  await cdp(`/json/close/${target.id}`, "PUT").catch(() => null);
}

// --- people shortlist: human picks which candidate photos to keep ---
function writeReview(dir, nodes) {
  const cands = nodes.filter((n) => n.type === "image" && n.file && n.width >= CAND_MIN_W && n.height >= CAND_MIN_H);
  const sel = cands.map((n) => ({ seq: n.seq, file: n.file, keep: true }));
  mkdirSync(join(dir, "review"), { recursive: true });
  writeFileSync(join(dir, "review", "selection.json"), JSON.stringify(sel, null, 1), "utf8");
  writeFileSync(join(dir, "review", "index.html"), reviewHTML(sel), "utf8");
  return cands.length;
}

function reviewHTML(sel) {
  const cards = sel.map((s, i) =>
    `<figure><img src="../${s.file}" loading="lazy"><figcaption>#${i} seq=${s.seq} ${s.file.split("/").pop()}<br><label><input type="checkbox" data-i="${i}" checked> เก็บ (รูปคนชัด)</label></figcaption></figure>`).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>เลือกรูปคน — ติ๊กเฉพาะรูปที่เอา</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ติ๊กเฉพาะรูปคนชัดที่ต้องการเก็บ (${sel.length} รูป)</h2>
<button id="save">บันทึก selection.json</button>
<p>แล้วเอาไฟล์ที่โหลดได้ไปทับ <code>review/selection.json</code> จากนั้นรัน <code>node backup-page.mjs --finalize &lt;โฟลเดอร์&gt;</code></p>
<div>${cards}</div>
<script>document.getElementById("save").onclick=()=>{
  const out=[...document.querySelectorAll("input[data-i]")].map(c=>({seq:+c.closest("figure").textContent.match(/seq=(\\d+)/)[1],file:c.closest("figure").querySelector("img").getAttribute("src").replace("../",""),keep:c.checked}));
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="selection.json";a.click();
};</script>`;
}

function finalize(dir) {
  const cjPath = join(dir, "content.json"), selPath = join(dir, "review", "selection.json");
  if (!existsSync(cjPath) || !existsSync(selPath)) fail(`missing content.json or review/selection.json in ${dir}`);
  const cj = JSON.parse(readFileSync(cjPath, "utf8"));
  const sel = JSON.parse(readFileSync(selPath, "utf8"));
  const keep = new Set(sel.filter((s) => s.keep).map((s) => s.seq));
  let removed = 0;
  cj.nodes = cj.nodes.filter((n) => {
    if (n.type === "image" && n.file && !keep.has(n.seq)) {
      try { unlinkSync(join(dir, n.file)); } catch { /* already gone */ }
      removed++;
      return false;
    }
    return true;
  });
  cj.manifest.counts.image = cj.nodes.filter((n) => n.type === "image").length;
  cj.manifest.counts.cut += removed;
  cj.manifest.reviewed = true;
  cj.manifest.reviewed_at = new Date().toISOString();
  writeFileSync(cjPath, JSON.stringify(cj, null, 1), "utf8");
  console.log(`finalized ${dir}: kept ${cj.manifest.counts.image} images, removed ${removed}`);
}
