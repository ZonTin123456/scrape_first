// jobs/pipeline.mjs — P7 Pipeline DAG as job ops.
// Canonical DAG + in-process executor for the UI path. No child processes,
// no stdin pauses: human steps become approval gates (approval events),
// --yes becomes the autoApprove option. CLI files (pipeline.mjs, backup-page.mjs,
// upload-people.mjs) keep working over the same DAG; this module mirrors their
// step list/ordering and drives the same staging files through injected
// in-process runners. Only node builtins + ./store.mjs + ./safety.mjs + ./review.mjs.
// Never imports CLI entries (reuse boundary: UI imports Lift + Wrap cores only).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { advance, appendLedger, canAdvance, claimEngineOp, clearBlocker, failJob, findJobById, finishUpload, finishUploadRowAndCancel, hasBlocker, isTerminal, notifyGuardRegression, notifyProofLost, raiseBlocker, readJob, releaseEngineOp, SPINE, writeJob } from "./store.mjs";
import {
  beginUploadWithProof,
  grantArmFromSafety,
  recordDryPass,
  verifyDryReport,
} from "./safety.mjs";
import { importScrapeSelection, loadReviewModel, validateForFinalize } from "./review.mjs";
import { checkPageApproval, recordPageApproval } from "./pages.mjs";
import { realEngine } from "./engine-cdp.mjs";

// Same DAG as pipeline.mjs:31 (parity pinned in tests/pipeline.test.mjs).
export const ALL = ["probe", "pick-links", "master", "apply-master", "run", "pick-images", "finalize", "upload"];

// Steps that pause for a human on the CLI path (pipeline.mjs pause()).
// On the UI path they become approval gates awaiting UI approval events.
export const HUMAN_STEPS = ["pick-links", "master", "pick-images"];

export const STAGING_DIR = "_staging";

// DAG step -> job spine stage entered before the step runs.
// Upload walks only to detecting_backend; dry/arm/uploading/done go through
// the safety functions (G1/G2 enforced, single-use arm).
export const STEP_STAGES = {
  probe: "probing",
  "pick-links": "waiting_for_page_selection",
  master: "waiting_for_page_selection",
  "apply-master": "waiting_for_page_selection",
  run: "scraping",
  "pick-images": "waiting_for_people_review",
  finalize: "finalizing",
  upload: "detecting_backend",
};

// Staging/output files remain the step contract (explore §6).
export const STAGING_CONTRACT = {
  probe: {
    reads: ["<from> urls.txt"],
    writes: [
      "_staging/picked-links.json",
      "_staging/pick-links.html",
      "_staging/master.json",
      "_staging/master-pick.html",
      "_staging/<slug>/probe.json",
      "_staging/<slug>/picked-images.json",
      "_staging/<slug>/pick-images.html",
    ],
  },
  "pick-links": { reads: ["_staging/pick-links.html"], writes: ["_staging/picked-links.json"], human: true },
  master: { reads: ["_staging/master-pick.html"], writes: ["_staging/master.json"], human: true },
  "apply-master": { reads: ["_staging/master.json"], writes: ["_staging/<slug>/picked-images.json"] },
  run: {
    reads: ["_staging/picked-links.json"],
    writes: ["<slug>/content.json", "<slug>/people.json", "<slug>/images/*", "<slug>/review/selection.json", "<slug>/review/index.html"],
  },
  "pick-images": { reads: ["_staging/<slug>/pick-images.html"], writes: ["_staging/<slug>/picked-images.json"], human: true },
  finalize: { reads: ["summary.json", "<dir>/review/selection.json"], writes: ["<dir>/content.json (manifest.reviewed)"] },
  upload: {
    reads: ["summary.json", "<dir>/people.json"],
    writes: ["uploader/report-<slug>.json", "uploader/shots/<slug>/*.png", "jobs/<jobId>/save-<id>.json (job-layer proof)"],
  },
};

export function describePipeline() {
  return ALL.map((step) => ({
    step,
    stage: STEP_STAGES[step],
    human: HUMAN_STEPS.includes(step),
    reads: STAGING_CONTRACT[step]?.reads ?? [],
    writes: STAGING_CONTRACT[step]?.writes ?? [],
  }));
}

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  throw e;
}

function emit(hub, jobId, type, payload) {
  try {
    return hub?.emit(jobId, type, payload ?? {}) ?? null;
  } catch {
    return null;
  }
}

// Shared ledger + persist + notify triple for pipeline steps.
function commitStep(outDir, job, hub, { ledgerKind, ledgerMessage, ledgerExtra, emitType, emitPayload }) {
  if (ledgerKind) appendLedger(job, ledgerKind, ledgerMessage, ledgerExtra ?? {});
  writeJob(outDir, job);
  if (emitType) emit(hub, job.jobId, emitType, emitPayload ?? {});
}

// Same-job re-entry guard (finding 5): claimEngineOp is re-entrant for the
// same job by primitive contract (tests/jobs-state.test.mjs), so the engine
// entry point tracks active pipeline runs itself and refuses a second run on
// the same job while one holds the claim. Released in finally, even on throw.
const activePipelineJobs = new Set();

export function currentPipelineJobs() {
  return [...activePipelineJobs];
}

// Step selection, mirrors pipeline.mjs:32-33. Unknown steps fail closed.
export function parseSteps(raw) {
  const list = raw == null ? [...ALL] : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of list) {
    if (!ALL.includes(s)) fail("unknown-step", `unknown step ${s} (want ${ALL.join("|")})`, { step: s });
  }
  return list;
}

// --order fan-out, verbatim semantics of pipeline.mjs orderSubs: substring
// match against slug (then url), first-match wins; unmatched subs keep original
// order appended after. Unknown tokens route to onWarn (CLI logs a warn line;
// job path folds them into the upload:plan payload + ledger).
export function orderSubs(subs, orderRaw, { onWarn = null } = {}) {
  const tokens = String(orderRaw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return [...subs];
  const rest = [...subs];
  const out = [];
  for (const t of tokens) {
    const i = rest.findIndex(
      (r) => String(r.slug || "").toLowerCase().includes(t) || String(r.url || "").toLowerCase().includes(t)
    );
    if (i < 0) {
      if (typeof onWarn === "function") {
        try {
          onWarn(t);
        } catch {
          // warn hook never blocks ordering
        }
      }
      continue;
    }
    out.push(rest.splice(i, 1)[0]);
  }
  return [...out, ...rest];
}

// Row count for the upload queue display, mirrors pipeline.mjs peopleCount
// ("?" when people.json is missing/unreadable — skip decided separately).
export function peopleCountFor(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, "people.json"), "utf8"));
    return Array.isArray(p) ? p.length : "?";
  } catch {
    return "?";
  }
}

// Upload queue from summary.json: successful scrapes only, ordered by --order.
// Mirrors pipeline.mjs:122-128 (missing summary / no successes fail closed).
export function buildUploadQueue(summary, orderRaw, { onWarn = null } = {}) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.results)) {
    fail("missing-summary", "missing summary.json results (nothing to upload)");
  }
  const subs = summary.results.filter((r) => !r.error && r.dir);
  if (!subs.length) fail("no-successful-scrapes", "no successful scrapes to upload");
  return orderSubs(subs, orderRaw, { onWarn });
}

function resolveSubDir(outDir, rootDir, dir) {
  // Mirrors pipeline.mjs resolve(HERE, r.dir): absolute stays, relative
  // resolves against the repo root (rootDir, default cwd).
  if (isAbsolute(dir)) return dir;
  return resolve(rootDir ?? process.cwd(), dir);
}

function spineIndex(stage) {
  return SPINE.indexOf(stage);
}

// Forward-only walk along the spine with ledger audit. Non-requested wait
// stages on subset runs pass through with a ledger note (files stay the
// contract); approval gates fire only for requested human steps.
function walkTo(job, target, { step }) {
  const walked = [];
  if (job.stage === target) return walked;
  if (job.stage === "done" || job.stage === "failed" || job.stage === "cancelled") {
    fail("illegal-pipeline-transition", `pipeline:${step}: terminal ${job.stage} never reopens (new Job for same source)`);
  }
  const fi = spineIndex(job.stage);
  const ti = spineIndex(target);
  if (fi < 0 || ti < 0) fail("illegal-pipeline-transition", `pipeline:${step}: unknown stage ${job.stage} -> ${target}`);
  if (fi > ti) return walked; // already past (e.g. armed job running upload)
  while (job.stage !== target) {
    const next = SPINE[spineIndex(job.stage) + 1];
    if (!canAdvance(job.stage, next)) {
      fail("illegal-pipeline-transition", `pipeline:${step}: ${job.stage} -> ${next} blocked`);
    }
    advance(job, next, { reason: `pipeline:${step}` });
    walked.push(next);
  }
  return walked;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stagingPaths(outDir) {
  const stagingRoot = join(outDir, STAGING_DIR);
  return {
    stagingRoot,
    pickedLinks: join(stagingRoot, "picked-links.json"),
    master: join(stagingRoot, "master.json"),
    summary: join(outDir, "summary.json"),
  };
}

// Human gate: autoApprove maps old --yes (non-interactive confirm only —
// safety prerequisites still enforced downstream). Without it the job waits:
// no approve callback -> throw approval-required, resumable via resume/approve.
async function gateStep({ outDir, job, step, autoApprove, hub, approvals }) {
  emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, awaitingApproval: true });
  if (autoApprove) {
    commitStep(outDir, job, hub, {
      ledgerKind: "pipeline:auto-approved",
      ledgerMessage: `${step} (maps --yes: non-interactive confirm only; safety gates still enforced)`,
      emitType: "job:advanced",
      emitPayload: { step, stage: job.stage, approved: true, autoApproved: true },
    });
    return { step, status: "auto-approved" };
  }
  const approve = approvals?.[step];
  if (typeof approve !== "function") {
    fail("approval-required", `pipeline:${step}: approval required (job waits at ${job.stage}; approve via approvals.${step} or resume)`, {
      step,
      stage: job.stage,
    });
  }
  const ok = await approve({ job, step, outDir });
  if (!ok) {
    fail("approval-required", `pipeline:${step}: approval refused (job waits at ${job.stage})`, { step, stage: job.stage });
  }
  commitStep(outDir, job, hub, {
    ledgerKind: "pipeline:approved",
    ledgerMessage: step,
    emitType: "job:advanced",
    emitPayload: { step, stage: job.stage, approved: true },
  });
  return { step, status: "approved" };
}

// Staging-file preconditions per step (mirrors pipeline.mjs fail-closed
// messages). Browser work itself runs via injected runners; without a runner
// the step validates the contract and defers with a ledger note.
async function machineStep({ outDir, rootDir, job, step, hub, runners, from }) {
  const paths = stagingPaths(outDir);
  const ctx = { outDir, rootDir, job, step, hub, from, paths };
  if (step === "probe") {
    if (from && !existsSync(from)) fail("missing-from", `missing --from file: ${from}`);
  } else if (step === "apply-master") {
    if (!existsSync(paths.master)) {
      fail("missing-master", `missing ${paths.master} (probe writes a default one — run probe + master first)`);
    }
  } else if (step === "run") {
    if (!existsSync(paths.pickedLinks)) {
      fail("missing-picked-links", `missing ${paths.pickedLinks} (run probe + pick-links first, or re-add those steps)`);
    }
  } else if (step === "finalize") {
    ctx.summary = readSummaryOrFail(paths.summary, "finalize");
    ctx.dirs = finalizeDirs(outDir, rootDir, ctx.summary);
    if (!ctx.dirs.length) {
      fail("nothing-to-finalize", `nothing to finalize (missing ${paths.summary} — run the run step first)`);
    }
  }
  const run = runners?.[step];
  if (typeof run !== "function") {
    commitStep(outDir, job, hub, {
      ledgerKind: "pipeline:deferred",
      ledgerMessage: `${step}: contract validated, no in-process runner (browser work deferred)`,
      emitType: "job:advanced",
      emitPayload: { step, stage: job.stage, deferred: true },
    });
    return { step, status: "deferred" };
  }
  const detail = await run(ctx);
  commitStep(outDir, job, hub, {
    ledgerKind: "pipeline:step",
    ledgerMessage: `${step}: in-process runner ok`,
    emitType: "job:advanced",
    emitPayload: { step, stage: job.stage },
  });
  return { step, status: "ran", detail: detail ?? null };
}

function readSummaryOrFail(summaryPath, step) {
  let summary = null;
  try {
    summary = readJsonFile(summaryPath);
  } catch {
    summary = null;
  }
  if (!summary || !Array.isArray(summary.results)) {
    if (step === "upload") fail("missing-summary", `missing ${summaryPath} (nothing to upload)`);
    fail("nothing-to-finalize", `nothing to finalize (missing ${summaryPath} — run the run step first)`);
  }
  return summary;
}

function finalizeDirs(outDir, rootDir, summary) {
  return summary.results.filter((r) => !r.error && r.dir).map((r) => resolveSubDir(outDir, rootDir, r.dir));
}

// Per-row regression guard (finding 3): the job layer cannot observe the
// backend mid-upload, so the injected runner may report guardStatus:"red"
// (or runners.guardCheck may return {regression:true}) when group/host/field/
// identity gates flip after the dry. Regression records guard:regression via
// notifyGuardRegression, consumes the arm via failJob, and fails closed —
// written rows kept truthfully, exactly like a failed row.
function failOnGuardRegression(outDir, job, hub, { queue, rowResults, detail }) {
  notifyGuardRegression(job, { detail: detail ?? "guard regression mid-upload" });
  failJob(job, { reason: `upload:guard-regression:${job.slug}` });
  commitStep(outDir, job, hub, {
    emitType: "gate:failed",
    emitPayload: { gate: "G1", step: "upload", reasons: ["guard-regression"] },
  });
  emit(hub, job.jobId, "job:advanced", { step: "upload", to: "failed", stage: job.stage });
  fail("guard-regression", `upload: guard regressed mid-upload (written rows kept truthfully)`, { queue, rowResults });
}

// Operator stop arrives via POST cancel, which writes the record to disk while
// the upload loop holds a stale in-memory copy. Re-read at every row boundary
// so a stop finishes the current row truthfully, then cancels with the arm
// consumed (finding 8). Returns true when the run must stop now.
function syncStopAndProof(outDir, job, hub, { queue, rowResults }) {
  try {
    Object.assign(job, readJob(outDir, job.slug, job.jobId));
  } catch {
    // Unreadable record mid-run: fail closed rather than upload blind.
    failJob(job, { reason: "upload:record-unreadable" });
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "upload", to: "failed", stage: job.stage });
    fail("record-unreadable", "upload: job record unreadable mid-upload (fail closed)", { queue, rowResults });
  }
  if (job.stopRequested) {
    finishUploadRowAndCancel(job, { reason: "stop_requested: row boundary" });
    commitStep(outDir, job, hub, {
      emitType: "job:advanced",
      emitPayload: { step: "upload", to: "cancelled", stage: job.stage },
    });
    return true;
  }
  const pv = verifyDryReport(outDir, job);
  if (!pv.ok) {
    notifyProofLost(job, { detail: pv.reasons.join("; ").slice(0, 200) });
    failJob(job, { reason: "upload:proof-lost-mid-queue" });
    commitStep(outDir, job, hub, {
      emitType: "gate:failed",
      emitPayload: { gate: "G1", step: "upload", reasons: pv.reasons },
    });
    emit(hub, job.jobId, "job:advanced", { step: "upload", to: "failed", stage: job.stage });
    fail("missing-proof", `upload: dry proof lost mid-queue — ${pv.reasons.join("; ")}`, { queue, rowResults });
  }
  return false;
}

// Upload as job ops. Staging files stay the contract; the job-layer dry proof
// (jobs/safety) is threaded fail-closed: missing/invalid dry fails even with
// autoApprove, and autoApprove never mints arms (G2 still needs the exact
// attestation copy + typed slug + click via armInputs, or a prior arm).
async function uploadStep({ outDir, rootDir, job, hub, runners, order, autoApprove, dryInputs, armInputs }) {
  const paths = stagingPaths(outDir);
  const summary = readSummaryOrFail(paths.summary, "upload");
  const warnings = [];
  const ordered = buildUploadQueue(summary, order, { onWarn: (t) => warnings.push(t) });
  const queue = [];
  const skipped = [];
  for (const r of ordered) {
    const dir = resolveSubDir(outDir, rootDir, r.dir);
    const peoplePath = join(dir, "people.json");
    if (!existsSync(peoplePath)) {
      skipped.push({ slug: r.slug ?? null, dir, reason: "no people.json" });
      continue;
    }
    queue.push({ slug: r.slug ?? null, url: r.url ?? null, dir, rows: peopleCountFor(dir) });
  }
  if (!queue.length) fail("no-successful-scrapes", "no successful scrapes to upload (every queued dir lacks people.json)");
  const planPayload = {
    groups: queue.length,
    plan: queue.map((q) => ({ group: q.slug ?? q.dir, action: "upload", target: q.url, rows: q.rows })),
    warnings,
    skipped: skipped.length,
  };
  emit(hub, job.jobId, "upload:plan", { slug: job.slug, mode: "save", total: queue.length, ...planPayload });
  appendLedger(job, "pipeline:upload-plan", `${queue.length} queued, ${skipped.length} skipped`);

  // Optional in-process dry (G1 enforced inside recordDryPass, fail closed).
  if (dryInputs && (job.stage === "detecting_backend" || job.stage === "dry_running")) {
    walkTo(job, "dry_running", { step: "upload" });
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "upload", to: "dry_running", stage: job.stage });
    const dry = recordDryPass(outDir, job, dryInputs);
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "upload", to: "dry_passed", stage: job.stage, reason: `dry ${dry.dryRunId}` });
    emit(hub, job.jobId, "artifact:written", { kind: "dry-report", relPath: dry.relPath, sha256: dry.sha256, byteLength: dry.byteLength });
  }
  // Prerequisite dry verified fail-closed — autoApprove never bypasses this,
  // nor the group/host/field/identity guards nor the failed-row policy.
  const pre = verifyDryReport(outDir, job);
  if (!pre.ok) {
    commitStep(outDir, job, hub, {
      ledgerKind: "gate:failed",
      ledgerMessage: `upload refused: ${pre.reasons.join("; ").slice(0, 200)}`,
      emitType: "gate:failed",
      emitPayload: { gate: "G1", step: "upload", reasons: pre.reasons },
    });
    fail("missing-proof", `upload refused: prerequisite dry invalid — ${pre.reasons.join("; ")}`, { reasons: pre.reasons });
  }
  // G2 arm: explicit triple via armInputs, or a prior arm. Never auto-minted.
  if (job.stage === "dry_passed" && armInputs) {
    grantArmFromSafety(outDir, job, {
      attestedText: armInputs.attestedText ?? null,
      typed: armInputs.typed ?? null,
      clicked: armInputs.clicked ?? false,
    });
    writeJob(outDir, job);
    emit(hub, job.jobId, "arm:granted", { dry_run_id: job.dry_run_id, snapshot_id: job.snapshot_id });
  }
  if (job.stage !== "armed" || job.arm?.state !== "armed") {
    fail("not-armed", `upload refused: stage must be armed with live arm (was ${job.stage}/${job.arm?.state}); pass G2 armInputs or arm first`, {
      stage: job.stage,
    });
  }
  const uploadRow = runners?.uploadRow;
  if (typeof uploadRow !== "function") {
    // Validate-only: proof threads (missing-proof thrown above) but the
    // single-use arm stays untouched until real row work runs.
    commitStep(outDir, job, hub, {
      ledgerKind: "pipeline:deferred",
      ledgerMessage: "upload: queue + dry proof validated, no uploadRow runner (arm untouched)",
      emitType: "job:advanced",
      emitPayload: { step: "upload", stage: job.stage, deferred: true },
    });
    return { step: "upload", status: "deferred", queue, skipped, warnings };
  }
  const started = beginUploadWithProof(outDir, job, {});
  writeJob(outDir, job);
  emit(hub, job.jobId, "arm:consumed", { reason: "upload-attempt", save_run_id: started.saveRunId });
  emit(hub, job.jobId, "job:advanced", { step: "upload", to: "uploading", stage: job.stage, save_run_id: started.saveRunId });
  emit(hub, job.jobId, "artifact:written", { kind: "save-report", relPath: started.relPath, sha256: started.sha256, byteLength: started.byteLength });
  const rowResults = [];
  const guardCheck = runners?.guardCheck;
  for (const q of queue) {
    // Row boundary: observe operator stop (fresh record), re-verify the dry
    // proof, and stop-now when requested — previous rows finished truthfully,
    // the arm is consumed into cancelled.
    if (syncStopAndProof(outDir, job, hub, { queue, rowResults })) {
      return { step: "upload", status: "cancelled", queue, skipped, warnings, saveRunId: started.saveRunId, rowResults };
    }
    if (typeof guardCheck === "function") {
      const gc = await guardCheck({ outDir, job, entry: q, dir: q.dir });
      if (gc && (gc.regression === true || gc.guardStatus === "red")) {
        failOnGuardRegression(outDir, job, hub, { queue, rowResults, detail: gc.detail ?? "guardCheck red" });
      }
    }
    let result = null;
    try {
      result = await uploadRow({ outDir, job, entry: q, dir: q.dir });
    } catch (e) {
      result = { slug: q.slug, dir: q.dir, status: "failed", detail: String(e?.message ?? e).slice(0, 200) };
    }
    if (result?.guardStatus === "red") {
      failOnGuardRegression(outDir, job, hub, { queue, rowResults, detail: result?.detail ?? "row reported guard red" });
    }
    const status = result?.status === "failed" ? "failed" : "done";
    rowResults.push({ ...q, status, detail: result?.detail ?? null });
    emit(hub, job.jobId, "upload:row-finished", { slug: q.slug, dir: q.dir, status });
    if (status === "failed") {
      failJob(job, { reason: `upload:row-failed:${q.slug ?? q.dir}` });
      writeJob(outDir, job);
      emit(hub, job.jobId, "job:advanced", { step: "upload", to: "failed", stage: job.stage });
      fail("row-failed", `upload: row failed for ${q.slug ?? q.dir} (written rows kept truthfully)`, { queue, rowResults });
    }
  }
  // A stop that landed during the final row still cancels instead of done:
  // finishUpload throws stop-requested, so check the fresh record first.
  if (syncStopAndProof(outDir, job, hub, { queue, rowResults })) {
    return { step: "upload", status: "cancelled", queue, skipped, warnings, saveRunId: started.saveRunId, rowResults };
  }
  finishUpload(job, { reason: `pipeline:upload:${started.saveRunId}` });
  writeJob(outDir, job);
  emit(hub, job.jobId, "upload:report-written", { slug: job.slug, mode: "save", total: queue.length, save_run_id: started.saveRunId, relPath: started.relPath });
  emit(hub, job.jobId, "job:advanced", { step: "upload", to: "done", stage: job.stage });
  return { step: "upload", status: "done", queue, skipped, warnings, saveRunId: started.saveRunId, rowResults };
}

// Full pipeline (probe through upload) as in-process job ops with approval
// gates instead of spawned processes and terminal pauses.
//
// - steps: comma string or array subset of ALL (default all, same as CLI).
// - order: --order token string for the upload queue (same fan-out).
// - autoApprove: maps old --yes (skips human pauses only; safety gates,
//   dry proof, guards, row policy still enforced — never bypassed).
// - runners: injected in-process step work {probe, apply-master, run,
//   finalize, uploadRow, guardCheck}. Absent runners validate the staging
//   contract and defer with ledger audit (browser work deferred, arms
//   untouched). guardCheck({outDir, job, entry, dir}) is the per-row guard
//   re-check seam ({regression:true} or {guardStatus:"red"} fails closed);
//   uploadRow results may also carry guardStatus:"red" with the same effect.
//   The upload loop re-reads the record per row: operator stop cancels after
//   the current row (status "cancelled"), lost dry proof fails closed.
// - approvals: per-human-step callbacks ({job, step, outDir}) -> truthy.
//   Without autoApprove and without a callback the job waits (throws
//   approval-required; resume/approve later — never blocks stdin).
// - dryInputs/armInputs: optional in-process dry (G1) + G2 arm triple for the
//   upload step. G2 is never auto-minted.
// - rootDir: base for relative summary dirs (mirrors pipeline resolve(HERE)).
// - from: --from file for the probe precondition (must exist when given).
export async function runPipelineAsJobOps({
  outDir,
  job,
  steps = null,
  order = "",
  autoApprove = false,
  hub = null,
  runners = {},
  approvals = {},
  dryInputs = null,
  armInputs = null,
  rootDir = null,
  from = null,
} = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "runPipelineAsJobOps: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "runPipelineAsJobOps: job record required");
  // P8 single-flight v1: one active engine op globally. A second pipeline run
  // while one holds the claim is refused (code single-flight) — cross-job via
  // claimEngineOp, same-job via the active set (the store primitive stays
  // re-entrant for the same job by contract). Waits may sit: the claim covers
  // execution only and releases in finally (even on throw).
  if (activePipelineJobs.has(job.jobId)) {
    fail("single-flight", `pipeline:${job.jobId} already running (same-job re-entry refused)`, { jobId: job.jobId });
  }
  claimEngineOp(job.jobId, "pipeline");
  activePipelineJobs.add(job.jobId);
  try {
    return await runPipelineClaimed({
      outDir, job, steps, order, autoApprove, hub, runners, approvals, dryInputs, armInputs, rootDir, from,
    });
  } finally {
    activePipelineJobs.delete(job.jobId);
    releaseEngineOp(job.jobId);
  }
}

async function runPipelineClaimed({
  outDir,
  job,
  steps = null,
  order = "",
  autoApprove = false,
  hub = null,
  runners = {},
  approvals = {},
  dryInputs = null,
  armInputs = null,
  rootDir = null,
  from = null,
} = {}) {
  const list = parseSteps(steps == null ? [...ALL] : steps);
  writeJob(outDir, job);
  emit(hub, job.jobId, "job:advanced", { pipeline: "started", steps: list, autoApprove });
  const results = [];
  for (const step of list) {
    if (HUMAN_STEPS.includes(step)) {
      walkTo(job, STEP_STAGES[step], { step });
      writeJob(outDir, job);
      results.push(await gateStep({ outDir, job, step, autoApprove, hub, approvals }));
    } else if (step === "upload") {
      walkTo(job, STEP_STAGES[step], { step });
      writeJob(outDir, job);
      results.push(await uploadStep({ outDir, rootDir, job, hub, runners, order, autoApprove, dryInputs, armInputs }));
    } else {
      walkTo(job, STEP_STAGES[step], { step });
      writeJob(outDir, job);
      results.push(await machineStep({ outDir, rootDir, job, step, hub, runners, from }));
    }
  }
  emit(hub, job.jobId, "job:advanced", { pipeline: "finished", steps: list });
  return { jobId: job.jobId, steps: results };
}

// ---- UI step wiring (PR #30 gap fix) ----
// Operator-facing UI actions mapped to spine stages. Used by
// jobs/commands.mjs POST /jobs/:jobId/commands so the normal workflow runs
// from the workspace without CLI. All logic stays server-side (no browser
// duplication in the client); probe/scrape/detect run the real lifted CDP
// engine (jobs/engine-cdp.mjs: Wrapped cores, never CLI entries) as
// background work under the single-flight claim, while approve-page/finalize
// complete synchronously (human gate + pure review validation).
// Transport: POST accepts immediately ({accepted:true, reason:"started"});
// completion lands via ledger + SSE + GET (the client polls). Never imports
// CLI entries.
export const UI_STEPS = ["probe", "approve-page", "scrape", "finalize", "detect", "run-step"];

// Steps whose real work runs in the background (browser/CDP, minutes).
// approve-page/finalize (+ run-step human/finalize/upload) stay synchronous.
export const BG_STEPS = new Set(["probe", "scrape", "detect"]);

// Engine error code -> orthogonal blocker type (store BLOCKER_TYPES).
// Unmapped codes fail closed with ledger only (no blocker to raise).
const BLOCKER_FOR = {
  "cloudflare-blocked": "cloudflare",
  "cdp-unreachable": "cdp",
  "cdp-error": "cdp",
};

export const UI_STEP_STAGES = {
  probe: "probing",
  "approve-page": "scraping",
  scrape: "scraping",
  finalize: "finalizing",
  detect: "detecting_backend",
};

// Forward-only walk for UI steps (same semantics as walkTo). Exported so
// jobs/commands.mjs reuses one walk implementation. Terminals never reopen;
// backwards moves must use retry.
export function walkUiTo(job, target, { step } = {}) {
  const walked = [];
  if (job.stage === target) return walked;
  if (job.stage === "done" || job.stage === "failed" || job.stage === "cancelled") {
    fail("illegal-pipeline-transition", `pipeline:${step}: terminal ${job.stage} never reopens (new Job for same source)`);
  }
  const fi = spineIndex(job.stage);
  const ti = spineIndex(target);
  if (fi < 0 || ti < 0) fail("illegal-pipeline-transition", `pipeline:${step}: unknown stage ${job.stage} -> ${target}`);
  if (fi > ti) return walked; // already past: caller treats as already-past (idempotent UI)
  while (job.stage !== target) {
    const next = SPINE[spineIndex(job.stage) + 1];
    if (!canAdvance(job.stage, next)) {
      fail("illegal-pipeline-transition", `pipeline:${step}: ${job.stage} -> ${next} blocked`);
    }
    advance(job, next, { reason: `pipeline:${step}` });
    walked.push(next);
  }
  return walked;
}

// Real in-process runners for the async pipeline path, using wrapped cores.
// probe/run stay deferred (browser/CDP work, no engine import on UI path);
// finalize runs real review validation (jobs/review, pure); detect records
// guard-aware ledger (pure, fail-closed downstream via safety gates).
// Absent runners still defer via machineStep (browser work deferred).
export function getDefaultRunners({ outDir } = {}) {
  return {
    finalize: async (ctx) => {
      const dir = outDir ?? ctx?.outDir;
      const job = ctx?.job;
      if (!dir || !job) return { deferred: true, reason: "missing-context" };
      let model = null;
      try {
        model = loadReviewModel(dir, job);
      } catch {
        return { deferred: true, reason: "review-unreadable" };
      }
      if (!model?.selection?.length) return { deferred: true, reason: "no-selection" };
      const v = validateForFinalize(model.selection);
      return { kept: v.kept.length, removed: v.removed, warnings: v.warnings, effectiveOrder: v.effectiveOrder };
    },
  };
}

// Sync UI step executor for POST commands (jobs/commands.mjs calls this for
// approve-page/finalize/run-step-human; probe/scrape/detect go through
// startUiStep below). Mutates job in-memory (walk + ledger), writes record,
// emits SSE. Engine steps claim single-flight briefly and release in finally;
// the human gate approve-page never claims (like resume: approvals must get
// through). Throws fail-closed codes for caller mapping. Idempotent when
// already at/past target (returns already-past, no backward move).
export function runUiStepSync({ outDir, job, uiStep, hub = null, payload = {} } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "runUiStepSync: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "runUiStepSync: job record required");
  if (!UI_STEPS.includes(uiStep)) fail("unknown-step", `unknown UI step ${uiStep} (want ${UI_STEPS.join("|")})`, { step: uiStep });
  if (uiStep === "probe" || uiStep === "scrape" || uiStep === "detect") {
    fail("use-start", `ui:${uiStep} runs as background work (use startUiStep)`, { step: uiStep });
  }
  if (uiStep === "approve-page") {
    return runUiStepClaimed({ outDir, job, uiStep, hub, payload });
  }
  if (activePipelineJobs.has(job.jobId)) {
    fail("single-flight", `pipeline:${job.jobId} already running (same-job re-entry refused)`, { jobId: job.jobId });
  }
  claimEngineOp(job.jobId, `ui:${uiStep}`);
  activePipelineJobs.add(job.jobId);
  try {
    return runUiStepClaimed({ outDir, job, uiStep, hub, payload });
  } finally {
    activePipelineJobs.delete(job.jobId);
    releaseEngineOp(job.jobId);
  }
}

// Async-accept entry for UI steps. Sync steps (approve-page/finalize/run-step
// human+finalize+upload) delegate to runUiStepSync and complete before ack.
// Background steps (probe/scrape/detect, run-step probe/run) walk to the
// target stage synchronously, persist the started ledger, hold the
// single-flight claim across the background run, and return {status:"started"}
// immediately; completion (or fail-closed failure) lands via ledger + SSE +
// GET. Re-runs at the target stage execute fresh work (new commandId); past
// the target returns already-past. Terminals never reopen.
export function startUiStep({ outDir, job, uiStep, hub = null, payload = {}, engine = null } = {}) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "startUiStep: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "startUiStep: job record required");
  if (!UI_STEPS.includes(uiStep)) fail("unknown-step", `unknown UI step ${uiStep} (want ${UI_STEPS.join("|")})`, { step: uiStep });
  let op = uiStep;
  if (uiStep === "run-step") {
    const raw = payload?.step ?? payload?.steps ?? null;
    const list = parseSteps(typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(",") : null);
    if (list.length !== 1) fail("bad-step", `run-step: single DAG step required (got ${list.join(",")})`, { step: raw });
    const step = list[0];
    if (step === "probe" || step === "run") op = step === "probe" ? "probe" : "scrape";
    else return runUiStepSync({ outDir, job, uiStep, hub, payload });
  }
  if (!BG_STEPS.has(op)) return runUiStepSync({ outDir, job, uiStep, hub, payload });
  return acceptBgStep({ outDir, job, uiStep, op, hub, payload, engine: engine ?? realEngine });
}

function acceptBgStep({ outDir, job, uiStep, op, hub, payload, engine }) {
  const target = UI_STEP_STAGES[op];
  const fi = spineIndex(job.stage);
  const ti = spineIndex(target);
  if (fi > ti) return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });
  if (!engine || typeof engine[opName(op)] !== "function") {
    fail("missing-engine", `ui:${op}: no engine runner (pass engine or use deferred run-step)`, { step: op });
  }
  if (activePipelineJobs.has(job.jobId)) {
    fail("single-flight", `pipeline:${job.jobId} already running (same-job re-entry refused)`, { jobId: job.jobId });
  }
  if (op === "scrape") {
    // Durable human gate: scraping begins only on approved staging. Approval
    // is recorded by approve-page and bound to a staging fingerprint; any
    // later Save invalidates it (approval-stale). Fail-closed, no side effects.
    const chk = checkPageApproval(outDir, job);
    if (!chk.ok) {
      fail(chk.reason, `ui:scrape: ${chk.reason === "approval-stale" ? "staging changed since approval (re-approve)" : "approve pages first"}`, { step: op });
    }
  }
  claimEngineOp(job.jobId, `ui:${op}`);
  activePipelineJobs.add(job.jobId);
  try {
    walkUiTo(job, target, { step: `ui:${op}` });
    if (op === "probe" && (!job.source || typeof job.source !== "string")) {
      fail("bad-source", "ui:probe: job source URL required", { step: op });
    }
    const commandId = typeof payload?.commandId === "string" ? payload.commandId : null;
    appendLedger(job, "pipeline:started", `ui ${op} accepted (background)`, commandId ? { commandId } : {});
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: op, stage: job.stage, started: true });
    if (op === "probe" || op === "scrape") {
      emit(hub, job.jobId, "scrape:url-started", { url: job.source, slug: job.slug, mode: op === "probe" ? "probe" : "scrape" });
    }
    const bg = { outDir, slug: job.slug, jobId: job.jobId, source: job.source, op, uiStep, hub, payload, engine, commandId };
    runBgStep(bg).catch(() => null);
    return { step: uiStep, op, status: "started", stage: job.stage };
  } catch (e) {
    activePipelineJobs.delete(job.jobId);
    releaseEngineOp(job.jobId);
    throw e;
  }
}

function opName(op) {
  return op === "probe" ? "probeUrl" : op === "scrape" ? "scrapeUrl" : "detectBackend";
}

function engineOpts(payload) {
  const p = payload ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    port: p.port ?? "auto",
    timeoutMs: num(p.timeoutS, 60) * 1000,
    cfWaitS: num(p.cfWaitS, 60),
    via: typeof p.via === "string" ? p.via : "auto",
    backend: typeof p.backend === "string" ? p.backend : null,
    match: typeof p.match === "string" ? p.match : "personal",
  };
}

function readPickedEntry(outDir, job) {
  const arr = (() => { try { return JSON.parse(readFileSync(join(outDir, "_staging", "picked-links.json"), "utf8")); } catch { return null; } })();
  if (!Array.isArray(arr)) fail("missing-picked-links", "ui:scrape: missing picked-links.json (probe + page selection first)", { step: "scrape" });
  const hit = arr.find((e) => e && e.slug === job.slug);
  if (!hit) fail("missing-picked-links", `ui:scrape: no picked-links entry for ${job.slug} (probe first)`, { step: "scrape" });
  if (hit.keep === false) fail("page-deselected", `ui:scrape: page deselected for ${job.slug} (re-select in Pages, Approve, retry)`, { step: "scrape" });
  return hit;
}

function readImageSeqFilter(outDir, slug) {
  let arr;
  try {
    arr = JSON.parse(readFileSync(join(outDir, "_staging", slug, "picked-images.json"), "utf8"));
  } catch {
    return null; // no per-image filter = keep all (CLI parity)
  }
  if (!Array.isArray(arr)) return null;
  return new Set(arr.filter((x) => x && x.keep).map((x) => Number(x.seq)));
}

// Background worker: runs the real engine, then applies the result to the
// fresh record (cancel-safe: a terminal/cancelled record is never clobbered;
// staging files already written are kept as files, noted in ledger).
async function runBgStep(bg) {
  const { outDir, slug, jobId, op, uiStep, hub, payload, engine, commandId } = bg;
  const done = () => { activePipelineJobs.delete(jobId); releaseEngineOp(jobId); };
  const emitFn = (type, p) => emit(hub, jobId, type, p);
  let result = null;
  let failure = null;
  try {
    const opts = engineOpts(payload);
    if (op === "probe") {
      result = await engine.probeUrl({ outDir, url: bg.source, port: opts.port, timeoutMs: opts.timeoutMs, cfWaitS: opts.cfWaitS, via: opts.via, emit: emitFn });
    } else if (op === "scrape") {
      readPickedEntry(outDir, { slug, jobId });
      const filter = readImageSeqFilter(outDir, slug);
      result = await engine.scrapeUrl({ outDir, url: bg.source, slug, port: opts.port, timeoutMs: opts.timeoutMs, cfWaitS: opts.cfWaitS, via: opts.via, imageSeqFilter: filter, emit: emitFn });
    } else {
      result = await engine.detectBackend({ outDir, slug, jobId, port: opts.port, backend: opts.backend, match: opts.match, emit: emitFn });
    }
  } catch (e) {
    failure = normalizeEngineError(e);
  }
  let fresh;
  try {
    fresh = readJob(outDir, slug, jobId);
  } catch {
    emit(hub, jobId, "job:advanced", { step: op, error: "record-unreadable" });
    done();
    return;
  }
  try {
    if (fresh.stage === "done" || fresh.stage === "failed" || fresh.stage === "cancelled" || fresh.stopRequested) {
      appendLedger(fresh, "pipeline:superseded", `ui ${op} finished after ${fresh.stage}${fresh.stopRequested ? "+stop" : ""} (staging files kept, record untouched)`, commandId ? { commandId } : {});
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: op, stage: fresh.stage, superseded: true });
      return;
    }
    if (failure) {
      const blocker = BLOCKER_FOR[failure.code] ?? null;
      appendLedger(fresh, "pipeline:failed", `ui ${op}: ${failure.code} ${failure.detail}`.slice(0, 220), commandId ? { commandId, code: failure.code } : { code: failure.code });
      if (blocker) {
        try { raiseBlocker(fresh, { type: blocker, ctx: `${op}:${failure.code}` }); } catch { /* bad type never happens */ }
        emit(hub, jobId, "blocker:raised", { type: blocker, step: op, reason: failure.code });
      }
      if (op === "probe" || op === "scrape") {
        emit(hub, jobId, "scrape:url-failed", { url: fresh.source, slug: fresh.slug, error: `${failure.code} ${failure.detail}`.slice(0, 200) });
      }
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: op, stage: fresh.stage, failed: true, reason: failure.code });
      return;
    }
    const { message, artifacts } = describeResult(op, outDir, result);
    if (op === "scrape") {
      // Scrape->Review handoff: seed the job-scoped draft from the slug-dir
      // selection the scrape wrote, so Review UI + finalize see real rows.
      // Non-fatal: missing/invalid only notes in ledger (finalize surfaces it).
      try {
        const imp = importScrapeSelection(outDir, fresh);
        if (imp.status === "seeded") {
          appendLedger(fresh, "review:seeded", `scrape selection imported (rev ${imp.revision}, ${imp.kept} kept)`);
          emit(hub, jobId, "review:selection-written", { slug: fresh.slug, count: imp.kept, relPath: `${fresh.slug}/jobs/${jobId}/review/selection.json` });
        } else if (imp.status === "missing") {
          appendLedger(fresh, "pipeline:deferred", "ui scrape: no slug selection to seed review (operator seeds via Review UI)");
        }
      } catch (e) {
        appendLedger(fresh, "pipeline:deferred", `ui scrape: review seed skipped (${e?.code ?? "error"})`);
      }
    }
    // Human-acceptance fix: a successful background step advances the Job to
    // the next stable stage (probe -> page selection, scrape -> people
    // review, detect -> dry). walkUiTo is forward-only and idempotent
    // (already at/past = no-op, terminals throw but returned above), so
    // command replay — which never re-runs this worker — and operator moves
    // between accept and completion cannot double-advance. Advance applies
    // only when the record still sits at the in-flight stage or already
    // reached/passed the target; any other operator-moved stage is left
    // untouched (finished ledger + artifacts still recorded below).
    // Cancel/terminal supersession, blockers, single-flight, and fail-closed
    // failure handling are unchanged.
    const NEXT_STABLE = {
      probe: "waiting_for_page_selection",
      scrape: "waiting_for_people_review",
      detect: "dry_running",
    };
    const stable = NEXT_STABLE[op];
    if (stable && (fresh.stage === UI_STEP_STAGES[op] || spineIndex(fresh.stage) >= spineIndex(stable))) {
      walkUiTo(fresh, stable, { step: `ui:${op}` });
    }
    appendLedger(fresh, "pipeline:finished", message, commandId ? { commandId } : {});
    writeJob(outDir, fresh);
    for (const a of artifacts) emit(hub, jobId, "artifact:written", a);
    for (const t of ["cloudflare", "cdp"]) {
      if (hasBlocker(fresh, t)) {
        clearBlocker(fresh, t);
        writeJob(outDir, fresh);
        emit(hub, jobId, "blocker:cleared", { type: t, step: op });
      }
    }
    emit(hub, jobId, "job:advanced", { step: op, stage: fresh.stage, finished: true });
  } finally {
    done();
  }
}

// Background row-execution worker: runs the shared real upload core
// (uploader/lib/upload-core.mjs via an injected or default uploadRow runner)
// after begin-upload entered uploading. Mirrors the probe/scrape/detect bg
// pattern: single-flight held across the run, cancel-safe fresh reads,
// proof re-verified at every row boundary, truthful failure (never done
// unless every row completes), command replay never re-runs rows.
export async function runUploadRowsBg({ outDir, jobId, hub = null, engine = null, payload = {}, commandId = null } = {}) {
  const done = () => { activePipelineJobs.delete(jobId); releaseEngineOp(jobId); };
  let runner = null;
  let runnerOwned = false;
  try {
    let fresh = null;
    try {
      const found = findJobById(outDir, jobId);
      fresh = found?.job ?? null;
    } catch {
      fresh = null;
    }
    if (!fresh) {
      emit(hub, jobId, "job:advanced", { step: "upload-rows", error: "record-unreadable" });
      return { status: "record-unreadable" };
    }
    if (fresh.stage === "done" || fresh.stage === "failed" || fresh.stage === "cancelled") {
      appendLedger(fresh, "pipeline:superseded", `ui upload-rows finished after ${fresh.stage} (record untouched)`, commandId ? { commandId } : {});
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: "upload-rows", stage: fresh.stage, superseded: true });
      return { status: "superseded", stage: fresh.stage };
    }
    if (fresh.stopRequested) {
      finishUploadRowAndCancel(fresh, { reason: "stop_requested: before first row" });
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: "upload-rows", to: "cancelled", stage: fresh.stage });
      return { status: "cancelled", stage: fresh.stage };
    }
    if (fresh.stage !== "uploading") {
      appendLedger(fresh, "pipeline:deferred", `ui upload-rows: stage ${fresh.stage} is not uploading (rows not started)`, commandId ? { commandId } : {});
      writeJob(outDir, fresh);
      return { status: "deferred", stage: fresh.stage };
    }
    // Re-verify the dry proof at row-execution start (fail closed).
    const pv = verifyDryReport(outDir, fresh);
    if (!pv.ok) {
      failJob(fresh, { reason: `upload:proof-invalid:${pv.reasons.join(",")}` });
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: "upload-rows", to: "failed", stage: fresh.stage });
      return { status: "failed", stage: fresh.stage };
    }
    const dryRows = Array.isArray(pv.report?.rows) ? pv.report.rows : [];
    const queue = dryRows
      .filter((r) => r && (r.status === "dry" || r.status === "dry-partial"))
      .map((r) => ({ seq: Number(r.seq), name: r.name ?? null, group: r.group ?? null, target: r.target ?? null }));
    if (!queue.length) {
      failJob(fresh, { reason: "upload:no-uploadable-rows" });
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: "upload-rows", to: "failed", stage: fresh.stage });
      return { status: "failed", stage: fresh.stage };
    }
    // Runner: injected uploadRow wins (tests/fakes); otherwise the production
    // Playwright binding over CDP against the dry backend. No runner and no
    // browser means rows cannot start: stay uploading with a visible deferred
    // note (today's behavior — never fail a healthy upload for lack of a
    // driver, never report done without row execution).
    let uploadRow = typeof engine?.uploadRow === "function" ? engine.uploadRow : null;
    if (!uploadRow) {
      try {
        const { createUploadRowRunner } = await import("../uploader/lib/upload-runner.mjs");
        const port = payload?.port ?? "auto";
        runner = await createUploadRowRunner({ outDir, job: fresh, port });
        runnerOwned = true;
        uploadRow = (args) => runner.uploadRow(args);
      } catch (e) {
        appendLedger(fresh, "pipeline:deferred", `ui upload-rows: no row driver (${String(e?.message ?? e).slice(0, 120)}); rows await a runner`, commandId ? { commandId } : {});
        writeJob(outDir, fresh);
        emit(hub, jobId, "job:advanced", { step: "upload-rows", stage: fresh.stage, deferred: true });
        return { status: "deferred", stage: fresh.stage };
      }
    }
    activePipelineJobs.add(jobId);
    // Claim for the row loop (released in finally). Bounded wait: another
    // engine op may briefly hold the claim; rows must never run concurrently
    // with it. On persistent contention the worker defers visibly instead of
    // starting blind.
    let claimed = false;
    for (let i = 0; i < 120 && !claimed; i++) {
      try {
        claimEngineOp(jobId, "ui:upload-rows");
        claimed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!claimed) {
      appendLedger(fresh, "pipeline:deferred", "ui upload-rows: engine busy, rows pending (retry the upload when free)", commandId ? { commandId } : {});
      writeJob(outDir, fresh);
      emit(hub, jobId, "job:advanced", { step: "upload-rows", stage: fresh.stage, deferred: true });
      return { status: "deferred", stage: fresh.stage };
    }
    const guardCheck = typeof engine?.guardCheck === "function" ? engine.guardCheck : null;
    const rowResults = [];
    for (const q of queue) {
      if (syncStopAndProof(outDir, fresh, hub, { queue, rowResults })) {
        return { status: "cancelled", stage: fresh.stage, saveRunId: fresh.save_run_id, rowResults };
      }
      // Re-read the live record each boundary so SSE/GET stay truthful.
      try {
        fresh = readJob(outDir, fresh.slug, jobId);
      } catch {
        emit(hub, jobId, "job:advanced", { step: "upload-rows", error: "record-unreadable" });
        return { status: "record-unreadable" };
      }
      if (guardCheck) {
        const gc = await guardCheck({ outDir, job: fresh, entry: q });
        if (gc && (gc.regression === true || gc.guardStatus === "red")) {
          failOnGuardRegression(outDir, fresh, hub, { queue, rowResults, detail: gc.detail ?? "guardCheck red" });
        }
      }
      let result = null;
      try {
        result = await uploadRow({ outDir, job: fresh, entry: q });
      } catch (e) {
        result = { seq: q.seq, status: "failed", detail: String(e?.message ?? e).slice(0, 200) };
      }
      if (result?.guardStatus === "red") {
        failOnGuardRegression(outDir, fresh, hub, { queue, rowResults, detail: result?.detail ?? "row reported guard red" });
      }
      const status = result?.status === "failed" ? "failed" : "done";
      rowResults.push({ ...q, status, detail: result?.detail ?? null });
      emit(hub, jobId, "upload:row-finished", { seq: q.seq, status });
      try {
        fresh = readJob(outDir, fresh.slug, jobId);
      } catch {
        emit(hub, jobId, "job:advanced", { step: "upload-rows", error: "record-unreadable" });
        return { status: "record-unreadable" };
      }
      if (status === "failed") {
        failJob(fresh, { reason: `upload:row-failed:seq-${q.seq}:${String(result?.detail ?? "unknown").slice(0, 120)}` });
        writeJob(outDir, fresh);
        emit(hub, jobId, "job:advanced", { step: "upload-rows", to: "failed", stage: fresh.stage });
        return { status: "failed", stage: fresh.stage, rowResults };
      }
      writeJob(outDir, fresh);
    }
    if (syncStopAndProof(outDir, fresh, hub, { queue, rowResults })) {
      return { status: "cancelled", stage: fresh.stage, saveRunId: fresh.save_run_id, rowResults };
    }
    finishUpload(fresh, { reason: `pipeline:upload:${fresh.save_run_id}` });
    writeJob(outDir, fresh);
    emit(hub, jobId, "upload:report-written", { slug: fresh.slug, mode: "save", total: queue.length, save_run_id: fresh.save_run_id });
    emit(hub, jobId, "job:advanced", { step: "upload-rows", to: "done", stage: fresh.stage });
    return { status: "done", stage: fresh.stage, saveRunId: fresh.save_run_id, rowResults };
  } finally {
    if (runnerOwned) {
      try {
        await runner.close();
      } catch {
        // ignore
      }
    }
    done();
  }
}

function normalizeEngineError(e) {
  if (e && typeof e.code === "string") return { code: e.code, detail: String(e.message ?? e).slice(0, 160) };
  const msg = String(e?.message ?? e).slice(0, 160);
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|CDP|WebSocket|socket hang up|socket/i.test(msg)) {
    return { code: "cdp-unreachable", detail: msg };
  }
  if (/cloudflare|challenge/i.test(msg)) return { code: "cloudflare-blocked", detail: msg };
  return { code: "command-failed", detail: msg };
}

function artifactFor(outDir, relPath, kind) {
  try {
    const buf = readFileSync(join(outDir, relPath));
    return { kind, relPath, sha256: createHash("sha256").update(buf).digest("hex"), byteLength: buf.length };
  } catch {
    return { kind, relPath, sha256: null, byteLength: null };
  }
}

function describeResult(op, outDir, result) {
  if (op === "probe") {
    const slug = result.slug;
    return {
      message: `ui probe finished: ${slug} (${result.counts?.image ?? "?"} images)`,
      artifacts: [
        artifactFor(outDir, `_staging/${slug}/probe.json`, "probe"),
        artifactFor(outDir, "_staging/picked-links.json", "picked-links"),
        artifactFor(outDir, "_staging/master.json", "master"),
      ],
    };
  }
  if (op === "scrape") {
    const slug = result.slug;
    return {
      message: `ui scrape finished: ${slug} (${result.nPeople ?? "?"} people, ${result.nCands ?? "?"} candidates)`,
      artifacts: [
        artifactFor(outDir, `${slug}/content.json`, "content"),
        artifactFor(outDir, `${slug}/people.json`, "people"),
        artifactFor(outDir, `${slug}/review/selection.json`, "selection"),
        artifactFor(outDir, "summary.json", "summary"),
      ],
    };
  }
  return {
    message: `ui detect finished: ${result.host} (${(result.departments ?? []).length} departments${result.profile ? `, profile:${result.profile}` : ""})`,
    artifacts: [
      { kind: "detect-report", relPath: result.relPath, sha256: result.sha256 ?? null, byteLength: result.byteLength ?? null },
    ],
  };
}

function runUiStepClaimed({ outDir, job, uiStep, hub, payload }) {
  // run-step: generic single DAG step (strict contract via parseSteps).
  if (uiStep === "run-step") {
    const raw = payload?.step ?? payload?.steps ?? null;
    const list = parseSteps(typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(",") : null);
    // Single step only for UI determinism; full lists go via runPipelineAsJobOps.
    const step = list[0];
    if (list.length !== 1) fail("bad-step", `run-step: single DAG step required (got ${list.join(",")})`, { step: raw });
    const target = STEP_STAGES[step];
    if (!target) fail("unknown-step", `run-step: no stage for ${step}`, { step });
    const fi = spineIndex(job.stage);
    const ti = spineIndex(target);
    if (fi > ti) return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });
    walkUiTo(job, target, { step: `ui:${uiStep}:${step}` });
    if (HUMAN_STEPS.includes(step)) {
      const approved = payload?.autoApprove === true || payload?.approved === true;
      if (!approved) {
        appendLedger(job, "pipeline:awaiting-approval", `${step} waits at ${job.stage} (approve via approve-page or resume)`);
        writeJob(outDir, job);
        emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, awaitingApproval: true });
        return { step: uiStep, dagStep: step, status: "awaiting-approval", stage: job.stage };
      }
      appendLedger(job, "pipeline:approved", `${step} (ui run-step)`);
    } else {
      appendLedger(job, "pipeline:step", `ui run-step ${step}: contract validated, browser work deferred where applicable`);
    }
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, uiStep });
    return { step: uiStep, dagStep: step, status: "ran", stage: job.stage };
  }

  // approve-page: durable human approval only. Records approval on the job
  // record (reload-safe, bound to a staging fingerprint) and stays at
  // waiting_for_page_selection. Scraping begins only when the Scrape command
  // is accepted. Past the wait the approval is moot (already-past).
  if (uiStep === "approve-page") {
    const wait = "waiting_for_page_selection";
    if (isTerminal(job.stage)) {
      fail("illegal-pipeline-transition", `pipeline:ui:approve-page: terminal ${job.stage} never reopens (new Job for same source)`);
    }
    const fi = spineIndex(job.stage);
    const wi = spineIndex(wait);
    if (fi < wi) {
      fail("bad-stage", `ui:approve-page: stage must be ${wait} (was ${job.stage})`, { step: uiStep });
    }
    if (fi > wi) return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });
    readPickedEntry(outDir, job);
    recordPageApproval(outDir, job);
    appendLedger(job, "pipeline:approved", "pick-links/master (ui approve-page)");
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "approve-page", stage: job.stage, approved: true });
    return { step: uiStep, status: "approved", stage: job.stage };
  }

  // finalize: validate FIRST, then complete synchronously through the
  // transient finalizing stage to detecting_backend (no pre-walk: a failed
  // validation must leave the stage untouched). Placed before the generic
  // walk so deferred outcomes never claim finalizing.
  if (uiStep === "finalize") {
    const ft = UI_STEP_STAGES.finalize;
    if (spineIndex(job.stage) > spineIndex(ft)) {
      return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });
    }
    let detail = { deferred: true };
    try {
      const model = loadReviewModel(outDir, job);
      if (model?.selection?.length) {
        const v = validateForFinalize(model.selection);
        detail = { kept: v.kept.length, removed: v.removed, warnings: v.warnings, effectiveOrder: v.effectiveOrder };
        appendLedger(job, "pipeline:step", `ui finalize: review validated (kept ${v.kept.length}, removed ${v.removed})`);
        // Successful finalize completes synchronously to detecting_backend,
        // where Detect owns the next step. Failures stay deferred below.
        walkUiTo(job, "detecting_backend", { step: "ui:finalize" });
      } else {
        appendLedger(job, "pipeline:deferred", "ui finalize: no review selection (browser work deferred)");
      }
    } catch {
      appendLedger(job, "pipeline:deferred", "ui finalize: review unreadable (deferred)");
    }
    writeJob(outDir, job);
    emit(hub, job.jobId, "review:finalized", { slug: job.slug, kept: detail.kept ?? null, removed: detail.removed ?? null });
    emit(hub, job.jobId, "job:advanced", { step: "finalize", stage: job.stage });
    return { step: uiStep, status: "ran", stage: job.stage, detail };
  }

  const target = UI_STEP_STAGES[uiStep];
  const fi = spineIndex(job.stage);
  const ti = spineIndex(target);
  if (fi > ti) return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });
  if (fi === ti) return finishUiStep(outDir, job, hub, { uiStep, status: "already-past", stage: job.stage });

  walkUiTo(job, target, { step: `ui:${uiStep}` });

  if (uiStep === "probe") {
    if (!job.source || typeof job.source !== "string") fail("bad-source", "ui:probe: job source URL required", { step: uiStep });
    ensureProbeStaging(outDir, job);
    appendLedger(job, "pipeline:step", `ui probe: source validated, browser work deferred where applicable`);
    writeJob(outDir, job);
    emit(hub, job.jobId, "scrape:url-started", { url: job.source, slug: job.slug, mode: "probe" });
    emit(hub, job.jobId, "job:advanced", { step: "probe", stage: job.stage, deferred: true });
    return { step: uiStep, status: "ran", stage: job.stage, deferred: true };
  }

  if (uiStep === "scrape") {
    appendLedger(job, "pipeline:step", "ui scrape (run): contract validated, browser work deferred where applicable");
    writeJob(outDir, job);
    emit(hub, job.jobId, "scrape:url-started", { url: job.source, slug: job.slug, mode: "scrape" });
    emit(hub, job.jobId, "job:advanced", { step: "scrape", stage: job.stage, deferred: true });
    return { step: uiStep, status: "ran", stage: job.stage, deferred: true };
  }

  if (uiStep === "detect") {
    appendLedger(job, "pipeline:step", "ui detect: backend discovery validated, CDP work deferred where applicable (guards enforced downstream)");
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "detect", stage: job.stage, deferred: true });
    return { step: uiStep, status: "ran", stage: job.stage, deferred: true };
  }

  fail("unknown-step", `unknown UI step ${uiStep}`, { step: uiStep });
}

function finishUiStep(outDir, job, hub, { uiStep, status, stage }) {
  appendLedger(job, "pipeline:step", `ui ${uiStep}: ${status} at ${stage}`);
  writeJob(outDir, job);
  emit(hub, job.jobId, "job:advanced", { step: uiStep, stage: job.stage, status });
  return { step: uiStep, status, stage: job.stage };
}

function ensureProbeStaging(outDir, job) {
  try {
    mkdirSync(join(outDir, STAGING_DIR), { recursive: true });
    mkdirSync(join(outDir, STAGING_DIR, job.slug), { recursive: true });
    const marker = join(outDir, STAGING_DIR, job.slug, "probe.json");
    if (!existsSync(marker)) {
      writeFileSync(marker, JSON.stringify({ slug: job.slug, source: job.source, jobId: job.jobId, at: new Date().toISOString() }, null, 1) + "\n", "utf8");
    }
  } catch {
    // Staging marker best-effort; stage walk + ledger already authoritative.
  }
}
