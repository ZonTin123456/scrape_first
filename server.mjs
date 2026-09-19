// server.mjs — P3 transport: SSE per Job + POST commands.
// Importable only: importing starts nothing. Call startServer({outDir,port}).
// Uses jobs/store for truth, jobs/events for envelope/buffer/epoch,
// jobs/commands for commandId idempotency. No engine imports.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findJobById } from "./jobs/store.mjs";
import { createHub, formatSSE } from "./jobs/events.mjs";
import { createCommandStore } from "./jobs/commands.mjs";

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

async function handleWith(req, res, ctx) {
  const { outDir, hub, commands } = ctx;
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const path = u.pathname;
  let m;

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

export async function startServer({ outDir = "./out", port = 0 } = {}) {
  const resolvedOut = resolve(process.cwd(), outDir);
  mkdirSync(resolvedOut, { recursive: true });
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
