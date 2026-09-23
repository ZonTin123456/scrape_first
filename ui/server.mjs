#!/usr/bin/env node
// ui/server.mjs — local dashboard for the backup -> upload pipeline.
//
// Zero dependencies (Node stdlib only). Serves the UI, a small JSON API, and
// runs the existing scripts as child processes (stdout/stderr streamed live
// over SSE). It writes files ONLY when the user clicks an explicit save/run
// action — same boundaries as the CLI, same output layout under out/.
//
//   node ui/server.mjs [--port 4173]
//
// Then open http://localhost:4173
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "out");
const STAGING = join(OUT, "_staging");
const NODE = process.execPath;

const portArg = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : NaN;
})();
const PORT = Number.isFinite(portArg) ? portArg : Number(process.env.PORT || 4173);

// ---------- tiny helpers ----------
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};
const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readTextSafe = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const slugOf = (s) => {
  const v = String(s || "").trim();
  if (!SLUG_RE.test(v)) throw new Error(`slug ไม่ถูกต้อง: ${v}`);
  return v;
};
const body = (req, cap = 8 * 1024 * 1024) => new Promise((ok, bad) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > cap) req.destroy(); });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
  req.on("error", bad);
});

// ---------- URL list (urls.txt) ----------
const normalizeUrl = (s) => {
  const t = String(s || "").trim();
  if (!t || t.startsWith("#")) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};
function parseUrls(text) {
  const seen = new Set(), out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const u = normalizeUrl(line);
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// ---------- read state ----------
function readProbes() {
  const out = [];
  if (!existsSync(STAGING)) return out;
  for (const d of readdirSync(STAGING, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = readJsonSafe(join(STAGING, d.name, "probe.json"));
    if (!p) continue;
    const picked = readJsonSafe(join(STAGING, d.name, "picked-images.json"));
    out.push({
      slug: d.name,
      url: p.source_url || "",
      title: p.source_title || "",
      counts: p.counts || {},
      images: p.images || [],
      keptImages: Array.isArray(picked) ? picked.filter((x) => x && x.keep).length : null,
      hasPickedImages: Array.isArray(picked),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildMasterGroups(probes) {
  const bySrc = new Map();
  for (const p of probes) {
    for (const im of p.images || []) {
      if (!im.src) continue;
      let g = bySrc.get(im.src);
      if (!g) {
        g = { src: im.src, width: im.width, height: im.height, names: new Set(), positions: new Set(), pages: [], anyNamed: false };
        bySrc.set(im.src, g);
      }
      if (im.name) g.names.add(im.name);
      if (im.position) g.positions.add(im.position);
      if (im.name && !im.likely_header) g.anyNamed = true;
      if (!g.pages.includes(p.slug)) g.pages.push(p.slug);
    }
  }
  return [...bySrc.values()]
    .map((g) => ({ src: g.src, width: g.width, height: g.height, names: [...g.names], positions: [...g.positions], pages: g.pages, keep: g.anyNamed }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

// overlay saved master.json decisions (keep flags) onto freshly grouped images
function applySavedMasterDecisions(groups, master) {
  const bySrc = new Map((master?.decisions || []).map((d) => [d.src, !!d.keep]));
  if (!bySrc.size) return groups;
  return groups.map((g) => (bySrc.has(g.src) ? { ...g, keep: bySrc.get(g.src) } : g));
}

function readPages() {
  const out = [];
  if (!existsSync(OUT)) return out;
  for (const d of readdirSync(OUT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "_staging") continue;
    const dir = join(OUT, d.name);
    const cj = readJsonSafe(join(dir, "content.json"));
    const pj = readJsonSafe(join(dir, "people.json"));
    if (!cj && !Array.isArray(pj)) continue; // not a page dir
    out.push({
      slug: d.name,
      url: cj?.manifest?.source_url || pj?.[0]?.source_url || "",
      title: cj?.manifest?.source_title || "(ไม่มี content.json — อัปโหลดจาก people.json)",
      counts: cj?.manifest?.counts || {},
      nodes: (cj?.nodes || []).length,
      people: Array.isArray(pj) ? pj.length : null,
      hasSelection: existsSync(join(dir, "review", "selection.json")),
      reviewed: !!cj?.manifest?.reviewed,
      hasContent: !!cj,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function cdpStatus() {
  for (const p of [9333, 9444, 9222]) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 600);
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        const v = await r.json();
        return { port: p, browser: v.Browser || "", headless: /headless/i.test(`${v.Browser || ""} ${v["User-Agent"] || ""}`) };
      }
    } catch { /* not this port */ }
  }
  return null;
}

async function buildState() {
  const probes = readProbes();
  const pickedLinks = readJsonSafe(join(STAGING, "picked-links.json"));
  const keepByUrl = new Map((Array.isArray(pickedLinks) ? pickedLinks : []).map((e) => [e.url, e.keep !== false]));
  const master = readJsonSafe(join(STAGING, "master.json"));
  const stagingSummary = readJsonSafe(join(STAGING, "summary.json"));
  const failed = (stagingSummary?.results || []).filter((r) => r.error).map((r) => ({ url: r.url, error: r.error }));

  return {
    urls: readTextSafe(join(ROOT, "urls.txt")),
    urlList: parseUrls(readTextSafe(join(ROOT, "urls.txt"))),
    cdp: await cdpStatus(),
    links: probes.map((p) => ({
      slug: p.slug, url: p.url, title: p.title, counts: p.counts,
      images: (p.images || []).length,
      keep: keepByUrl.has(p.url) ? keepByUrl.get(p.url) : true,
    })),
    failed,
    probes: probes.map((p) => ({ slug: p.slug, keeps: `${p.keptImages ?? "-"}/${(p.images || []).length}`, hasPickedImages: p.hasPickedImages })),
    master: probes.length ? {
      pages: master?.pages?.length ? master.pages : probes.map((p) => ({ slug: p.slug, url: p.url })),
      groups: applySavedMasterDecisions(buildMasterGroups(probes), master),
      saved: !!master,
    } : null,
    pages: readPages(),
    hasSections: existsSync(join(ROOT, "sections.json")),
  };
}

// ---------- jobs (child processes streamed over SSE) ----------
const jobs = new Map();
let nextJob = 1;

function buildArgs(step, o = {}) {
  const bp = [];
  if (o.port) bp.push("--port", String(o.port));
  if (o.via) bp.push("--via", String(o.via));
  if (o.cfWait !== undefined && o.cfWait !== null && o.cfWait !== "") bp.push("--cf-wait", String(o.cfWait));
  bp.push("--no-cf-manual"); // stdin is not a TTY under the server: no interactive pause

  const up = [];
  if (o.port) up.push("--port", String(o.port));
  if (o.backend) up.push("--backend", String(o.backend));
  if (o.limit) up.push("--limit", String(o.limit));
  if (o.map) up.push("--map", String(o.map));
  if (o.to) up.push("--to", String(o.to));
  if (o.strictSections) up.push("--strict-sections");

  switch (step) {
    case "probe":
      return ["backup-page.mjs", "--probe", "--from", "urls.txt", "--out", "./out", ...bp];
    case "apply-master":
      if (!existsSync(join(STAGING, "master.json"))) throw new Error("ยังไม่มี out/_staging/master.json (ต้อง probe + ติ๊กรวมก่อน)");
      return ["backup-page.mjs", "--apply-master", "out/_staging/master.json", "--out", "./out"];
    case "run": {
      if (!existsSync(join(STAGING, "picked-links.json"))) throw new Error("ยังไม่มี out/_staging/picked-links.json (ติ๊กลิงก์ก่อน)");
      const a = ["backup-page.mjs", "--run", "--from", "out/_staging/picked-links.json", "--out", "./out", ...bp];
      if (existsSync(join(ROOT, "sections.json"))) a.push("--page-sections", "sections.json");
      return a;
    }
    case "finalize": {
      const a = ["backup-page.mjs", "--finalize", "--all", "--out", "./out"];
      if (o.compactOrders !== false) a.push("--compact-orders");
      return a;
    }
    case "regen-review":
      return ["backup-page.mjs", "--regen-review", "--all", "--out", "./out"];
    case "upload": {
      const slug = slugOf(o.slug);
      const from = `out/${slug}/people.json`;
      if (!existsSync(join(ROOT, from))) throw new Error(`ไม่พบ ${from} (ต้อง finalize ก่อน)`);
      const a = ["uploader/upload-people.mjs", "--from", from, ...up];
      if (o.save) {
        if (!o.iVerified) throw new Error("โหมดยิงจริงต้องติ๊กยืนยัน i-verified ก่อน");
        a.push("--save", "--i-verified");
      }
      return a;
    }
    default:
      throw new Error(`ไม่รู้จัก step: ${step}`);
  }
}

function startJob(step, opts) {
  const args = buildArgs(step, opts);
  const id = `j${nextJob++}`;
  const job = { id, step, line: `node ${args.join(" ")}`, events: [], listeners: new Set(), done: false, code: null };
  jobs.set(id, job);
  const emit = (ev) => { job.events.push(ev); for (const l of job.listeners) { try { l(ev); } catch { /* closed */ } } };
  let child;
  try {
    child = spawn(NODE, args, { cwd: ROOT, env: process.env });
  } catch (e) {
    emit({ type: "err", text: String(e.message) + "\n" });
    emit({ type: "exit", code: 1 });
    job.done = true; job.code = 1;
    return job;
  }
  job.child = child;
  emit({ type: "start", line: job.line });
  child.stdout.on("data", (d) => emit({ type: "out", text: d.toString() }));
  child.stderr.on("data", (d) => emit({ type: "err", text: d.toString() }));
  child.on("error", (e) => emit({ type: "err", text: String(e.message) + "\n" }));
  child.on("close", (code) => { job.done = true; job.code = code; emit({ type: "exit", code }); });
  return job;
}

function sse(req, res, job) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const ev of job.events) send(ev);
  if (job.done) { res.end(); return; }
  const l = (ev) => { try { send(ev); if (ev.type === "exit") res.end(); } catch { /* closed */ } };
  job.listeners.add(l);
  req.on("close", () => job.listeners.delete(l));
}

// ---------- static ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
function serveFile(res, abs) {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return json(res, 404, { error: "not found" });
    const buf = readFileSync(abs);
    res.writeHead(200, { "Content-Type": MIME[extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch (e) { json(res, 500, { error: String(e.message) }); }
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(u.pathname);
  try {
    // static UI
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, join(HERE, "index.html"));
    if (req.method === "GET" && (p === "/app.js" || p === "/style.css")) return serveFile(res, join(HERE, p.slice(1)));

    // files under out/ (image previews, review images)
    if (req.method === "GET" && p.startsWith("/out/")) {
      const abs = resolve(ROOT, "." + p);
      if (!abs.startsWith(OUT)) return json(res, 403, { error: "forbidden" });
      return serveFile(res, abs);
    }

    if (req.method === "GET" && p === "/api/state") return json(res, 200, await buildState());

    if (req.method === "GET" && p.startsWith("/api/probe/")) {
      const slug = slugOf(p.slice("/api/probe/".length));
      const probe = readJsonSafe(join(STAGING, slug, "probe.json"));
      if (!probe) return json(res, 404, { error: "no probe.json" });
      const picked = readJsonSafe(join(STAGING, slug, "picked-images.json"));
      return json(res, 200, { slug, probe, picked: Array.isArray(picked) ? picked : null });
    }

    if (req.method === "GET" && p.startsWith("/api/review/")) {
      const slug = slugOf(p.slice("/api/review/".length));
      const dir = join(OUT, slug);
      const cj = readJsonSafe(join(dir, "content.json"));
      if (!cj) return json(res, 404, { error: "no content.json" });
      const bySeq = new Map((cj.nodes || []).map((n) => [n.seq, n]));
      let sel = readJsonSafe(join(dir, "review", "selection.json"));
      if (!Array.isArray(sel)) {
        // default: keep all, order = visual-row group suggestion (same as writeReview)
        const cands = (cj.nodes || []).filter((n) => n.type === "image" && n.file);
        let g = -1, lastTop = null;
        sel = cands.map((n) => {
          const t = Number.isFinite(n.top) ? n.top : null;
          if (t === null || lastTop === null || Math.abs(t - lastTop) > 25) g++;
          if (t !== null) lastTop = t;
          return { seq: n.seq, file: n.file, keep: true, order: g };
        });
      }
      const cands = sel.map((s) => {
        const n = bySeq.get(s.seq);
        return {
          seq: s.seq, file: s.file, keep: s.keep !== false, order: Number.isFinite(+s.order) ? +s.order : 0,
          src: `/out/${slug}/${s.file}`,
          caption: n?.caption_text || "", phone: n?.phone || "", note: n?.note || "",
          section: n?.section || "", likely_header: !!n?.likely_header, vacant: !!n?.vacant, alt: n?.alt || "",
        };
      });
      return json(res, 200, { slug, title: cj.manifest?.source_title || "", url: cj.manifest?.source_url || "", candidates: cands, reviewed: !!cj.manifest?.reviewed });
    }

    if (req.method === "GET" && p.startsWith("/api/report/")) {
      const slug = slugOf(p.slice("/api/report/".length));
      const r = readJsonSafe(join(ROOT, "uploader", `report-${slug}.json`));
      return json(res, 200, { slug, report: r });
    }

    if (req.method === "POST") {
      if (p === "/api/urls") {
        const b = await body(req);
        const list = parseUrls(b.text);
        if (!list.length) return json(res, 400, { error: "ไม่พบ URL" });
        writeFileSync(join(ROOT, "urls.txt"), list.join("\n") + "\n", "utf8");
        return json(res, 200, { count: list.length, urlList: list });
      }
      if (p === "/api/staging/picked-links") {
        const b = await body(req);
        const arr = Array.isArray(b.links) ? b.links : [];
        if (!arr.length) return json(res, 400, { error: "ไม่มีรายการ" });
        mkdirSync(STAGING, { recursive: true });
        writeFileSync(join(STAGING, "picked-links.json"), JSON.stringify(arr.map((e) => ({ url: e.url, slug: e.slug, keep: e.keep !== false })), null, 1), "utf8");
        return json(res, 200, { ok: true, kept: arr.filter((e) => e.keep !== false).length });
      }
      if (p === "/api/staging/master") {
        const b = await body(req);
        mkdirSync(STAGING, { recursive: true });
        writeFileSync(join(STAGING, "master.json"), JSON.stringify({
          generated_at: new Date().toISOString(),
          pages: b.pages || [],
          decisions: (b.decisions || []).map((d) => ({ src: d.src, keep: !!d.keep })),
        }, null, 1), "utf8");
        return json(res, 200, { ok: true });
      }
      if (p === "/api/staging/picked-images") {
        const b = await body(req);
        const slug = slugOf(b.slug);
        const dir = join(STAGING, slug);
        if (!existsSync(dir)) return json(res, 404, { error: "no staging dir" });
        writeFileSync(join(dir, "picked-images.json"), JSON.stringify((b.decisions || []).map((d) => ({ seq: d.seq, src: d.src, keep: !!d.keep })), null, 1), "utf8");
        return json(res, 200, { ok: true, kept: (b.decisions || []).filter((d) => d.keep).length });
      }
      if (p.startsWith("/api/review/")) {
        const slug = slugOf(p.slice("/api/review/".length));
        const dir = join(OUT, slug, "review");
        if (!existsSync(join(OUT, slug, "content.json"))) return json(res, 404, { error: "no content.json" });
        mkdirSync(dir, { recursive: true });
        const b = await body(req);
        writeFileSync(join(dir, "selection.json"), JSON.stringify(b.selection || [], null, 1), "utf8");
        return json(res, 200, { ok: true, kept: (b.selection || []).filter((s) => s.keep).length });
      }
      if (p === "/api/drop-people") {
        const b = await body(req);
        const rows = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
        if (!Array.isArray(rows)) return json(res, 400, { error: "people.json ต้องเป็น array" });
        const group = rows.find((r) => r && r.source_group)?.source_group || String(b.name || "people").replace(/\.json$/i, "");
        const slug = slugOf(String(group).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"));
        mkdirSync(join(OUT, slug), { recursive: true });
        writeFileSync(join(OUT, slug, "people.json"), JSON.stringify(rows, null, 1), "utf8");
        return json(res, 200, { slug, rows: rows.length });
      }
      if (p === "/api/job") {
        const b = await body(req);
        const job = startJob(b.step, b.opts || {});
        return json(res, 200, { id: job.id, line: job.line });
      }
      if (p.match(/^\/api\/job\/[^/]+\/kill$/)) {
        const id = p.split("/")[3];
        const j = jobs.get(id);
        if (j?.child) { try { j.child.kill(); } catch { /* gone */ } }
        return json(res, 200, { ok: true });
      }
      if (p === "/api/refresh") return json(res, 200, await buildState());
    }

    if (req.method === "GET" && p.startsWith("/api/job/")) {
      const rest = p.slice("/api/job/".length);
      const [id] = rest.split("/");
      const j = jobs.get(id);
      if (!j) return json(res, 404, { error: "no job" });
      return sse(req, res, j);
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`ui: http://localhost:${PORT}`);
  console.log(`ui: project root ${ROOT}`);
});
