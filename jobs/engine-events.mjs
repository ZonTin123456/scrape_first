// jobs/engine-events.mjs — P4a minimal + P4b full engine event catalog.
// Importable emitter wrapping jobs/events.mjs hub, usable by Wrap cores
// without CLI coupling. No CLI/browser imports. No writes, no console.
// Behind flag first: JOB_EVENTS=1 or opts.emitEvents. UI path passes
// emitEvents:true explicitly; CLI defaults off so terminal/files unchanged.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { assertArtifactPointer } from "./events.mjs";

export const P4A_TYPES = new Set([
  "scrape:url-started",
  "scrape:url-finished",
  "scrape:url-failed",
  "upload:row-finished",
  "artifact:written",
]);

// P4b full catalog (plan §P4 second half + Transport event catalog).
// Challenge variants use `challenge:` prefix per envelope `domain:action`
// convention (task shorthand challenge-seen/cleared/blocked).
export const P4B_TYPES = new Set([
  "upload:plan",
  "challenge:seen",
  "challenge:cleared",
  "challenge:blocked",
  "scrape:image-downloaded",
  "scrape:image-failed",
  "scrape:group-demoted",
  "review:selection-written",
  "review:finalized",
  "upload:report-written",
]);

export const FULL_ENGINE_TYPES = new Set([...P4A_TYPES, ...P4B_TYPES]);

export function isEngineEventsEnabled(opts = {}) {
  if (opts && typeof opts.emitEvents === "boolean") return opts.emitEvents;
  if (opts && opts.emitEvents != null) return !!opts.emitEvents;
  try {
    return process.env.JOB_EVENTS === "1";
  } catch {
    return false;
  }
}

function trunc(s, n = 200) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
}

function cleanPayload(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export function artifactPointerForFile({ absPath, relPath = null, kind, url = null } = {}) {
  if (!kind || typeof kind !== "string") throw new Error("artifactPointerForFile: kind required");
  if (!absPath || typeof absPath !== "string") return null;
  let buf;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null;
  }
  const byteLength = buf.length;
  let sha256 = null;
  try {
    sha256 = createHash("sha256").update(buf).digest("hex");
  } catch {
    sha256 = null;
  }
  const pointer = cleanPayload({ kind, url, relPath, sha256, byteLength });
  assertArtifactPointer(pointer);
  return pointer;
}

export function createEngineEmitter({ hub = null, jobId = null, emitEvents } = {}) {
  const enabled = !!(hub && jobId && typeof jobId === "string" && isEngineEventsEnabled({ emitEvents }));

  function safeEmit(type, payload) {
    if (!enabled) return null;
    if (!FULL_ENGINE_TYPES.has(type)) return null;
    try {
      return hub.emit(jobId, type, payload);
    } catch {
      return null;
    }
  }

  function urlStarted({ url, slug = null, mode = null } = {}) {
    if (!url) return null;
    return safeEmit("scrape:url-started", cleanPayload({ url, slug, mode }));
  }

  function urlFinished({ url, slug = null, dir = null, title = null, counts = null } = {}) {
    if (!url) return null;
    return safeEmit("scrape:url-finished", cleanPayload({ url, slug, dir, title, counts }));
  }

  function urlFailed({ url, slug = null, error = null } = {}) {
    if (!url) return null;
    return safeEmit("scrape:url-failed", cleanPayload({ url, slug, error: error != null ? trunc(error) : null }));
  }

  function rowFinished({ seq, order = null, name = null, status, detail = null, group = null, form = null } = {}) {
    if (seq == null || !status) return null;
    return safeEmit(
      "upload:row-finished",
      cleanPayload({ seq, order, name, status, detail: detail != null ? trunc(detail, 300) : null, group, form })
    );
  }

  // P4b full catalog. All payloads are notifications/references only
  // (counts, relPaths, urls, truncated reasons) — never authoritative
  // state (no job dump, no ledger, no inline bytes, no full results).

  function uploadPlan({ slug = null, mode = null, total = null, plan = null } = {}) {
    if (!Array.isArray(plan)) return null;
    const cleanPlan = [];
    for (const e of plan.slice(0, 200)) {
      if (!e || typeof e !== "object") continue;
      if (!e.group) continue;
      cleanPlan.push(
        cleanPayload({
          group: trunc(e.group, 200),
          action: e.action != null ? trunc(e.action, 40) : null,
          target: e.target != null ? trunc(e.target, 300) : null,
          via: e.via != null ? trunc(e.via, 40) : null,
        })
      );
    }
    return safeEmit("upload:plan", cleanPayload({ slug, mode, total, groups: cleanPlan.length, plan: cleanPlan }));
  }

  function challengeSeen({ url, phase = null } = {}) {
    if (!url) return null;
    return safeEmit("challenge:seen", cleanPayload({ url, phase }));
  }

  function challengeCleared({ url, elapsedMs = null } = {}) {
    if (!url) return null;
    return safeEmit("challenge:cleared", cleanPayload({ url, elapsedMs }));
  }

  function challengeBlocked({ url, reason = null, phase = null } = {}) {
    if (!url) return null;
    return safeEmit(
      "challenge:blocked",
      cleanPayload({ url, reason: reason != null ? trunc(reason, 200) : null, phase })
    );
  }

  function imageDownloaded({ seq, file = null, byteLength = null, bytes = null, via = null, url = null } = {}) {
    if (seq == null) return null;
    const len = byteLength ?? bytes;
    if (len != null && (!Number.isInteger(len) || len < 0)) return null;
    return safeEmit("scrape:image-downloaded", cleanPayload({ seq, file, byteLength: len, via, url }));
  }

  function imageFailed({ seq, src = null, error = null, via = null } = {}) {
    if (seq == null) return null;
    return safeEmit(
      "scrape:image-failed",
      cleanPayload({ seq, src, error: error != null ? trunc(error, 200) : null, via })
    );
  }

  function groupDemoted({ url = null, seq, previous = null, demoted = null, kept = null, reason = null } = {}) {
    if (seq == null) return null;
    return safeEmit(
      "scrape:group-demoted",
      cleanPayload({ url, seq, previous, demoted, kept, reason: reason != null ? trunc(reason, 200) : null })
    );
  }

  function selectionWritten({ slug = null, dir = null, count = null, relPath = null } = {}) {
    if (count == null && !slug && !dir) return null;
    return safeEmit("review:selection-written", cleanPayload({ slug, dir, count, relPath }));
  }

  function finalized({ slug = null, dir = null, kept = null, removed = null, counts = null } = {}) {
    if (!slug && !dir) return null;
    return safeEmit("review:finalized", cleanPayload({ slug, dir, kept, removed, counts }));
  }

  function reportWritten({ slug = null, mode = null, total = null, byStatus = null, relPath = null } = {}) {
    if (!mode && total == null && !slug) return null;
    if (byStatus != null && (typeof byStatus !== "object" || Array.isArray(byStatus))) return null;
    return safeEmit("upload:report-written", cleanPayload({ slug, mode, total, byStatus, relPath }));
  }

  function artifactWritten(input = {}) {
    if (!input || !input.kind) return null;
    for (const k of ["bytes", "inline", "base64", "blob", "buffer", "content", "data"]) {
      if (input[k] != null) return null;
    }
    const { kind, url = null, relPath = null, sha256 = null, byteLength = null } = input;
    const pointer = cleanPayload({ kind, url, relPath, sha256, byteLength });
    try {
      assertArtifactPointer(pointer);
    } catch {
      return null;
    }
    return safeEmit("artifact:written", pointer);
  }

  function artifactFromFile({ absPath, relPath = null, kind, url = null } = {}) {
    if (!enabled) return null;
    let pointer = null;
    try {
      pointer = artifactPointerForFile({ absPath, relPath, kind, url });
    } catch {
      return null;
    }
    if (!pointer) return null;
    return safeEmit("artifact:written", pointer);
  }

  return {
    enabled,
    jobId: enabled ? jobId : null,
    hub: enabled ? hub : null,
    emit: safeEmit,
    urlStarted,
    urlFinished,
    urlFailed,
    rowFinished,
    uploadPlan,
    challengeSeen,
    challengeCleared,
    challengeBlocked,
    imageDownloaded,
    imageFailed,
    groupDemoted,
    selectionWritten,
    finalized,
    reportWritten,
    artifactWritten,
    artifactFromFile,
  };
}
