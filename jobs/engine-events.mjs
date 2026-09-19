// jobs/engine-events.mjs — P4a minimal engine events (trio + row + artifact).
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
    if (!P4A_TYPES.has(type)) return null;
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
    artifactWritten,
    artifactFromFile,
  };
}
