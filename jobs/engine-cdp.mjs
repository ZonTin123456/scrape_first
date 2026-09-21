// jobs/engine-cdp.mjs — importable CDP engine for the UI job path.
// Lifted (parameterized) from the CLI engine operations in backup-page.mjs
// (probeOne/scrapeOne/navigateAndExtract/downloadQueue/CF helpers/staging
// writers) and uploader/detect.mjs (ephemeral automap discovery). CLI files
// are byte-identical and keep their own copies; this module is the Wrapped
// job-ops side of the reuse boundary: UI imports Wrapped cores, never CLI
// entries. Only node builtins + services/* + uploader/lib/* (both importable,
// no argv dispatch) + jobs/review.mjs (selection semantics).
//
// Differences vs CLI (all deliberate, fail-closed on the server path):
// - No module globals: port/outDir/via/cfWait/sections are parameters.
// - No stdin pause: a persistent challenge throws `cloudflare-blocked` after
//   the auto-wait budget (operator solves in headed Chrome, UI Retry reruns).
// - No Chrome auto-launch: unreacahble CDP throws `cdp-unreachable` (the
//   workspace targets an external headed Chrome; the server never spawns).
// - No console output: progress flows via the injected emit(type, payload).
// - Aggregates (picked-links/master/summary) merge by key instead of CLI
//   overwrite, so sequential jobs sharing global staging do not clobber each
//   other. CLI overwrite behavior is unchanged (CLI keeps its own code).
// - Legacy human HTML files are written like CLI (same builders, lifted
//   verbatim) so on-disk staging stays identical for both paths.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  attachCaptions,
  buildKept,
  buildPeople,
  slugBaseOf,
  MIN_PX,
} from "../services/sectioning.mjs";
import { automap, loadProfiles } from "../uploader/lib/automap.mjs";
import { discoverBackends, resolvePort } from "../uploader/lib/cdp-port.mjs";
import { buildInitialSelection } from "./review.mjs";

// Manifest parity value with the CLI engine (backup-page.mjs VERSION).
// Not pinned by tests; kept equal so reports are indistinguishable.
export const ENGINE_VERSION = "1.3.0";
const RETRY = 2;
const STAGING = "_staging";

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  throw e;
}

function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n", "utf8");
  renameSync(tmp, path);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------- Cloudflare challenge handling (lifted verbatim, no stdin) ----------
// Includes Thai-localized wall text (bot-check pages render Thai): a wall
// must fail closed (cloudflare-blocked + blocker + UI Retry), never scrape as
// content. CLI keeps its own copy unchanged.
const CF_TITLE_RE = /just a moment|attention required|security check|verifying you|confirm you are human|รอสักครู่/i;
const CF_BODY_MARKERS = ["verifying you are human", "just a moment", "cf-challenge",
  "turnstile", "attention required", "cf_clearance", "challenge-form",
  "กำลังทำการตรวจสอบความปลอดภัย", "ตรวจสอบว่าคุณไม่ใช่บอต"];
const CHALLENGE_PROBE_EXPR = `(() => { try {
    return { title: document.title || "",
      hasTurnstile: !!document.querySelector('iframe[src*="turnstile"],iframe[src*="challenge"],#cf-challenge,#challenge-form,.cf-turnstile'),
      body: (document.body ? document.body.innerText : "").slice(0, 2000) };
  } catch (e) { return { title: "", hasTurnstile: false, body: "" }; } })()`;
export function isChallengeProbe(p) {
  if (!p) return false;
  if (CF_TITLE_RE.test(String(p.title || ""))) return true;
  if (p.hasTurnstile) return true;
  const b = String(p.body || "").toLowerCase();
  return CF_BODY_MARKERS.some((m) => b.includes(m));
}

async function probeChallenge(c) {
  try {
    const ev = await c.send("Runtime.evaluate", { expression: CHALLENGE_PROBE_EXPR, returnByValue: true });
    return ev.result?.result?.value || null;
  } catch { return null; }
}

// Polls until the challenge clears. Returns {challenged}. A persistent wall
// throws `cloudflare-blocked` (fail-closed: blocker + UI Retry reruns).
async function waitForChallengeClear(c, url, { cfWaitS = 60, emit = null } = {}) {
  const budgetMs = Math.max(0, cfWaitS * 1000);
  const t0 = Date.now();
  let challenged = false;
  let seenEmitted = false;
  for (;;) {
    const p = await probeChallenge(c);
    if (!isChallengeProbe(p)) {
      if (challenged) {
        try { emit?.("challenge:cleared", { url, elapsedMs: Date.now() - t0 }); } catch { /* emit never breaks engine */ }
      }
      return { challenged };
    }
    challenged = true;
    if (!seenEmitted) {
      seenEmitted = true;
      try { emit?.("challenge:seen", { url, phase: "auto-wait" }); } catch { /* ignore */ }
    }
    if (Date.now() - t0 >= budgetMs) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  try { emit?.("challenge:blocked", { url, reason: "cloudflare challenge not cleared" }); } catch { /* ignore */ }
  fail("cloudflare-blocked", `cloudflare challenge not cleared in ${cfWaitS}s for ${url} (solve Turnstile in headed Chrome, keep the tab open, UI Retry reruns)`, { url });
}

// ---------- CDP transport (lifted, port parameterized) ----------
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

async function cdpHttp(port, path, method = "GET") {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  if (!r.ok) fail("cdp-unreachable", `CDP ${path}: http ${r.status}`, { port });
  return r.json();
}

async function ensurePort(prefer = "auto") {
  try {
    return await resolvePort(prefer ?? "auto");
  } catch (e) {
    fail("cdp-unreachable", e?.message ?? "no CDP found (start headed Chrome with --remote-debugging-port=9333)");
  }
}

async function openCdpPage(port) {
  let target;
  try {
    target = await cdpHttp(port, "/json/new?about:blank", "PUT");
  } catch (e) {
    if (e?.code) throw e;
    fail("cdp-unreachable", `cdp new target: ${String(e?.message ?? e).slice(0, 120)}`, { port });
  }
  const c = client(target.webSocketDebuggerUrl);
  try {
    await c.open();
  } catch (e) {
    await cdpHttp(port, `/json/close/${target.id}`, "PUT").catch(() => null);
    fail("cdp-unreachable", `cdp socket: ${String(e?.message ?? e).slice(0, 120)}`, { port });
  }
  return { c, target };
}

async function closeCdpPage(port, c, target) {
  try { c.close(); } catch { /* noop */ }
  if (target?.id) await cdpHttp(port, `/json/close/${target.id}`, "PUT").catch(() => null);
}

// Minimal page/context shim over raw CDP so the shared automap core runs
// unmodified (it only uses newPage/goto/waitForTimeout/evaluate/close).
export function cdpContext(port) {
  return {
    newPage: async () => {
      const { c, target } = await openCdpPage(port);
      return {
        goto: async (url, { timeout = 30000 } = {}) => {
          await c.send("Page.enable");
          await c.send("Page.navigate", { url });
          await c.waitEvent("Page.loadEventFired", timeout);
        },
        waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
        evaluate: async (fn) => {
          const ev = await c.send("Runtime.evaluate", {
            expression: `(${fn.toString()})()`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (ev.result?.subtype === "error") {
            fail("cdp-error", `evaluate failed: ${String(ev.result?.result?.description ?? "error").slice(0, 120)}`);
          }
          return ev.result?.result?.value;
        },
        close: async () => closeCdpPage(port, c, target),
      };
    },
  };
}

// ---------- DOM extract (EXPR lifted verbatim) ----------
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
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { width: 0, height: 0, top: 0 };
      out.push({ t: "img", src: abs(srcVal || ""),
        w: n.naturalWidth || Math.round(r.width) || 0, h: n.naturalHeight || Math.round(r.height) || 0,
        top: Math.round(r.top + window.scrollY), left: Math.round(r.left || 0),
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

export function extOf(buf, ct, u) {
  const head = buf.slice(0, 512).toString("latin1");
  if (/<svg[\s>]/.test(head)) return "svg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 3).toString() === "GIF") return "gif";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  return ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp"
  : /\.png($|\?)/i.test(u) ? "png" : /\.gif($|\?)/i.test(u) ? "gif" : /\.webp($|\?)/i.test(u) ? "webp" : "jpg";
}

async function navigateAndExtract(c, url, timeoutMs, { cfWaitS = 60, port = null, emit = null } = {}) {
  await c.send("Page.enable");
  await c.send("Page.navigate", { url });
  await c.waitEvent("Page.loadEventFired", timeoutMs);
  const cf = await waitForChallengeClear(c, url, { cfWaitS, emit });
  c._cfChallenge = cf.challenged || false;
  await new Promise((r) => setTimeout(r, 2500));
  await c.send("Runtime.evaluate", { expression:
    `(async () => { const h = () => document.body ? document.body.scrollHeight : 0; const y0 = window.scrollY; for (let y = 0; y < h(); y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }   window.scrollTo(0, y0); await new Promise((r) => setTimeout(r, 800)); return h(); })()`,
    awaitPromise: true, returnByValue: true }).catch(() => null);
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
  if (ev.result?.subtype === "error" || !ev.result?.result?.value) fail("cdp-error", `evaluate failed for ${url}`, { url });
  const data = ev.result.result.value;
  if (CF_TITLE_RE.test(String(data.title || "")) && (data.nodes || []).length < 10) {
    try { emit?.("challenge:blocked", { url, reason: "wall after extract" }); } catch { /* ignore */ }
    fail("cloudflare-blocked", `cloudflare wall after extract (${String(data.title).slice(0, 60)}) — solve in Chrome :${port} and UI Retry reruns`, { url });
  }
  return data;
}

async function downloadQueue(c, queue, kept, stats, dir, url, origin, { via = "auto", cfChallenge = false, emit = null } = {}) {
  const imgDir = join(dir, "images");
  mkdirSync(imgDir, { recursive: true });
  const forceCdp = via === "cdp" || (via === "auto" && !!cfChallenge);
  let imgErrors = 0;
  for (const rec of queue) {
    const cdpTry = async () => {
      const g = await cdpFetchImage(c, rec.src).catch((e) => ({ error: String(e.message || e).slice(0, 80) }));
      if (!g.error) { rec.via = "cdp"; return g; }
      return g;
    };
    let got;
    if (via === "cdp") {
      got = await cdpTry();
      if (got.error) {
        const f = await fetchBuf(rec.src, url);
        if (!f.error) { got = f; delete rec.via; }
      }
    } else if (via === "fetch") {
      got = await fetchBuf(rec.src, url);
      if (got.error && sameOrigin(rec.src, origin)) {
        const g2 = await cdpTry();
        if (!g2.error) got = g2;
      }
    } else {
      got = await fetchBuf(rec.src, url);
      const blocked = !!got.error && /http 40[13]/.test(got.error);
      if (got.error && (sameOrigin(rec.src, origin) || blocked || forceCdp)) {
        const g2 = await cdpTry();
        if (!g2.error) got = g2;
        else if (forceCdp || blocked) got = g2;
      }
    }
    if (got.error) {
      rec.file = null; rec.error = got.error; imgErrors++;
      try { emit?.("scrape:image-failed", { seq: rec.seq, src: rec.src, error: got.error, via: rec.via || via }); } catch { /* ignore */ }
    }
    else {
      if (got.buf.length <= 70) { kept.splice(kept.indexOf(rec), 1); stats.image--; stats.cut++; continue; }
      const file = `images/${String(rec.seq).padStart(4, "0")}-${rec.width}x${rec.height}.${extOf(got.buf, got.ct, rec.src)}`;
      writeFileSync(join(dir, file), got.buf);
      rec.file = file; rec.bytes = got.buf.length;
      try { emit?.("scrape:image-downloaded", { seq: rec.seq, file, byteLength: got.buf.length, via: rec.via || via, url }); } catch { /* ignore */ }
    }
    delete rec.src;
  }
  return imgErrors;
}

// ---------- slug + sections (lifted, outDir parameterized) ----------
function dirSourceUrl(dir, kind) {
  try {
    const p = kind === "probe" ? join(dir, "probe.json") : join(dir, "content.json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return kind === "probe" ? (j.source_url || null) : (j.manifest?.source_url || null);
  } catch { return "unreadable"; }
}

export function resolveSlug(url, outDir) {
  const base = slugBaseOf(url);
  for (let n = 0; n < 100; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const finalDir = join(outDir, slug);
    const stageDir = join(outDir, STAGING, slug);
    const s1 = existsSync(finalDir) ? dirSourceUrl(finalDir, "final") : null;
    const s2 = existsSync(stageDir) ? dirSourceUrl(stageDir, "probe") : null;
    const owner = s1 || s2;
    if (owner === null) return slug;
    if (owner === url) return slug;
  }
  return `${base}-${Date.now()}`;
}

export function loadPageSections() {
  const cand = join(process.cwd(), "sections.json");
  if (existsSync(cand)) {
    try {
      const all = JSON.parse(readFileSync(cand, "utf8"));
      const out = {};
      for (const [k, v] of Object.entries(all || {})) {
        if (k.startsWith("_")) continue;
        out[k] = v;
      }
      return out;
    } catch { /* fall through to empty */ }
  }
  return {};
}

export function pageSectionFor(url, pageSections) {
  for (const [sub, sec] of Object.entries(pageSections || {})) {
    if (sub.startsWith("_")) continue;
    if (url.includes(sub)) return sec;
  }
  return null;
}

// ---------- legacy human HTML builders (lifted verbatim; UI path writes the
// same on-disk staging so CLI file flows keep working) ----------
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

function reviewHTML(sel, nodes, slug) {
  const bySeq = new Map(nodes.map((n) => [n.seq, n]));
  const cards = sel.map((s, i) => {
    const n = bySeq.get(s.seq);
    const cap = n?.caption_text || "";
    const phone = n?.phone ? `<br>โทร: ${esc(n.phone)}` : "";
    const noteLine = n?.note ? `<br><small>${String(n.note).split("<br>").map(esc).join("<br>")}</small>` : "";
    return `<figure><img src="../${s.file}" loading="lazy"><figcaption>#${i} seq=${s.seq} ${s.file.split("/").pop()}${cap ? `<br><b>${esc(cap)}</b>` : ""}${phone}${noteLine}<br><label><input type="checkbox" data-seq="${s.seq}" data-file="${esc(s.file)}" checked> เก็บ (รูปคนชัด)</label><br><label>ตำแหน่งภาพ: <input type="number" data-ord="${s.seq}" value="${i}" min="0" style="width:4em"></label></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>เลือกรูปคน — ติ๊กเฉพาะรูปที่เอา</title>
<style>body{font-family:system-ui;margin:16px}figure{display:inline-block;width:220px;vertical-align:top;margin:8px}img{width:100%}button{font-size:18px;padding:8px 16px}</style>
<h2>ติ๊กเฉพาะรูปคนชัดที่ต้องการเก็บ (${sel.length} รูป)</h2>
<button id="save">ดาวน์โหลด selection.json</button>
${filePickerBtn("selection.json")}
<p>ติ๊กเสร็จกด “บันทึกทับไฟล์เดิม” (เลือก <code>review/selection.json</code> ครั้งเดียว) แล้วรัน <code>node backup-page.mjs --finalize &lt;โฟลเดอร์&gt;</code></p>
<p>ติ๊กหลายใบแล้วตั้งเลขเดียวกัน: <input id="bulk-ord" type="number" min="0" value="0" style="width:4em"> <button id="bulk-set">ตั้งเลขใบที่ติ๊ก</button> (เลขซ้ำได้ แต่ backend โชว์ใบไหนก่อนแล้วแต่ระบบ)</p>
<div>${cards}</div>
<script>function ordOf(seq){
  const el=document.querySelector('input[data-ord="'+seq+'"]');
  const v=el?parseInt(el.value,10):NaN;
  return Number.isFinite(v)&&v>=0?v:0;
}
function collect(){
  return [...document.querySelectorAll("input[data-seq]")].map(c=>({seq:+c.dataset.seq,file:c.dataset.file,keep:c.checked,order:ordOf(+c.dataset.seq)}));
}
function applyTicks(arr){
  const bySeq=new Map((arr||[]).map(e=>[+e.seq,e]));
  document.querySelectorAll("input[data-seq]").forEach(c=>{
    const e=bySeq.get(+c.dataset.seq);
    if(!e) return;
    c.checked=!!e.keep;
    const o=document.querySelector('input[data-ord="'+c.dataset.seq+'"]');
    if(o&&Number.isFinite(+e.order)&&+e.order>=0)o.value=+e.order;
  });
}
document.getElementById("bulk-set").onclick=()=>{
  const v=parseInt(document.getElementById("bulk-ord").value,10);
  if(!Number.isFinite(v)||v<0)return;
  document.querySelectorAll("input[data-seq]:checked").forEach(c=>{
    const o=document.querySelector('input[data-ord="'+c.dataset.seq+'"]');
    if(o)o.value=v;
  });
};
document.getElementById("save").onclick=()=>{
  const out=collect();
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="selection.json";a.click();
};</script>`;
}

// ---------- summary upsert (CLI overwrites; UI path merges by slug) ----------
export function upsertSummary(outDir, entry) {
  const path = join(outDir, "summary.json");
  let summary = readJson(path, null);
  if (!summary || !Array.isArray(summary.results)) {
    summary = { generated_at: new Date().toISOString(), extractor_version: ENGINE_VERSION, total: 0, ok: 0, failed: 0, results: [] };
  }
  const results = summary.results.filter((r) => r.slug !== entry.slug);
  results.push(entry);
  summary.results = results;
  summary.generated_at = new Date().toISOString();
  summary.total = results.length;
  summary.ok = results.filter((r) => !r.error).length;
  summary.failed = results.filter((r) => r.error).length;
  atomicWriteJson(path, summary);
  return summary;
}

// ---------- probe: metadata only, zero image bytes (job-scoped CLI parity) ----------
export async function probeUrl({ outDir, url, port = "auto", timeoutMs = 60000, cfWaitS = 60, via = "auto", pageSections = null, emit = null } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "probeUrl: outDir required");
  if (!url || typeof url !== "string") fail("bad-source", "probeUrl: url required");
  const sections = pageSections ?? loadPageSections();
  const realPort = await ensurePort(port);
  const { c, target } = await openCdpPage(realPort);
  try {
    emit?.("scrape:url-started", { url, mode: "probe" });
    const { origin, title, nodes } = await navigateAndExtract(c, url, Math.max(5000, timeoutMs), { cfWaitS, port: realPort, emit });
    const { kept, stats } = buildKept(nodes, origin, pageSectionFor(url, sections));
    const slug = resolveSlug(url, outDir);
    const stageDir = join(outDir, STAGING, slug);
    mkdirSync(stageDir, { recursive: true });
    const images = kept.filter((n) => n.type === "image").map((n) => ({
      seq: n.seq, src: n.src, width: n.width, height: n.height,
      top: (Number.isFinite(n.top) ? n.top : null),
      alt: n.alt || null, fullres_candidate: n.fullres_candidate || null,
      caption_next: n.caption_next || [], caption_text: n.caption_text || "",
      name: n.caption_next?.[0] || null, position: n.caption_next?.[1] || null,
      phone: n.phone || null, note: n.note || null, section: n.section || null, section_from: n.section_from || null,
      likely_header: !!n.likely_header, vacant: !!n.vacant,
    }));
    const probe = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
      extractor_version: ENGINE_VERSION, slug, counts: { ...stats, people: buildPeople(kept, url, "src").length }, images,
      people_preview: buildPeople(kept, url, "src").slice(0, 5),
      texts_preview: kept.filter((n) => n.type === "text").slice(0, 8).map((n) => n.text) };
    atomicWriteJson(join(stageDir, "probe.json"), probe);
    atomicWriteJson(join(stageDir, "picked-images.json"),
      images.map((im) => ({ seq: im.seq, src: im.src, keep: !!(im.name && !im.likely_header) })));
    writeFileSync(join(stageDir, "pick-images.html"), pickImagesHTML(url, title, slug, images), "utf8");
    mergeProbeAggregates(outDir, probe);
    emit?.("scrape:url-finished", { url, slug, dir: join(outDir, STAGING, slug), title, counts: probe.counts });
    return { slug, probe, counts: probe.counts };
  } finally {
    await closeCdpPage(realPort, c, target);
  }
}

// Merge (not overwrite) the global probe aggregates so sequential jobs sharing
// staging keep each other's entries. Keyed by url (picked-links) and src
// (master decisions), by slug (pages).
function mergeProbeAggregates(outDir, probe) {
  const stagingRoot = join(outDir, STAGING);
  mkdirSync(stagingRoot, { recursive: true });
  const linksPath = join(stagingRoot, "picked-links.json");
  const prevLinks = readJson(linksPath, []);
  const links = Array.isArray(prevLinks) ? prevLinks.filter((p) => p.url !== probe.source_url) : [];
  links.push({ url: probe.source_url, slug: probe.slug, keep: true });
  atomicWriteJson(linksPath, links);
  const probes = links.map((l) => {
    if (l.url === probe.source_url) return probe;
    const pj = readJson(join(stagingRoot, l.slug, "probe.json"), null);
    return pj ?? { source_url: l.url, slug: l.slug, error: "probe missing (another job's aggregate entry)" };
  });
  writeFileSync(join(stagingRoot, "pick-links.html"), pickLinksHTML(probes), "utf8");
  const okProbes = probes.filter((p) => !p.error);
  const groups = new Map();
  for (const p of okProbes) {
    for (const im of (p.images || [])) {
      if (!im.src) continue;
      let g = groups.get(im.src);
      if (!g) {
        g = { src: im.src, width: im.width, height: im.height, names: new Set(), positions: new Set(), pages: [], anyNamed: false };
        groups.set(im.src, g);
      }
      if (im.name) g.names.add(im.name);
      if (im.position) g.positions.add(im.position);
      if (im.name && !im.likely_header) g.anyNamed = true;
      if (!g.pages.includes(p.slug)) g.pages.push(p.slug);
    }
  }
  const masterGroups = [...groups.values()]
    .map((g) => ({ src: g.src, width: g.width, height: g.height, names: [...g.names], positions: [...g.positions], pages: g.pages, keep: g.anyNamed }))
    .sort((a, b) => b.pages.length - a.pages.length);
  const masterPath = join(stagingRoot, "master.json");
  const prevMaster = readJson(masterPath, null);
  const prevDecisions = new Map(((prevMaster && prevMaster.decisions) || []).map((d) => [d.src, !!d.keep]));
  const prevPages = new Map(((prevMaster && prevMaster.pages) || []).map((p) => [p.slug, p.url]));
  for (const g of masterGroups) prevDecisions.set(g.src, g.keep);
  for (const p of okProbes) prevPages.set(p.slug, p.source_url);
  const master = { generated_at: new Date().toISOString(), extractor_version: ENGINE_VERSION,
    pages: [...prevPages.entries()].map(([slug, murl]) => ({ slug, url: murl })),
    decisions: [...prevDecisions.entries()].map(([src, keep]) => ({ src, keep })) };
  atomicWriteJson(masterPath, master);
  writeFileSync(join(stagingRoot, "master-pick.html"),
    masterPickHTML(masterGroups, okProbes.map((p) => ({ slug: p.slug, url: p.source_url }))), "utf8");
  upsertSummary(stagingRoot, { url: probe.source_url, slug: probe.slug, dir: join(outDir, STAGING, probe.slug), title: probe.source_title, counts: probe.counts, images: probe.images.length });
}

// ---------- scrape: full content + download (job-scoped CLI parity) ----------
export async function scrapeUrl({ outDir, url, slug = null, port = "auto", timeoutMs = 60000, cfWaitS = 60, via = "auto", pageSections = null, imageSeqFilter = null, emit = null } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "scrapeUrl: outDir required");
  if (!url || typeof url !== "string") fail("bad-source", "scrapeUrl: url required");
  const sections = pageSections ?? loadPageSections();
  const realPort = await ensurePort(port);
  const { c, target } = await openCdpPage(realPort);
  try {
    emit?.("scrape:url-started", { url, slug, mode: "scrape" });
    const { origin, title, nodes } = await navigateAndExtract(c, url, Math.max(5000, timeoutMs), { cfWaitS, port: realPort, emit });
    let { kept, queue, stats } = buildKept(nodes, origin, pageSectionFor(url, sections));
    for (const n of kept) {
      if (n.group_warn) {
        try {
          emit?.("scrape:group-demoted", { url, seq: n.seq, previous: n.group_warn.previous || null, demoted: n.group_warn.demoted || null, kept: n.section || null, reason: n.group_warn.reason || null });
        } catch { /* ignore */ }
      }
    }
    if (imageSeqFilter) {
      const dropSeqs = new Set([...queue].filter((r) => !imageSeqFilter.has(r.seq)).map((r) => r.seq));
      if (dropSeqs.size) {
        for (const r of [...queue]) if (dropSeqs.has(r.seq)) { queue.splice(queue.indexOf(r), 1); }
        kept = kept.filter((n) => !(n.type === "image" && dropSeqs.has(n.seq)));
        stats.cut += dropSeqs.size;
        stats.image = kept.filter((n) => n.type === "image").length;
      }
    }
    const finalSlug = slug || resolveSlug(url, outDir);
    const dir = join(outDir, finalSlug);
    mkdirSync(join(dir, "images"), { recursive: true });
    const imgErrors = await downloadQueue(c, queue, kept, stats, dir, url, origin, { via, cfChallenge: !!c._cfChallenge, emit });
    const people = buildPeople(kept, url, "file");
    const manifest = { source_url: url, source_title: title, captured_at: new Date().toISOString(),
      extractor_version: ENGINE_VERSION, counts: { ...stats, imgErrors, people: people.length },
      rules: ["text-only chrome", "image denylist + <=70B filter", "text denylist (goog-te, เลือกภาษา)",
        `dedupe by image URL + page slot position`, `min size ${MIN_PX}px`, "cross-origin iframes -> placeholder",
        "UTF-8 JSON output", `image retry x${RETRY}`, "caption_next = next 2 non-phone texts", "phone = first tel:/phone-pattern text in run", "note = trailing texts joined with <br> (junk tails cut)", "order = visual-row group suggestion (same row = same number, editable on review)", "section = H1-H3 heading > --page-sections url > scoped division / position evidence > page fallback", `slug unique (${finalSlug})`,
        `image via ${via}${c._cfChallenge ? " (cf-challenge seen: cdp forced)" : ""}`, `cf-wait ${cfWaitS}s`, `cdp :${realPort}`] };
    atomicWriteJson(join(dir, "content.json"), { manifest, nodes: kept });
    atomicWriteJson(join(dir, "people.json"), people);
    const sel = buildInitialSelection(kept.filter((n) => n.type === "image" && n.file));
    mkdirSync(join(dir, "review"), { recursive: true });
    atomicWriteJson(join(dir, "review", "selection.json"), sel);
    writeFileSync(join(dir, "review", "index.html"), reviewHTML(sel, kept, finalSlug), "utf8");
    try { emit?.("review:selection-written", { slug: finalSlug, dir, count: sel.length, relPath: `${finalSlug}/review/selection.json` }); } catch { /* ignore */ }
    upsertSummary(outDir, { url, slug: finalSlug, dir, title, counts: manifest.counts, candidates: sel.length, people: people.length });
    emit?.("scrape:url-finished", { url, slug: finalSlug, dir, title, counts: manifest.counts });
    return { dir, slug: finalSlug, title, manifest, nCands: sel.length, nPeople: people.length };
  } finally {
    await closeCdpPage(realPort, c, target);
  }
}

// ---------- detect: ephemeral backend discovery (read-only, zero writes) ----------
// Runs the shared automap core over a raw-CDP page shim (no playwright on the
// UI path; the core only uses newPage/goto/waitForTimeout/evaluate/close).
// The discovery snapshot is persisted per-job (never maps/, never merged).
export async function detectBackend({ outDir, slug, jobId, port = "auto", backend = null, match = "personal", emit = null } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "detectBackend: outDir required");
  if (!slug || typeof slug !== "string") fail("bad-slug", "detectBackend: slug required");
  if (!jobId || typeof jobId !== "string") fail("bad-job", "detectBackend: jobId required");
  const peoplePath = join(outDir, slug, "people.json");
  const people = readJson(peoplePath, null);
  if (!Array.isArray(people)) fail("missing-people", `detect: missing ${peoplePath} (scrape first)`, { slug });
  const sections = [...new Set(people.map((p) => p.section).filter(Boolean))];
  if (!sections.length) fail("missing-people", "detect: people.json has no sections", { slug });
  const realPort = await ensurePort(port);
  let hosts;
  if (backend) {
    hosts = [String(backend).replace(/\/$/, "")];
  } else {
    try {
      hosts = await discoverBackends(realPort, match);
    } catch (e) {
      fail("cdp-unreachable", `detect: CDP port ${realPort} unreachable`, { port: realPort });
    }
    if (!hosts.length) fail("no-backend", `detect: no open tab matches "${match}" on port ${realPort} (open + log in the backend tab, keep it open, UI Retry reruns)`, { port: realPort });
  }
  const host = hosts[0];
  const ctx = cdpContext(realPort);
  const rec = await automap(ctx, host, sections, { write: false });
  if (!rec.ok) fail("detect-failed", `detect: ${rec.error ?? "discovery failed"}`, { host });
  const snapshot = { host, detected_at: new Date().toISOString(), jobId, slug,
    sections_probed: sections.slice(0, 5), profile: rec.content?.profile ?? null,
    department_options: rec.content?.map?.department_options ?? [],
    ambiguous: rec.content?.map?.ambiguous ?? [], content: rec.content };
  const relPath = `${slug}/jobs/${jobId}/detect.json`;
  const absPath = join(outDir, relPath);
  atomicWriteJson(absPath, snapshot);
  const buf = readFileSync(absPath);
  return { host, relPath, sha256: createHash("sha256").update(buf).digest("hex"), byteLength: buf.length, sectionCount: sections.length,
    profile: rec.content?.profile ?? null,
    departments: rec.content?.map?.department_options ?? [] };
}

export const realEngine = { probeUrl, scrapeUrl, detectBackend };
