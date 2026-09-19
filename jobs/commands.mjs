// jobs/commands.mjs — P3 POST command idempotency + minimal job plumbing,
// plus P6 safety gates (dry/arm/begin-upload enforced via jobs/safety).
// Client-generated commandId on all mutating commands.
// Replay returns original disposition, never executes twice.
// Cancel records intent/audit before ack via jobs/store (ledger append + write).
import { findJobById, writeJob, requestCancel, advance, retry, resume, addArtifact } from "./store.mjs";
import { assertArtifactPointer } from "./events.mjs";
import { beginUploadWithProof, grantArmFromSafety, recordDryPass } from "./safety.mjs";

export const SUPPORTED = new Set(["cancel", "advance", "retry", "resume", "artifact", "dry", "arm", "begin-upload"]);

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
          if (hub) {
            try {
              hub.emit(jobId, "gate:failed", { gate: "G1", reason: e?.code ?? "gate1-failed" });
            } catch {
              // ignore
            }
          }
          throw e;
        }
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "job:advanced", { to: "dry_passed", stage: job.stage, reason: `dry ${result.dryRunId}` });
          } catch {
            // ignore
          }
          try {
            hub.emit(jobId, "artifact:written", {
              kind: "dry-report",
              relPath: result.relPath,
              sha256: result.sha256,
              byteLength: result.byteLength,
            });
          } catch {
            // ignore
          }
        }
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
          if (hub) {
            try {
              hub.emit(jobId, "gate:failed", { gate: e?.code === "gate1-failed" ? "G1" : "G2", reason: e?.code ?? "gate-failed" });
            } catch {
              // ignore
            }
          }
          throw e;
        }
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "arm:granted", { dry_run_id: job.dry_run_id, snapshot_id: job.snapshot_id });
          } catch {
            // ignore
          }
        }
        reason = "armed";
      } else if (type === "begin-upload") {
        // P6 real-upload entry: prerequisite dry verified fail-closed, then
        // the single-use arm is consumed and the immutable save proof (which
        // references that dry) is written. Any attempt consumes the arm.
        const p = payload ?? {};
        const result = beginUploadWithProof(outDir, job, { saveRunId: p.saveRunId ?? null });
        writeJob(outDir, job);
        if (hub) {
          try {
            hub.emit(jobId, "arm:consumed", { reason: "upload-attempt", save_run_id: result.saveRunId });
          } catch {
            // ignore
          }
          try {
            hub.emit(jobId, "job:advanced", { to: "uploading", stage: job.stage, save_run_id: result.saveRunId });
          } catch {
            // ignore
          }
          try {
            hub.emit(jobId, "artifact:written", {
              kind: "save-report",
              relPath: result.relPath,
              sha256: result.sha256,
              byteLength: result.byteLength,
            });
          } catch {
            // ignore
          }
        }
        reason = "upload-started";
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
