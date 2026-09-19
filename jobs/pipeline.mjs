// jobs/pipeline.mjs — P7 Pipeline DAG as job ops.
// Canonical DAG + in-process executor for the UI path. No child processes,
// no stdin pauses: human steps become approval gates (approval events),
// --yes becomes the autoApprove option. CLI files (pipeline.mjs, backup-page.mjs,
// upload-people.mjs) keep working over the same DAG; this module mirrors their
// step list/ordering and drives the same staging files through injected
// in-process runners. Only node builtins + ./store.mjs + ./safety.mjs.
// Never imports CLI entries (reuse boundary: UI imports Lift + Wrap cores only).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { advance, appendLedger, canAdvance, failJob, finishUpload, SPINE, writeJob } from "./store.mjs";
import {
  beginUploadWithProof,
  grantArmFromSafety,
  recordDryPass,
  verifyDryReport,
} from "./safety.mjs";

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
    appendLedger(job, "pipeline:auto-approved", `${step} (maps --yes: non-interactive confirm only; safety gates still enforced)`);
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, approved: true, autoApproved: true });
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
  appendLedger(job, "pipeline:approved", step);
  writeJob(outDir, job);
  emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, approved: true });
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
    appendLedger(job, "pipeline:deferred", `${step}: contract validated, no in-process runner (browser work deferred)`);
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step, stage: job.stage, deferred: true });
    return { step, status: "deferred" };
  }
  const detail = await run(ctx);
  appendLedger(job, "pipeline:step", `${step}: in-process runner ok`);
  writeJob(outDir, job);
  emit(hub, job.jobId, "job:advanced", { step, stage: job.stage });
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
    appendLedger(job, "gate:failed", `upload refused: ${pre.reasons.join("; ").slice(0, 200)}`);
    writeJob(outDir, job);
    emit(hub, job.jobId, "gate:failed", { gate: "G1", step: "upload", reasons: pre.reasons });
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
    appendLedger(job, "pipeline:deferred", "upload: queue + dry proof validated, no uploadRow runner (arm untouched)");
    writeJob(outDir, job);
    emit(hub, job.jobId, "job:advanced", { step: "upload", stage: job.stage, deferred: true });
    return { step: "upload", status: "deferred", queue, skipped, warnings };
  }
  const started = beginUploadWithProof(outDir, job, {});
  writeJob(outDir, job);
  emit(hub, job.jobId, "arm:consumed", { reason: "upload-attempt", save_run_id: started.saveRunId });
  emit(hub, job.jobId, "job:advanced", { step: "upload", to: "uploading", stage: job.stage, save_run_id: started.saveRunId });
  emit(hub, job.jobId, "artifact:written", { kind: "save-report", relPath: started.relPath, sha256: started.sha256, byteLength: started.byteLength });
  const rowResults = [];
  for (const q of queue) {
    let result = null;
    try {
      result = await uploadRow({ outDir, job, entry: q, dir: q.dir });
    } catch (e) {
      result = { slug: q.slug, dir: q.dir, status: "failed", detail: String(e?.message ?? e).slice(0, 200) };
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
//   finalize, uploadRow}. Absent runners validate the staging contract and
//   defer with ledger audit (browser work deferred, arms untouched).
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
