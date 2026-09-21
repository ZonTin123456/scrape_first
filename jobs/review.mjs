// jobs/review.mjs — P5 Review-first engine/service owns semantics.
// Components render model + submit keep/order; cosmetic/local validation only.
// Server is POST-only writer, validates + atomic-writes, emits artifact:written,
// returns revision/fingerprint. Preview is non-persisting, same shared logic
// as finalize validation. No CLI/browser imports. No file:// or inline bytes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobDirFor } from "./store.mjs";

export const ROW_TOL = 25;

// Order input coercion: invalid -> 0 (reviewHTML ordOf parity).
// Accepts numbers, numeric strings; rejects NaN, negatives, non-integers, empty.
export function coerceOrder(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0) return n;
  const p = parseInt(String(v), 10);
  if (Number.isInteger(p) && p >= 0 && String(p) === String(v).trim()) return p;
  return 0;
}

// Visual-row grouping: same row (same top ±ROW_TOL) shares one order.
// Verbatim from backup-page.mjs suggestOrders.
export function suggestOrders(cands) {
  let g = -1;
  let lastTop = null;
  return cands.map((n) => {
    const t = Number.isFinite(n?.top) ? n.top : null;
    if (t === null || lastTop === null || Math.abs(t - lastTop) > ROW_TOL) g++;
    if (t !== null) lastTop = t;
    return g;
  });
}

// Src-grouping + keep defaults (anyNamed). Verbatim semantics from
// backup-page.mjs buildMasterGroups: group probe images by absolute src,
// keep = anyNamed (named, non-header).
export function groupBySrc(probes) {
  const bySrc = new Map();
  for (const p of probes || []) {
    for (const im of p?.images || []) {
      if (!im?.src) continue;
      let g = bySrc.get(im.src);
      if (!g) {
        g = {
          src: im.src,
          width: im.width,
          height: im.height,
          names: new Set(),
          positions: new Set(),
          pages: [],
          anyNamed: false,
        };
        bySrc.set(im.src, g);
      }
      if (im.name) g.names.add(im.name);
      if (im.position) g.positions.add(im.position);
      if (im.name && !im.likely_header) g.anyNamed = true;
      if (p.slug && !g.pages.includes(p.slug)) g.pages.push(p.slug);
    }
  }
  return [...bySrc.values()]
    .map((g) => ({
      src: g.src,
      width: g.width,
      height: g.height,
      names: [...g.names],
      positions: [...g.positions],
      pages: g.pages,
      keep: g.anyNamed,
    }))
    .sort((a, b) => b.pages.length - a.pages.length);
}

// Initial selection: every candidate shown, keep=true, order=suggested row group.
// Parity with backup-page.mjs writeReview.
export function buildInitialSelection(cands) {
  const list = Array.isArray(cands) ? cands : [];
  const groups = suggestOrders(list);
  return list.map((n, idx) => ({
    seq: Number(n.seq),
    file: String(n.file ?? ""),
    keep: true,
    order: groups[idx] ?? 0,
  }));
}

export function normalizeRow(row) {
  if (!row || typeof row !== "object") throw new Error("selection row must be object");
  const seq = Number(row.seq);
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`bad seq: ${row.seq}`);
  const file = String(row.file ?? "");
  if (!file) throw new Error(`bad file for seq ${seq}`);
  return { seq, file, keep: !!row.keep, order: coerceOrder(row.order) };
}

export function normalizeSelection(arr) {
  if (!Array.isArray(arr)) throw new Error("selection must be array");
  return arr.map(normalizeRow);
}

export function validateSelectionShape(arr) {
  try {
    const norm = normalizeSelection(arr);
    return { ok: true, selection: norm, errors: [] };
  } catch (e) {
    return { ok: false, selection: null, errors: [e.message] };
  }
}

// Checked-only bulk assign: only seqs in checkedSeqs get order set.
// Invalid order coerces (invalid->0 handled by caller via coerceOrder;
// here invalid bulk value is coerced too for parity with component).
export function applyBulkAssign(selection, checkedSeqs, orderValue) {
  const checked = new Set((Array.isArray(checkedSeqs) ? checkedSeqs : [...(checkedSeqs || [])]).map((s) => Number(s)));
  const order = coerceOrder(orderValue);
  return (selection || []).map((r) => (checked.has(Number(r.seq)) ? { ...r, order } : { ...r }));
}

export function keptOnly(selection) {
  return (selection || []).filter((r) => r.keep);
}

// Effective sort preview: (order,seq). Parity with finalize sort.
export function effectiveSort(rows) {
  return [...(rows || [])].sort((a, b) => a.order - b.order || a.seq - b.seq);
}

// Dup-allowed but warned: groups of kept rows sharing one order.
export function detectDuplicates(kept) {
  const groups = new Map();
  for (const p of kept || []) {
    if (!groups.has(p.order)) groups.set(p.order, []);
    groups.get(p.order).push(p.seq);
  }
  return [...groups.entries()]
    .filter(([, seqs]) => seqs.length > 1)
    .map(([order, seqs]) => ({ order, seqs: [...seqs].sort((a, b) => a - b) }));
}

export function formatDupWarning(dups) {
  if (!dups?.length) return null;
  return `duplicate orders: ${dups.map(({ order, seqs }) => `${order} (seq ${seqs.join(",")})`).join("; ")}`;
}

// Shared finalize validation logic (authoritative). Mirrors
// backup-page.mjs finalize: keep-filter + explicit orders + free-fill +
// (order,seq) sort + dup-warn. Used by preview AND save/finalize paths.
export function validateForFinalize(selection) {
  const norm = normalizeSelection(selection);
  const keep = new Set(norm.filter((s) => s.keep).map((s) => s.seq));
  const explicit = new Map();
  for (const s of norm) {
    if (!s.keep || !keep.has(s.seq)) continue;
    if (s.order === undefined || s.order === null || s.order === "") continue;
    const o = Number(s.order);
    if (Number.isInteger(o) && o >= 0) explicit.set(s.seq, o);
  }
  const used = new Set(explicit.values());
  let next = 0;
  const takeFree = () => {
    while (used.has(next)) next++;
    used.add(next);
    return next;
  };
  const pruned = norm
    .filter((s) => keep.has(s.seq))
    .map((s) => ({ ...s, order: explicit.has(s.seq) ? explicit.get(s.seq) : takeFree() }));
  pruned.sort((a, b) => a.order - b.order || a.seq - b.seq);
  const duplicates = detectDuplicates(pruned);
  const warnings = [];
  const dupWarn = formatDupWarning(duplicates);
  if (dupWarn) warnings.push(`finalize: warn: ${dupWarn}`);
  return {
    kept: pruned,
    removed: norm.length - pruned.length,
    explicit: [...explicit.entries()].map(([seq, order]) => ({ seq, order })),
    effectiveOrder: pruned.map((p) => ({ seq: p.seq, order: p.order })),
    duplicates,
    warnings,
  };
}

// Server-computed non-persisting warning preview: same shared logic,
// advisory only (dup orders, effective sort). Writes nothing.
export function buildWarningPreview(selection) {
  const v = validateForFinalize(selection);
  return { warnings: v.warnings, duplicates: v.duplicates, effectiveOrder: v.effectiveOrder, kept: v.kept.length };
}

// --compact-orders squeeze (opt-in): dense 0..N preserving ties + relative order.
export function compactOrders(pruned) {
  const uniq = [...new Set((pruned || []).map((p) => p.order))].sort((a, b) => a - b);
  const dense = new Map(uniq.map((o, i) => [o, i]));
  let changed = false;
  const out = (pruned || []).map((p) => {
    const d = dense.get(p.order);
    if (d !== p.order) changed = true;
    return { ...p, order: d };
  });
  return { orders: out, changed, from: uniq };
}

export function fingerprintSelection(selection) {
  const norm = normalizeSelection(selection);
  const bytes = Buffer.from(JSON.stringify(norm), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- fs layout: out/<slug>/jobs/<jobId>/review/selection.json ----

export function reviewDirFor(outDir, slug, jobId) {
  return join(jobDirFor(outDir, slug, jobId), "review");
}

export function selectionPathFor(outDir, slug, jobId) {
  return join(reviewDirFor(outDir, slug, jobId), "selection.json");
}

function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n", "utf8");
  renameSync(tmp, path);
}

export function getStoredReview(job) {
  const fp = job?.fingerprints?.review;
  if (!fp || typeof fp !== "object") return { revision: 0, sha256: null };
  return {
    revision: Number.isInteger(fp.revision) && fp.revision >= 0 ? fp.revision : 0,
    sha256: typeof fp.sha256 === "string" ? fp.sha256 : null,
  };
}

export function readSelectionFile(outDir, slug, jobId) {
  const p = selectionPathFor(outDir, slug, jobId);
  if (!existsSync(p)) return { found: false, path: p, selection: null, sha256: null };
  const raw = readFileSync(p, "utf8");
  const selection = JSON.parse(raw);
  const sha256 = createHash("sha256").update(Buffer.from(JSON.stringify(normalizeSelection(selection)), "utf8")).digest("hex");
  return { found: true, path: p, selection: normalizeSelection(selection), sha256, raw };
}

// Seed a review draft for a Job (test/setup path). Builds initial selection
// from candidate nodes when no draft exists. Returns {revision, fingerprint}.
export function seedReview(outDir, job, cands) {
  const dir = reviewDirFor(outDir, job.slug, job.jobId);
  mkdirSync(dir, { recursive: true });
  const initial = buildInitialSelection(cands);
  const fp = fingerprintSelection(initial);
  atomicWriteJson(selectionPathFor(outDir, job.slug, job.jobId), initial);
  job.fingerprints = { ...(job.fingerprints || {}), review: { revision: 1, sha256: fp } };
  return { selection: initial, revision: 1, fingerprint: fp };
}

function diskMismatch(outDir, job) {
  const stored = getStoredReview(job);
  const disk = readSelectionFile(outDir, job.slug, job.jobId);
  if (!disk.found) return { mismatch: stored.revision !== 0, reason: "missing-file", stored, disk };
  if (stored.sha256 && disk.sha256 !== stored.sha256) {
    return { mismatch: true, reason: "fingerprint-mismatch", stored, disk };
  }
  return { mismatch: false, reason: null, stored, disk };
}

// Load review model for GET: detects out-of-band disk edits via fingerprint.
// Never throws on missing draft: returns empty selection with revision 0.
export function loadReviewModel(outDir, job) {
  const stored = getStoredReview(job);
  const disk = readSelectionFile(outDir, job.slug, job.jobId);
  if (!disk.found) {
    return {
      selection: [],
      revision: stored.revision,
      fingerprint: stored.sha256,
      stale: stored.revision !== 0,
      staleReason: stored.revision !== 0 ? "missing-file" : null,
      warnings: [],
      duplicates: [],
      effectiveOrder: [],
    };
  }
  const stale = !!stored.sha256 && disk.sha256 !== stored.sha256;
  let warnings = [];
  let duplicates = [];
  let effectiveOrder = [];
  try {
    const v = validateForFinalize(disk.selection);
    warnings = v.warnings;
    duplicates = v.duplicates;
    effectiveOrder = v.effectiveOrder;
  } catch {
    warnings = ["invalid selection on disk"];
  }
  return {
    selection: disk.selection,
    revision: stored.revision,
    fingerprint: stored.sha256,
    stale,
    staleReason: stale ? "fingerprint-mismatch" : null,
    warnings,
    duplicates,
    effectiveOrder,
  };
}

// Scrape->Review handoff: seed the job-scoped review draft from the
// slug-dir selection.json the scrape wrote (CLI parity location). Runs once:
// when the job has no draft yet (revision 0). Uses the same POST-only writer
// (validation + fingerprint, never last-wins) so the workspace Review UI and
// finalize see exactly what the scrape produced. Returns {status, revision}.
export function importScrapeSelection(outDir, job) {
  const stored = getStoredReview(job);
  if (stored.revision !== 0) return { status: "already-seeded", revision: stored.revision };
  let raw;
  try {
    raw = readFileSync(join(outDir, job.slug, "review", "selection.json"), "utf8");
  } catch {
    return { status: "missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const e = new Error("scrape selection unreadable");
    e.code = "invalid-selection";
    throw e;
  }
  const saved = saveReviewState(outDir, job, { selection: parsed, editedFrom: 0 });
  return { status: "seeded", revision: saved.revision, kept: saved.selection.filter((s) => s.keep).length };
}

// POST-only save: validates + atomic-writes, bumps revision, updates
// fingerprint. Stale (editedFrom mismatch OR disk fingerprint drift) ->
// conflict, never last-wins.
export function saveReviewState(outDir, job, { selection, editedFrom } = {}) {
  const stored = getStoredReview(job);
  if (!Number.isInteger(editedFrom)) {
    const e = new Error("editedFrom revision required");
    e.code = "missing-revision";
    throw e;
  }
  if (editedFrom !== stored.revision) {
    const e = new Error(`stale: editedFrom ${editedFrom} != current ${stored.revision}`);
    e.code = "stale-conflict";
    e.current = stored;
    throw e;
  }
  const drift = diskMismatch(outDir, job);
  if (drift.mismatch) {
    const e = new Error(`stale: out-of-band edit (${drift.reason})`);
    e.code = "stale-conflict";
    e.current = stored;
    e.reason = drift.reason;
    throw e;
  }
  const v = validateSelectionShape(selection);
  if (!v.ok) {
    const e = new Error(`invalid selection: ${v.errors.join("; ")}`);
    e.code = "invalid-selection";
    throw e;
  }
  const norm = v.selection;
  const dir = reviewDirFor(outDir, job.slug, job.jobId);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(selectionPathFor(outDir, job.slug, job.jobId), norm);
  const fp = fingerprintSelection(norm);
  const revision = stored.revision + 1;
  job.fingerprints = { ...(job.fingerprints || {}), review: { revision, sha256: fp } };
  return { selection: norm, revision, fingerprint: fp };
}
