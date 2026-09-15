#!/usr/bin/env node
// backup-page: backup Thai local-gov pages via Chrome CDP. Implements SPEC.md + multi/probe extensions.
// Usage:
//   node backup-page.mjs <url> [--out ./out] [--port 9444] [--timeout 60]
//   node backup-page.mjs <url1> <url2> ...            (direct multi, sequential)
//   node backup-page.mjs --from urls.txt              (direct multi from file)
//   node backup-page.mjs --probe --from urls.txt      (phase 1: metadata only, no image bytes)
//   node backup-page.mjs --run --from picked-links.json
//   node backup-page.mjs --finalize <outdir>
// Needs: Node 18+, Chrome (uses running instance on --port, else launches headless).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const VERSION = "1.3.0";
const IMG_DENY = /(cleardot|blank\.gif|j1\.gif|rblue\.gif|spacer|pixel)/i;
const TEXT_DENY_EXACT = new Set(["เลือกภาษา"]);
const MIN_PX = 12, RETRY = 2;
const CAND_MIN_W = 130, CAND_MIN_H = 100;
const STAGING = "_staging";

function usage() {
  console.log("Usage: node backup-page.mjs <url> [--out ./out] [--port 9444] [--timeout 60]");
  console.log("       node backup-page.mjs <url1> <url2> ... [--out ./out]");
  console.log("       node backup-page.mjs --from urls.txt [--out ./out] [--port 9444] [--timeout 60] [--page-sections sections.json]");
  console.log("       node backup-page.mjs --probe --from urls.txt [--out ./out] [--port 9444]");
  console.log("       node backup-page.mjs --run --from picked-links.json [--out ./out] [--port 9444]");
  console.log("       node backup-page.mjs --finalize <outdir>");
  process.exit(2);
}
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage();
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const OUT = opt("--out", "./out");
let PORT = Number(opt("--port", "9444"));
const TIMEOUT_S = Number(opt("--timeout", "60"));
const fail = (msg) => { console.error("backup-page: " + msg); process.exit(1); };

// ---------- pure helpers (no Chrome needed, testable) ----------
function normalizeUrl(s) {
  s = String(s || "").trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s}`;
}
function readUrlList(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch { fail(`cannot read --from file: ${file}`); }
  const seen = new Set(), urls = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const u = normalizeUrl(t);
    if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
  }
  return urls;
}
function slugBaseOf(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, "").split(".").slice(0, -1).join("") || x.hostname.replace(/\./g, "");
    const path = (x.pathname + (x.search ? `-${x.search}` : "")).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "index";
    return `${host}-${path}`.toLowerCase();
  } catch { return "page-index"; }
}
function dirSourceUrl(dir, kind) {
  try {
    const p = kind === "probe" ? join(dir, "probe.json") : join(dir, "content.json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return kind === "probe" ? (j.source_url || null) : (j.manifest?.source_url || null);
  } catch { return "unreadable"; }
}
// Unique slug across OUT/<slug> and OUT/_staging/<slug>. Deterministic for same URL.
function resolveSlug(url, outDir = OUT) {
  const base = slugBaseOf(url);
  for (let n = 0; n < 100; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const finalDir = join(outDir, slug);
    const stageDir = join(outDir, STAGING, slug);
    const s1 = existsSync(finalDir) ? dirSourceUrl(finalDir, "final") : null;
    const s2 = existsSync(stageDir) ? dirSourceUrl(stageDir, "probe") : null;
    const owner = s1 || s2;
    if (owner === null) return slug;       // free slot
    if (owner === url) return slug;        // same URL re-run -> reuse, no mixing
  }
  return `${base}-${Date.now()}`;
}
// caption = next <=2 text nodes before next image/placeholder/iframe. Skips chrome-mismatched text.
// phone = first tel:-flagged (or phone-pattern) text within next <=4 texts. section = nearest preceding H1-H3.
const PHONE_RE = /^[+\d][\d\s\-().]{7,}$/;
const isPhoneText = (t) => {
  if (!t || !PHONE_RE.test(t)) return false;
  return (t.replace(/\D/g, "").length >= 9);
};
// section priority: H1-H3 heading > --page-sections url override > position inference
const SEC_FROM_POSITION = [
  [/สภา/, "สภาท้องถิ่น"],
  [/นายก|รองนายก|เลขานุการนายก|ที่ปรึกษา/, "คณะผู้บริหาร"],
  [/ปลัด|รองปลัด|หัวหน้า|ผู้อำนวยการ|นักวิชาการ|นักจัดการ|เจ้าพนักงาน|พนักงาน|ลูกจ้าง/, "พนักงานส่วนท้องถิ่น"],
];
function inferSection(position, name) {
  const t = `${position || ""} ${name || ""}`;
  for (const [re, sec] of SEC_FROM_POSITION) if (re.test(t)) return sec;
  return null;
}
function attachCaptions(kept, pageSection = null) {
  let lastHeading = null;
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (n.type === "text" && n.h && (n.h === "H1" || n.h === "H2" || n.h === "H3") && !n.chrome) lastHeading = n.text;
    if (n.type !== "image") continue;
    const texts = [];
    for (let j = i + 1; j < kept.length && texts.length < 4; j++) {
      const m = kept[j];
      if (m.type !== "text") break; // stop at next image/placeholder/iframe-sameorigin
      if (m.chrome !== n.chrome) continue; // don't mix chrome text into content caption
      if (m.text) texts.push(m);
    }
    const cap = texts.slice(0, 2).map((m) => m.text);
    let phone = null;
    for (const m of texts) {
      if (m.tel || isPhoneText(m.text)) { phone = m.text; break; }
    }
    const rest = texts.map((m) => m.text).filter((t) => t !== phone);
    n.caption_next = (rest.slice(0, 2));
    n.caption_text = n.caption_next.join(" | ");
    n.phone = phone;
    if (lastHeading) { n.section = lastHeading; n.section_from = "heading"; }
    else if (pageSection) { n.section = pageSection; n.section_from = "url"; }
    else {
      const inferred = inferSection(n.caption_next[1], n.caption_next[0]);
      n.section = inferred; n.section_from = inferred ? "position" : null;
    }
  }
  return kept;
}
// Personnel records for the Playwright uploader: [{photo, name, position, phone, section, order, ...}]
function buildPeople(kept, url, photoKey) {
  const imgs = kept.filter((n) => n.type === "image");
  return imgs.map((n, idx) => ({
    seq: n.seq,
    order: idx + 1,
    photo: (photoKey === "file" ? (n.file || n.src || null) : (n.src || null)),
    name: n.caption_next?.[0] || null,
    position: n.caption_next?.[1] || null,
    phone: n.phone || null,
    section: n.section || null,
    width: n.width, height: n.height,
    alt: n.alt || null,
    source_url: url,
  }));
}

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
  const headOf = (el) => {
    const p = el.nodeType === 3 ? el.parentElement : el;
    const h = p && p.closest ? p.closest("h1,h2,h3") : null;
    return h ? h.tagName : null;
  };
  const telOf = (el) => {
    const p = el.nodeType === 3 ? el.parentElement : el;
    const a = p && p.closest ? p.closest('a[href^="tel:"]') : null;
    return a ? a.getAttribute("href") : null;
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) {
      const text = n.nodeValue.replace(/\\s+/g, " ").trim();
      if (!text) continue;
      const p = n.parentElement;
      if (p && skip.has(p.tagName)) continue;
      out.push({ t: "text", text, chrome: chromeOf(n), goog: goog(n), h: headOf(n), tel: telOf(n) });
    } else if (n.tagName === "IMG") {
      const a = n.closest("a[href]");
      const raw = n.currentSrc || n.getAttribute("src") || "";
      const lazy = (!raw || raw.startsWith("data:"))
        ? (n.getAttribute("data-src") || n.getAttribute("data-original") || n.getAttribute("data-lazy-src") || n.getAttribute("data-srcset") || "") : "";
      const srcVal = raw && !raw.startsWith("data:") ? raw : lazy;
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { width: 0, height: 0 };
      out.push({ t: "img", src: abs(srcVal || ""),
        w: n.naturalWidth || Math.round(r.width) || 0, h: n.naturalHeight || Math.round(r.height) || 0,
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

function buildKept(rawNodes, origin, pageSection = null) {
  const stats = { text: 0, image: 0, placeholder: 0, "iframe-sameorigin": 0, cut: 0 };
  const kept = [], queue = [], seen = new Set();
  const cut = () => stats.cut++;
  rawNodes.forEach((n, i) => {
    if (n.t === "text") {
      if (n.goog || TEXT_DENY_EXACT.has(n.text)) return cut();
      stats.text++;
      const rec = { seq: i, type: "text", chrome: n.chrome, text: n.text };
      if (n.h) rec.h = n.h;
      if (n.tel) rec.tel = n.tel;
      kept.push(rec);
    } else if (n.t === "img") {
      if (!n.src || n.src.startsWith("data:")) return cut(); // inline data-URI icons, not content
      if (IMG_DENY.test(n.src)) return cut();
      if (n.w < MIN_PX || n.h < MIN_PX) return cut();
      if (n.chrome) return cut();
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
  attachCaptions(kept, pageSection);
  return { kept, queue, stats };
}

async function navigateAndExtract(c, url, timeoutMs) {
  await c.send("Page.enable");
  await c.send("Page.navigate", { url });
  await c.waitEvent("Page.loadEventFired", timeoutMs);
  await new Promise((r) => setTimeout(r, 2500));
  // trigger lazy-loaders/sliders: scroll top->bottom->top, then let images settle
  await c.send("Runtime.evaluate", { expression:
    `(async () => { const h = () => document.body ? document.body.scrollHeight : 0; const y0 = window.scrollY; for (let y = 0; y < h(); y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }   window.scrollTo(0, y0); await new Promise((r) => setTimeout(r, 800)); return h(); })()`,
    awaitPromise: true, returnByValue: true }).catch(() => null);
  // wait for laid-out-but-unloaded images (personnel photos in sliders); display:none stays 0 and gets cut later
  await c.send("Runtime.evaluate", { expression:
    `(async () => { const pending = () => [...document.images].filter((i) => {
        const s = i.currentSrc || i.getAttribute("src") || "";
        if (!s || s.startsWith("data:")) return false;
        if (i.naturalWidth > 0) return false;
        const r = i.getBoundingClientRect();
        return r.width >= 12 && r.height >= 12;
      }).length;
      const t0 = Date.now(); let last = -1, stable = 0;
      while (Date.now() - t0 < 8000) {
        const n = pending();
        if (n === 0) return 0;
        if (n === last) { stable++; if (stable >= 3) return n; } else { stable = 0; last = n; }
        await new Promise((r) => setTimeout(r, 500));
      }
      return pending(); })()`,
    awaitPromise: true, returnByValue: true }).catch(() => null);
  const ev = await c.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
  if (ev.result?.subtype === "error" || !ev.result?.result?.value) throw new Error("evaluate failed");
  return ev.result.result.value; // {origin, title, nodes}
}

async function downloadQueue(c, queue, kept, stats, dir, url, origin) {
  const imgDir = join(dir, "images");
  mkdirSync(imgDir, { recursive: true });
  let imgErrors = 0;
  for (const rec of queue) {
    let got = await fetchBuf(rec.src, url);
    if (got.error && sameOrigin(rec.src, origin)) {
      const g2 = await cdpFetchImage(c, rec.src).catch((e) => ({ error: String(e.message || e).slice(0, 80) }));
      if (!g2.error) { got = g2; rec.via = "cdp"; }
    }
    if (got.error) { rec.file = null; rec.error = got.error; imgErrors++; }
    else {
      if (got.buf.length <= 70) { kept.splice(kept.indexOf(rec), 1); stats.image--; stats.cut++; continue; }
      const file = `images/${String(rec.seq).padStart(4, "0")}-${rec.width}x${rec.height}.${extOf(got.buf, got.ct, rec.src)}`;
      writeFileSync(join(dir, file), got.buf);
      rec.file = file; rec.bytes = got.buf.length;
    }
    delete rec.src;
  }
  return imgErrors;
}

// Full scrape with download. imageSeqFilter: Set(seq) or null = all.
async function scrapeOne(c, url, timeoutMs, imageSeqFilter = null) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const { origin, title, nodes } = await navigateAndExtract(c, url, Math.max(5000, deadline - Date.now()));
  let { kept, queue, stats } = buildKept(nodes, origin, pageSectionFor(url));
  if (imageSeqFilter) {
    const dropSeqs = new Set([...queue].filter((r) => !imageSeqFilter.has(r.seq)).map((r) => r.seq));
    if (dropSeqs.size) {
      for (const r of [...queue]) if (dropSeqs.has(r.seq)) { queue.splice(queue.indexOf(r), 1); }
      kept = kept.filter((n) => !(n.type === "image" && dropSeqs.has(n.seq)));
      stats.cut += dropSeqs.size;
      stats.image = kept.filter((n) => n.type === "image").length;
    }
  }
  const slug = resolveSlug(url);
  const dir = join(OUT, slug);
  mkdirSync(join(dir, "images"), { recursive: true });
  const imgErrors = await downloadQueue(c, queue, kept, stats, dir, url, origin);
  const people = buildPeople(kept, url, "file");
  const manifest = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
    extractor_version: VERSION, counts: { ...stats, imgErrors, people: people.length },
    rules: ["text-only chrome", "image denylist + <=70B filter", "text denylist (goog-te, เลือกภาษา)",
      `dedupe by absolute URL`, `min size ${MIN_PX}px`, "cross-origin iframes -> placeholder",
      "UTF-8 JSON output", `image retry x${RETRY}`, "caption_next = next <=2 non-phone texts", "phone = tel: link or phone-pattern within next 4 texts", "section = H1-H3 heading > --page-sections url > position inference", `slug unique (${slug})`] };
  if (imageSeqFilter) { manifest.picked = true; }
  writeFileSync(join(dir, "content.json"), JSON.stringify({ manifest, nodes: kept }, null, 1), "utf8");
  writeFileSync(join(dir, "people.json"), JSON.stringify(people, null, 1), "utf8");
  const nCands = writeReview(dir, kept);
  return { dir, slug, title, manifest, nCands, nPeople: people.length };
}

// Probe: metadata only, zero image bytes.
async function probeOne(c, url, timeoutMs) {
  const { origin, title, nodes } = await navigateAndExtract(c, url, timeoutMs);
  const { kept, stats } = buildKept(nodes, origin, pageSectionFor(url));
  const slug = resolveSlug(url);
  const stageDir = join(OUT, STAGING, slug);
  mkdirSync(stageDir, { recursive: true });
  const images = kept.filter((n) => n.type === "image").map((n) => ({
    seq: n.seq, src: n.src, width: n.width, height: n.height,
    alt: n.alt || null, fullres_candidate: n.fullres_candidate || null,
    caption_next: n.caption_next || [], caption_text: n.caption_text || "",
    name: n.caption_next?.[0] || null, position: n.caption_next?.[1] || null,
    phone: n.phone || null, section: n.section || null, section_from: n.section_from || null, section_from: n.section_from || null,
  }));
  const probe = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
    extractor_version: VERSION, slug, counts: { ...stats, people: buildPeople(kept, url, "src").length }, images,
    people_preview: buildPeople(kept, url, "src").slice(0, 5),
    texts_preview: kept.filter((n) => n.type === "text").slice(0, 8).map((n) => n.text) };
  writeFileSync(join(stageDir, "probe.json"), JSON.stringify(probe, null, 1), "utf8");
  // default picked-images = all keep:true (user overwrites via HTML save)
  writeFileSync(join(stageDir, "picked-images.json"),
    JSON.stringify(images.map((im) => ({ seq: im.seq, src: im.src, keep: true })), null, 1), "utf8");
  writeFileSync(join(stageDir, "pick-images.html"), pickImagesHTML(url, title, slug, images), "utf8");
  return probe;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pickLinksHTML(probes) {
  const rows = probes.map((p, i) => {
    const ok = !p.error;
    const counts = ok ? `text ${p.counts.text} / img ${p.counts.image}` : `FAIL: ${esc(p.error)}`;
    return `<tr><td><input type="checkbox" data-i="${i}" ${ok ? "checked" : ""}></td>`
      + `<td>${esc(p.source_title || "(no title)")}<br><small>${esc(p.source_url)}</small><br><small>${esc(counts)}</small></td>`
      + `<td>${ok ? `<a href="./${esc(p.slug)}/pick-images.html" target="_blank">เลือกรูป (${p.images.length})</a>` : "-"}</td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ติ๊กเลือกลิงก์ที่จะโหลด (${probes.length})</title>
<style>body{font-family:system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}button{font-size:18px;padding:8px 16px}</style>
<h2>ชั้น 1 — ติ๊กเลือกลิงก์ที่จะโหลด (${probes.length} ลิงก์)</h2>
<button id="save">บันทึก picked-links.json</button>
<p>เอาไฟล์ที่โหลดได้ไปทับ <code>${STAGING}/picked-links.json</code> จากนั้นรัน <code>node backup-page.mjs --run --from ${STAGING}/picked-links.json</code></p>
<table><tr><th>เอา</th><th>เว็บ</th><th>รูป</th></tr>${rows}</table>
<script>document.getElementById("save").onclick=()=>{
  const boxes=[...document.querySelectorAll("input[data-i]")];
  const meta=${JSON.stringify(probes.map((p) => ({ url: p.source_url, slug: p.slug })))};
  const out=boxes.map(c=>({url:meta[+c.dataset.i].url,slug:meta[+c.dataset.i].slug,keep:c.checked}));
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="picked-links.json";a.click();
};</script>`;
}

function pickImagesHTML(url, title, slug, images) {
  const cards = images.map((im, i) => {
    const who = [im.name, im.position].filter(Boolean).join(" | ") || im.alt || "(ไม่มีชื่อใต้รูป)";
    const extra = [im.section ? `แผนก: ${esc(im.section)}` : "", im.phone ? `โทร: ${esc(im.phone)}` : ""].filter(Boolean).join("<br>");
    return `<figure><img src="${esc(im.src)}" loading="lazy" onerror="this.outerHTML='<div style=\\'padding:20px;background:#eee\\'>โหลดพรีวิวไม่ได้<br>${im.width}x${im.height}</div>'">`
    + `<figcaption>#${i} seq=${im.seq} ${im.width}x${im.height}<br><b>${esc(who)}</b>${extra ? `<br>${extra}` : ""}`
    + `<br><label><input type="checkbox" data-seq="${im.seq}" checked> โหลดรูปนี้</label></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>เลือกรูป — ${esc(title)}</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px;border:1px solid #ddd;padding:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ชั้น 2 — ติ๊กรูปที่จะโหลด (${images.length} รูป)</h2>
<p>${esc(title)}<br><small>${esc(url)}</small></p>
<button id="save">บันทึก picked-images.json</button>
<p>เอาไฟล์ที่โหลดได้ไปทับ <code>${STAGING}/${esc(slug)}/picked-images.json</code></p>
<div>${cards || "<p>ไม่มีรูปให้เลือก</p>"}</div>
<script>document.getElementById("save").onclick=()=>{
  const out=[...document.querySelectorAll("input[data-seq]")].map(c=>({seq:+c.dataset.seq,src:c.closest("figure").querySelector("img")?.getAttribute("src")||"",keep:c.checked}));
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="picked-images.json";a.click();
};</script>`;
}

// --- people shortlist: human picks which candidate photos to keep ---
function writeReview(dir, nodes) {
  const cands = nodes.filter((n) => n.type === "image" && n.file && n.width >= CAND_MIN_W && n.height >= CAND_MIN_H);
  const sel = cands.map((n) => ({ seq: n.seq, file: n.file, keep: true }));
  mkdirSync(join(dir, "review"), { recursive: true });
  writeFileSync(join(dir, "review", "selection.json"), JSON.stringify(sel, null, 1), "utf8");
  writeFileSync(join(dir, "review", "index.html"), reviewHTML(sel, nodes), "utf8");
  return cands.length;
}

function reviewHTML(sel, nodes) {
  const bySeq = new Map(nodes.map((n) => [n.seq, n]));
  const cards = sel.map((s, i) => {
    const n = bySeq.get(s.seq);
    const cap = n?.caption_text || "";
    const phone = n?.phone ? `<br>โทร: ${esc(n.phone)}` : "";
    return `<figure><img src="../${s.file}" loading="lazy"><figcaption>#${i} seq=${s.seq} ${s.file.split("/").pop()}${cap ? `<br><b>${esc(cap)}</b>` : ""}${phone}<br><label><input type="checkbox" data-i="${i}" checked> เก็บ (รูปคนชัด)</label></figcaption></figure>`;
  }).join("\n");
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
  // keep people.json in sync with pruned images
  const peoplePath = join(dir, "people.json");
  if (existsSync(peoplePath)) {
    try {
      const people = JSON.parse(readFileSync(peoplePath, "utf8"));
      const pruned = people.filter((p) => keep.has(p.seq));
      pruned.forEach((p, idx) => { p.order = idx + 1; });
      writeFileSync(peoplePath, JSON.stringify(pruned, null, 1), "utf8");
      cj.manifest.counts.people = pruned.length;
      writeFileSync(cjPath, JSON.stringify(cj, null, 1), "utf8");
    } catch { /* keep content.json as-is on people.json parse error */ }
  }
  console.log(`finalized ${dir}: kept ${cj.manifest.counts.image} images, removed ${removed}`);
}

function writeSummary(outDir, results) {
  const summary = { generated_at: new Date().toISOString(), extractor_version: VERSION,
    total: results.length,
    ok: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    results };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1), "utf8");
  for (const r of results) {
    if (r.error) console.log(`FAIL ${r.url} :: ${r.error}`);
    else console.log(`OK ${r.url} -> ${r.dir}`);
  }
  console.log(`summary: ${join(outDir, "summary.json")}`);
  return summary;
}

// ---------- CLI dispatch ----------
if (argv[0] === "--finalize") {
  if (!argv[1]) fail("usage: node backup-page.mjs --finalize <outdir>");
  finalize(argv[1]);
  process.exit(0);
}

const isProbe = has("--probe");
const isRun = has("--run");
const fromFile = opt("--from", null);
// page sections: explicit --page-sections file wins, else sections.json next to --from file
import { dirname as _dirname } from "node:path";
let pageSections = {};
const _secFile = opt("--page-sections", null) || (fromFile && !basename(fromFile).startsWith("picked-") ? join(_dirname(fromFile), "sections.json") : null);
if (_secFile && existsSync(_secFile)) {
  try { pageSections = JSON.parse(readFileSync(_secFile, "utf8")); }
  catch { fail(`cannot parse ${_secFile}`); }
  console.log(`page sections: ${Object.keys(pageSections).filter((k) => !k.startsWith("_")).length} rules from ${_secFile}`);
}
const pageSectionFor = (url) => {
  for (const [sub, sec] of Object.entries(pageSections)) {
    if (sub.startsWith("_")) continue;
    if (url.includes(sub)) return sec;
  }
  return null;
};
if (isProbe && isRun) fail("use either --probe or --run, not both");
if (isRun && !fromFile) fail("usage: node backup-page.mjs --run --from <picked-links.json>");

let urlList = [];
let pickedLinks = null; // for --run
if (fromFile) {
  if (isRun && basename(fromFile).startsWith("picked-")) {
    try { pickedLinks = JSON.parse(readFileSync(fromFile, "utf8")); }
    catch (e) { fail(`cannot read picked file ${fromFile}: ${e.message}`); }
    urlList = pickedLinks.filter((p) => p.keep !== false).map((p) => p.url).filter(Boolean);
    if (!urlList.length) fail("picked file has 0 kept urls");
  } else {
    urlList = readUrlList(fromFile);
    if (!urlList.length) fail(`no urls in ${fromFile}`);
  }
} else {
  const positionals = argv.filter((a) => !a.startsWith("--") && a !== opt("--out", null) && a !== opt("--port", null) && a !== opt("--timeout", null));
  // filter out option values
  const optVals = new Set([OUT, String(PORT), String(TIMEOUT_S)]);
  const urls = [];
  let skipNext = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (skipNext) { skipNext = false; continue; }
    if (["--out", "--port", "--timeout", "--from"].includes(a)) { skipNext = true; continue; }
    if (a.startsWith("--")) continue;
    const u = normalizeUrl(a);
    if (u) urls.push(u);
  }
  void optVals; void positionals;
  urlList = [...new Set(urls)];
  if (!urlList.length) usage();
}

const pickedSeqMap = new Map(); // url -> Set(seq)
if (isRun && pickedLinks) {
  const stagingRoot = join(OUT, STAGING);
  for (const p of pickedLinks) {
    if (p.keep === false) continue;
    const slug = p.slug || slugBaseOf(p.url);
    const cand = join(stagingRoot, slug, "picked-images.json");
    if (!existsSync(cand)) continue; // no per-image filter = keep all
    try {
      const arr = JSON.parse(readFileSync(cand, "utf8"));
      pickedSeqMap.set(p.url, new Set(arr.filter((x) => x.keep).map((x) => x.seq)));
    } catch { /* keep all on parse error */ }
  }
}

mkdirSync(OUT, { recursive: true });
await ensureChrome();
const results = [];
for (const url of urlList) {
  const target = await cdp("/json/new?about:blank", "PUT").catch((e) => ({ _err: String(e.message || e) }));
  if (target._err) { results.push({ url, error: `cdp new target: ${target._err}` }); continue; }
  const c = client(target.webSocketDebuggerUrl);
  try {
    await c.open();
    const timeoutMs = Math.max(5000, TIMEOUT_S * 1000);
    if (isProbe) {
      const probe = await probeOne(c, url, timeoutMs);
      results.push({ url, slug: probe.slug, dir: join(OUT, STAGING, probe.slug), title: probe.source_title, counts: probe.counts, images: probe.images.length });
    } else {
      const filter = pickedSeqMap.get(url) || null;
      const r = await scrapeOne(c, url, timeoutMs, filter);
      results.push({ url, slug: r.slug, dir: r.dir, title: r.title, counts: r.manifest.counts, candidates: r.nCands, people: r.nPeople });
      if (urlList.length === 1 && !fromFile) {
        console.log(r.dir);
        console.log(`review: ${r.nCands} candidates in review/ — open review/index.html, tick people photos, save selection.json, then: node backup-page.mjs --finalize ${r.dir}`);
      }
    }
  } catch (e) {
    results.push({ url, error: String(e.message || e).slice(0, 200) });
  } finally {
    try { c.close(); } catch { /* noop */ }
    await cdp(`/json/close/${target.id}`, "PUT").catch(() => null);
  }
}

if (isProbe) {
  mkdirSync(join(OUT, STAGING), { recursive: true });
  const probes = results.map((r) => r.error
    ? { source_url: r.url, slug: slugBaseOf(r.url), error: r.error }
    : JSON.parse(readFileSync(join(OUT, STAGING, r.slug, "probe.json"), "utf8")));
  writeFileSync(join(OUT, STAGING, "picked-links.json"),
    JSON.stringify(results.map((r) => ({ url: r.url, slug: r.slug || slugBaseOf(r.url), keep: !r.error })), null, 1), "utf8");
  writeFileSync(join(OUT, STAGING, "pick-links.html"), pickLinksHTML(probes), "utf8");
  console.log(`probe done: open ${join(OUT, STAGING, "pick-links.html")} — tick links, save picked-links.json, then open each pick-images.html`);
}
if (fromFile || urlList.length > 1) writeSummary(isProbe ? join(OUT, STAGING) : OUT, results);
if (results.some((r) => r.error)) process.exitCode = 1;
