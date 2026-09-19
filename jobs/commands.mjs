// jobs/commands.mjs — P3 POST command idempotency + minimal job plumbing,
// plus P6 safety gates (dry/arm/begin-upload enforced via jobs/safety).
// Client-generated commandId on all mutating commands.
// Replay returns original disposition, never executes twice.
// Cancel records intent/audit before ack via jobs/store (ledger append + write).
import { findJobById, writeJob, requestCancel, advance, retry, resume, addArtifact, finishUploadRowAndCancel, currentEngineOp, jobDirFor } from "./store.mjs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertArtifactPointer } from "./events.mjs";
import { beginUploadWithProof, grantArmFromSafety, recordDryPass } from "./safety.mjs";
import { UI_STEPS, runUiStepSync } from "./pipeline.mjs";

export const SUPPORTED = new Set(["cancel", "advance", "retry", "resume", "artifact", "dry", "arm", "begin-upload", "finish-row", "probe", "approve-page", "scrape", "finalize", "detect", "run-step"]);

// Engine-mutating commands yield to an active engine op (single-flight v1,
// Wayfinder #12): while runPipelineAsJobOps holds the claim, dry/arm/
// begin-upload are refused transiently. Cancel/finish-row/review traffic is
// never gated (stop must always get through). Refusals are NOT cached: the
// same commandId retries fresh after release.
// UI step commands (probe/scrape/finalize/detect/run-step) also yield: they
// claim the same single-flight briefly via runUiStepSync. approve-page is a
// human gate like resume (never gated).
export const ENGINE_OPS = new Set(["dry", "arm", "begin-upload", "probe", "scrape", "finalize", "detect", "run-step"]);

// Emit helper: hub failures never block the command ack.
function emitSafe(hub, jobId, type, payload) {
  if (!hub) return null;
  try {
    return hub.emit(jobId, type, payload ?? {});
  } catch {
    return null;
  }
}

// Per-job command log: persists dispositions next to the job record so a
// replayed commandId never double-executes across server restart (P8 #29).
// Best-effort: corrupt/missing log reads as empty; write failure leaves the
// in-memory guard for this process. Capped to bound disk growth.
export const COMMAND_LOG_LIMIT = 500;

export function commandLogPathFor(outDir, slug, jobId) {
  return join(jobDirFor(outDir, slug, jobId), "commands.json");
}

export function loadCommandLog(outDir, slug, jobId) {
  try {
    const obj = JSON.parse(readFileSync(commandLogPathFor(outDir, slug, jobId), "utf8"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    // missing/corrupt log: no replay memory, execute fresh
  }
  return {};
}

export function persistDisposition(outDir, slug, jobId, commandId, disposition) {
  try {
    const log = loadCommandLog(outDir, slug, jobId);
    log[commandId] = disposition;
    const keys = Object.keys(log);
    const pruned = {};
    for (const k of keys.slice(Math.max(0, keys.length - COMMAND_LOG_LIMIT))) pruned[k] = log[k];
    const path = commandLogPathFor(outDir, slug, jobId);
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(pruned, null, 1) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    // persistence best-effort; in-memory seen still guards this process
  }
}

export function isSupported(type) {
  return SUPPORTED.has(type);
}

export function createCommandStore({ hub = null } = {}) {
  const seen = new Map();
  const k = (jobId, commandId) => `${jobId}:${commandId}`;

  function execute({ outDir, jobId, commandId, type, payload = {} } = {}) {
    if (!jobId || typeof jobId !== "string") throw new Error("execute: jobId required");
    if (!commandId || typeof commandId !== "string") throw new Error("execute: commandId required");
    const key = k(jobId, commandId);
    if (seen.has(key)) {
      return { ...seen.get(key) };
    }
    if (typeof type !== "string" || !type || !SUPPORTED.has(type)) {
      const d = { accepted: false, reason: "not-implemented", jobId, commandId };
      seen.set(key, d);
      return { ...d };
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      const d = { accepted: false, reason: "job-not-found", jobId, commandId };
      seen.set(key, d);
      return { ...d };
    }
    const { job } = found;
    if (ENGINE_OPS.has(type) && currentEngineOp()) {
      // Transient busy refusal: never cached, never executed. Retry with the
      // same commandId after release runs fresh (finding 5).
      return { accepted: false, reason: "single-flight", jobId, commandId };
    }
    // Cross-restart replay: a disposition persisted by a previous process
    // wins over re-execution (finding 7). In-memory seen stays first.
    const logged = loadCommandLog(outDir, found.slug, jobId)[commandId];
    if (logged && typeof logged === "object" && !Array.isArray(logged)) {
      const replayed = { ...logged, jobId, commandId };
      seen.set(key, replayed);
      return { ...replayed };
    }
    try {
      let reason;
      if (type === "cancel") {
        const prompted = payload?.prompted;
        const creason = payload?.reason ?? null;
        requestCancel(job, { prompted, reason: creason });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", {
          stage: job.stage,
          stopRequested: !!job.stopRequested,
          reason: creason ?? "cancel",
        });
        reason = job.stage === "cancelled" ? "cancelled" : job.stopRequested ? "stop_requested" : "cancelled";
      } else if (type === "advance") {
        const to = payload?.to;
        const areason = payload?.reason ?? null;
        advance(job, to, { reason: areason });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", { to, stage: job.stage, reason: areason });
        reason = "advanced";
      } else if (type === "retry") {
        const to = payload?.to;
        const rreason = payload?.reason ?? null;
        retry(job, { to, reason: rreason });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", { to, stage: job.stage, reason: rreason });
        reason = "retried";
      } else if (type === "resume") {
        const rreason = payload?.reason ?? null;
        resume(job, { reason: rreason });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", { stage: job.stage, reason: rreason });
        reason = "resumed";
      } else if (type === "dry") {
        // P6 G1: record a dry pass. Payload carries the dry inputs; the gate
        // (row policy + guard + snapshot) is enforced in jobs/safety and
        // fails closed — the job stays dry_running on gate1-failed.
        const p = payload ?? {};
        let result;
        try {
          result = recordDryPass(outDir, job, {
            snapshotInput: p.snapshotInput ?? null,
            snapshotId: p.snapshotId ?? null,
            rows: p.rows ?? [],
            mapMode: p.mapMode ?? "pinned",
            guardStatus: p.guardStatus ?? "green",
            listedPath: p.listedPath ?? null,
            destinationOrigin: p.destinationOrigin ?? null,
            targetDepts: p.targetDepts ?? [],
            wouldCreate: p.wouldCreate ?? [],
            identity: p.identity ?? null,
            unmapped: p.unmapped ?? [],
            shots: p.shots ?? [],
          });
        } catch (e) {
          emitSafe(hub, jobId, "gate:failed", { gate: "G1", reason: e?.code ?? "gate1-failed" });
          throw e;
        }
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", { to: "dry_passed", stage: job.stage, reason: `dry ${result.dryRunId}` });
        emitSafe(hub, jobId, "artifact:written", {
          kind: "dry-report",
          relPath: result.relPath,
          sha256: result.sha256,
          byteLength: result.byteLength,
        });
        reason = "dry-recorded";
      } else if (type === "arm") {
        // P6 G2: exact attestation copy + typed slug + click, after live G1.
        const p = payload ?? {};
        try {
          grantArmFromSafety(outDir, job, {
            attestedText: p.attestedText ?? null,
            typed: p.typed ?? null,
            clicked: p.clicked ?? false,
          });
        } catch (e) {
          emitSafe(hub, jobId, "gate:failed", { gate: e?.code === "gate1-failed" ? "G1" : "G2", reason: e?.code ?? "gate-failed" });
          throw e;
        }
        writeJob(outDir, job);
        emitSafe(hub, jobId, "arm:granted", { dry_run_id: job.dry_run_id, snapshot_id: job.snapshot_id });
        reason = "armed";
      } else if (type === "begin-upload") {
        // P6 real-upload entry: prerequisite dry verified fail-closed, then
        // the single-use arm is consumed and the immutable save proof (which
        // references that dry) is written. Any attempt consumes the arm.
        const p = payload ?? {};
        const result = beginUploadWithProof(outDir, job, { saveRunId: p.saveRunId ?? null });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "arm:consumed", { reason: "upload-attempt", save_run_id: result.saveRunId });
        emitSafe(hub, jobId, "job:advanced", { to: "uploading", stage: job.stage, save_run_id: result.saveRunId });
        emitSafe(hub, jobId, "artifact:written", {
          kind: "save-report",
          relPath: result.relPath,
          sha256: result.sha256,
          byteLength: result.byteLength,
        });
        reason = "upload-started";
      } else if (type === "finish-row") {
        // P8 upload-stop path: the engine finished the current row truthfully
        // after stop_requested; this records cancelled (consumes arm) over the
        // transport with commandId idempotency. Repeated calls idempotent.
        const rreason = payload?.reason ?? null;
        finishUploadRowAndCancel(job, { reason: rreason });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "job:advanced", { to: "cancelled", stage: job.stage, reason: rreason ?? "row-finished" });
        reason = "cancelled";
      } else if (UI_STEPS.includes(type)) {
        // PR #30 gap fix: normal workflow from the workspace (no CLI).
        // Delegates to jobs/pipeline runUiStepSync (state machine + ledger +
        // SSE + pure wrapped cores; browser work deferred). writeJob + emits
        // happen inside runUiStepSync; here we only map disposition reason.
        // Throws fail-closed (terminal/illegal-transition/single-flight) for
        // outer catch mapping. Idempotent via outer commandId wrapper.
        const result = runUiStepSync({ outDir, job, uiStep: type, hub, payload: payload ?? {} });
        if (result?.status === "already-past") reason = "already-past";
        else if (result?.status === "awaiting-approval") reason = "awaiting-approval";
        else if (type === "probe") reason = "probed";
        else if (type === "approve-page") reason = "page-approved";
        else if (type === "scrape") reason = "scraped";
        else if (type === "finalize") reason = "finalized";
        else if (type === "detect") reason = "detected";
        else if (type === "run-step") reason = "step-ran";
        else reason = "step-ran";
      } else if (type === "artifact") {
        const art = payload?.artifact ?? payload;
        assertArtifactPointer(art);
        addArtifact(job, {
          kind: art.kind,
          url: art.url ?? null,
          relPath: art.relPath ?? null,
          sha256: art.sha256 ?? null,
          byteLength: art.byteLength ?? null,
        });
        writeJob(outDir, job);
        emitSafe(hub, jobId, "artifact:written", {
          kind: art.kind,
          url: art.url ?? null,
          relPath: art.relPath ?? null,
          sha256: art.sha256 ?? null,
          byteLength: art.byteLength ?? null,
        });
        reason = "artifact-recorded";
      }
      const d = { accepted: true, reason, jobId, commandId };
      seen.set(key, d);
      persistDisposition(outDir, found.slug, jobId, commandId, d);
      return { ...d };
    } catch (e) {
      const code = e && typeof e.code === "string" ? e.code : "command-failed";
      const d = { accepted: false, reason: code, jobId, commandId };
      seen.set(key, d);
      persistDisposition(outDir, found.slug, jobId, commandId, d);
      return { ...d };
    }
  }

  function get(jobId, commandId) {
    const v = seen.get(k(jobId, commandId));
    return v ? { ...v } : null;
  }

  function clear() {
    seen.clear();
  }

  function size() {
    return seen.size;
  }

  return { execute, get, clear, size };
}
