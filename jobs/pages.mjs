// jobs/pages.mjs — Page Selection model over the staging contract.
// Backs GET/POST /jobs/:jobId/pages: display discovered pages, keep/unkeep
// selection, server-side save, then Approve/Resume into Scrape.
// Reads/writes the same files as the CLI probe flow (picked-links.json,
// master.json, _staging/<slug>/probe.json + picked-images.json); never CLI
// entries. Only node builtins. Merges by key (url/seq/src) so sequential jobs
// sharing global staging do not clobber each other.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  throw e;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n", "utf8");
  renameSync(tmp, path);
}

export function stagingPaths(outDir) {
  const root = join(outDir, "_staging");
  return {
    root,
    pickedLinks: join(root, "picked-links.json"),
    master: join(root, "master.json"),
  };
}

function probeInfo(outDir, slug) {
  const probe = readJson(join(outDir, "_staging", slug, "probe.json"), null);
  if (!probe || probe.error) return null;
  return {
    title: probe.source_title ?? null,
    counts: probe.counts ?? null,
    images: (probe.images || []).map((im) => ({
      // Display-only pass-through of engine probe metadata (verbatim, no
      // filtering or classification here). Save path uses seq/keep only.
      seq: im.seq,
      src: im.src ?? null,
      width: im.width ?? null,
      height: im.height ?? null,
      name: im.name ?? null,
      position: im.position ?? null,
      alt: im.alt ?? null,
      note: im.note ?? null,
      caption_text: im.caption_text ?? null,
      section: im.section ?? null,
    })),
  };
}

function pickedImagesKeep(outDir, slug) {
  const arr = readJson(join(outDir, "_staging", slug, "picked-images.json"), null);
  if (!Array.isArray(arr)) return null;
  return arr;
}

// Load the Page Selection model for a job. pending=true when no probe ran yet
// (single suggested link from the job source); the UI then shows Probe first.
export function loadPagesModel(outDir, job) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "loadPagesModel: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "loadPagesModel: job required");
  const paths = stagingPaths(outDir);
  const all = readJson(paths.pickedLinks, null);
  if (!Array.isArray(all)) {
    return { jobId: job.jobId, slug: job.slug, pending: true, links: [], master: null };
  }
  const mine = all.filter((e) => e && e.slug === job.slug);
  const master = readJson(paths.master, null);
  const links = mine.map((e) => {
    const info = probeInfo(outDir, e.slug);
    const picks = pickedImagesKeep(outDir, e.slug);
    const keepBySeq = new Map((picks || []).map((p) => [Number(p.seq), !!p.keep]));
    return {
      url: e.url,
      slug: e.slug,
      keep: e.keep !== false,
      title: info?.title ?? null,
      counts: info?.counts ?? null,
      images: (info?.images || []).map((im) => ({ ...im, keep: keepBySeq.has(im.seq) ? keepBySeq.get(im.seq) : true })),
      pickedFile: picks ? true : false,
    };
  });
  return {
    jobId: job.jobId,
    slug: job.slug,
    pending: links.length === 0,
    links,
    master: master ? { generated_at: master.generated_at ?? null, pages: master.pages ?? [], decisions: master.decisions ?? [] } : null,
  };
}

function assertLinkEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) fail("bad-pages", "links entries must be objects");
  if (typeof e.url !== "string" || !e.url) fail("bad-pages", "link url required");
  if (typeof e.keep !== "boolean") fail("bad-pages", `link keep must be boolean for ${e.url}`);
  return { url: e.url, keep: e.keep };
}

function assertImageEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) fail("bad-pages", "image entries must be objects");
  if (!Number.isInteger(e.seq) || e.seq < 0) fail("bad-pages", `image seq must be int >=0 (got ${e?.seq})`);
  if (typeof e.keep !== "boolean") fail("bad-pages", `image keep must be boolean for seq ${e.seq}`);
  return { seq: e.seq, keep: e.keep };
}

// Save Page Selection. Merges by key: picked-links by url (other urls kept),
// picked-images by seq per slug (unknown seq/slug rejected fail-closed),
// master decisions by src for affected slugs. Returns a summary.
export function savePagesModel(outDir, job, { links, images } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "savePagesModel: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "savePagesModel: job required");
  if (!Array.isArray(links)) fail("bad-pages", "links array required");
  if (!images || typeof images !== "object" || Array.isArray(images)) fail("bad-pages", "images map required");
  const paths = stagingPaths(outDir);
  const normLinks = links.map(assertLinkEntry);
  // Every submitted link must belong to this job (no cross-job writes).
  for (const l of normLinks) {
    const known = linkSlugFor(outDir, job, l.url);
    if (!known) fail("unknown-url", `link url not part of job ${job.slug}: ${l.url}`, { url: l.url });
  }
  const normImages = {};
  for (const [slug, arr] of Object.entries(images)) {
    if (slug !== job.slug) fail("unknown-slug", `images slug not part of job: ${slug}`, { slug });
    if (!Array.isArray(arr)) fail("bad-pages", `images for ${slug} must be array`);
    normImages[slug] = arr.map(assertImageEntry);
  }
  // Validate seqs against the probe's picked-images file (fail unknown).
  const srcBySeq = {};
  for (const slug of Object.keys(normImages)) {
    const picks = pickedImagesKeep(outDir, slug);
    if (!picks) fail("missing-picked-images", `no picked-images for ${slug} (probe first)`, { slug });
    const knownSeq = new Map(picks.map((p) => [Number(p.seq), p.src ?? null]));
    for (const e of normImages[slug]) {
      if (!knownSeq.has(e.seq)) fail("bad-seq", `unknown seq ${e.seq} for ${slug}`, { slug, seq: e.seq });
    }
    srcBySeq[slug] = knownSeq;
  }

  // 1. picked-images per slug (merge keep by seq).
  let imageUpdates = 0;
  for (const [slug, arr] of Object.entries(normImages)) {
    const picks = pickedImagesKeep(outDir, slug);
    const want = new Map(arr.map((e) => [e.seq, e.keep]));
    for (const p of picks) {
      if (want.has(Number(p.seq)) && !!p.keep !== want.get(Number(p.seq))) {
        p.keep = want.get(Number(p.seq));
        imageUpdates++;
      }
    }
    atomicWriteJson(join(outDir, "_staging", slug, "picked-images.json"), picks);
  }
  // 2. master decisions for affected srcs.
  let decisionUpdates = 0;
  const masterPath = paths.master;
  const master = readJson(masterPath, null);
  if (master && Array.isArray(master.decisions)) {
    const wantSrc = new Map();
    for (const [slug, arr] of Object.entries(normImages)) {
      const known = srcBySeq[slug];
      for (const e of arr) {
        const src = known.get(e.seq);
        if (src) wantSrc.set(src, e.keep);
      }
    }
    for (const d of master.decisions) {
      if (d && typeof d.src === "string" && wantSrc.has(d.src) && !!d.keep !== wantSrc.get(d.src)) {
        d.keep = wantSrc.get(d.src);
        decisionUpdates++;
      }
    }
    atomicWriteJson(masterPath, master);
  }
  // 3. picked-links (merge keep by url, preserve other urls).
  const prevLinks = readJson(paths.pickedLinks, []);
  if (!Array.isArray(prevLinks)) fail("missing-picked-links", "picked-links.json unreadable (probe first)");
  const wantLink = new Map(normLinks.map((l) => [l.url, l.keep]));
  let linkUpdates = 0;
  for (const p of prevLinks) {
    if (p && wantLink.has(p.url) && !!p.keep !== wantLink.get(p.url)) {
      p.keep = wantLink.get(p.url);
      linkUpdates++;
    }
  }
  atomicWriteJson(paths.pickedLinks, prevLinks);

  return { links: normLinks.length, imageUpdates, decisionUpdates, linkUpdates };
}

// Resolve which slug a url belongs to for this job (picked-links entry or the
// job's own source). Null when the url is foreign.
function linkSlugFor(outDir, job, url) {
  const prevLinks = readJson(join(outDir, "_staging", "picked-links.json"), null);
  if (Array.isArray(prevLinks)) {
    const hit = prevLinks.find((p) => p && p.url === url && p.slug === job.slug);
    if (hit) return hit.slug;
  }
  if (url === job.source) return job.slug;
  return null;
}

// ---- durable page approval (human gate, server-authoritative) ----
// Approval binds to a fingerprint of the current staging selection, so any
// later Save (or re-probe) invalidates it and Scrape refuses until re-approve.
// Stored on the job record: reloads remember it. No stage movement here;
// scraping begins only when the Scrape command is accepted.
export function approvalFingerprint(outDir, slug) {
  const links = (readJson(join(outDir, "_staging", "picked-links.json"), []) || [])
    .filter((e) => e && e.slug === slug);
  const picks = readJson(join(outDir, "_staging", slug, "picked-images.json"), null);
  return `appr_${createHash("sha256").update(JSON.stringify({ links, picks }), "utf8").digest("hex").slice(0, 16)}`;
}

export function recordPageApproval(outDir, job) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "recordPageApproval: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "recordPageApproval: job required");
  const fp = approvalFingerprint(outDir, job.slug);
  job.pageApproval = { approved: true, at: new Date().toISOString(), fingerprint: fp };
  return job.pageApproval;
}

export function checkPageApproval(outDir, job) {
  const a = job?.pageApproval;
  if (!a || a.approved !== true) return { ok: false, reason: "approval-required" };
  if (a.fingerprint !== approvalFingerprint(outDir, job.slug)) return { ok: false, reason: "approval-stale" };
  return { ok: true };
}
