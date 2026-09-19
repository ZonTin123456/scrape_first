// server.mjs — P3 transport + P5 review-first component.
// Importable only: importing starts nothing. Call startServer({outDir,port}).
// Uses jobs/store for truth, jobs/events for envelope/buffer/epoch,
// jobs/commands for commandId idempotency, jobs/review for P5 semantics.
// No engine imports.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessRestart, findJobById, loadForRestart, writeJob } from "./jobs/store.mjs";
import { createHub, formatSSE } from "./jobs/events.mjs";
import { createCommandStore } from "./jobs/commands.mjs";
import {
  buildWarningPreview,
  loadReviewModel,
  saveReviewState,
  selectionPathFor,
  validateSelectionShape,
} from "./jobs/review.mjs";
import { safetyModel, verifyDryReport } from "./jobs/safety.mjs";

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad path");
    return;
  }
  const file = normalize(join(CLIENT_DIR, rel));
  const relToClient = relative(CLIENT_DIR, file);
  if (relToClient.startsWith("..") || isAbsolute(relToClient)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  let target = file;
  try {
    if (statSync(target).isDirectory()) target = join(target, "index.html");
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  try {
    const data = readFileSync(target);
    const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": data.length });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function writeEnvelope(res, env) {
  res.write(formatSSE(env));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      const e = new Error("body-too-large");
      e.code = 413;
      throw e;
    }
  }
  if (!raw) return {};
  return JSON.parse(raw);
}

function reviewBase(req) {
  const host = req.headers?.host || "127.0.0.1";
  return `http://${host}`;
}

function thumbsFor(req, jobId, selection) {
  const base = reviewBase(req);
  return (selection || []).map((r) => ({
    seq: r.seq,
    // localhost HTTP artifact pointer only. Never file://, never inline bytes.
    url: `${base}/jobs/${encodeURIComponent(jobId)}/review/thumbs/${encodeURIComponent(String(r.seq))}`,
  }));
}

function resolveThumbFile(outDir, job, seq) {
  const selPath = selectionPathFor(outDir, job.slug, job.jobId);
  let sel = null;
  try {
    sel = JSON.parse(readFileSync(selPath, "utf8"));
  } catch {
    return null;
  }
  const row = (Array.isArray(sel) ? sel : []).find((r) => Number(r?.seq) === Number(seq));
  if (!row) return null;
  const file = String(row.file ?? "");
  if (!file || file.startsWith("file://") || file.startsWith("data:")) return null;
  const jobDir = join(outDir, job.slug, "jobs", job.jobId);
  const candidates = [
    join(jobDir, file),
    join(jobDir, "review", file),
    join(jobDir, "review", "files", basename(file)),
    join(outDir, job.slug, file),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // next
    }
  }
  return null;
}

async function handleWith(req, res, ctx) {
  const { outDir, hub, commands } = ctx;
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const path = u.pathname;
  let m;

  // P5 review: HTTP-pointer thumbnails. Must precede generic /review routes.
  if ((m = path.match(/^\/jobs\/([^/]+)\/review\/thumbs\/([^/]+)$/))) {
    const jobId = decodeURIComponent(m[1]);
    const seqRaw = decodeURIComponent(m[2]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only" } });
      return;
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, { error: { code: "not-found", message: "job not found" } });
      return;
    }
    const abs = resolveThumbFile(outDir, found.job, seqRaw);
    if (!abs) {
      sendJson(res, 404, { error: { code: "not-found", message: `thumb not found for seq ${seqRaw}` } });
      return;
    }
    try {
      const data = readFileSync(abs);
      const type = MIME[extname(abs).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-length": data.length });
      res.end(data);
      return;
    } catch {
      sendJson(res, 404, { error: { code: "not-found", message: "thumb unreadable" } });
      return;
    }
  }

  // P5 review: non-persisting warning preview for a submitted draft.
  if ((m = path.match(/^\/jobs\/([^/]+)\/review\/preview$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, { error: { code: "not-found", message: "job not found" } });
      return;
    }
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: { code: "invalid-json", message: "invalid JSON" } });
      return;
    }
    const v = validateSelectionShape(body?.selection);
    if (!v.ok) {
      sendJson(res, 400, { error: { code: "invalid-selection", message: v.errors.join("; ") } });
      return;
    }
    // Same shared logic as finalize validation. Writes nothing.
    const preview = buildWarningPreview(v.selection);
    sendJson(res, 200, { jobId, persisted: false, ...preview });
    return;
  }

  // P5 review: warnings for the stored draft (non-persisting compute).
  if ((m = path.match(/^\/jobs\/([^/]+)\/review\/warnings$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only" } });
      return;
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, { error: { code: "not-found", message: "job not found" } });
      return;
    }
    const model = loadReviewModel(outDir, found.job);
    sendJson(res, 200, {
      jobId,
      revision: model.revision,
      fingerprint: model.fingerprint,
      stale: model.stale,
      persisted: false,
      warnings: model.warnings,
      duplicates: model.duplicates,
      effectiveOrder: model.effectiveOrder,
    });
    return;
  }

  // P5 review: GET model + POST-only save.
  if ((m = path.match(/^\/jobs\/([^/]+)\/review$/))) {
    const jobId = decodeURIComponent(m[1]);
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, { error: { code: "not-found", message: "job not found" } });
      return;
    }
    if (req.method === "GET") {
      const model = loadReviewModel(outDir, found.job);
      sendJson(res, 200, {
        jobId,
        slug: found.job.slug,
        stage: found.job.stage,
        revision: model.revision,
        fingerprint: model.fingerprint,
        stale: model.stale,
        staleReason: model.staleReason,
        selection: model.selection,
        effectiveOrder: model.effectiveOrder,
        warnings: model.warnings,
        duplicates: model.duplicates,
        thumbs: thumbsFor(req, jobId, model.selection),
      });
      return;
    }
    if (req.method === "POST") {
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        if (e?.code === 413) {
          sendJson(res, 413, { ok: false, reason: "body-too-large", jobId });
          return;
        }
        sendJson(res, 400, { ok: false, reason: "invalid-json", jobId });
        return;
      }
      // POST-only writer: GET never mutates; only this path writes.
      try {
        if (!Number.isInteger(body?.editedFrom)) {
          sendJson(res, 400, { ok: false, reason: "missing-revision", jobId });
          return;
        }
        const v = validateSelectionShape(body.selection);
        if (!v.ok) {
          sendJson(res, 400, { ok: false, reason: "invalid-selection", detail: v.errors.join("; "), jobId });
          return;
        }
        const saved = saveReviewState(outDir, found.job, { selection: v.selection, editedFrom: body.editedFrom });
        writeJob(outDir, found.job);
        try {
          hub.emit(jobId, "review:selection-written", {
            slug: found.job.slug,
            count: saved.selection.length,
            revision: saved.revision,
            relPath: `${found.job.slug}/jobs/${jobId}/review/selection.json`,
          });
        } catch {
          // emit never blocks save ack
        }
        try {
          hub.emit(jobId, "artifact:written", {
            kind: "selection",
            relPath: `${found.job.slug}/jobs/${jobId}/review/selection.json`,
            sha256: saved.fingerprint,
            byteLength: Buffer.byteLength(JSON.stringify(saved.selection), "utf8"),
          });
        } catch {
          // ignore
        }
        const preview = buildWarningPreview(saved.selection);
        sendJson(res, 200, {
          ok: true,
          jobId,
          revision: saved.revision,
          fingerprint: saved.fingerprint,
          warnings: preview.warnings,
          duplicates: preview.duplicates,
          effectiveOrder: preview.effectiveOrder,
        });
        return;
      } catch (e) {
        if (e?.code === "stale-conflict") {
          const cur = loadReviewModel(outDir, found.job);
          sendJson(res, 409, {
            ok: false,
            reason: "stale-conflict",
            detail: e.message,
            jobId,
            revision: cur.revision,
            fingerprint: cur.fingerprint,
            stale: true,
          });
          return;
        }
        if (e?.code === "invalid-selection" || e?.code === "missing-revision") {
          sendJson(res, 400, { ok: false, reason: e.code, detail: e.message, jobId });
          return;
        }
        sendJson(res, 400, { ok: false, reason: "invalid-selection", detail: e?.message || "save failed", jobId });
        return;
      }
    }
    sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET or POST only" } });
    return;
  }

  // P6 Safety: undroppable visibility bundle + live G1/G2 status (read-only).
  // Mutations go through POST /jobs/:jobId/commands (dry/arm/begin-upload)
  // so commandId idempotency covers arm/upload single-use. This GET never
  // mutates and never infers rows from logs or stray files.
  if ((m = path.match(/^\/jobs\/([^/]+)\/safety$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only" } });
      return;
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, { error: { code: "not-found", message: "job not found" } });
      return;
    }
    try {
      sendJson(res, 200, safetyModel(outDir, found.job));
    } catch (e) {
      sendJson(res, 500, { error: { code: e?.code ?? "internal", message: e?.message ?? "failure" } });
    }
    return;
  }

  if ((m = path.match(/^\/jobs\/([^/]+)\/commands$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "POST") {
      sendJson(res, 405, { accepted: false, reason: "method-not-allowed", jobId, commandId: null });
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) {
        sendJson(res, 413, { accepted: false, reason: "body-too-large", jobId, commandId: null });
        return;
      }
    }
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { accepted: false, reason: "invalid-json", jobId, commandId: null });
      return;
    }
    const commandId = body?.commandId ?? null;
    if (typeof commandId !== "string" || !commandId) {
      sendJson(res, 400, { accepted: false, reason: "missing-commandId", jobId, commandId: null });
      return;
    }
    const type = body?.type ?? null;
    if (typeof type !== "string" || !type) {
      sendJson(res, 400, { accepted: false, reason: "missing-type", jobId, commandId });
      return;
    }
    const payload = body?.payload ?? {};
    const disposition = commands.execute({ outDir, jobId, commandId, type, payload });
    sendJson(res, 200, disposition);
    return;
  }

  if ((m = path.match(/^\/jobs\/([^/]+)\/events$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only" } });
      return;
    }
    let known = null;
    try {
      known = findJobById(outDir, jobId);
    } catch {
      known = null;
    }
    if (!hub.getStream(jobId)) {
      hub.emit(jobId, "job:resynced", { reason: "stream-open" });
    }
    const lastId = req.headers["last-event-id"] ?? null;
    const sinceRaw = u.searchParams.get("since");
    const cursorRaw = lastId ?? sinceRaw ?? null;
    const replayed = hub.replay(jobId, cursorRaw);
    let toSend;
    if (replayed.mode === "reset") {
      const resetEnv = hub.emit(jobId, "job:resynced", {
        reset: true,
        reason: replayed.reason,
        hint: "GET /jobs/:id",
      });
      toSend = [resetEnv];
    } else {
      toSend = replayed.events;
      if (toSend.length === 0 && cursorRaw == null) {
        // welcome with empty buffer cannot happen (stream-open emitted),
        // but guard: ensure caller gets a cursor.
        const cur = hub.getStream(jobId);
        if (cur && cur.buffered === 0) {
          toSend = [hub.emit(jobId, "job:resynced", { reason: "stream-open" })];
        }
      }
    }
    const once = u.searchParams.get("once");
    const live = u.searchParams.get("live");
    const finiteRequested = once === "1" || live === "0";
    const finiteForUnknown = !known;
    if (finiteRequested || finiteForUnknown) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const env of toSend) writeEnvelope(res, env);
      res.end();
      return;
    }
    // Live per-Job stream: replay buffered, then stay open for pushes.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const env of toSend) writeEnvelope(res, env);
    if (typeof res.flushHeaders === "function") {
      try {
        res.flushHeaders();
      } catch {
        // ignore
      }
    }
    const unsub = hub.subscribe(jobId, (env) => {
      try {
        writeEnvelope(res, env);
      } catch {
        // client gone
      }
    });
    const cleanup = () => {
      try {
        unsub();
      } catch {
        // ignore
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    return;
  }

  if (path === "/jobs" && (req.method === "GET" || req.method === "HEAD")) {
    sendJson(res, 200, { jobs: [] });
    return;
  }

  if ((m = path.match(/^\/jobs\/([^/]+)$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only" } });
      return;
    }
    let found = null;
    try {
      found = findJobById(outDir, jobId);
    } catch {
      found = null;
    }
    if (!found) {
      sendJson(res, 404, {
        job: null,
        jobId,
        error: { code: "not-found", message: "job not found" },
      });
      return;
    }
    sendJson(res, 200, { job: found.job });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, path);
    return;
  }
  sendJson(res, 404, { error: { code: "not-found", message: "unknown route" } });
}

// Restart validation (finding 1, plan State contract): scan persisted job
// records, load + validate artifacts/fingerprints via loadForRestart,
// re-verify the dry proof, and disarm dry_passed/armed jobs on proof or
// artifact loss via assessRestart. Stage always comes from the record — never
// inferred from stray files. Only disarmed records are rewritten; healthy
// records are untouched. Exported for tests.
export function validateJobsAtBoot(outDir) {
  const checked = [];
  const disarmed = [];
  let slugs = [];
  try {
    slugs = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return { checked: 0, disarmed: [] };
  }
  for (const ent of slugs) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
    const slug = ent.name;
    let jobs = [];
    try {
      jobs = readdirSync(join(outDir, slug, "jobs"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const j of jobs) {
      if (!j.isDirectory()) continue;
      try {
        const loaded = loadForRestart(outDir, slug, j.name);
        const issues = loaded.issues || [];
        const artifactsOk = !issues.some((i) => i.code === "artifact-missing");
        const fingerprintsOk = !issues.some((i) => i.code === "fingerprint-mismatch");
        let proofsOk = true;
        if (loaded.job?.dry_run_id) {
          try {
            proofsOk = verifyDryReport(outDir, loaded.job).ok;
          } catch {
            proofsOk = false;
          }
        }
        const res = assessRestart(loaded.job, { artifactsOk, fingerprintsOk, proofsOk, detail: "boot" });
        checked.push(j.name);
        if (res.disarmed) {
          writeJob(outDir, loaded.job);
          disarmed.push(j.name);
        }
      } catch {
        // Corrupt/unreadable record: leave for the explicit read path errors.
      }
    }
  }
  return { checked: checked.length, disarmed };
}

export async function startServer({ outDir = "./out", port = 0 } = {}) {
  const resolvedOut = resolve(process.cwd(), outDir);
  mkdirSync(resolvedOut, { recursive: true });
  // P8 restart validation at boot (finding 1): every persisted job record is
  // loaded, artifacts/fingerprints checked, dry proof re-verified; proof or
  // artifact loss on dry_passed/armed disarms back to dry_running (fail
  // closed, plan State contract). Stream epoch stays fresh (new hub) — no
  // fake continuity. Never blocks boot: per-job errors are skipped.
  validateJobsAtBoot(resolvedOut);
  const hub = createHub();
  const commands = createCommandStore({ hub });

  const server = createServer((req, res) => {
    handleWith(req, res, { outDir: resolvedOut, hub, commands }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "failure" } });
      else res.end();
    });
  });

  await new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", bad);
      ok();
    });
  });

  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${actual}`;
  const close = () =>
    new Promise((ok, bad) => {
      if (!server.listening) {
        ok();
        return;
      }
      server.close((e) => (e ? bad(e) : ok()));
    });
  return { server, port: actual, outDir: resolvedOut, url, close, hub, commands };
}
