// jobs/commands.mjs — P3 POST command idempotency + minimal job plumbing.
// Client-generated commandId on all mutating commands.
// Replay returns original disposition, never executes twice.
// Cancel records intent/audit before ack via jobs/store (ledger append + write).
import { findJobById, writeJob, requestCancel, advance, retry, resume, addArtifact } from "./store.mjs";
import { assertArtifactPointer } from "./events.mjs";

export const SUPPORTED = new Set(["cancel", "advance", "retry", "resume", "artifact"]);

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
    try {
      let reason;
      if (type === "cancel") {
        const prompted = payload?.prompted;
        const creason = payload?.reason ?? null;
        requestCancel(job, { prompted, reason: creason });
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "job:advanced", {
              stage: job.stage,
              stopRequested: !!job.stopRequested,
              reason: creason ?? "cancel",
            });
          } catch {
            // emit failure never blocks ack
          }
        }
        reason = job.stage === "cancelled" ? "cancelled" : job.stopRequested ? "stop_requested" : "cancelled";
      } else if (type === "advance") {
        const to = payload?.to;
        const areason = payload?.reason ?? null;
        advance(job, to, { reason: areason });
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "job:advanced", { to, stage: job.stage, reason: areason });
          } catch {
            // ignore
          }
        }
        reason = "advanced";
      } else if (type === "retry") {
        const to = payload?.to;
        const rreason = payload?.reason ?? null;
        retry(job, { to, reason: rreason });
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "job:advanced", { to, stage: job.stage, reason: rreason });
          } catch {
            // ignore
          }
        }
        reason = "retried";
      } else if (type === "resume") {
        const rreason = payload?.reason ?? null;
        resume(job, { reason: rreason });
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "job:advanced", { stage: job.stage, reason: rreason });
          } catch {
            // ignore
          }
        }
        reason = "resumed";
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
        if (hub) {
          try {
            hub.emit(jobId, "artifact:written", {
              kind: art.kind,
              url: art.url ?? null,
              relPath: art.relPath ?? null,
              sha256: art.sha256 ?? null,
              byteLength: art.byteLength ?? null,
            });
          } catch {
            // ignore
          }
        }
        reason = "artifact-recorded";
      }
      const d = { accepted: true, reason, jobId, commandId };
      seen.set(key, d);
      return { ...d };
    } catch (e) {
      const code = e && typeof e.code === "string" ? e.code : "command-failed";
      const d = { accepted: false, reason: code, jobId, commandId };
      seen.set(key, d);
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
