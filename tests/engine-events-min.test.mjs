// tests/engine-events-min.test.mjs — P4a minimal engine events trio + row + artifact.
// Run: node --test tests/engine-events-min.test.mjs
// Verifies: trio + row-finished + artifact:written at Wrap points behind flag,
// SSE envelope/cursor via P3 hub, terminal/files unchanged, logs display-only.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub, validateEnvelope, formatSSE } from "../jobs/events.mjs";
import {
  P4A_TYPES,
  isEngineEventsEnabled,
  createEngineEmitter,
  artifactPointerForFile,
} from "../jobs/engine-events.mjs";
import { createJob, writeJob } from "../jobs/store.mjs";
import { startServer } from "../server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let savedJobEvents;
beforeEach(() => {
  savedJobEvents = process.env.JOB_EVENTS;
});
afterEach(() => {
  if (savedJobEvents === undefined) delete process.env.JOB_EVENTS;
  else process.env.JOB_EVENTS = savedJobEvents;
});

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p4a-engine-"));
}

function parseFrames(text) {
  const frames = [];
  for (const chunk of text.split("\n\n")) {
    const t = chunk.trim();
    if (!t) continue;
    let id = null;
    let event = null;
    const dataLines = [];
    for (const line of t.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    frames.push({ id, event, data: JSON.parse(dataLines.join("\n")) });
  }
  return frames;
}

async function getEventsOnce(url, jobId, { since = null, lastId = null } = {}) {
  let target = `${url}/jobs/${jobId}/events?once=1`;
  if (since != null) target += `&since=${encodeURIComponent(since)}`;
  const headers = {};
  if (lastId != null) headers["Last-Event-ID"] = lastId;
  const r = await fetch(target, { headers });
  const text = await r.text();
  return { status: r.status, text, frames: parseFrames(text) };
}

describe("P4a flag gating (behind JOB_EVENTS=1 or opts.emitEvents)", () => {
  it("disabled by default, enabled via env or explicit opt, explicit false wins", () => {
    delete process.env.JOB_EVENTS;
    assert.equal(isEngineEventsEnabled({}), false);
    assert.equal(isEngineEventsEnabled({ emitEvents: false }), false);
    assert.equal(isEngineEventsEnabled({ emitEvents: true }), true);
    process.env.JOB_EVENTS = "1";
    assert.equal(isEngineEventsEnabled({}), true);
    assert.equal(isEngineEventsEnabled({ emitEvents: true }), true);
    assert.equal(isEngineEventsEnabled({ emitEvents: false }), false, "explicit false beats env");
    process.env.JOB_EVENTS = "0";
    assert.equal(isEngineEventsEnabled({}), false);
  });

  it("disabled emitter returns null and touches nothing; enabled emits", () => {
    delete process.env.JOB_EVENTS;
    const hub = createHub();
    const off = createEngineEmitter({ hub, jobId: "j-off" });
    assert.equal(off.enabled, false);
    assert.equal(off.urlStarted({ url: "https://a/x" }), null);
    assert.equal(off.urlFinished({ url: "https://a/x" }), null);
    assert.equal(off.urlFailed({ url: "https://a/x", error: "boom" }), null);
    assert.equal(off.rowFinished({ seq: 1, status: "dry" }), null);
    assert.equal(off.artifactWritten({ kind: "selection", url: "/s" }), null);
    assert.equal(hub.getStream("j-off"), null, "disabled emits nothing into hub");

    const on = createEngineEmitter({ hub, jobId: "j-on", emitEvents: true });
    assert.equal(on.enabled, true);
    const e = on.urlStarted({ url: "https://a/x", mode: "run" });
    assert.ok(e && e.type === "scrape:url-started");
    assert.equal(hub.getStream("j-on").buffered, 1);
  });

  it("missing hub or jobId disables safely (never throws)", () => {
    const noHub = createEngineEmitter({ hub: null, jobId: "j", emitEvents: true });
    assert.equal(noHub.enabled, false);
    assert.equal(noHub.urlStarted({ url: "https://a/x" }), null);
    const hub = createHub();
    const noJob = createEngineEmitter({ hub, jobId: null, emitEvents: true });
    assert.equal(noJob.enabled, false);
    assert.equal(noJob.urlStarted({ url: "https://a/x" }), null);
  });
});

describe("P4a trio + row + artifact payloads (reference-only, P3 envelope)", () => {
  it("emits exactly the P4a allowlist with clean payloads", () => {
    delete process.env.JOB_EVENTS;
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "wrap-1", emitEvents: true });
    assert.deepEqual([...P4A_TYPES].sort(), ["artifact:written", "scrape:url-failed", "scrape:url-finished", "scrape:url-started", "upload:row-finished"].sort());

    const s = em.urlStarted({ url: "https://a.go.th/x", mode: "probe" });
    assert.equal(s.type, "scrape:url-started");
    assert.deepEqual(s.payload, { url: "https://a.go.th/x", mode: "probe" });

    const f = em.urlFinished({ url: "https://a.go.th/x", slug: "x", dir: "out/x", title: "T", counts: { image: 2 } });
    assert.equal(f.type, "scrape:url-finished");
    assert.equal(f.payload.slug, "x");

    const fl = em.urlFailed({ url: "https://a.go.th/x", error: "wall blocked" });
    assert.equal(fl.type, "scrape:url-failed");
    assert.match(fl.payload.error, /wall/);

    const row = em.rowFinished({ seq: 3, order: 0, name: "A", status: "dry", detail: "shot: /s.png", group: "g", form: "https://beacon/personal/1" });
    assert.equal(row.type, "upload:row-finished");
    assert.equal(row.payload.seq, 3);
    assert.equal(row.payload.status, "dry");

    const art = em.artifactWritten({ kind: "selection", url: "/artifacts/s.json", relPath: "review/selection.json", byteLength: 10 });
    assert.equal(art.type, "artifact:written");
    assert.equal(art.payload.kind, "selection");

    const replay = hub.replay("wrap-1", null);
    assert.equal(replay.events.length, 5);
    for (const env of replay.events) {
      const v = validateEnvelope(env);
      assert.equal(v.ok, true);
      assert.equal(v.action, "accept");
      assert.equal(env.v, 1);
      assert.equal(env.jobId, "wrap-1");
      assert.ok(env.streamId && Number.isInteger(env.seq) && env.seq >= 1);
      assert.ok(env.at);
      // Payload never authoritative state: no job dump, no bytes.
      assert.ok(!env.payload?.job || !env.payload.job.ledger, "payload reference-only");
      for (const k of ["bytes", "inline", "base64", "blob", "buffer", "content", "data"]) {
        assert.ok(!(k in (env.payload || {})), `payload must not inline ${k}`);
      }
      const frame = formatSSE(env);
      assert.match(frame, new RegExp(`id:\\s*${env.streamId}:${env.seq}`));
      assert.match(frame, new RegExp(`event:\\s*${env.type.replace(/[:/]/g, (c) => `\\${c}`)}`));
    }
    // seq cursor increments within one epoch.
    const seqs = replay.events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    assert.ok(replay.events.every((e) => e.streamId === replay.events[0].streamId), "same epoch same streamId");
  });

  it("P4a allowlist only: full-catalog types rejected (deferred to #25)", () => {
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "allow-1", emitEvents: true });
    assert.equal(em.emit("upload:plan", { x: 1 }), null);
    assert.equal(em.emit("review:finalized", {}), null);
    assert.equal(em.emit("job:advanced", {}), null);
    assert.equal(em.emit("scrape:image-downloaded", {}), null);
    assert.equal(hub.getStream("allow-1"), null, "non-P4a types never enter hub via P4a emitter");
  });

  it("row/art validators: bad row returns null, bad artifact returns null (never throws)", () => {
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "valid-1", emitEvents: true });
    assert.equal(em.rowFinished({ status: "dry" }), null, "seq required");
    assert.equal(em.rowFinished({ seq: 1 }), null, "status required");
    assert.equal(em.artifactWritten({}), null, "kind required");
    assert.equal(em.artifactWritten({ kind: "dry-report", url: "/a.json", byteLength: 1 }), null, "proof without sha256 rejected");
    assert.equal(em.artifactWritten({ kind: "x", url: "/a", bytes: "inline!" }), null, "inline bytes rejected");
    assert.equal(hub.getStream("valid-1"), null);
  });
});

describe("P4a artifact pointer from file (pointer-only, byteLength = file length)", () => {
  it("hashes file, byteLength matches, missing file returns null", () => {
    const dir = tmpOut();
    const abs = join(dir, "selection.json");
    const body = JSON.stringify([{ seq: 1, keep: true }], null, 1);
    writeFileSync(abs, body, "utf8");
    const ptr = artifactPointerForFile({ absPath: abs, relPath: "review/selection.json", kind: "selection", url: "/artifacts/selection.json" });
    assert.equal(ptr.kind, "selection");
    assert.equal(ptr.relPath, "review/selection.json");
    assert.equal(ptr.byteLength, Buffer.byteLength(body));
    assert.equal(ptr.sha256, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    assert.ok(!("bytes" in ptr) && !("data" in ptr) && !("content" in ptr));

    assert.equal(artifactPointerForFile({ absPath: join(dir, "missing.json"), relPath: "x", kind: "selection" }), null);
    assert.throws(() => artifactPointerForFile({ absPath: abs, kind: "" }), /kind/);
  });

  it("emitter artifactFromFile emits pointer-only artifact:written", () => {
    const dir = tmpOut();
    const abs = join(dir, "summary.json");
    writeFileSync(abs, JSON.stringify({ total: 1 }), "utf8");
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "art-1", emitEvents: true });
    const env = em.artifactFromFile({ absPath: abs, relPath: "summary.json", kind: "summary", url: "/artifacts/summary.json" });
    assert.ok(env);
    assert.equal(env.type, "artifact:written");
    assert.equal(env.payload.byteLength, readFileSync(abs).length);
    assert.ok(env.payload.sha256);
    // Missing file -> null, no event.
    assert.equal(em.artifactFromFile({ absPath: join(dir, "nope.json"), relPath: "nope", kind: "summary" }), null);
    assert.equal(hub.replay("art-1", null).events.length, 1);
  });
});

describe("P4a SSE via server hub (P3 envelope/cursor)", () => {
  it("engine events bound to server hub appear over SSE with cursor replay", async () => {
    const outDir = tmpOut();
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "sse-1" }));
    const app = await startServer({ outDir, port: 0 });
    try {
      const em = createEngineEmitter({ hub: app.hub, jobId: "sse-1", emitEvents: true });
      em.urlStarted({ url: "https://a.go.th/x", mode: "run" });
      em.urlFinished({ url: "https://a.go.th/x", slug: "x", dir: "out/x" });
      em.rowFinished({ seq: 1, order: 0, name: "A", status: "dry" });
      em.artifactWritten({ kind: "selection", url: "/artifacts/s.json", relPath: "review/selection.json", byteLength: 5 });

      const first = await getEventsOnce(app.url, "sse-1");
      assert.equal(first.status, 200);
      const types = first.frames.map((f) => f.data.type);
      assert.ok(types.includes("scrape:url-started"), `SSE shows trio, got ${types}`);
      assert.ok(types.includes("scrape:url-finished"));
      assert.ok(types.includes("upload:row-finished"));
      assert.ok(types.includes("artifact:written"));
      for (const f of first.frames) {
        assert.equal(f.data.v, 1);
        assert.equal(f.data.jobId, "sse-1");
        assert.match(f.id || "", /:/, "SSE id carries streamId:seq cursor");
        assert.equal(f.event, f.data.type);
      }
      // Cursor replay: from first cursor yields later events, same epoch.
      const cur = first.frames[0].data;
      const cursor = `${cur.streamId}:${cur.seq}`;
      const replay = await getEventsOnce(app.url, "sse-1", { lastId: cursor });
      assert.ok(replay.frames.length >= 1);
      assert.equal(replay.frames[replay.frames.length - 1].data.streamId, cur.streamId);
      const ids = new Set(first.frames.map((f) => `${f.data.streamId}:${f.data.seq}`));
      for (const f of replay.frames) {
        const k = `${f.data.streamId}:${f.data.seq}`;
        if (ids.has(k)) continue; // overlap at cursor boundary allowed once
        ids.add(k);
      }
    } finally {
      await app.close();
    }
  });
});

describe("P4a terminal/files unchanged + logs display-only", () => {
  it("Wrap with emitter on/off writes identical files and identical console", () => {
    const dir = tmpOut();
    function fakeWrap({ emitter, tag }) {
      // Simulates authoritative Wrap mutation point: file write + terminal line.
      const abs = join(dir, `content-${tag}.json`);
      const payload = { manifest: { source_url: "https://a.go.th/x" }, nodes: [{ seq: 1 }] };
      writeFileSync(abs, JSON.stringify(payload, null, 1), "utf8");
      console.log(`OK https://a.go.th/x -> ${abs}`);
      console.error(`group-integrity: display-only note`);
      emitter?.urlFinished({ url: "https://a.go.th/x", slug: "x", dir: abs });
      emitter?.artifactFromFile({ absPath: abs, relPath: `x/content-${tag}.json`, kind: "content" });
      return abs;
    }
    function capture(fn) {
      const out = [];
      const err = [];
      const olog = console.log;
      const oerr = console.error;
      console.log = (...a) => out.push(a.join(" "));
      console.error = (...a) => err.push(a.join(" "));
      try {
        const ret = fn();
        return { ret, out, err };
      } finally {
        console.log = olog;
        console.error = oerr;
      }
    }
    delete process.env.JOB_EVENTS;
    const hubOff = createHub();
    const off = createEngineEmitter({ hub: hubOff, jobId: "t-1" });
    const rOff = capture(() => fakeWrap({ emitter: off, tag: "off" }));

    const hubOn = createHub();
    const on = createEngineEmitter({ hub: hubOn, jobId: "t-1", emitEvents: true });
    const rOn = capture(() => fakeWrap({ emitter: on, tag: "on" }));

    // Terminal identical: emitter never logs.
    assert.deepEqual(rOn.out, rOff.out.map((s) => s.replace("content-off", "content-on")));
    assert.deepEqual(rOn.err, rOff.err);
    // Files identical content modulo tag filename: same JSON body hash.
    const hOff = createHash("sha256").update(readFileSync(rOff.ret)).digest("hex");
    const hOn = createHash("sha256").update(readFileSync(rOn.ret)).digest("hex");
    assert.equal(hOff, hOn, "emitter on/off must not alter file bytes");
    assert.equal(shaFile(rOff.ret), hOff);
    // But hub differs: on emitted, off did not.
    assert.equal(hubOff.getStream("t-1"), null);
    assert.equal(hubOn.replay("t-1", null).events.length, 2);
  });

  it("no log parsing into state: engine + server sources never read logs", () => {
    const eng = src("jobs/engine-events.mjs");
    const srv = src("server.mjs");
    const bp = src("backup-page.mjs");
    const up = src("uploader/upload-people.mjs");
    for (const [name, text] of [["engine-events", eng], ["server", srv]]) {
      assert.ok(!text.includes("fs.watch"), `${name}: no fs.watch transport`);
      assert.ok(!text.includes("watchFile"), `${name}: no watchFile`);
      assert.ok(!text.includes("spawnSync"), `${name}: no spawnSync on UI path`);
      assert.ok(!text.includes("child_process"), `${name}: no child_process`);
      assert.ok(!text.includes("readFileSync(0)"), `${name}: no stdin pause`);
      assert.ok(!/parse.*\.log/i.test(text), `${name}: logs never parsed`);
      assert.ok(!/tail\s+-f/i.test(text), `${name}: no log tail`);
    }
    // Wrap points ride behind flag, display-only logs untouched.
    assert.ok(bp.includes('process.env.JOB_EVENTS === "1"'), "backup-page gates events behind flag");
    assert.ok(bp.includes("__engine?.urlStarted"), "backup-page trio started at URL loop");
    assert.ok(bp.includes("__engine?.urlFinished"), "backup-page trio finished at URL loop");
    assert.ok(bp.includes("__engine?.urlFailed"), "backup-page trio failed at URL loop");
    assert.ok(bp.includes("__emitArtifact"), "backup-page artifact:written at file writes");
    assert.ok(up.includes('process.env.JOB_EVENTS === "1"'), "upload-people gates events behind flag");
    assert.ok(up.includes("__pushRow"), "upload-people row loop emits per row");
    assert.ok(up.includes("rowFinished"), "upload-people row-finished payload");
    assert.ok(up.includes("__emitArtifact"), "upload-people artifact:written for report/shots");
    // CLI terminal lines preserved verbatim.
    assert.ok(bp.includes("OK ${r.url} -> ${r.dir}") || bp.includes("OK ${r.url}"), "CLI OK line unchanged");
    assert.ok(up.includes('mode=${report.mode}'), "CLI report line unchanged");
  });

  it("engine emitter has no browser/CLI coupling", () => {
    const eng = src("jobs/engine-events.mjs");
    const targets = [...eng.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const t of targets) {
      assert.ok(t.startsWith("node:") || t.startsWith("./") || t.startsWith("../"), `non-builtin import: ${t}`);
    }
    for (const re of [/playwright/i, /backup-page/, /pipeline/, /upload-people/, /automap/, /sectioning/, /child_process/, /electron/i, /tauri/i, /spawnSync/]) {
      for (const t of targets) assert.ok(!re.test(t), `banned import in engine-events: ${t}`);
      assert.ok(!re.test(eng.split("import")[0] || ""), `banned reference ${re}`);
    }
    assert.ok(eng.includes("jobs/events") || eng.includes("./events.mjs"), "wraps jobs/events hub");
  });
});
