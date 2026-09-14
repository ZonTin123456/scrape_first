// PROTOTYPE — throwaway. Answers: "what should the backup output structure look like?"
// Part of map #1, ticket #4. Do NOT treat as production code. No tests, minimal error handling.
// Run: node prototype/output-proto-extract.mjs [targetIdPrefix]
// Reads one live Chrome page via CDP, writes prototype-output/<slug>/{content.json,images/,README.md}

const CDP = "http://127.0.0.1:9444";
const wantPrefix = process.argv[2] || "6A1A2706"; // talingchan manage.php

const list = await fetch(`${CDP}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page" && t.id.startsWith(wantPrefix));
if (!page) throw new Error("page target not found: " + wantPrefix);
console.log("target:", page.url);

const slug = new URL(page.url).hostname.split(".").slice(-3, -1).join("") + "-" +
  new URL(page.url).pathname.replace(/\//g, "").replace(/\.php.*/, "");

// --- minimal CDP client over native WebSocket ---
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const EXPR = `(() => {
  const out = [];
  const skip = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"]);
  const regionOf = (el) => {
    let n = el.nodeType === 3 ? el.parentElement : el;
    while (n && n !== document.body) {
      const t = n.tagName;
      if (t === "HEADER" || t === "NAV" || t === "MAIN" || t === "FOOTER") return t.toLowerCase();
      n = n.parentElement;
    }
    return "body";
  };
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) {
      const text = n.nodeValue.replace(/\\s+/g, " ").trim();
      if (!text) continue;
      let p = n.parentElement;
      if (p && skip.has(p.tagName)) continue;
      out.push({ t: "text", text, region: regionOf(n) });
    } else if (n.tagName === "IMG") {
      const a = n.closest("a[href]");
      out.push({ t: "img", src: abs(n.currentSrc || n.getAttribute("src") || ""),
        w: n.naturalWidth || 0, h: n.naturalHeight || 0,
        alt: (n.getAttribute("alt") || "").slice(0, 200),
        region: regionOf(n), full: a ? abs(a.getAttribute("href")) : null });
    } else if (n.tagName === "IFRAME") {
      const src = n.getAttribute("src") || "";
      out.push({ t: "iframe", src, abs: src ? abs(src) : "",
        title: (n.getAttribute("title") || "").slice(0, 200), region: regionOf(n) });
    }
  }
  return { origin: location.origin, nodes: out };
})()`;

const evalRes = await send("Runtime.evaluate", {
  expression: EXPR, returnByValue: true, awaitPromise: false,
});
const frames = await send("Page.getFrameTree").catch(() => null);
ws.close();
const { origin, nodes } = evalRes.result.result.value;
console.log("raw nodes:", nodes.length);

// --- apply scope rules decided in ticket #3 ---
const NOISE_NAME = /(cleardot|spacer|pixel|blank)\.(gif|png|jpg)/i;
const TRANS = /translate\.google|goog-te|cleardot/i;
const stats = { text: 0, img: 0, placeholder: 0, cutChromeImg: 0, cutNoise: 0, cutBlankFrame: 0, imgErrors: 0 };
const kept = [];
const toFetch = [];
nodes.forEach((n, i) => {
  if (n.t === "text") { stats.text++; kept.push({ seq: i, type: "text", region: n.region, text: n.text }); }
  else if (n.t === "img") {
    if (NOISE_NAME.test(n.src) || TRANS.test(n.src)) { stats.cutNoise++; return; }
    if (n.region === "header" || n.region === "nav" || n.region === "footer") { stats.cutChromeImg++; return; } // text-only chrome
    stats.img++;
    const rec = { seq: i, type: "image", region: n.region, file: null, src: n.src, width: n.w, height: n.h };
    if (n.alt) rec.alt = n.alt;
    if (n.full && n.full !== n.src && /\.(jpe?g|png|gif|webp)/i.test(n.full)) rec.fullres_candidate = n.full;
    kept.push(rec); toFetch.push(rec);
  }
  else if (n.t === "iframe") {
    if (!n.abs || n.abs === "about:blank") { stats.cutBlankFrame++; return; }
    let cross = true;
    try { cross = new URL(n.abs).origin !== origin; } catch { /* keep as placeholder */ }
    if (!cross) { kept.push({ seq: i, type: "iframe-sameorigin", region: n.region, src: n.abs }); return; }
    stats.placeholder++;
    kept.push({ seq: i, type: "placeholder", kind: "iframe", region: n.region, src: n.abs, title: n.title || null });
  }
});

// --- write output ---
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join("prototype-output", slug);
const imgDir = join(dir, "images");
mkdirSync(imgDir, { recursive: true });

let n = 0;
for (const rec of toFetch) {
  n++;
  let ext = "bin";
  try {
    const r = await fetch(rec.src);
    if (!r.ok) throw new Error("http " + r.status);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp" : "jpg";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length <= 70) { stats.cutNoise++; kept.splice(kept.indexOf(rec), 1); continue; } // 1px tracking
    const file = `images/${String(n).padStart(3, "0")}.${ext}`;
    writeFileSync(join(dir, file), buf);
    rec.file = file; rec.bytes = buf.length;
  } catch (e) { stats.imgErrors++; rec.file = null; rec.error = String(e.message || e).slice(0, 120); }
  delete rec.src; // file pointer is the reference; origin URL kept in manifest below
}

const manifest = { source_url: page.url, captured_at: new Date().toISOString(),
  origin, stats, frames_seen: frames ? JSON.stringify(frames.result.frameTree.childFrames?.length ?? 0) + " child frames" : "n/a",
  rules: ["text-only chrome (header/nav/footer images dropped)", "noise denylist + <=70B tracking filter",
    "cross-origin iframes -> placeholder", "output UTF-8 JSON", "fullres_candidate from parent link"] };
writeFileSync(join(dir, "content.json"), JSON.stringify({ manifest, nodes: kept }, null, 1), "utf8");
writeFileSync(join(dir, "README.md"),
  `# PROTOTYPE output — ${slug}\n\nThrowaway sample for ticket #4. Source: ${page.url}\n\n## Layout\n\n- \`content.json\` — \`{manifest, nodes}\`; nodes in DOM order, \`seq\` = original position\n- \`images/NNN.ext\` — downloaded files referenced by \`nodes[].file\`\n- node types: \`text\` | \`image\` (+optional \`fullres_candidate\`) | \`placeholder\` (iframe) | \`iframe-sameorigin\`\n\n## Stats\n\n${JSON.stringify(stats, null, 1)}\n\n## React to this (owner)\n\n1. Layout/file naming OK?\n2. \`region\` per node useful or noise?\n3. Placeholder shape enough for downstream systems?\n`, "utf8");

console.log("kept:", kept.length, "stats:", JSON.stringify(stats));
console.log("wrote:", dir);
