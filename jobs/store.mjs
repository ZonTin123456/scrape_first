// jobs/store.mjs — P2 Job record + state machine (no browser).
// Canonical: out/<slug>/jobs/<jobId>/job.json. Pointer: out/<slug>/job.json.
// Pure machine + fs persistence. No engine/browser/CLI imports.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const SPINE = [
  "idle",
  "probing",
  "waiting_for_page_selection",
  "scraping",
  "waiting_for_people_review",
  "finalizing",
  "detecting_backend",
  "dry_running",
  "dry_passed",
  "armed",
  "uploading",
  "done",
];

export const TERMINALS = ["failed", "cancelled"];
export const ALL_STAGES = [...SPINE, ...TERMINALS];
export const BLOCKER_TYPES = ["cloudflare", "cdp"];
export const ARM_STATES = ["none", "armed"];
export const WAITS = ["waiting_for_page_selection", "waiting_for_people_review"];
export const ARMED_STAGES = ["dry_passed", "armed"];

const SPINE_INDEX = new Map(SPINE.map((s, i) => [s, i]));

// Stage policy table: explicit dispositions; anything unlisted blocks by default.
export const STAGE_POLICY = {
  scraping: {
    "image-error": "allow",
    "image-failed": "allow",
    "image_download_failed": "allow",
  },
  probing: {
    "stage-error": "block",
    error: "block",
    "probe-failed": "block",
  },
  finalizing: {
    "stage-error": "block",
    error: "block",
  },
  detecting_backend: {
    "stage-error": "block",
    "detect-error": "block",
    error: "block",
  },
  dry_running: {
    ok: "allow",
    pass: "allow",
    "guard-red": "block",
    "row-failed": "block",
    "dry-partial": "amber",
    partial: "amber",
  },
  uploading: {
    ok: "allow",
    pass: "allow",
    "row-failed": "block",
    "guard-regression": "block",
    "guard-red": "block",
  },
};

export function evaluateStageResult(stage, outcome) {
  const table = STAGE_POLICY[stage];
  const disposition = table?.[outcome] ?? "block";
  return { stage, outcome, disposition };
}

export function applyStageResult(job, { outcome, detail = null } = {}) {
  assertJobShape(job);
  const { disposition } = evaluateStageResult(job.stage, outcome);
  if (disposition === "amber") {
    appendLedger(job, "stage:amber", `${job.stage}:${outcome}`, detail ? { detail } : {});
    touch(job);
    return { disposition, advanced: false };
  }
  if (disposition === "allow") {
    appendLedger(job, "stage:allowed", `${job.stage}:${outcome}`, detail ? { detail } : {});
    touch(job);
    return { disposition, advanced: false };
  }
  // block
  appendLedger(job, "stage:blocked", `${job.stage}:${outcome}`, detail ? { detail } : {});
  if (job.stage === "uploading") {
    // Upload blocking failure: terminal failed, written rows kept truthfully.
    consumeArm(job, { reason: `stage-block:${outcome}` });
    job.stage = "failed";
    appendLedger(job, "job:failed", `${outcome}`, detail ? { detail } : {});
  }
  // dry/probing/finalizing/detect blocking stays in place (G1 red), ledger records.
  // unclassified blocking by default also stays (except uploading above).
  touch(job);
  return { disposition, advanced: false };
}

// ---- ids ----

export function newJobId() {
  return `job_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function newDryRunId() {
  return `dry_${randomBytes(6).toString("hex")}`;
}

export function newSaveRunId() {
  return `save_${randomBytes(6).toString("hex")}`;
}

// ---- fingerprint ----

function stableStringify(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function computeSnapshotId(input = {}) {
  const {
    people = null,
    selection = null,
    sourceUrl = null,
    sourceGroup = null,
    backendOrigin = null,
    deptMapping = null,
    deptPlan = null,
    mappingVersion = null,
    profileVersion = null,
  } = input;
  // Selection normalized to keep/order meaning only; array order preserved.
  const normSelection = Array.isArray(selection)
    ? selection.map((s) => ({ seq: s.seq, keep: !!s.keep, order: Number(s.order ?? 0) }))
    : selection;
  const canonical = stableStringify({
    people,
    selection: normSelection,
    sourceUrl,
    sourceGroup,
    backendOrigin,
    deptMapping,
    deptPlan,
    mappingVersion,
    profileVersion,
  });
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `snap_${hash.slice(0, 16)}`;
}

// ---- paths ----

export function jobDirFor(outDir, slug, jobId) {
  return join(outDir, slug, "jobs", jobId);
}

export function jobPathFor(outDir, slug, jobId) {
  return join(jobDirFor(outDir, slug, jobId), "job.json");
}

export function pointerPathFor(outDir, slug) {
  return join(outDir, slug, "job.json");
}

export function getPointer(job) {
  return {
    jobId: job.jobId,
    slug: job.slug,
    stage: job.stage,
    updated_at: job.updated_at,
    snapshot_id: job.snapshot_id,
    dry_run_id: job.dry_run_id,
    save_run_id: job.save_run_id,
    jobPath: `jobs/${job.jobId}/job.json`,
  };
}

// ---- create / validate ----

function nowISO() {
  return new Date().toISOString();
}

export function createJob({ slug, source, group = "", jobId = null } = {}) {
  if (!slug || typeof slug !== "string") throw new Error("createJob: slug required");
  if (!source || typeof source !== "string") throw new Error("createJob: source URL required");
  const id = jobId ?? newJobId();
  const at = nowISO();
  const job = {
    jobId: id,
    source,
    group,
    slug,
    stage: "idle",
    blockers: [],
    attempts: 0,
    snapshot_id: null,
    dry_run_id: null,
    save_run_id: null,
    arm: { state: "none", attested: false, typed: null, dry_run_id: null },
    ledger: [{ at, kind: "job:created", message: `${slug} ${id}` }],
    artifacts: [],
    fingerprints: {},
    stopRequested: false,
    created_at: at,
    updated_at: at,
  };
  const v = validateJob(job);
  if (!v.ok) throw new Error(`createJob: invalid record: ${v.errors.join("; ")}`);
  return job;
}

export function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== "object") return { ok: false, errors: ["not-an-object"] };
  if (!job.jobId || typeof job.jobId !== "string") errors.push("jobId required");
  if (!job.slug || typeof job.slug !== "string") errors.push("slug required");
  if (!job.source || typeof job.source !== "string") errors.push("source required");
  if (typeof job.group !== "string") errors.push("group must be string");
  if (!ALL_STAGES.includes(job.stage)) errors.push(`unknown stage: ${job.stage}`);
  if (!Array.isArray(job.blockers)) errors.push("blockers must be array");
  else {
    for (const b of job.blockers) {
      if (!b || !BLOCKER_TYPES.includes(b.type)) errors.push(`bad blocker type: ${b?.type}`);
      if (!b?.at) errors.push("blocker at required");
    }
  }
  if (!Number.isInteger(job.attempts) || job.attempts < 0) errors.push("attempts must be int >=0");
  if (job.snapshot_id !== null && typeof job.snapshot_id !== "string") errors.push("snapshot_id must be string|null");
  if (job.dry_run_id !== null && typeof job.dry_run_id !== "string") errors.push("dry_run_id must be string|null");
  if (job.save_run_id !== null && typeof job.save_run_id !== "string") errors.push("save_run_id must be string|null");
  if (!job.arm || !ARM_STATES.includes(job.arm?.state)) errors.push("arm.state none|armed required");
  if (typeof job.arm?.attested !== "boolean") errors.push("arm.attested bool required");
  if (job.arm && job.arm.typed !== null && typeof job.arm.typed !== "string") errors.push("arm.typed string|null required");
  if (!Array.isArray(job.ledger)) errors.push("ledger must be array");
  if (!Array.isArray(job.artifacts)) errors.push("artifacts must be array");
  else {
    for (const a of job.artifacts) {
      if (!a || typeof a.kind !== "string" || !a.kind) errors.push("artifact kind required");
    }
  }
  if (!job.fingerprints || typeof job.fingerprints !== "object" || Array.isArray(job.fingerprints)) {
    errors.push("fingerprints must be object");
  }
  if (typeof job.created_at !== "string" || typeof job.updated_at !== "string") errors.push("timestamps required");
  return { ok: errors.length === 0, errors };
}

function assertJobShape(job) {
  const v = validateJob(job);
  if (!v.ok) throw new Error(`invalid job record: ${v.errors.join("; ")}`);
}

function touch(job) {
  job.updated_at = nowISO();
}

export function appendLedger(job, kind, message, extra = {}) {
  job.ledger.push({ at: nowISO(), kind, message, ...extra });
}

// ---- persistence ----

function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function writeJob(outDir, job) {
  assertJobShape(job);
  touch(job);
  const dir = jobDirFor(outDir, job.slug, job.jobId);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(jobPathFor(outDir, job.slug, job.jobId), job);
  mkdirSync(join(outDir, job.slug), { recursive: true });
  atomicWriteJson(pointerPathFor(outDir, job.slug), getPointer(job));
  return { jobPath: jobPathFor(outDir, job.slug, job.jobId), pointerPath: pointerPathFor(outDir, job.slug), job };
}

export function readJob(outDir, slug, jobId) {
  const p = jobPathFor(outDir, slug, jobId);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    const e = new Error(`job not found: ${slug}/${jobId}`);
    e.code = "not-found";
    throw e;
  }
  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    const e = new Error(`job corrupt (invalid JSON): ${slug}/${jobId}`);
    e.code = "corrupt";
    throw e;
  }
  const v = validateJob(job);
  if (!v.ok) {
    const e = new Error(`job invalid: ${v.errors.join("; ")}`);
    e.code = "invalid";
    e.errors = v.errors;
    throw e;
  }
  // Never infer stage from stray files: stage comes only from the record.
  return job;
}

export function readPointer(outDir, slug) {
  const p = pointerPathFor(outDir, slug);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    const e = new Error(`pointer not found: ${slug}`);
    e.code = "not-found";
    throw e;
  }
}

export function findJobById(outDir, jobId) {
  let entries = [];
  try {
    entries = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
    const p = jobPathFor(outDir, ent.name, jobId);
    if (existsSync(p)) {
      try {
        return { slug: ent.name, job: readJob(outDir, ent.name, jobId) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Restart: load record, validate artifacts/fingerprints, reconstruct projection.
// Never infers stage from stray files. Pure report; mutation via assessRestart.
export function loadForRestart(outDir, slug, jobId, { checkFiles = true } = {}) {
  const job = readJob(outDir, slug, jobId);
  const issues = [];
  if (job.fingerprints?.snapshot && job.snapshot_id && job.fingerprints.snapshot !== job.snapshot_id) {
    issues.push({ code: "fingerprint-mismatch", message: "fingerprints.snapshot != snapshot_id" });
  }
  if (checkFiles) {
    for (const a of job.artifacts) {
      if (!a.relPath) continue;
      const full = join(outDir, slug, a.relPath);
      if (!existsSync(full)) {
        issues.push({ code: "artifact-missing", message: a.relPath, kind: a.kind });
      }
    }
  }
  const projection = getPointer(job);
  return { job, issues, projection, valid: validateJob(job).ok };
}

// Pure restart guard: proof/fingerprint/artifact loss disarms dry_passed/armed.
export function assessRestart(job, { artifactsOk = true, fingerprintsOk = true, proofsOk = true, detail = null } = {}) {
  assertJobShape(job);
  const reasons = [];
  if (!artifactsOk) reasons.push("artifact-missing");
  if (!fingerprintsOk) reasons.push("fingerprint-mismatch");
  if (!proofsOk) reasons.push("proof-missing");
  const armedStage = ARMED_STAGES.includes(job.stage);
  if (reasons.length > 0 && armedStage) {
    consumeArm(job, { reason: `restart:${reasons.join(",")}` });
    job.stage = "dry_running";
    appendLedger(job, "job:disarmed", `restart guard: ${reasons.join(",")}`, detail ? { detail } : {});
    touch(job);
    return { job, disarmed: true, reasons };
  }
  if (reasons.length > 0) {
    appendLedger(job, "restart:issues", reasons.join(","), detail ? { detail } : {});
    touch(job);
  }
  return { job, disarmed: false, reasons };
}

// ---- transitions ----

export function isTerminal(stage) {
  return TERMINALS.includes(stage);
}

export function canAdvance(from, to) {
  if (!ALL_STAGES.includes(from) || !ALL_STAGES.includes(to)) return false;
  if (isTerminal(from) || from === "done") return false; // done/failed/cancelled never reopen
  if (from === to) return false;
  if (to === "failed") return true; // error path from any active stage
  if (to === "cancelled") return false; // must use requestCancel (prompt/stop semantics)
  if (to === "done") return from === "uploading";
  const fi = SPINE_INDEX.get(from);
  const ti = SPINE_INDEX.get(to);
  if (fi === undefined || ti === undefined) return false;
  // Gated edges require their functions: dry_passed->armed via grantArm (G2),
  // armed->uploading via beginUpload (consumes single-use arm).
  if (from === "dry_passed" && to === "armed") return false;
  if (from === "armed" && to === "uploading") return false;
  if (ti === fi + 1) return true; // linear spine incl. dry_passed->armed->uploading
  // Disarm backward edges (also reachable via notify*, kept explicit here).
  if ((from === "dry_passed" || from === "armed") && to === "dry_running") return true;
  // Structural re-detect: from dry area back to detecting_backend.
  if ((from === "dry_running" || from === "dry_passed" || from === "armed") && to === "detecting_backend") return true;
  return false;
}

export function advance(job, to, { reason = null } = {}) {
  assertJobShape(job);
  if (!canAdvance(job.stage, to)) {
    const e = new Error(`illegal transition: ${job.stage} -> ${to}`);
    e.code = "illegal-transition";
    throw e;
  }
  const from = job.stage;
  job.stage = to;
  if (to === "failed") consumeArm(job, { reason: reason ?? "failed" });
  appendLedger(job, "job:advanced", `${from} -> ${to}`, reason ? { reason } : {});
  touch(job);
  return job;
}

// Explicit retry: attempts++ + audit, re-enter last safe checkpoint same inputs.
export function retry(job, { to, reason = null } = {}) {
  assertJobShape(job);
  if (!to) throw new Error("retry: `to` checkpoint required");
  if (isTerminal(job.stage) || job.stage === "done") {
    const e = new Error(`retry from terminal ${job.stage}: create a new Job`);
    e.code = "terminal";
    throw e;
  }
  if (!ALL_STAGES.includes(to) || isTerminal(to) || to === "done") {
    const e = new Error(`retry: bad checkpoint ${to}`);
    e.code = "bad-checkpoint";
    throw e;
  }
  const fi = SPINE_INDEX.get(job.stage);
  const ti = SPINE_INDEX.get(to);
  if (ti === undefined || fi === undefined || ti > fi) {
    const e = new Error(`retry: checkpoint ${to} must be current or earlier than ${job.stage}`);
    e.code = "bad-checkpoint";
    throw e;
  }
  const from = job.stage;
  // Retreating out of a granted/proven stage consumes the single-use arm.
  if (ARMED_STAGES.includes(from) && !ARMED_STAGES.includes(to)) {
    consumeArm(job, { reason: reason ?? `retry:${from}->${to}` });
  }
  job.attempts += 1;
  job.stage = to;
  appendLedger(job, "job:retry", `${from} -> ${to} (attempt ${job.attempts})`, reason ? { reason } : {});
  touch(job);
  return job;
}

// Explicit resume only from waits to the next spine step.
export function resume(job, { reason = null } = {}) {
  assertJobShape(job);
  if (!WAITS.includes(job.stage)) {
    const e = new Error(`resume: stage ${job.stage} is not a wait`);
    e.code = "not-waiting";
    throw e;
  }
  const next = SPINE[SPINE_INDEX.get(job.stage) + 1];
  return advance(job, next, { reason: reason ?? "resume" });
}

// Upload never direct-resumes: minimum fresh dry_running->dry_passed->re-arm.
// Structural-mutation risk routes detecting_backend->dry_running->dry_passed->re-arm.
export function uploadResumePlan({ structural = false } = {}) {
  return structural
    ? ["detecting_backend", "dry_running", "dry_passed", "armed", "uploading"]
    : ["dry_running", "dry_passed", "armed", "uploading"];
}

// ---- blockers (orthogonal, preserve arm when proofs validate) ----

export function raiseBlocker(job, { type, ctx = null } = {}) {
  assertJobShape(job);
  if (!BLOCKER_TYPES.includes(type)) {
    const e = new Error(`bad blocker type: ${type}`);
    e.code = "bad-blocker";
    throw e;
  }
  job.blockers.push({ type, at: nowISO(), ctx });
  appendLedger(job, "blocker:raised", type, ctx ? { ctx } : {});
  touch(job);
  return job;
}

export function clearBlocker(job, type) {
  assertJobShape(job);
  if (!BLOCKER_TYPES.includes(type)) {
    const e = new Error(`bad blocker type: ${type}`);
    e.code = "bad-blocker";
    throw e;
  }
  const before = job.blockers.length;
  job.blockers = job.blockers.filter((b) => b.type !== type);
  if (job.blockers.length !== before) {
    appendLedger(job, "blocker:cleared", type);
    touch(job);
  }
  return job;
}

export function hasBlocker(job, type) {
  return job.blockers.some((b) => b.type === type);
}

// ---- arm (single-use) ----

export function grantArm(job, { attested, typed } = {}) {
  assertJobShape(job);
  if (job.stage !== "dry_passed") {
    const e = new Error(`grantArm: stage must be dry_passed (was ${job.stage})`);
    e.code = "bad-stage";
    throw e;
  }
  if (!job.snapshot_id || !job.dry_run_id) {
    const e = new Error("grantArm: snapshot_id + dry_run_id required (G1 fresh dry proof)");
    e.code = "missing-proof";
    throw e;
  }
  if (attested !== true || typed !== job.slug) {
    const e = new Error("grantArm: attestation + exact typed slug required (G2)");
    e.code = "g2-required";
    throw e;
  }
  // CF/CDP blockers are orthogonal: they do NOT block grant when proofs validate.
  job.arm = { state: "armed", attested: true, typed, dry_run_id: job.dry_run_id };
  job.stage = "armed";
  appendLedger(job, "arm:granted", `${job.dry_run_id} ${job.snapshot_id}`);
  touch(job);
  return job;
}

export function consumeArm(job, { reason = null } = {}) {
  const was = job.arm?.state === "armed";
  job.arm = { state: "none", attested: false, typed: null, dry_run_id: null };
  if (was) appendLedger(job, "arm:consumed", reason ?? "consumed");
  return was;
}

// Any real-upload attempt consumes the arm (single-use), even if it then fails.
export function beginUpload(job, { saveRunId = null, reason = null } = {}) {
  assertJobShape(job);
  if (job.stage !== "armed" || job.arm?.state !== "armed") {
    const e = new Error(`beginUpload: stage must be armed with live arm (was ${job.stage}/${job.arm?.state})`);
    e.code = "not-armed";
    throw e;
  }
  consumeArm(job, { reason: reason ?? "upload-attempt" });
  job.save_run_id = saveRunId ?? newSaveRunId();
  job.stopRequested = false;
  job.stage = "uploading";
  appendLedger(job, "upload:started", job.save_run_id, reason ? { reason } : {});
  touch(job);
  return job;
}

export function finishUpload(job, { reason = null } = {}) {
  assertJobShape(job);
  if (job.stage !== "uploading") {
    const e = new Error(`finishUpload: stage must be uploading (was ${job.stage})`);
    e.code = "bad-stage";
    throw e;
  }
  if (job.stopRequested) {
    const e = new Error("finishUpload: stop requested, use finishUploadRowAndCancel");
    e.code = "stop-requested";
    throw e;
  }
  job.stage = "done";
  job.stopRequested = false;
  appendLedger(job, "job:done", job.save_run_id ?? "", reason ? { reason } : {});
  touch(job);
  return job;
}

export function failJob(job, { reason = null } = {}) {
  assertJobShape(job);
  if (isTerminal(job.stage) || job.stage === "done") {
    const e = new Error(`failJob: terminal ${job.stage} never reopens`);
    e.code = "terminal";
    throw e;
  }
  consumeArm(job, { reason: reason ?? "failed" });
  job.stage = "failed";
  appendLedger(job, "job:failed", reason ?? "failed");
  touch(job);
  return job;
}

// ---- cancel (whole-Job idempotent, retains proofs) ----

export function requestCancel(job, { prompted = false, reason = null } = {}) {
  assertJobShape(job);
  if (job.stage === "cancelled") return job; // idempotent
  if (isTerminal(job.stage) || job.stage === "done") {
    const e = new Error(`cancel: terminal ${job.stage} already closed`);
    e.code = "terminal";
    throw e;
  }
  if (job.stage === "uploading") {
    if (job.stopRequested) return job; // repeated cancel idempotent
    job.stopRequested = true;
    appendLedger(job, "upload:stop_requested", "finish current row then cancel", reason ? { reason } : {});
    touch(job);
    return job;
  }
  if (prompted !== true) {
    const e = new Error("cancel: non-upload cancel requires explicit prompt confirmation");
    e.code = "prompt-required";
    throw e;
  }
  consumeArm(job, { reason: reason ?? "cancelled" });
  job.stage = "cancelled";
  appendLedger(job, "job:cancelled", reason ?? "cancelled");
  touch(job);
  return job;
}

// Upload path: finish current row truthfully, then enter cancelled. Consumes arm.
export function finishUploadRowAndCancel(job, { reason = null } = {}) {
  assertJobShape(job);
  if (job.stage === "cancelled") return job; // idempotent
  if (job.stage !== "uploading" || !job.stopRequested) {
    const e = new Error("finishUploadRowAndCancel: requires uploading + stop_requested");
    e.code = "bad-stage";
    throw e;
  }
  consumeArm(job, { reason: reason ?? "cancelled-after-row" });
  job.stage = "cancelled";
  job.stopRequested = false;
  appendLedger(job, "job:cancelled", `after current row: ${reason ?? "stop_requested"}`);
  touch(job);
  return job;
}

// ---- invalidation: fingerprint mutation / guard regression / proof loss ----

export function notifyFingerprintChanged(job, newSnapshotId, { reason = null } = {}) {
  assertJobShape(job);
  if (!newSnapshotId || typeof newSnapshotId !== "string") throw new Error("notifyFingerprintChanged: newSnapshotId required");
  const changed = job.snapshot_id !== newSnapshotId;
  job.snapshot_id = newSnapshotId;
  job.fingerprints = { ...job.fingerprints, snapshot: newSnapshotId };
  appendLedger(job, "fingerprint:changed", newSnapshotId, reason ? { reason } : {});
  let disarmed = false;
  if (changed && ARMED_STAGES.includes(job.stage)) {
    consumeArm(job, { reason: reason ?? "fingerprint-mutation" });
    job.stage = "dry_running";
    appendLedger(job, "job:disarmed", "fingerprint mutation -> dry_running");
    disarmed = true;
  }
  touch(job);
  return { job, disarmed };
}

export function notifyGuardRegression(job, { detail = null } = {}) {
  assertJobShape(job);
  appendLedger(job, "guard:regression", detail ?? "guard regression", detail ? { detail } : {});
  let disarmed = false;
  if (ARMED_STAGES.includes(job.stage)) {
    consumeArm(job, { reason: "guard-regression" });
    job.stage = "dry_running";
    appendLedger(job, "job:disarmed", "guard regression -> dry_running");
    disarmed = true;
  }
  touch(job);
  return { job, disarmed };
}

export function notifyProofLost(job, { detail = null } = {}) {
  assertJobShape(job);
  appendLedger(job, "proof:lost", detail ?? "proof lost", detail ? { detail } : {});
  let disarmed = false;
  if (ARMED_STAGES.includes(job.stage)) {
    consumeArm(job, { reason: "proof-loss" });
    job.stage = "dry_running";
    appendLedger(job, "job:disarmed", "proof loss -> dry_running");
    disarmed = true;
  }
  touch(job);
  return { job, disarmed };
}

// ---- artifacts ----

export function addArtifact(job, { kind, url = null, relPath = null, sha256 = null, byteLength = null } = {}) {
  assertJobShape(job);
  if (!kind || typeof kind !== "string") throw new Error("addArtifact: kind required");
  job.artifacts.push({ kind, url, relPath, sha256, byteLength });
  appendLedger(job, "artifact:written", kind, relPath ? { relPath } : {});
  touch(job);
  return job;
}

// ---- single-flight v1: one active engine op globally ----

let activeEngineOp = null;

export function claimEngineOp(jobId, op = "engine") {
  if (!jobId) throw new Error("claimEngineOp: jobId required");
  if (activeEngineOp && activeEngineOp.jobId !== jobId) {
    const e = new Error(`single-flight: ${activeEngineOp.jobId}:${activeEngineOp.op} active, ${jobId}:${op} refused`);
    e.code = "single-flight";
    throw e;
  }
  if (!activeEngineOp) {
    activeEngineOp = { jobId, op, at: nowISO() };
  }
  return { ...activeEngineOp };
}

export function releaseEngineOp(jobId = null) {
  if (activeEngineOp && (!jobId || activeEngineOp.jobId === jobId)) {
    activeEngineOp = null;
  }
  return null;
}

export function currentEngineOp() {
  return activeEngineOp ? { ...activeEngineOp } : null;
}

export function resetEngineOp() {
  activeEngineOp = null;
}
