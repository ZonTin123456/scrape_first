// #39 Accept-gated deep-link routing: browser navigation gets the new shell,
// API/CLI fetches keep JSON. Plus dumb-client linkage scan over web/js.
// Run: node --test tests/server-routing.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = { Accept: "text/html,application/xhtml+xml" };

describe("deep-link intercept (#39)", () => {
  let app;
  let jobId;
  before(async () => {
    const outDir = mkdtempSync(join(tmpdir(), "routing-39-"));
    app = await startServer({ outDir, port: 0 });
    const r = await fetch(`${app.url}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.invalid/board" }),
    });
    assert.equal(r.status, 201);
    jobId = (await r.json()).jobId;
    assert.ok(jobId);
  });
  after(async () => {
    await app?.close();
  });

  it("API fetches keep JSON shapes (default fetch Accept)", async () => {
    for (const p of ["", "/pages", "/review", "/safety"]) {
      const r = await fetch(`${app.url}/jobs/${jobId}${p}`);
      assert.equal(r.status, 200, p || "/jobs/:id");
      assert.match(r.headers.get("content-type") || "", /application\/json/);
    }
    const miss = await fetch(`${app.url}/jobs/nope-zzz`);
    assert.equal(miss.status, 404);
    assert.match(miss.headers.get("content-type") || "", /application\/json/);
  });

  it("browser navigation to all 5 deep links serves the new shell", async () => {
    for (const p of ["", "/pages", "/review", "/safety"]) {
      const r = await fetch(`${app.url}/jobs/${jobId}${p}`, { headers: HTML });
      assert.equal(r.status, 200, p || "/jobs/:id");
      assert.match(r.headers.get("content-type") || "", /text\/html/);
      assert.match(await r.text(), /light-job-workspace/);
    }
  });

  it("trailing slash + unknown job serve shell for browsers, JSON for API", async () => {
    const slash = await fetch(`${app.url}/jobs/${jobId}/review/`, { headers: HTML });
    assert.equal(slash.status, 200);
    assert.match(await slash.text(), /light-job-workspace/);
    const unknownHtml = await fetch(`${app.url}/jobs/nope-zzz`, { headers: HTML });
    assert.equal(unknownHtml.status, 200);
    assert.match(await unknownHtml.text(), /light-job-workspace/);
    const unknownJson = await fetch(`${app.url}/jobs/nope-zzz`);
    assert.equal(unknownJson.status, 404);
    assert.match(unknownJson.headers.get("content-type") || "", /application\/json/);
  });

  it("root still serves the old UI (flip lands in #44)", async () => {
    const r = await fetch(`${app.url}/`, { headers: HTML });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.doesNotMatch(html, /light-job-workspace/);
  });

  it("POST mutations never divert to HTML", async () => {
    const r = await fetch(`${app.url}/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "text/html,application/xhtml+xml" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.reason, "missing-revision");
  });

  it("SSE + thumbs routes never divert", async () => {
    const sse = await fetch(`${app.url}/jobs/${jobId}/events?once=1`);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") || "", /text\/event-stream/);
    const thumb = await fetch(`${app.url}/jobs/${jobId}/review/thumbs/1`, {
      headers: { Accept: "image/*" },
    });
    assert.equal(thumb.status, 404);
    assert.match(thumb.headers.get("content-type") || "", /application\/json/);
  });
});

describe("dumb-client linkage scan over web/js (#39 guardrail)", () => {
  function jsFiles(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...jsFiles(p));
      else if (e.name.endsWith(".js")) out.push(p);
    }
    return out;
  }
  const banned = [
    /child_process/,
    /spawnSync/,
    /playwright/i,
    /engine-cdp/,
    /sectioning/,
    /automap/,
    /group-guard/,
    /host-gate/,
    /verify-identity/,
    /upload-people/,
    /backup-page/,
    /\bfrom\s+["']node:/,
    /\brequire\(\s*["']node:/,
  ];
  it("no engine/fs/browser-automation linkage in the shell", () => {
    const files = jsFiles(join(root, "web", "js"));
    assert.ok(files.length > 0, "expected shell js files");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const re of banned) assert.ok(!re.test(src), `${f}: banned ${re}`);
    }
  });
});
