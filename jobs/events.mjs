// jobs/events.mjs — P3 transport envelope, per-Job buffer, stream epoch.
// In-memory only, no fs watch, no polling, no engine imports.
// Envelope v:1 {v,streamId,seq,jobId,type,at,payload}.
// SSE id:<streamId>:<seq>, event:<type>. Dedup (jobId,streamId,seq).
// Payload notifications/references only, never authoritative state.
// Unknown type ignorable iff v supported. Unknown v -> resync, never silent.
import { randomBytes } from "node:crypto";

export const BUFFER_LIMIT = 200;
export const ENVELOPE_VERSION = 1;

export const KNOWN_TYPES = new Set([
  "job:advanced",
  "job:resynced",
  "job:created",
  "job:retry",
  "blocker:raised",
  "blocker:cleared",
  "gate:failed",
  "upload:plan",
  "upload:row-finished",
  "upload:report-written",
  "upload:stop_requested",
  "challenge:seen",
  "challenge:cleared",
  "challenge:blocked",
  "scrape:url-started",
  "scrape:url-finished",
  "scrape:url-failed",
  "scrape:image-downloaded",
  "scrape:image-failed",
  "scrape:group-demoted",
  "review:selection-written",
  "review:finalized",
  "artifact:written",
  "arm:granted",
  "arm:consumed",
]);

function newStreamId() {
  return `s_${randomBytes(4).toString("hex")}`;
}

function nowISO() {
  return new Date().toISOString();
}

export function isProofKind(kind) {
  if (typeof kind !== "string") return false;
  return /(report|shot|proof)/i.test(kind);
}

const FORBIDDEN_INLINE_KEYS = ["bytes", "inline", "base64", "blob", "buffer", "content", "data"];

export function assertArtifactPointer(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    const e = new Error("artifact must be object");
    e.code = "bad-artifact";
    throw e;
  }
  if (!a.kind || typeof a.kind !== "string") {
    const e = new Error("artifact kind required");
    e.code = "bad-artifact";
    throw e;
  }
  if (a.url != null && typeof a.url !== "string") {
    const e = new Error("artifact url must be string");
    e.code = "bad-artifact";
    throw e;
  }
  if (typeof a.url === "string") {
    if (a.url.startsWith("file://")) {
      const e = new Error("artifact url must be http pointer, never file://");
      e.code = "bad-artifact";
      throw e;
    }
    if (a.url.startsWith("data:")) {
      const e = new Error("artifact url must be pointer, never inline bytes");
      e.code = "bad-artifact";
      throw e;
    }
  }
  if (a.relPath != null && typeof a.relPath !== "string") {
    const e = new Error("artifact relPath must be string");
    e.code = "bad-artifact";
    throw e;
  }
  for (const k of FORBIDDEN_INLINE_KEYS) {
    if (a[k] != null) {
      const e = new Error(`artifact pointer-only: field ${k} forbidden`);
      e.code = "bad-artifact";
      throw e;
    }
  }
  if (a.byteLength != null) {
    if (!Number.isInteger(a.byteLength) || a.byteLength < 0) {
      const e = new Error("artifact byteLength must be int >=0 file length");
      e.code = "bad-artifact";
      throw e;
    }
  }
  if (isProofKind(a.kind)) {
    if (!a.sha256 || typeof a.sha256 !== "string" || !a.sha256) {
      const e = new Error(`artifact ${a.kind} requires sha256`);
      e.code = "bad-artifact";
      throw e;
    }
  } else if (a.sha256 != null && typeof a.sha256 !== "string") {
    const e = new Error("artifact sha256 must be string");
    e.code = "bad-artifact";
    throw e;
  }
  return true;
}

export function validateEnvelope(env) {
  if (!env || typeof env !== "object") return { ok: false, action: "resync", reason: "bad-envelope" };
  if (env.v !== ENVELOPE_VERSION) {
    return { ok: false, action: "resync", reason: "unknown-version", v: env.v };
  }
  if (typeof env.streamId !== "string" || !env.streamId) {
    return { ok: false, action: "resync", reason: "bad-stream" };
  }
  if (!Number.isInteger(env.seq) || env.seq < 1) {
    return { ok: false, action: "resync", reason: "bad-seq" };
  }
  if (typeof env.jobId !== "string" || !env.jobId) {
    return { ok: false, action: "resync", reason: "bad-job" };
  }
  if (typeof env.type !== "string" || !env.type) {
    return { ok: false, action: "resync", reason: "bad-type" };
  }
  if (typeof env.at !== "string" || !env.at) {
    return { ok: false, action: "resync", reason: "bad-at" };
  }
  if (KNOWN_TYPES.has(env.type)) return { ok: true, action: "accept" };
  return { ok: true, action: "ignore", reason: "unknown-type" };
}

export function createDeduper() {
  const seen = new Set();
  const k = (env) => `${env.jobId}:${env.streamId}:${env.seq}`;
  return {
    has(env) {
      return seen.has(k(env));
    },
    add(env) {
      seen.add(k(env));
    },
    check(env) {
      const key = k(env);
      if (seen.has(key)) return "duplicate";
      seen.add(key);
      return "new";
    },
    size() {
      return seen.size;
    },
    clear() {
      seen.clear();
    },
  };
}

export function formatSSE(env) {
  return `id: ${env.streamId}:${env.seq}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

export function parseCursor(raw, currentStreamId = null) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes(":")) {
    const idx = s.lastIndexOf(":");
    const streamId = s.slice(0, idx);
    const seq = Number(s.slice(idx + 1));
    if (!streamId || !Number.isInteger(seq) || seq < 0) return { invalid: true, raw: s };
    return { streamId, seq };
  }
  const seq = Number(s);
  if (!Number.isInteger(seq) || seq < 0) return { invalid: true, raw: s };
  return { streamId: currentStreamId, seq };
}

export function createHub({ bufferLimit = BUFFER_LIMIT } = {}) {
  const limit = bufferLimit;
  const streams = new Map();
  const listeners = new Map();

  function getStream(jobId) {
    const st = streams.get(jobId);
    if (!st) return null;
    return { streamId: st.streamId, seq: st.seq, buffered: st.buffer.length, limit };
  }

  function subscribe(jobId, cb) {
    let set = listeners.get(jobId);
    if (!set) {
      set = new Set();
      listeners.set(jobId, set);
    }
    set.add(cb);
    return () => {
      const s = listeners.get(jobId);
      if (s) s.delete(cb);
    };
  }

  function emit(jobId, type, payload = {}) {
    if (!jobId || typeof jobId !== "string") throw new Error("emit: jobId required");
    if (typeof type !== "string" || !type) throw new Error("emit: type required");
    let st = streams.get(jobId);
    if (!st) {
      st = { streamId: newStreamId(), seq: 0, buffer: [] };
      streams.set(jobId, st);
    }
    const seq = st.seq + 1;
    st.seq = seq;
    const env = {
      v: ENVELOPE_VERSION,
      streamId: st.streamId,
      seq,
      jobId,
      type,
      at: nowISO(),
      payload,
    };
    st.buffer.push(env);
    while (st.buffer.length > limit) st.buffer.shift();
    const subs = listeners.get(jobId);
    if (subs) {
      for (const cb of [...subs]) {
        try {
          cb(env);
        } catch {
          // ignore listener errors, transport stays alive
        }
      }
    }
    return env;
  }

  function replay(jobId, cursorRaw) {
    const st = streams.get(jobId);
    if (!st) {
      return { mode: "reset", reason: "unknown-stream", streamId: null, seq: 0, events: [] };
    }
    if (cursorRaw == null || String(cursorRaw).trim() === "") {
      return { mode: "welcome", streamId: st.streamId, seq: st.seq, events: [...st.buffer] };
    }
    const cur = parseCursor(cursorRaw, st.streamId);
    if (!cur || cur.invalid) {
      return { mode: "reset", reason: "unknown-cursor", streamId: st.streamId, seq: st.seq, events: [] };
    }
    const { streamId, seq } = cur;
    if (streamId !== st.streamId) {
      return {
        mode: "reset",
        reason: "epoch-changed",
        streamId: st.streamId,
        seq: st.seq,
        events: [],
      };
    }
    if (seq === st.seq) {
      return { mode: "live", streamId: st.streamId, seq: st.seq, events: [] };
    }
    if (seq > st.seq) {
      return { mode: "reset", reason: "unknown-cursor", streamId: st.streamId, seq: st.seq, events: [] };
    }
    // seq < current. since=0 means from beginning: replay all buffered.
    if (seq === 0) {
      return { mode: "replay", streamId: st.streamId, seq: st.seq, events: [...st.buffer] };
    }
    if (st.buffer.length === 0) {
      return { mode: "reset", reason: "purged", streamId: st.streamId, seq: st.seq, events: [] };
    }
    const oldest = st.buffer[0].seq;
    if (seq < oldest) {
      return { mode: "reset", reason: "purged", streamId: st.streamId, seq: st.seq, events: [] };
    }
    const events = st.buffer.filter((e) => e.seq > seq);
    return { mode: "replay", streamId: st.streamId, seq: st.seq, events };
  }

  function rotate(jobId, reason = "epoch") {
    const fresh = newStreamId();
    streams.set(jobId, { streamId: fresh, seq: 0, buffer: [] });
    return emit(jobId, "job:resynced", { reason: `new-epoch:${reason}`, streamId: fresh });
  }

  function clear() {
    streams.clear();
    listeners.clear();
  }

  return { emit, replay, getStream, subscribe, rotate, clear, get limit() { return limit; } };
}
