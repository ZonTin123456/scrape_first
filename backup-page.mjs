#!/usr/bin/env node
// backup-page: backup Thai local-gov pages via Chrome CDP. Implements SPEC.md + multi/probe extensions.
// Usage:
//   node backup-page.mjs <url> [--out ./out] [--port auto] [--timeout 60] [--via auto] [--cf-wait 60]
//   node backup-page.mjs <url1> <url2> ...            (direct multi, sequential)
//   node backup-page.mjs --from urls.txt              (direct multi from file)
//   node backup-page.mjs --probe --from urls.txt      (phase 1: metadata only, no image bytes)
//   node backup-page.mjs --run --from picked-links.json
//   node backup-page.mjs --finalize <outdir>
// Needs: Node 18+, Chrome (uses running headed instance via --port auto 9333->9444->9222, else launches headless).
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
  console.log("Usage: node backup-page.mjs <url> [--out ./out] [--port auto] [--timeout 60] [--via auto] [--cf-wait 60] [--no-cf-manual]");
  console.log("       node backup-page.mjs <url1> <url2> ... [--out ./out]");
  console.log("       node backup-page.mjs --from urls.txt [--out ./out] [--port auto] [--timeout 60] [--page-sections sections.json]");
  console.log("       node backup-page.mjs --probe --from urls.txt [--out ./out] [--port auto]");
  console.log("       node backup-page.mjs --run --from picked-links.json [--out ./out] [--port auto]");
  console.log("       node backup-page.mjs --finalize <outdir>");
  console.log("       node backup-page.mjs --apply-master <master.json> [--out ./out]");
  console.log("  --port auto scans 9333 -> 9444 -> 9222 (explicit port still works)");
  console.log("  --via auto|cdp|fetch (default auto; cdp forced on Cloudflare/403)");
  console.log("  --cf-wait <sec> auto-wait for challenge; then pause for manual solve unless --no-cf-manual");
  process.exit(2);
}
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage();
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const fail = (msg) => { console.error("backup-page: " + msg); process.exit(1); };
const OUT = opt("--out", "./out");
const PORT_RAW = opt("--port", "auto");
let PORT = PORT_RAW === "auto" ? 0 : Number(PORT_RAW);
const TIMEOUT_S = Number(opt("--timeout", "60"));
const VIA_RAW = String(opt("--via", "auto")).toLowerCase();
const VIA = ["auto", "cdp", "fetch"].includes(VIA_RAW) ? VIA_RAW : fail(`bad --via ${VIA_RAW} (want auto|cdp|fetch)`);
const CF_WAIT_S = (() => { const n = Number(opt("--cf-wait", "60")); return Number.isFinite(n) && n >= 0 ? n : 60; })();
const CF_MANUAL = !has("--no-cf-manual"); // pause for manual Turnstile solve when challenge persists

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
// caption = next 2 non-phone texts (name, position). phone = first tel:-flagged
// (or phone-pattern) text in the same run. extras = every trailing text after
// those (until the next image/placeholder/iframe), minus junk tails, joined
// with <br> into note for the backend detail field. section = nearest preceding H1-H3.
const PHONE_RE = /^[+\d][\d\s\-().]{7,}$/;
const isPhoneText = (t) => {
  if (!t || !PHONE_RE.test(t)) return false;
  return (t.replace(/\D/g, "").length >= 9);
};
// section priority: H1-H3 heading > --page-sections url override > division context > position inference > page fallback
const SEC_FROM_POSITION = [
  [/สภา/, "สภาท้องถิ่น"],
  [/นายก|รองนายก|เลขานุการนายก|ที่ปรึกษา/, "คณะผู้บริหาร"],
  [/ปลัด|รองปลัด|หัวหน้า|ผู้อำนวยการ|นัก|เจ้าพนักงาน|พนักงาน|ลูกจ้าง|ข้าราชการ|คนงาน|แม่บ้าน|ภารโรง|ประจำ|ผู้ช่วย|เจ้าหน้าที่|พนักงานจ้าง/, "พนักงานส่วนท้องถิ่น"],
];
// division header: สำนัก/กอง/ฝ่าย/แผนก/งาน + short name (section context for following images)
const VACANT_RE = /^(ว่าง|.*ว่าง.*|ไม่มีผู้ดำรงตำแหน่ง)$/;
// junk-only tails (punct separators, widget tails): extras stop here.
const JUNK_TEXT_RE = /^[\s.,·•\-–—_|/\\:;…!?()[\]{}"']+$/;
const isJunkText = (t) => {
  const s = String(t || "").trim();
  return s.length < 2 || JUNK_TEXT_RE.test(s);
};
const isDivisionText = (t) => {
  if (!t) return false;
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 30) return false;
  return /^(สำนัก|กอง|ฝ่าย|แผนก|งาน)\S*( .{1,24})?$/.test(s);
};
function inferSection(position, name) {
  const t = `${position || ""} ${name || ""}`;
  for (const [re, sec] of SEC_FROM_POSITION) if (re.test(t)) return sec;
  return null;
}
function attachCaptions(kept, pageSection = null) {
  let lastHeading = null, lastDivision = null;
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (n.type === "text") {
      if (n.h && (n.h === "H1" || n.h === "H2" || n.h === "H3") && !n.chrome) lastHeading = n.text;
      // division headers are plain texts, not menu links
      if (!n.chrome && !n.link && isDivisionText(n.text)) lastDivision = n.text.replace(/\s+/g, " ").trim();
      continue;
    }
    if (n.type !== "image") continue;
    const texts = [];
    for (let j = i + 1; j < kept.length; j++) {
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
    // extras: trailing texts after the caption lines + phone, in DOM order.
    // Stops at the first junk-only tail (punct separators, widget tails).
    const extras = [];
    {
      let seenCap = 0;
      for (const m of texts) {
        if (phone !== null && m.text === phone) continue;
        if (seenCap < n.caption_next.length) { seenCap++; continue; }
        if (isJunkText(m.text)) break;
        extras.push(m.text);
      }
    }
    n.note = extras.length ? extras.join("<br>") : null;
    // header graphic? (division name as caption, no position/phone)
    const headName = n.caption_next[0];
    if (headName && !n.caption_next[1] && !phone && isDivisionText(headName)) {
      n.likely_header = true;
      lastDivision = headName;
    }
    if (VACANT_RE.test(n.caption_next[0] || "")) n.vacant = true;
    if (lastHeading) { n.section = lastHeading; n.section_from = "heading"; }
    else if (pageSection) { n.section = pageSection; n.section_from = "url"; }
    else if (lastDivision && !n.likely_header) { n.section = lastDivision; n.section_from = "division"; }
    else {
      const inferred = inferSection(n.caption_next[1], n.caption_next[0]);
      n.section = inferred; n.section_from = inferred ? "position" : null;
    }
    if (n.likely_header && !n.section) { n.section = lastDivision; n.section_from = "division"; }
  }
  // guarantee: every named image leaves with a section (first section seen on page)
  let pageFallback = null;
  for (const n of kept) { if (n.type === "image" && n.section) { pageFallback = n.section; break; } }
  if (pageFallback) {
    for (const n of kept) {
      if (n.type === "image" && !n.section && n.caption_next?.[0]) {
        n.section = pageFallback; n.section_from = "page";
      }
    }
  }
  return kept;
}
// Personnel records for the Playwright uploader: [{photo, name, position, phone, section, order, ...}]
function buildPeople(kept, url, photoKey) {
  const imgs = kept.filter((n) => n.type === "image");
  return imgs.map((n, idx) => ({
    seq: n.seq,
    order: idx, // 0-based DOM sequence: backend ตำแหน่งภาพ starts at 0
    photo: (photoKey === "file" ? (n.file || n.src || null) : (n.src || null)),
    name: n.caption_next?.[0] || null,
    position: n.caption_next?.[1] || null,
    phone: n.phone || null,
    note: n.note || null,
    section: n.section || null, section_from: n.section_from || null,
    likely_header: !!n.likely_header, vacant: !!n.vacant,
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
async function cdpAlive(p) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`);
    return r.ok;
  } catch { return false; }
}
async function warnIfHeadless() {
  try {
    const v = await cdp("/json/version");
    if (/headless/i.test(`${v.Browser || ""} ${v["User-Agent"] || ""}`))
      console.error("backup-page: warning: connected Chrome looks headless — Cloudflare may block; prefer headed Chrome on :9333");
  } catch { /* version probe is best-effort */ }
}
async function ensureChrome() {
  // Prefer an already-running (headed, logged-in) Chrome. --port auto scans 9333 -> 9444 -> 9222.
  if (PORT_RAW !== "auto") {
    try { await cdp("/json/version"); await warnIfHeadless(); return; } catch { /* launch below */ }
  } else {
    for (const p of [9333, 9444, 9222]) {
      if (await cdpAlive(p)) {
        PORT = p;
        console.log(`CDP: using 127.0.0.1:${PORT}`);
        await warnIfHeadless();
        return;
      }
    }
    PORT = 9444; // nothing listening: fall through and launch on default
  }
  const cands = [
    process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const bin = cands.find((p) => existsSync(p));
  if (!bin) fail(`no Chrome reachable (scanned 9333/9444/9222) and no chrome.exe found — start headed Chrome: chrome.exe --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir="C:\\tmp\\chrome-cdp-profile"`);
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
      out.push({ t: "text", text, chrome: chromeOf(n), goog: goog(n), h: headOf(n), tel: telOf(n),
        link: !!(p && p.closest && p.closest("a[href]")) });
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
      if (n.link) rec.link = true;
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

// ---------- Cloudflare challenge handling ----------
// Detects IUAM / Turnstile / "Just a moment" walls so we wait (or pause for a
// human to tick the checkbox in the headed Chrome) instead of scraping a wall.
const CF_TITLE_RE = /just a moment|attention required|security check|verifying you|confirm you are human/i;
const CF_BODY_MARKERS = ["verifying you are human", "just a moment", "cf-challenge",
  "turnstile", "attention required", "cf_clearance", "challenge-form"];
const CHALLENGE_PROBE_EXPR = `(() => { try {
    return { title: document.title || "",
      hasTurnstile: !!document.querySelector('iframe[src*="turnstile"],iframe[src*="challenge"],#cf-challenge,#challenge-form,.cf-turnstile'),
      body: (document.body ? document.body.innerText : "").slice(0, 2000) };
  } catch (e) { return { title: "", hasTurnstile: false, body: "" }; } })()`;
function isChallengeProbe(p) {
  if (!p) return false;
  if (CF_TITLE_RE.test(String(p.title || ""))) return true;
  if (p.hasTurnstile) return true;
  const b = String(p.body || "").toLowerCase();
  return CF_BODY_MARKERS.some((m) => b.includes(m));
}
function waitForEnter(msg) {
  return new Promise((res) => {
    process.stdout.write(msg);
    const onData = () => { cleanup(); res(); };
    const cleanup = () => {
      try { process.stdin.removeListener("data", onData); } catch { /* noop */ }
      try { process.stdin.pause(); } catch { /* noop */ }
    };
    try { process.stdin.resume(); process.stdin.setEncoding("utf8"); } catch { /* noop */ }
    process.stdin.once("data", onData);
  });
}
async function probeChallenge(c) {
  try {
    const ev = await c.send("Runtime.evaluate", { expression: CHALLENGE_PROBE_EXPR, returnByValue: true });
    return ev.result?.result?.value || null;
  } catch { return null; }
}
// Polls until the challenge clears. Returns {challenged, stillBlocked}.
// challenged=true if a wall was seen at least once (image path then prefers CDP).
async function waitForChallengeClear(c, url) {
  const budgetMs = Math.max(0, CF_WAIT_S * 1000);
  const t0 = Date.now();
  let challenged = false;
  for (;;) {
    const p = await probeChallenge(c);
    if (!isChallengeProbe(p)) return { challenged, stillBlocked: false };
    challenged = true;
    if (Date.now() - t0 >= budgetMs) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (CF_MANUAL && process.stdin.isTTY) {
    console.error(`backup-page: Cloudflare challenge still up for ${url}`);
    console.error(`backup-page: solve Turnstile/checkbox in the headed Chrome (:${PORT}), keep the tab open, then press Enter here...`);
    await waitForEnter("");
    const t1 = Date.now();
    for (;;) {
      const p = await probeChallenge(c);
      if (!isChallengeProbe(p)) return { challenged: true, stillBlocked: false };
      if (Date.now() - t1 >= 60000) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { challenged: true, stillBlocked: true };
}

async function navigateAndExtract(c, url, timeoutMs) {
  await c.send("Page.enable");
  await c.send("Page.navigate", { url });
  await c.waitEvent("Page.loadEventFired", timeoutMs);
  const cf = await waitForChallengeClear(c, url);
  c._cfChallenge = cf.challenged || false;
  if (cf.stillBlocked)
    throw new Error(`cloudflare challenge not cleared in ${CF_WAIT_S}s (solve Turnstile in Chrome :${PORT}, keep tab open, rerun)`);
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
  const data = ev.result.result.value; // {origin, title, nodes}
  if (CF_TITLE_RE.test(String(data.title || "")) && (data.nodes || []).length < 10)
    throw new Error(`cloudflare wall after extract (${String(data.title).slice(0, 60)}) — solve in Chrome :${PORT} and rerun`);
  return data;
}

async function downloadQueue(c, queue, kept, stats, dir, url, origin) {
  const imgDir = join(dir, "images");
  mkdirSync(imgDir, { recursive: true });
  const forceCdp = VIA === "cdp" || (VIA === "auto" && !!c._cfChallenge);
  if (forceCdp) console.error(`backup-page: image via=cdp (${VIA === "cdp" ? "flag" : "cloudflare wall seen"})`);
  let imgErrors = 0;
  for (const rec of queue) {
    const cdpTry = async () => {
      const g = await cdpFetchImage(c, rec.src).catch((e) => ({ error: String(e.message || e).slice(0, 80) }));
      if (!g.error) { rec.via = "cdp"; return g; }
      return g;
    };
    let got;
    if (VIA === "cdp") {
      got = await cdpTry();
      if (got.error) {
        const f = await fetchBuf(rec.src, url); // last-resort direct fetch
        if (!f.error) { got = f; delete rec.via; }
      }
    } else if (VIA === "fetch") {
      got = await fetchBuf(rec.src, url);
      if (got.error && sameOrigin(rec.src, origin)) {
        const g2 = await cdpTry();
        if (!g2.error) got = g2;
      }
    } else { // auto: direct first (cookies/TLS of node), CDP fallback on block
      got = await fetchBuf(rec.src, url);
      const blocked = !!got.error && /http 40[13]/.test(got.error); // 401/403 incl. Cloudflare
      if (got.error && (sameOrigin(rec.src, origin) || blocked || forceCdp)) {
        const g2 = await cdpTry();
        if (!g2.error) got = g2;
        else if (forceCdp || blocked) got = g2; // keep CDP (in-page cookies) error, it is authoritative
      }
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
      "UTF-8 JSON output", `image retry x${RETRY}`, "caption_next = next 2 non-phone texts", "phone = first tel:/phone-pattern text in run", "note = trailing texts joined with <br> (junk tails cut)", "order = 0-based DOM sequence", "section = H1-H3 heading > --page-sections url > position inference", `slug unique (${slug})`,
      `image via ${VIA}${c._cfChallenge ? " (cf-challenge seen: cdp forced)" : ""}`, `cf-wait ${CF_WAIT_S}s${CF_MANUAL ? "+manual" : ""}`, `cdp :${PORT}`] };
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
    phone: n.phone || null, note: n.note || null, section: n.section || null, section_from: n.section_from || null,
    likely_header: !!n.likely_header, vacant: !!n.vacant,
  }));
  const probe = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
    extractor_version: VERSION, slug, counts: { ...stats, people: buildPeople(kept, url, "src").length }, images,
    people_preview: buildPeople(kept, url, "src").slice(0, 5),
    texts_preview: kept.filter((n) => n.type === "text").slice(0, 8).map((n) => n.text) };
  writeFileSync(join(stageDir, "probe.json"), JSON.stringify(probe, null, 1), "utf8");
  // default picked-images: keep everything with a name; untick header graphics and nameless icons
  // (vacant seats have names like ว่าง and are kept — untick manually to drop)
  writeFileSync(join(stageDir, "picked-images.json"),
    JSON.stringify(images.map((im) => ({ seq: im.seq, src: im.src, keep: !!(im.name && !im.likely_header) })), null, 1), "utf8");
  writeFileSync(join(stageDir, "pick-images.html"), pickImagesHTML(url, title, slug, images), "utf8");
  return probe;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// File Picker buttons (no server needed — pages open straight from disk):
// "เปิดไฟล์เดิม" loads ticks from a JSON file into the checkboxes,
// "บันทึกทับไฟล์เดิม" writes ticks back (picker once per session, then 1 click).
// Each page must define collect() -> array and applyTicks(arr). Unsupported
// browsers hide these buttons; the download button still works.
function filePickerBtn(suggestedName) {
  return `<button id="fp-open">เปิดไฟล์เดิม</button>
<button id="fp-save">บันทึกทับไฟล์เดิม</button> <span id="fp-msg"></span>
<script>let fpHandle=null;
const fpMsg=(t)=>{document.getElementById("fp-msg").textContent=t;};
if(!("showSaveFilePicker" in window)){document.getElementById("fp-open").style.display="none";document.getElementById("fp-save").style.display="none";}
async function fpWrite(h,data){
  const w=await h.createWritable();await w.write(JSON.stringify(data,null,1));await w.close();
}
document.getElementById("fp-open").onclick=async()=>{
  try{
    const [h]=await window.showOpenFilePicker({types:[{description:"JSON",accept:{"application/json":[".json"]}}]});
    const t=await (await h.getFile()).text();applyTicks(JSON.parse(t));fpHandle=h;fpMsg("โหลดแล้ว แก้ไขต่อได้เลย");
  }catch(e){ if(e&&e.name!=="AbortError") fpMsg("เปิดไม่ได้: "+(e.message||e)); }
};
document.getElementById("fp-save").onclick=async()=>{
  try{
    if(!fpHandle) fpHandle=await window.showSaveFilePicker({suggestedName:${JSON.stringify(suggestedName)},types:[{description:"JSON",accept:{"application/json":[".json"]}}]});
    await fpWrite(fpHandle,collect());fpMsg("บันทึกแล้ว");
  }catch(e){ if(e&&e.name!=="AbortError") fpMsg("บันทึกไม่ได้: "+(e.message||e)+" — ใช้ปุ่มดาวน์โหลดแทน"); }
};</script>`;
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
<button id="save">ดาวน์โหลด picked-links.json</button>
${filePickerBtn("picked-links.json")}
<p>ติ๊กเสร็จกด “บันทึกทับไฟล์เดิม” (เลือก <code>${STAGING}/picked-links.json</code> ครั้งเดียว) จากนั้นรัน <code>node backup-page.mjs --run --from ${STAGING}/picked-links.json</code></p>
<table><tr><th>เอา</th><th>เว็บ</th><th>รูป</th></tr>${rows}</table>
<script>const META=${JSON.stringify(probes.map((p) => ({ url: p.source_url, slug: p.slug })))};
function collect(){
  const boxes=[...document.querySelectorAll("input[data-i]")];
  return boxes.map(c=>({url:META[+c.dataset.i].url,slug:META[+c.dataset.i].slug,keep:c.checked}));
}
function applyTicks(arr){
  const byUrl=new Map((arr||[]).map(e=>[e.url,!!e.keep]));
  document.querySelectorAll("input[data-i]").forEach(c=>{const u=META[+c.dataset.i].url;if(byUrl.has(u))c.checked=byUrl.get(u);});
}
document.getElementById("save").onclick=()=>{
  const out=collect();
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="picked-links.json";a.click();
};</script>`;
}

function pickImagesHTML(url, title, slug, images) {
  const cards = images.map((im, i) => {
    const who = [im.name, im.position].filter(Boolean).join(" | ") || im.alt || "(ไม่มีชื่อใต้รูป)";
    const extra = [im.section ? `แผนก: ${esc(im.section)}` : "", im.phone ? `โทร: ${esc(im.phone)}` : ""].filter(Boolean).join("<br>");
    const noteLine = im.note ? `<br><small>${String(im.note).split("<br>").map(esc).join("<br>")}</small>` : "";
    const flag = im.likely_header ? "<br><i>ป้ายแผนก (ข้ามอัตโนมัติ)</i>" : im.vacant ? "<br><i>เก้าอี้ว่าง</i>" : (!im.name ? "<br><i>ไม่มีชื่อ</i>" : "");
    const checked = (im.likely_header || !im.name) ? "" : "checked";
    return `<figure><img src="${esc(im.src)}" loading="lazy" onerror="this.outerHTML='<div style=\\'padding:20px;background:#eee\\'>โหลดพรีวิวไม่ได้<br>${im.width}x${im.height}</div>'">`
    + `<figcaption>#${i} seq=${im.seq} ${im.width}x${im.height}<br><b>${esc(who)}</b>${extra ? `<br>${extra}` : ""}${noteLine}${flag}`
    + `<br><label><input type="checkbox" data-seq="${im.seq}" ${checked}> โหลดรูปนี้</label></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>เลือกรูป — ${esc(title)}</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px;border:1px solid #ddd;padding:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ชั้น 2 — ติ๊กรูปที่จะโหลด (${images.length} รูป)</h2>
<p>${esc(title)}<br><small>${esc(url)}</small></p>
<button id="save">ดาวน์โหลด picked-images.json</button>
${filePickerBtn("picked-images.json")}
<p>ติ๊กเสร็จกด “บันทึกทับไฟล์เดิม” (เลือก <code>${STAGING}/${esc(slug)}/picked-images.json</code> ครั้งเดียว)</p>
<div>${cards || "<p>ไม่มีรูปให้เลือก</p>"}</div>
<script>function collect(){
  return [...document.querySelectorAll("input[data-seq]")].map(c=>({seq:+c.dataset.seq,src:c.closest("figure").querySelector("img")?.getAttribute("src")||"",keep:c.checked}));
}
function applyTicks(arr){
  const bySeq=new Map((arr||[]).map(e=>[+e.seq,!!e.keep]));
  document.querySelectorAll("input[data-seq]").forEach(c=>{if(bySeq.has(+c.dataset.seq))c.checked=bySeq.get(+c.dataset.seq);});
}
document.getElementById("save").onclick=()=>{
  const out=collect();
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="picked-images.json";a.click();
};</script>`;
}

// --- master pick: one tick for images shared across all probed pages ---
// Groups probe images by absolute src (seq differs per page). Tick once here,
// save master.json, then --apply-master fans decisions out to every
// staging/<slug>/picked-images.json by src match.
function buildMasterGroups(probes) {
  const bySrc = new Map();
  for (const p of probes) {
    for (const im of (p.images || [])) {
      if (!im.src) continue;
      let g = bySrc.get(im.src);
      if (!g) {
        g = { src: im.src, width: im.width, height: im.height,
          names: new Set(), positions: new Set(), pages: [], anyNamed: false };
        bySrc.set(im.src, g);
      }
      if (im.name) g.names.add(im.name);
      if (im.position) g.positions.add(im.position);
      if (im.name && !im.likely_header) g.anyNamed = true;
      if (!g.pages.includes(p.slug)) g.pages.push(p.slug);
    }
  }
  return [...bySrc.values()]
    .map((g) => ({ src: g.src, width: g.width, height: g.height,
      names: [...g.names], positions: [...g.positions], pages: g.pages, keep: g.anyNamed }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

function masterPickHTML(groups, pages) {
  const cards = groups.map((g) => {
    const who = g.names.slice(0, 2).join(" | ") || "(ไม่มีชื่อใต้รูป)";
    const pg = `${g.pages.length} หน้า: ${g.pages.join(", ")}`;
    return `<figure><img src="${esc(g.src)}" loading="lazy" onerror="this.outerHTML='<div style=\\'padding:20px;background:#eee\\'>โหลดพรีวิวไม่ได้</div>'">`
    + `<figcaption>${g.width}x${g.height}<br><b>${esc(who)}</b><br><small>${esc(pg)}</small>`
    + `<br><label><input type="checkbox" data-src="${esc(g.src)}" ${g.keep ? "checked" : ""}> โหลดรูปนี้ทุกหน้า</label></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ติ๊กรวม — รูปซ้ำทุกหน้า (${groups.length} รูป / ${pages.length} หน้า)</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px;border:1px solid #ddd;padding:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ติ๊กรวม — ติ๊กครั้งเดียวใช้ทุกหน้า (${groups.length} รูป / ${pages.length} หน้า)</h2>
<button id="save">ดาวน์โหลด master.json</button>
${filePickerBtn("master.json")}
<p>ติ๊กเสร็จกด “บันทึกทับไฟล์เดิม” (เลือก <code>${STAGING}/master.json</code> ครั้งเดียว) จากนั้นรัน <code>node backup-page.mjs --apply-master &lt;master.json&gt;</code></p>
<div>${cards || "<p>ไม่มีรูป</p>"}</div>
<script>const META_PAGES=${JSON.stringify(pages)};
function collect(){
  return {generated_at:new Date().toISOString(),pages:META_PAGES,
    decisions:[...document.querySelectorAll("input[data-src]")].map(c=>({src:c.dataset.src,keep:c.checked}))};
}
function applyTicks(m){
  const bySrc=new Map(((m&&m.decisions)||[]).map(e=>[e.src,!!e.keep]));
  document.querySelectorAll("input[data-src]").forEach(c=>{if(bySrc.has(c.dataset.src))c.checked=bySrc.get(c.dataset.src);});
}
document.getElementById("save").onclick=()=>{
  const out=collect();
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="master.json";a.click();
};</script>`;
}

function applyMaster(masterPath) {
  let m;
  try { m = JSON.parse(readFileSync(masterPath, "utf8")); }
  catch (e) { fail(`cannot read master file ${masterPath}: ${e.message}`); }
  const decisions = new Map((m.decisions || []).map((d) => [d.src, !!d.keep]));
  if (!decisions.size) { console.log("apply-master: 0 decisions — nothing to do"); return; }
  let slugs = (m.pages || []).map((p) => p.slug).filter(Boolean);
  if (!slugs.length) {
    const st = join(OUT, STAGING);
    try {
      for (const d of readdirSync(st)) {
        if (existsSync(join(st, d, "picked-images.json"))) slugs.push(d);
      }
    } catch { /* staging unreadable */ }
  }
  slugs = [...new Set(slugs)];
  if (!slugs.length) fail("no pages found (master has no pages list and staging is empty)");
  let totalUp = 0, totalKeep = 0;
  for (const slug of slugs) {
    const fp = join(OUT, STAGING, slug, "picked-images.json");
    if (!existsSync(fp)) { console.log(`apply-master: skip ${slug} (no picked-images.json)`); continue; }
    let arr;
    try { arr = JSON.parse(readFileSync(fp, "utf8")); }
    catch { console.log(`apply-master: skip ${slug} (unreadable)`); continue; }
    let up = 0, keep = 0;
    for (const e of arr) {
      if (e && typeof e.src === "string" && decisions.has(e.src)) { e.keep = decisions.get(e.src); up++; }
      if (e && e.keep) keep++;
    }
    writeFileSync(fp, JSON.stringify(arr, null, 1), "utf8");
    totalUp += up; totalKeep += keep;
    console.log(`apply-master: ${slug}: ${up} updated, ${keep}/${arr.length} kept`);
  }
  console.log(`apply-master: done — ${totalUp} entries updated, ${totalKeep} kept total`);
}

// --- people shortlist: human picks which candidate photos to keep ---
function writeReview(dir, nodes) {
  const cands = nodes.filter((n) => n.type === "image" && n.file && n.width >= CAND_MIN_W && n.height >= CAND_MIN_H);
  const sel = cands.map((n) => ({ seq: n.seq, file: n.file, keep: true }));
  mkdirSync(join(dir, "review"), { recursive: true });
  writeFileSync(join(dir, "review", "selection.json"), JSON.stringify(sel, null, 1), "utf8");
  writeFileSync(join(dir, "review", "index.html"), reviewHTML(sel, nodes, basename(dir)), "utf8");
  return cands.length;
}

function reviewHTML(sel, nodes, slug) {
  const bySeq = new Map(nodes.map((n) => [n.seq, n]));
  const cards = sel.map((s, i) => {
    const n = bySeq.get(s.seq);
    const cap = n?.caption_text || "";
    const phone = n?.phone ? `<br>โทร: ${esc(n.phone)}` : "";
    const noteLine = n?.note ? `<br><small>${String(n.note).split("<br>").map(esc).join("<br>")}</small>` : "";
    return `<figure><img src="../${s.file}" loading="lazy"><figcaption>#${i} seq=${s.seq} ${s.file.split("/").pop()}${cap ? `<br><b>${esc(cap)}</b>` : ""}${phone}${noteLine}<br><label><input type="checkbox" data-seq="${s.seq}" data-file="${esc(s.file)}" checked> เก็บ (รูปคนชัด)</label></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>เลือกรูปคน — ติ๊กเฉพาะรูปที่เอา</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ติ๊กเฉพาะรูปคนชัดที่ต้องการเก็บ (${sel.length} รูป)</h2>
<button id="save">ดาวน์โหลด selection.json</button>
${filePickerBtn("selection.json")}
<p>ติ๊กเสร็จกด “บันทึกทับไฟล์เดิม” (เลือก <code>review/selection.json</code> ครั้งเดียว) แล้วรัน <code>node backup-page.mjs --finalize &lt;โฟลเดอร์&gt;</code></p>
<div>${cards}</div>
<script>function collect(){
  return [...document.querySelectorAll("input[data-seq]")].map(c=>({seq:+c.dataset.seq,file:c.dataset.file,keep:c.checked}));
}
function applyTicks(arr){
  const bySeq=new Map((arr||[]).map(e=>[+e.seq,!!e.keep]));
  document.querySelectorAll("input[data-seq]").forEach(c=>{if(bySeq.has(+c.dataset.seq))c.checked=bySeq.get(+c.dataset.seq);});
}
document.getElementById("save").onclick=()=>{
  const out=collect();
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
      pruned.forEach((p, idx) => { p.order = idx; });
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
if (argv[0] === "--apply-master") {
  if (!argv[1]) fail("usage: node backup-page.mjs --apply-master <master.json> [--out ./out]");
  applyMaster(argv[1]);
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
  const optVals = new Set([OUT, String(PORT_RAW), String(TIMEOUT_S), VIA_RAW, String(CF_WAIT_S)]);
  const urls = [];
  let skipNext = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (skipNext) { skipNext = false; continue; }
    if (["--out", "--port", "--timeout", "--from", "--via", "--cf-wait", "--page-sections"].includes(a)) { skipNext = true; continue; }
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
  const okProbes = probes.filter((p) => !p.error);
  const masterGroups = buildMasterGroups(okProbes);
  const masterPages = okProbes.map((p) => ({ slug: p.slug, url: p.source_url }));
  writeFileSync(join(OUT, STAGING, "master.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), extractor_version: VERSION,
      pages: masterPages, decisions: masterGroups.map((g) => ({ src: g.src, keep: g.keep })) }, null, 1), "utf8");
  writeFileSync(join(OUT, STAGING, "master-pick.html"), masterPickHTML(masterGroups, masterPages), "utf8");
  console.log(`probe done: open ${join(OUT, STAGING, "master-pick.html")} — tick once for all pages, save master.json, then: node backup-page.mjs --apply-master <master.json>`);
}
if (fromFile || urlList.length > 1) writeSummary(isProbe ? join(OUT, STAGING) : OUT, results);
if (results.some((r) => r.error)) process.exitCode = 1;
