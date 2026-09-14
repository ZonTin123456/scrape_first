// TASK asset — survey script for ticket #5. Throwaway-grade: no polish, one purpose.
// Run: node task/survey-encoding-assets.mjs
// Probes every live page target on CDP :9444 + HTTP headers, writes task/survey-results.json

const CDP = "http://127.0.0.1:9444";
const NOISE = /(cleardot|spacer|pixel|blank)\.(gif|png|jpg)/i;

const list = await fetch(`${CDP}/json/list`).then((r) => r.json());
const pages = list.filter((t) => t.type === "page");

const EXPR = `(() => {
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const imgs = [...document.images].map((im) => ({
    src: abs(im.currentSrc || im.getAttribute("src") || ""),
    w: im.naturalWidth || 0, h: im.naturalHeight || 0 }));
  const frames = [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") || "(blank)");
  return { charset: document.characterSet, title: document.title.slice(0, 80),
    textNodes: document.body ? document.body.innerText.length : 0, imgs, frames };
})()`;

const cdpEval = (wsUrl) => new Promise(async (resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  let mid = 0;
  const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("cdp timeout")); }, 30000);
  ws.onopen = () => ws.send(JSON.stringify({ id: ++mid, method: "Runtime.evaluate",
    params: { expression: EXPR, returnByValue: true } }));
  ws.onerror = (e) => { clearTimeout(t); reject(e); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) { clearTimeout(t); ws.close(); resolve(m.result.result.value); }
  };
});

const results = [];
for (const p of pages) {
  const rec = { url: p.url };
  try { rec.dom = await cdpEval(p.webSocketDebuggerUrl); }
  catch (e) { rec.dom = { error: String(e.message || e).slice(0, 100) }; }
  try {
    const r = await fetch(p.url, { headers: { "user-agent": "Mozilla/5.0 survey" } });
    rec.http = { status: r.status, contentType: r.headers.get("content-type") };
    await r.arrayBuffer().catch(() => null);
  } catch (e) { rec.http = { error: String(e.message || e).slice(0, 100) }; }
  results.push(rec);
  console.log(rec.url, "->", rec.dom.charset || rec.dom.error, "|", rec.http.status ?? rec.http.error);
}

// classify images per page
for (const r of results) {
  if (!r.dom.imgs) continue;
  const seen = new Map();
  let noise = 0, tiny = 0;
  for (const im of r.dom.imgs) {
    seen.set(im.src, (seen.get(im.src) || 0) + 1);
    if (NOISE.test(im.src)) noise++;
    else if (im.w <= 1 && im.h <= 1) tiny++;
  }
  const dups = [...seen.entries()].filter(([, c]) => c > 1);
  r.images = { total: r.dom.imgs.length, unique: seen.size,
    junk_noiseName: noise, junk_1px: tiny,
    content_candidates: r.dom.imgs.length - noise - tiny,
    dup_urls: dups.length, top_dups: dups.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([src, c]) => ({ times: c, src: src.slice(0, 100) })) };
  delete r.dom.imgs;
}

import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("task", { recursive: true });
writeFileSync("task/survey-results.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 1), "utf8");
console.log("wrote task/survey-results.json");
