// P0 scaffold seam: startServer serves static client + stub job endpoints.
// Run: node --test tests/server-seam.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("server.mjs static linkage scan (no engine on the server path)", () => {
  const src = readFileSync(join(root, "server.mjs"), "utf8");
  const targets = [
    ...src.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  it("imports node builtins + relative paths only", () => {
    assert.ok(targets.length > 0, "expected at least one import");
    for (const t of targets) {
      assert.ok(
        t.startsWith("node:") || t.startsWith("./") || t.startsWith("../"),
        `non-builtin import on server path: ${t}`,
      );
    }
  });

  it("no engine/service/browser linkage", () => {
    const banned = [
      /playwright/i,
      /backup-page/,
      /pipeline/,
      /upload-people/,
      /automap/,
      /sectioning/,
      /group-guard/,
      /host-gate/,
      /verify-identity/,
      /cdp-port/,
      /target-creation/,
      /match\.mjs/,
      /child_process/,
      /electron/i,
      /tauri/i,
    ];
    for (const t of targets) {
      for (const re of banned) assert.ok(!re.test(t), `banned import on server path: ${t}`);
    }
    assert.ok(!/spawnSync/.test(src), "banned spawnSync on server path");
  });

  it("no top-level listen (importable seam)", () => {
    const hits = [...src.matchAll(/\.listen\(/g)];
    assert.equal(hits.length, 1, "exactly one listen call");
    assert.ok(src.indexOf("startServer") < hits[0].index, "listen lives inside startServer");
  });
});

describe("startServer stub roundtrip", () => {
  let app;
  before(async () => {
    const outDir = mkdtempSync(join(tmpdir(), "p0-seam-"));
    app = await startServer({ outDir, port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  it("serves the static client shell at / (light shell after #44 flip)", async () => {
    const r = await fetch(`${app.url}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/html/);
    const html = await r.text();
    assert.match(html, /light-job-workspace/);
  });

  it("old single-page file retired: absent on disk, /index.html now 404s (#45)", async () => {
    assert.throws(() => readFileSync(join(root, "web", "index.html"), "utf8"), /ENOENT/);
    const r = await fetch(`${app.url}/index.html`, { headers: { Accept: "text/html" } });
    assert.equal(r.status, 404);
  });

  it("GET /jobs/:id returns forward-compat not-found", async () => {
    const r = await fetch(`${app.url}/jobs/demo-1`);
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.job, null);
    assert.equal(body.jobId, "demo-1");
    assert.equal(body.error?.code, "not-found");
  });

  it("POST /jobs/:jobId/commands echoes not-implemented with commandId", async () => {
    const r = await fetch(`${app.url}/jobs/demo-1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", type: "bogus-type-xyz", payload: {} }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      accepted: false,
      reason: "not-implemented",
      jobId: "demo-1",
      commandId: "cmd-1",
    });
  });

  it("POST probe on missing job fails job-not-found (wired, not stub)", async () => {
    const r = await fetch(`${app.url}/jobs/demo-1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-probe-1", type: "probe", payload: {} }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      accepted: false,
      reason: "job-not-found",
      jobId: "demo-1",
      commandId: "cmd-probe-1",
    });
  });

  it("POST without commandId fails closed with the idempotency shape", async () => {
    const r = await fetch(`${app.url}/jobs/demo-1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "probe" }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.accepted, false);
    assert.equal(body.jobId, "demo-1");
    assert.equal(body.commandId, null);
  });

  it("GET /jobs/:jobId/events returns an SSE envelope and accepts cursors", async () => {
    const r = await fetch(`${app.url}/jobs/demo-1/events`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /event:\s*job:resynced/);
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    assert.ok(dataLine, "missing SSE data line");
    const env = JSON.parse(dataLine.slice("data:".length).trim());
    assert.deepEqual(
      Object.keys(env).sort(),
      ["at", "jobId", "payload", "seq", "streamId", "type", "v"].sort(),
    );
    assert.equal(env.v, 1);
    assert.equal(env.jobId, "demo-1");
    assert.equal(env.type, "job:resynced");
    assert.match(text, new RegExp(`id:\\s*${env.streamId}:${env.seq}`));

    const r2 = await fetch(`${app.url}/jobs/demo-1/events?since=0`, {
      headers: { "Last-Event-ID": `${env.streamId}:${env.seq}` },
    });
    assert.equal(r2.status, 200);
    await r2.text();
  });

  it("stops cleanly", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "p0-seam-stop-"));
    const second = await startServer({ outDir, port: 0 });
    const url = second.url;
    await second.close();
    await assert.rejects(() => fetch(url));
  });
});
