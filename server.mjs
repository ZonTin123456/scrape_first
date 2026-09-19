// server.mjs — P0 scaffold seam for the local job workspace.
// Importable only: importing this module starts nothing. Call
// `startServer({ outDir, port })` to serve the static client plus stub job
// endpoints in a single Node process.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function handle(req, res) {
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
    sendJson(res, 200, { accepted: false, reason: "not-implemented", jobId, commandId });
    return;
  }

  if ((m = path.match(/^\/jobs\/([^/]+)\/events$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only (P0 stub)" } });
      return;
    }
    // Cursor inputs accepted for forward compatibility; P0 replays the stub envelope.
    void u.searchParams.get("since");
    void req.headers["last-event-id"];
    const streamId = "stub-1";
    const seq = 1;
    const envelope = {
      v: 1,
      streamId,
      seq,
      jobId,
      type: "job:resynced",
      at: new Date().toISOString(),
      payload: { reason: "p0-stub" },
    };
    const frame = `id: ${streamId}:${seq}\nevent: job:resynced\ndata: ${JSON.stringify(envelope)}\n\n`;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(frame);
    return;
  }

  if ((m = path.match(/^\/jobs\/([^/]+)$/))) {
    const jobId = decodeURIComponent(m[1]);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: "GET only (P0 stub)" } });
      return;
    }
    sendJson(res, 404, {
      job: null,
      jobId,
      error: { code: "not-found", message: "job not found (P0 stub)" },
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, path);
    return;
  }
  sendJson(res, 404, { error: { code: "not-found", message: "unknown route (P0 stub)" } });
}

export async function startServer({ outDir = "./out", port = 0 } = {}) {
  const resolvedOut = resolve(process.cwd(), outDir);
  mkdirSync(resolvedOut, { recursive: true });

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "stub failure" } });
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
  return { server, port: actual, outDir: resolvedOut, url, close };
}
