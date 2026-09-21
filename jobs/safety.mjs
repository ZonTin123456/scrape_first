// jobs/safety.mjs — P6 Safety: trinity visibility bundle, G1/G2 gates, immutable proofs.
// UI + CLI both enforce through this module. No browser/CLI/service imports:
// only node builtins + ./store.mjs (state contract) + ./events.mjs (pointer shape).
// Disarm/consume rules live in store.mjs; this module wires them into the gates.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addArtifact,
  advance,
  appendLedger,
  beginUpload,
  computeSnapshotId,
  consumeArm,
  grantArm,
  jobDirFor,
  newDryRunId,
  newSaveRunId,
} from "./store.mjs";
import { assertArtifactPointer } from "./events.mjs";

export const MODES = ["discover", "dry", "real"];

// Undroppable visibility bundle sections. The bundle object MUST carry every
// key; empty arrays allowed, missing keys throw. UI renders all sections or an
// explicit pending note — never silently drops one.
export const VISIBILITY_SECTIONS = [
  "source",
  "group",
  "destinationOrigin",
  "targetDepts",
  "wouldCreate",
  "identity",
  "unmapped",
  "counts",
  "rows",
  "proofs",
];

// Row statuses (CLI report taxonomy + job-layer unresolved).
const FAILED = new Set(["failed"]);
const WOULD_CREATE_STATUS = new Set(["skip-would-create"]);
const UNRESOLVED = new Set(["unresolved"]);
const PARTIAL = new Set(["dry-partial", "created-partial"]);

// G2 exact attestation copy. Template pinned by plan §Safety contract:
// checkbox "I reviewed dry report <dry_run_id> and all <N> screenshots for
// snapshot <short>". short = full snapshot_id (unambiguous, exact match).
export function attestationText({ dryRunId, shotCount, snapshotId } = {}) {
  if (!dryRunId || typeof dryRunId !== "string") throw new Error("attestationText: dryRunId required");
  if (!Number.isInteger(shotCount) || shotCount < 0) throw new Error("attestationText: shotCount int >=0 required");
  if (!snapshotId || typeof snapshotId !== "string") throw new Error("attestationText: snapshotId required");
  return `I reviewed dry report ${dryRunId} and all ${shotCount} screenshots for snapshot ${snapshotId}`;
}

// ---- row policy ----
// any failed blocks. pinned-map would-create/unresolved blocks. zero-map
// would-create is a listed path only: real may create then must rediscover +
// re-gate + identity-verify before row writes (listedPath proves the three).
// dry-partial amber allowed with warnings.
export function evaluateRowPolicy(rows, { mapMode = "pinned", wouldCreate = [], listedPath = null } = {}) {
  if (!Array.isArray(rows)) throw new Error("evaluateRowPolicy: rows array required");
  if (mapMode !== "pinned" && mapMode !== "zero") throw new Error("evaluateRowPolicy: mapMode pinned|zero required");
  const list = Array.isArray(wouldCreate) ? wouldCreate : [];
  const reasons = [];
  const warnings = [];
  const failed = rows.filter((r) => FAILED.has(r?.status));
  const unresolved = rows.filter((r) => UNRESOLVED.has(r?.status));
  const wouldRows = rows.filter((r) => WOULD_CREATE_STATUS.has(r?.status));
  const partial = rows.filter((r) => PARTIAL.has(r?.status));
  if (failed.length) {
    reasons.push(`row-failed: seq ${failed.map((r) => r.seq).join(",")} — G1 red until rows pass`);
  }
  if (unresolved.length) {
    reasons.push(`unresolved: seq ${unresolved.map((r) => r.seq).join(",")} — resolve targets before gating`);
  }
  const wouldTotal = wouldRows.length + list.length;
  if (wouldTotal > 0 && mapMode === "pinned") {
    reasons.push(
      `pinned-would-create: ${wouldTotal} would-create (seq ${wouldRows.map((r) => r.seq).join(",") || "—"}; list ${list.join(",") || "—"}) — pinned map cannot auto-create, re-run zero-map discovery`
    );
  }
  if (wouldTotal > 0 && mapMode === "zero") {
    const lp = listedPath || {};
    const missing = ["rediscovered", "regated", "identityVerified"].filter((k) => lp[k] !== true);
    if (missing.length) {
      reasons.push(
        `zero-would-create-unverified: missing ${missing.join(",")} — real may create then must rediscover + re-gate + verify identity before row writes`
      );
    } else {
      warnings.push(`listed-path: ${wouldTotal} would-create verified (rediscovered + re-gated + identity-verified)`);
    }
  }
  if (partial.length) {
    warnings.push(`dry-partial amber: seq ${partial.map((r) => r.seq).join(",")} allowed with ledger warnings`);
  }
  const skipped = wouldRows.length;
  const counts = {
    total: rows.length,
    failed: failed.length,
    unresolved: unresolved.length,
    wouldCreate: wouldTotal,
    partial: partial.length,
    skipped,
  };
  const ok = reasons.length === 0;
  return { ok, code: ok ? "ok" : "blocked", reasons, warnings, counts };
}

// Shared guard-status gate: red or unknown blocks G1 fail-closed.
// Single source for checkGate1 + recordDryPass (identical wording).
export function guardStatusReason(guardStatus) {
  if (guardStatus === "red") return "guard red: group/host/field/identity gate failing — G1 red";
  if (guardStatus !== "green") return `guard unknown status: ${guardStatus}`;
  return null;
}
// ---- G1: all-green + fresh dry for SAME snapshot, else Real disabled ----
export function checkGate1(
  job,
  {
    rows = [],
    mapMode = "pinned",
    wouldCreate = [],
    listedPath = null,
    guardStatus = "green",
    dryVerified = false,
    snapshotFresh = false,
  } = {}
) {
  if (!job || typeof job !== "object") throw new Error("checkGate1: job required");
  const reasons = [];
  const warnings = [];
  if (!job.snapshot_id) reasons.push("no snapshot: run dry first");
  if (!job.dry_run_id) reasons.push("no fresh dry for this snapshot: run dry first");
  if (job.snapshot_id && job.dry_run_id && !snapshotFresh) {
    reasons.push(`snapshot stale or unverified (${job.snapshot_id}): any material change re-dries`);
  }
  if (job.dry_run_id && !dryVerified) reasons.push(`dry proof missing or invalid (${job.dry_run_id}): fail closed`);
  const guardReason = guardStatusReason(guardStatus);
  if (guardReason) reasons.push(guardReason);
  const policy = evaluateRowPolicy(rows, { mapMode, wouldCreate, listedPath });
  for (const r of policy.reasons) reasons.push(r);
  for (const w of policy.warnings) warnings.push(w);
  const ok = reasons.length === 0;
  let attestation = null;
  if (ok) {
    attestation = attestationText({
      dryRunId: job.dry_run_id,
      shotCount: proofShotCount(job),
      snapshotId: job.snapshot_id,
    });
  }
  return { ok, code: ok ? "green" : "red", reasons, warnings, counts: policy.counts, attestation };
}

// Shot count for the attestation line comes from recorded dry-report shot
// artifacts (kind includes "shot"). Falls back to 0 when none recorded yet.
export function proofShotCount(job) {
  if (!job || !Array.isArray(job.artifacts)) return 0;
  return job.artifacts.filter((a) => /shot/i.test(a?.kind || "") && a?.sha256).length;
}

// ---- G2: exact attestation copy + typed slug + click, all mandatory ----
export function checkGate2({ attestedText, expectedAttestation, typed, slug, clicked } = {}) {
  const reasons = [];
  if (typeof expectedAttestation !== "string" || !expectedAttestation) {
    reasons.push("no expected attestation: G1 must pass first");
  } else if (attestedText !== expectedAttestation) {
    reasons.push("attestation copy mismatch: check the exact dry-report text");
  }
  if (typeof slug !== "string" || !slug) reasons.push("no slug: job slug required");
  else if (typed !== slug) reasons.push("typed slug mismatch: type the exact slug");
  if (clicked !== true) reasons.push("click required: arm button must be clicked");
  return { ok: reasons.length === 0, reasons };
}

// ---- proofs (immutable, sha256, save references prerequisite dry) ----

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function stableStringify(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function dryReportPathFor(outDir, slug, jobId, dryRunId) {
  return join(jobDirFor(outDir, slug, jobId), `dry-${dryRunId}.json`);
}

export function saveReportPathFor(outDir, slug, jobId, saveRunId) {
  return join(jobDirFor(outDir, slug, jobId), `save-${saveRunId}.json`);
}

function atomicWriteNew(path, bytes) {
  if (existsSync(path)) {
    const e = new Error(`proof immutable: ${path} already exists, never overwrite`);
    e.code = "proof-exists";
    throw e;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function normalizeDryRow(r) {
  if (!r || typeof r !== "object") throw new Error("dry row must be object");
  const seq = Number(r.seq);
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`dry row bad seq: ${r.seq}`);
  if (!r.status || typeof r.status !== "string") throw new Error(`dry row seq ${seq}: status required`);
  return {
    seq,
    status: r.status,
    name: r.name != null ? String(r.name) : null,
    group: r.group != null ? String(r.group) : null,
    target: r.target != null ? String(r.target) : null,
    detail: r.detail != null ? String(r.detail).slice(0, 300) : null,
  };
}

// Record a dry pass: enforces G1 (row policy + guard), mints dry_run_id,
// writes the immutable dry report (sha256), registers proof artifacts
// (report + shots, sha256 required), advances dry_running -> dry_passed.
// Throws code gate1-failed (fail closed, stays dry_running) on any block.
export function recordDryPass(
  outDir,
  job,
  {
    snapshotInput = null,
    snapshotId = null,
    rows = [],
    mapMode = "pinned",
    guardStatus = "green",
    listedPath = null,
    destinationOrigin = null,
    targetDepts = [],
    wouldCreate = [],
    identity = null,
    unmapped = [],
    shots = [],
  } = {}
) {
  if (!outDir || typeof outDir !== "string") throw new Error("recordDryPass: outDir required");
  if (!job || typeof job !== "object") throw new Error("recordDryPass: job required");
  if (job.stage !== "dry_running") {
    const e = new Error(`recordDryPass: stage must be dry_running (was ${job.stage})`);
    e.code = "bad-stage";
    throw e;
  }
  const snap = snapshotId ?? (snapshotInput ? computeSnapshotId(snapshotInput) : null);
  if (!snap || typeof snap !== "string") {
    const e = new Error("recordDryPass: snapshotInput or snapshotId required");
    e.code = "missing-snapshot";
    throw e;
  }
  const normRows = (Array.isArray(rows) ? rows : []).map(normalizeDryRow);
  const normShots = Array.isArray(shots) ? shots : [];
  for (const s of normShots) {
    assertArtifactPointer({ kind: "shot", url: s.url ?? null, relPath: s.relPath ?? null, sha256: s.sha256, byteLength: s.byteLength ?? null });
    if (!s.sha256 || !Number.isInteger(s.byteLength)) {
      const e = new Error("recordDryPass: every shot proof requires sha256 + byteLength");
      e.code = "bad-artifact";
      throw e;
    }
  }
  const policy = evaluateRowPolicy(normRows, { mapMode, wouldCreate, listedPath });
  const gateReasons = [];
  const guardReason = guardStatusReason(guardStatus);
  if (guardReason) gateReasons.push(guardReason);
  for (const r of policy.reasons) gateReasons.push(r);
  if (gateReasons.length) {
    appendLedger(job, "gate:failed", `G1 red: ${gateReasons.join("; ").slice(0, 300)}`);
    const e = new Error(`G1 red: ${gateReasons.join("; ")}`);
    e.code = "gate1-failed";
    e.reasons = gateReasons;
    e.ledgered = true; // detail already on the record; callers only persist it
    throw e;
  }
  const dryRunId = newDryRunId();
  job.snapshot_id = snap;
  job.fingerprints = { ...(job.fingerprints || {}), snapshot: snap };
  job.dry_run_id = dryRunId;
  const report = {
    dry_run_id: dryRunId,
    snapshot_id: snap,
    slug: job.slug,
    jobId: job.jobId,
    mode: "dry",
    mapMode,
    guardStatus,
    destinationOrigin,
    targetDepts: Array.isArray(targetDepts) ? targetDepts : [],
    wouldCreate: Array.isArray(wouldCreate) ? wouldCreate : [],
    identity: identity ?? null,
    unmapped: Array.isArray(unmapped) ? unmapped : [],
    counts: policy.counts,
    rows: normRows,
    shots: normShots.map((s) => ({
      relPath: s.relPath ?? null,
      url: s.url ?? null,
      sha256: s.sha256,
      byteLength: s.byteLength,
    })),
    warnings: policy.warnings,
    created_at: new Date().toISOString(),
  };
  const bytes = Buffer.from(stableStringify(report), "utf8");
  const sha256 = sha256Hex(bytes);
  const relPath = `jobs/${job.jobId}/dry-${dryRunId}.json`;
  const absPath = dryReportPathFor(outDir, job.slug, job.jobId, dryRunId);
  atomicWriteNew(absPath, bytes);
  addArtifact(job, { kind: "dry-report", url: null, relPath, sha256, byteLength: bytes.length });
  for (const s of normShots) {
    addArtifact(job, {
      kind: "shot",
      url: s.url ?? null,
      relPath: s.relPath ?? null,
      sha256: s.sha256,
      byteLength: s.byteLength,
    });
  }
  for (const w of policy.warnings) appendLedger(job, "stage:amber", w);
  advance(job, "dry_passed", { reason: `dry ${dryRunId}` });
  const attestation = attestationText({ dryRunId, shotCount: normShots.length, snapshotId: snap });
  return {
    dryRunId,
    snapshotId: snap,
    sha256,
    byteLength: bytes.length,
    relPath,
    attestation,
    warnings: policy.warnings,
    counts: policy.counts,
  };
}

export function readDryReport(outDir, slug, jobId, dryRunId) {
  const p = dryReportPathFor(outDir, slug, jobId, dryRunId);
  let raw;
  try {
    raw = readFileSync(p);
  } catch {
    const e = new Error(`dry proof not found: ${dryRunId}`);
    e.code = "proof-missing";
    throw e;
  }
  let report;
  try {
    report = JSON.parse(raw.toString("utf8"));
  } catch {
    const e = new Error(`dry proof corrupt: ${dryRunId}`);
    e.code = "proof-corrupt";
    throw e;
  }
  return { report, sha256: sha256Hex(raw), byteLength: raw.length, relPath: `jobs/${jobId}/dry-${dryRunId}.json` };
}

// Fail closed: dry proof verifies only when the file exists, its sha256
// matches bytes, and ids match the job's current snapshot/dry pair.
export function verifyDryReport(outDir, job, { expectedDryRunId = null, expectedSnapshotId = null } = {}) {
  const reasons = [];
  const dryId = expectedDryRunId ?? job?.dry_run_id;
  const snapId = expectedSnapshotId ?? job?.snapshot_id;
  if (!dryId) reasons.push("no dry_run_id: run dry first");
  if (!snapId) reasons.push("no snapshot_id: run dry first");
  if (reasons.length) return { ok: false, reasons, report: null };
  let loaded;
  try {
    loaded = readDryReport(outDir, job.slug, job.jobId, dryId);
  } catch (e) {
    return { ok: false, reasons: [`dry proof unreadable: ${e.code ?? e.message}`], report: null };
  }
  if (loaded.report?.dry_run_id !== dryId) reasons.push("dry proof id drift");
  if (loaded.report?.snapshot_id !== snapId) {
    reasons.push(`dry proof snapshot ${loaded.report?.snapshot_id} != current ${snapId}: re-dry`);
  }
  const art = (job.artifacts || []).find((a) => a?.kind === "dry-report" && a?.relPath === loaded.relPath);
  if (!art) reasons.push("dry proof artifact not registered on job record");
  else if (art.sha256 !== loaded.sha256) reasons.push("dry proof sha256 drift: immutable proof violated");
  return { ok: reasons.length === 0, reasons, report: loaded.report, sha256: loaded.sha256 };
}

// Real-upload entry with proof: verifies the prerequisite dry first (fail
// closed), consumes the single-use arm via beginUpload, then writes the
// immutable save report referencing that dry. Any attempt consumes the arm,
// even when the save write then fails (consume happens in beginUpload).
export function beginUploadWithProof(outDir, job, { saveRunId = null } = {}) {
  if (!outDir || typeof outDir !== "string") throw new Error("beginUploadWithProof: outDir required");
  if (!job || typeof job !== "object") throw new Error("beginUploadWithProof: job required");
  const pre = verifyDryReport(outDir, job);
  if (!pre.ok) {
    const e = new Error(`save refused: prerequisite dry invalid — ${pre.reasons.join("; ")}`);
    e.code = "missing-proof";
    e.reasons = pre.reasons;
    throw e;
  }
  const saveId = saveRunId ?? newSaveRunId();
  beginUpload(job, { saveRunId: saveId, reason: "safety G1+G2 passed" });
  const report = {
    save_run_id: saveId,
    dry_run_id: job.dry_run_id,
    snapshot_id: job.snapshot_id,
    slug: job.slug,
    jobId: job.jobId,
    mode: "save",
    dry_report_sha256: pre.sha256,
    created_at: new Date().toISOString(),
  };
  const bytes = Buffer.from(stableStringify(report), "utf8");
  const sha256 = sha256Hex(bytes);
  const relPath = `jobs/${job.jobId}/save-${saveId}.json`;
  try {
    atomicWriteNew(saveReportPathFor(outDir, job.slug, job.jobId, saveId), bytes);
  } catch (e) {
    // Arm already consumed by beginUpload (single-use attempt rule); the job
    // stays uploading with a ledger note so the failure is truthful.
    appendLedger(job, "upload:report-unwritten", `${saveId}: ${e.code ?? e.message}`);
    throw e;
  }
  addArtifact(job, { kind: "save-report", url: null, relPath, sha256, byteLength: bytes.length });
  return { saveRunId: saveId, dryRunId: job.dry_run_id, sha256, byteLength: bytes.length, relPath };
}

// G2 arm entry: G1 must currently pass (fresh dry, verified proof, green
// rows/guards) AND the exact attestation copy + typed slug + click must all
// hold. Then store.grantArm (single-use arm). Emits ledger via store.
export function grantArmFromSafety(outDir, job, { attestedText, typed, clicked } = {}) {
  if (!outDir || typeof outDir !== "string") throw new Error("grantArmFromSafety: outDir required");
  if (!job || typeof job !== "object") throw new Error("grantArmFromSafety: job required");
  if (job.stage !== "dry_passed") {
    const e = new Error(`grantArm: stage must be dry_passed (was ${job.stage})`);
    e.code = "bad-stage";
    throw e;
  }
  const pre = verifyDryReport(outDir, job);
  const dry = pre.report;
  const g1 = checkGate1(job, {
    rows: Array.isArray(dry?.rows) ? dry.rows : [],
    mapMode: dry?.mapMode ?? "pinned",
    wouldCreate: Array.isArray(dry?.wouldCreate) ? dry.wouldCreate : [],
    listedPath: dry?.listedPath ?? null,
    guardStatus: dry?.guardStatus ?? "green",
    dryVerified: pre.ok,
    snapshotFresh: pre.ok,
  });
  if (!g1.ok) {
    appendLedger(job, "gate:failed", `G1 red at arm: ${g1.reasons.join("; ").slice(0, 300)}`);
    const e = new Error(`G1 red: ${g1.reasons.join("; ")}`);
    e.code = "gate1-failed";
    e.reasons = g1.reasons;
    throw e;
  }
  const expected = attestationText({
    dryRunId: job.dry_run_id,
    shotCount: Array.isArray(dry?.shots) ? dry.shots.length : 0,
    snapshotId: job.snapshot_id,
  });
  const g2 = checkGate2({ attestedText, expectedAttestation: expected, typed, slug: job.slug, clicked });
  if (!g2.ok) {
    appendLedger(job, "gate:failed", `G2 refused: ${g2.reasons.join("; ").slice(0, 300)}`);
    const e = new Error(`G2 refused: ${g2.reasons.join("; ")}`);
    e.code = "g2-required";
    e.reasons = g2.reasons;
    throw e;
  }
  grantArm(job, { attested: true, typed });
  return { armed: true, dryRunId: job.dry_run_id, attestation: expected };
}

// ---- visibility bundle (undroppable) ----

export function buildSafetyBundle(
  job,
  {
    destinationOrigin,
    targetDepts,
    wouldCreate,
    identity,
    unmapped,
    rows,
    proofs,
  } = {}
) {
  if (!job || typeof job !== "object") throw new Error("buildSafetyBundle: job required");
  const present = { destinationOrigin, targetDepts, wouldCreate, identity, unmapped, rows, proofs };
  const missing = VISIBILITY_SECTIONS.filter((k) => {
    if (k === "source") return job.source == null;
    if (k === "group") return job.group == null;
    if (k === "counts") return false; // derived, always present
    return present[k] === undefined;
  });
  if (missing.length) {
    const e = new Error(`visibility bundle drops sections: ${missing.join(",")}`);
    e.code = "bundle-incomplete";
    e.missing = missing;
    throw e;
  }
  const normRows = (Array.isArray(rows) ? rows : []).map((r) => ({
    seq: Number(r?.seq),
    name: r?.name ?? null,
    group: r?.group ?? null,
    target: r?.target ?? null,
    status: r?.status ?? null,
    detail: r?.detail ?? null,
  }));
  const byStatus = normRows.reduce((m, r) => {
    m[r.status] = (m[r.status] || 0) + 1;
    return m;
  }, {});
  return {
    source: job.source,
    group: job.group,
    slug: job.slug,
    stage: job.stage,
    arm: job.arm?.state ?? "none",
    snapshot_id: job.snapshot_id,
    dry_run_id: job.dry_run_id,
    save_run_id: job.save_run_id,
    destinationOrigin,
    targetDepts: Array.isArray(targetDepts) ? targetDepts : [],
    wouldCreate: Array.isArray(wouldCreate) ? wouldCreate : [],
    identity,
    unmapped: Array.isArray(unmapped) ? unmapped : [],
    counts: {
      total: normRows.length,
      unmapped: Array.isArray(unmapped) ? unmapped.length : 0,
      partial: normRows.filter((r) => PARTIAL.has(r.status)).length,
      skipped: normRows.filter((r) => WOULD_CREATE_STATUS.has(r.status)).length,
      failed: normRows.filter((r) => FAILED.has(r.status)).length,
      byStatus,
    },
    rows: normRows,
    proofs: Array.isArray(proofs) ? proofs : [],
  };
}

// Server GET /jobs/:id/safety model: bundle from the recorded dry proof
// (null + explicit pending sections before any dry), live G1 status, and the
// G2 requirement shape. Never infers rows from logs or stray files.
export function safetyModel(outDir, job) {
  if (!job || typeof job !== "object") throw new Error("safetyModel: job required");
  let dry = null;
  let dryVerified = false;
  let snapshotFresh = false;
  let verifyReasons = [];
  if (job.dry_run_id) {
    const v = verifyDryReport(outDir, job);
    dryVerified = v.ok;
    snapshotFresh = v.ok;
    verifyReasons = v.reasons;
    dry = v.report;
  } else {
    verifyReasons = ["no dry yet: run dry first"];
  }
  let bundle = null;
  if (dry) {
    const proofs = (job.artifacts || [])
      .filter((a) => /report|shot|proof/i.test(a?.kind || ""))
      .map((a) => ({ kind: a.kind, relPath: a.relPath ?? null, url: a.url ?? null, sha256: a.sha256 ?? null, byteLength: a.byteLength ?? null }));
    bundle = buildSafetyBundle(job, {
      destinationOrigin: dry.destinationOrigin ?? null,
      targetDepts: dry.targetDepts ?? [],
      wouldCreate: dry.wouldCreate ?? [],
      identity: dry.identity ?? null,
      unmapped: dry.unmapped ?? [],
      rows: dry.rows ?? [],
      proofs,
    });
  }
  const gate1 = checkGate1(job, {
    rows: Array.isArray(dry?.rows) ? dry.rows : [],
    mapMode: dry?.mapMode ?? "pinned",
    wouldCreate: Array.isArray(dry?.wouldCreate) ? dry.wouldCreate : [],
    listedPath: dry?.listedPath ?? null,
    guardStatus: dry?.guardStatus ?? (job.dry_run_id ? "green" : "unknown"),
    dryVerified,
    snapshotFresh,
  });
  // Attestation preview for G2: exact text the checkbox must carry.
  let attestation = gate1.attestation;
  if (!attestation && job.dry_run_id && job.snapshot_id) {
    try {
      attestation = attestationText({
        dryRunId: job.dry_run_id,
        shotCount: Array.isArray(dry?.shots) ? dry.shots.length : proofShotCount(job),
        snapshotId: job.snapshot_id,
      });
    } catch {
      attestation = null;
    }
  }
  return {
    jobId: job.jobId,
    slug: job.slug,
    stage: job.stage,
    arm: job.arm?.state ?? "none",
    snapshot_id: job.snapshot_id,
    dry_run_id: job.dry_run_id,
    save_run_id: job.save_run_id,
    available: bundle !== null,
    pending: bundle === null ? [...VISIBILITY_SECTIONS] : [],
    bundle,
    gate1: { ...gate1, verifyReasons },
    gate2: {
      required: ["attestation-copy", "typed-slug", "click"],
      attestation,
      armed: job.arm?.state === "armed",
    },
  };
}

export { consumeArm };
