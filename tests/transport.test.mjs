// tests/transport.test.mjs — P3 transport SSE per Job + POST commands.
// Run: node --test tests/transport.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";
import {
  createJob,
  writeJob,
  readJob,
  advance,
  grantArm,
  beginUpload,
  computeSnapshotId,
  newDryRunId,
} from "../jobs/store.mjs";
import {
  BUFFER_LIMIT,
  KNOWN_TYPES,
  createHub,
  validateEnvelope,
  createDeduper,
  formatSSE,
  parseCursor,
  assertArtifactPointer,
  isProofKind,
} from "../jobs/events.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p3-transport-"));
}

function snapFixture() {
  return {
    people: [{ seq: 1, name: "A" }],
    selection: [{ seq: 1, keep: true, order: 1 }],
    sourceUrl: "https://a.go.th/x",
    sourceGroup: "a",
    backendOrigin: "https://beacon/x",
    deptMapping: { a: 1 },
    deptPlan: [{ row: 1 }],
    mappingVersion: "m1",
    profileVersion: "p1",
  };
}

async function postCommand(url, jobId, body) {
  const r = await fetch(`${url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, json };
}

async function getJob(url, jobId) {
  const r = await fetch(`${url}/jobs/${jobId}`);
  const json = await r.json();
  return { status: r.status, json };
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
    const data = JSON.parse(dataLines.join("\n"));
    frames.push({ id, event, data });
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
  return { status: r.status, ctype: r.headers.get("content-type"), text, frames: parseFrames(text) };
}

function driveToDryPassed(job) {
  const path = ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"];
  for (const s of path) advance(job, s);
  job.snapshot_id = computeSnapshotId(snapFixture());
  job.fingerprints = { snapshot: job.snapshot_id };
  job.dry_run_id = newDryRunId();
  advance(job, "dry_passed");
  return job;
}

describe("P3 envelope + cursor + dedup + version", () => {
  it("hub emits v:1 envelope with cursor, SSE id/event lines", () => {
    const hub = createHub();
    const e1 = hub.emit("j1", "job:advanced", { stage: "probing" });
    assert.deepEqual(Object.keys(e1).sort(), ["at", "jobId", "payload", "seq", "streamId", "type", "v"].sort());
    assert.equal(e1.v, 1);
    assert.equal(e1.seq, 1);
    assert.equal(e1.jobId, "j1");
    assert.equal(e1.type, "job:advanced");
    assert.ok(e1.at);
    const e2 = hub.emit("j1", "job:resynced", { reason: "x" });
    assert.equal(e2.seq, 2);
    assert.equal(e2.streamId, e1.streamId, "same epoch same streamId");
    const frame = formatSSE(e1);
    assert.match(frame, new RegExp(`id:\\s*${e1.streamId}:${e1.seq}`));
    assert.match(frame, /event:\s*job:advanced/);
    assert.match(frame, /data:/);
    const parsed = JSON.parse(frame.split("\n").find((l) => l.startsWith("data:")).slice(5).trim());
    assert.equal(parsed.v, 1);
  });

  it("validate: unknown type ignorable iff v supported; unknown v resyncs never silent", () => {
    const good = { v: 1, streamId: "s_x", seq: 1, jobId: "j", type: "job:advanced", at: new Date().toISOString(), payload: {} };
    assert.deepEqual(validateEnvelope(good), { ok: true, action: "accept" });
    const unknownType = { ...good, type: "future:weird" };
    const r = validateEnvelope(unknownType);
    assert.equal(r.ok, true);
    assert.equal(r.action, "ignore");
    const badV = { ...good, v: 99 };
    const r2 = validateEnvelope(badV);
    assert.equal(r2.ok, false);
    assert.equal(r2.action, "resync");
    assert.equal(r2.reason, "unknown-version");
    const badV0 = { ...good, v: 0 };
    assert.equal(validateEnvelope(badV0).action, "resync");
  });

  it("dedup (jobId,streamId,seq) detects duplicates", () => {
    const d = createDeduper();
    const env = { jobId: "j", streamId: "s1", seq: 1 };
    assert.equal(d.check(env), "new");
    assert.equal(d.check(env), "duplicate");
    assert.equal(d.has({ jobId: "j", streamId: "s1", seq: 2 }), false);
    assert.ok(KNOWN_TYPES.has("job:advanced"));
    assert.ok(KNOWN_TYPES.has("job:resynced"));
    assert.ok(KNOWN_TYPES.has("artifact:written"));
  });

  it("HTTP SSE envelope + cursor replay, no duplicates", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "env-1" });
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const first = await getEventsOnce(app.url, "env-1");
      assert.equal(first.status, 200);
      assert.match(first.ctype || "", /text\/event-stream/);
      assert.ok(first.frames.length >= 1);
      const env = first.frames[0].data;
      assert.deepEqual(Object.keys(env).sort(), ["at", "jobId", "payload", "seq", "streamId", "type", "v"].sort());
      assert.equal(env.v, 1);
      assert.equal(env.jobId, "env-1");
      assert.match(first.text, new RegExp(`id:\\s*${env.streamId}:${env.seq}`));
      assert.match(first.text, new RegExp(`event:\\s*${env.type}`));
      const cursor = `${env.streamId}:${env.seq}`;
      // Mutate via POST so a new event exists, then replay from old cursor.
      const adv = await postCommand(app.url, "env-1", { commandId: "c-env-1", type: "advance", payload: { to: "probing" } });
      assert.equal(adv.json.accepted, true);
      const replay = await getEventsOnce(app.url, "env-1", { lastId: cursor });
      assert.equal(replay.status, 200);
      assert.ok(replay.frames.length >= 1, "replay returns events after cursor");
      const last = replay.frames[replay.frames.length - 1].data;
      assert.equal(last.streamId, env.streamId, "same epoch same stream");
      assert.ok(last.seq > env.seq);
      // Dedup across fetches: ids unique.
      const ids = new Set();
      for (const f of [...first.frames, ...replay.frames]) {
        const k = `${f.data.jobId}:${f.data.streamId}:${f.data.seq}`;
        assert.ok(!ids.has(k) || f.data.seq === env.seq, `duplicate SSE id ${k}`);
        ids.add(k);
      }
      // Payload never authoritative state: no full job dump.
      for (const f of replay.frames) {
        assert.ok(!f.data.payload?.job || typeof f.data.payload.job !== "object" || !f.data.payload.job.ledger, "payload must be reference, never authoritative state");
      }
    } finally {
      await app.close();
    }
  });

  it("?since= optional works as seq and as streamId:seq", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "since-1" });
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const first = await getEventsOnce(app.url, "since-1");
      const cur = first.frames[0].data;
      await postCommand(app.url, "since-1", { commandId: "c-s1", type: "advance", payload: { to: "probing" } });
      const bySeq = await getEventsOnce(app.url, "since-1", { since: String(cur.seq) });
      assert.ok(bySeq.frames.length >= 1);
      const byFull = await getEventsOnce(app.url, "since-1", { since: `${cur.streamId}:${cur.seq}` });
      assert.ok(byFull.frames.length >= 1);
      assert.equal(byFull.frames[byFull.frames.length - 1].data.streamId, cur.streamId);
    } finally {
      await app.close();
    }
  });
});

describe("P3 POST commandId idempotency", () => {
  it("replay same commandId returns original, never executes twice", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "idem-1" });
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const d1 = await postCommand(app.url, "idem-1", { commandId: "cmd-A", type: "advance", payload: { to: "probing" } });
      assert.equal(d1.status, 200);
      assert.deepEqual(d1.json, { accepted: true, reason: "advanced", jobId: "idem-1", commandId: "cmd-A" });
      const after1 = await getJob(app.url, "idem-1");
      assert.equal(after1.json.job.stage, "probing");
      const ledgerN = after1.json.job.ledger.length;
      // Exact replay.
      const d2 = await postCommand(app.url, "idem-1", { commandId: "cmd-A", type: "advance", payload: { to: "probing" } });
      assert.deepEqual(d2.json, d1.json, "replay returns original disposition");
      const after2 = await getJob(app.url, "idem-1");
      assert.equal(after2.json.job.stage, "probing");
      assert.equal(after2.json.job.ledger.length, ledgerN, "never executes twice");
      // Same commandId different payload still returns original, never new execution.
      const d3 = await postCommand(app.url, "idem-1", { commandId: "cmd-A", type: "advance", payload: { to: "scraping" } });
      assert.deepEqual(d3.json, d1.json);
      const after3 = await getJob(app.url, "idem-1");
      assert.equal(after3.json.job.stage, "probing", "different payload with same commandId must not execute");
    } finally {
      await app.close();
    }
  });

  it("unknown type stays not-implemented and idempotent (P0 shape)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const d1 = await postCommand(app.url, "ghost-1", { commandId: "cmd-P", type: "bogus-type-xyz", payload: {} });
      assert.deepEqual(d1.json, { accepted: false, reason: "not-implemented", jobId: "ghost-1", commandId: "cmd-P" });
      const d2 = await postCommand(app.url, "ghost-1", { commandId: "cmd-P", type: "bogus-type-xyz", payload: {} });
      assert.deepEqual(d2.json, d1.json);
    } finally {
      await app.close();
    }
  });

  it("POST returns {accepted,reason,jobId,commandId} immediately; completion via GET", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "imm-1" });
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const d = await postCommand(app.url, "imm-1", { commandId: "c-imm", type: "advance", payload: { to: "probing" } });
      assert.deepEqual(Object.keys(d.json).sort(), ["accepted", "commandId", "jobId", "reason"].sort());
      const g = await getJob(app.url, "imm-1");
      assert.equal(g.status, 200);
      assert.equal(g.json.job.stage, "probing", "completion visible via state + GET");
    } finally {
      await app.close();
    }
  });
});

describe("P3 epoch + resync (restart gives new streamId, no fake continuity)", () => {
  it("new epoch new streamId; old cursor triggers resync via GET", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "epoch-1" });
    writeJob(outDir, job);
    const app1 = await startServer({ outDir, port: 0 });
    let stream1;
    try {
      const f1 = await getEventsOnce(app1.url, "epoch-1");
      stream1 = f1.frames[0].data;
      assert.ok(stream1.streamId);
    } finally {
      await app1.close();
    }
    const app2 = await startServer({ outDir, port: 0 });
    try {
      const f2 = await getEventsOnce(app2.url, "epoch-1");
      const stream2 = f2.frames[0].data;
      assert.notEqual(stream2.streamId, stream1.streamId, "restart must yield new streamId");
      // Old cursor on new epoch -> reset, never fake continuity.
      const stale = await getEventsOnce(app2.url, "epoch-1", { lastId: `${stream1.streamId}:${stream1.seq}` });
      assert.equal(stale.status, 200);
      assert.ok(stale.frames.length >= 1);
      const reset = stale.frames[stale.frames.length - 1].data;
      assert.equal(reset.type, "job:resynced");
      assert.equal(reset.payload?.reset, true);
      assert.equal(reset.streamId, stream2.streamId, "reset carries current streamId");
      // Client resets via GET /jobs/:id then reconnects with new cursor.
      const g = await getJob(app2.url, "epoch-1");
      assert.equal(g.status, 200);
      assert.equal(g.json.job.jobId, "epoch-1");
      const freshCursor = `${reset.streamId}:${reset.seq}`;
      const live = await getEventsOnce(app2.url, "epoch-1", { lastId: freshCursor });
      assert.equal(live.status, 200);
      // Fresh cursor must not reset.
      if (live.frames.length) {
        for (const f of live.frames) assert.notEqual(f.data.payload?.reset, true, "fresh cursor must not reset");
      }
    } finally {
      await app2.close();
    }
  });
});

describe("P3 unknown cursor resets via GET", () => {
  it("bogus/old/purged cursors yield resynced reset + GET heals", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "reset-1" });
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const bogus = await getEventsOnce(app.url, "reset-1", { lastId: "bogus:999" });
      assert.equal(bogus.status, 200);
      const r0 = bogus.frames[bogus.frames.length - 1].data;
      assert.equal(r0.type, "job:resynced");
      assert.equal(r0.payload?.reset, true);
      assert.match(r0.payload?.hint || "", /GET \/jobs/);
      const invalid = await getEventsOnce(app.url, "reset-1", { since: "???" });
      const r1 = invalid.frames[invalid.frames.length - 1].data;
      assert.equal(r1.type, "job:resynced");
      assert.equal(r1.payload?.reset, true);
      // GET heals: authoritative state, reset cursor, reconnect clean.
      const g = await getJob(app.url, "reset-1");
      assert.equal(g.status, 200);
      assert.equal(g.json.job.jobId, "reset-1");
      const fresh = await getEventsOnce(app.url, "reset-1");
      const cur = fresh.frames[fresh.frames.length - 1].data;
      const ok = await getEventsOnce(app.url, "reset-1", { lastId: `${cur.streamId}:${cur.seq}` });
      assert.equal(ok.status, 200);
      for (const f of ok.frames) assert.notEqual(f.data.payload?.reset, true);
    } finally {
      await app.close();
    }
  });

  it("bounded ~200 buffer: purged cursor resets, recent replays", () => {
    const hub = createHub({ bufferLimit: 200 });
    assert.equal(hub.limit, 200);
    assert.equal(BUFFER_LIMIT, 200);
    for (let i = 0; i < 250; i++) hub.emit("jb", "job:advanced", { i });
    const st = hub.getStream("jb");
    assert.equal(st.buffered, 200);
    assert.equal(st.seq, 250);
    const purged = hub.replay("jb", `${st.streamId}:10`);
    assert.equal(purged.mode, "reset");
    assert.equal(purged.reason, "purged");
    const recent = hub.replay("jb", `${st.streamId}:240`);
    assert.equal(recent.mode, "replay");
    assert.equal(recent.events.length, 10);
    assert.equal(recent.events[0].seq, 241);
  });

  it("per-Job streams isolated, no global bus", async () => {
    const hub = createHub();
    hub.emit("a", "job:advanced", { x: 1 });
    hub.emit("b", "job:advanced", { x: 2 });
    const ra = hub.replay("a", null);
    const rb = hub.replay("b", null);
    assert.ok(ra.events.every((e) => e.jobId === "a"));
    assert.ok(rb.events.every((e) => e.jobId === "b"));
    assert.notEqual(hub.getStream("a").streamId, hub.getStream("b").streamId);
    // HTTP isolation.
    const outDir = tmpOut();
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "iso-a" }));
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "iso-b" }));
    const app = await startServer({ outDir, port: 0 });
    try {
      await postCommand(app.url, "iso-a", { commandId: "c-iso", type: "advance", payload: { to: "probing" } });
      const fa = await getEventsOnce(app.url, "iso-a");
      const fb = await getEventsOnce(app.url, "iso-b");
      assert.ok(fa.frames.some((f) => f.data.type === "job:advanced"));
      assert.ok(fb.frames.every((f) => f.data.jobId === "iso-b"), "one stream per selected Job");
      const list = await (await fetch(`${app.url}/jobs`)).json();
      assert.ok(Array.isArray(list.jobs), "GET /jobs returns real list");
      const ids = list.jobs.map((j) => j.jobId).sort();
      assert.deepEqual(ids, ["iso-a", "iso-b"]);
    } finally {
      await app.close();
    }
  });
});

describe("P3 artifacts pointer-only", () => {
  it("unit: pointer shape, sha256 for proofs, byteLength file length, never inline", () => {
    assert.equal(isProofKind("dry-report"), true);
    assert.equal(isProofKind("save-report"), true);
    assert.equal(isProofKind("shots"), true);
    assert.equal(isProofKind("selection"), false);
    assert.ok(assertArtifactPointer({ kind: "dry-report", url: "/a/dry.json", relPath: "r/dry.json", sha256: "ab12", byteLength: 10 }));
    assert.ok(assertArtifactPointer({ kind: "selection", url: "/a/s.json" }), "sha256 optional legacy");
    assert.throws(() => assertArtifactPointer({ kind: "dry-report", url: "/a.json", byteLength: 1 }), /sha256/);
    assert.throws(() => assertArtifactPointer({ kind: "dry-report", url: "/a.json", sha256: "ab", byteLength: 1, bytes: "xx" }), /pointer-only/);
    assert.throws(() => assertArtifactPointer({ kind: "x", url: "/a", sha256: "ab", data: [1] }), /pointer-only/);
    assert.throws(() => assertArtifactPointer({ kind: "save-report", url: "file:///etc/passwd", sha256: "ab" }), /file:\/\//);
    assert.throws(() => assertArtifactPointer({ kind: "save-report", url: "data:application/json,{}", sha256: "ab" }), /pointer/);
    assert.throws(() => assertArtifactPointer({ kind: "dry-report", url: "/a", sha256: "ab", byteLength: -1 }), /byteLength/);
    assert.throws(() => assertArtifactPointer({ kind: "", url: "/a" }), /kind/);
  });

  it("HTTP: artifact command pointer-only, bad rejected, no double-add on replay", async () => {
    const outDir = tmpOut();
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "art-1" }));
    const app = await startServer({ outDir, port: 0 });
    try {
      const good = {
        kind: "dry-report",
        url: "/artifacts/dry.json",
        relPath: "reports/dry.json",
        sha256: "ff".padEnd(16, "0"),
        byteLength: 42,
      };
      const d1 = await postCommand(app.url, "art-1", { commandId: "art-c1", type: "artifact", payload: { artifact: good } });
      assert.deepEqual(d1.json, { accepted: true, reason: "artifact-recorded", jobId: "art-1", commandId: "art-c1" });
      const g = await getJob(app.url, "art-1");
      assert.equal(g.json.job.artifacts.length, 1);
      const stored = g.json.job.artifacts[0];
      assert.equal(stored.kind, "dry-report");
      assert.equal(stored.sha256, good.sha256);
      assert.equal(stored.byteLength, 42, "byteLength file length never inline bytes");
      assert.ok(!("bytes" in stored) && !("data" in stored) && !("inline" in stored) && !("base64" in stored) && !("content" in stored));
      // SSE carries pointer only.
      const ev = await getEventsOnce(app.url, "art-1");
      const artEv = ev.frames.find((f) => f.data.type === "artifact:written");
      assert.ok(artEv, "artifact:written emitted");
      assert.equal(artEv.data.payload.kind, "dry-report");
      assert.ok(!("bytes" in artEv.data.payload));
      // Bad inline rejected.
      const bad = { kind: "dry-report", url: "/a.json", sha256: "ab", byteLength: 1, bytes: "inline!" };
      const dBad = await postCommand(app.url, "art-1", { commandId: "art-bad", type: "artifact", payload: { artifact: bad } });
      assert.equal(dBad.json.accepted, false);
      assert.equal(dBad.json.reason, "bad-artifact");
      const g2 = await getJob(app.url, "art-1");
      assert.equal(g2.json.job.artifacts.length, 1, "bad artifact not stored");
      const dBad2 = await postCommand(app.url, "art-1", { commandId: "art-bad", type: "artifact", payload: { artifact: bad } });
      assert.deepEqual(dBad2.json, dBad.json, "replay returns original, never executes twice");
      // Proof without sha256 rejected.
      const noHash = await postCommand(app.url, "art-1", { commandId: "art-nh", type: "artifact", payload: { artifact: { kind: "save-report", url: "/s.json", byteLength: 5 } } });
      assert.equal(noHash.json.accepted, false);
    } finally {
      await app.close();
    }
  });
});

describe("P3 cancel idempotent + intent before ack", () => {
  it("non-upload cancel needs prompt, idempotent, retains proofs", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "cx-1" });
    job.snapshot_id = computeSnapshotId(snapFixture());
    job.dry_run_id = newDryRunId();
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      await postCommand(app.url, "cx-1", { commandId: "adv-cx", type: "advance", payload: { to: "probing" } });
      const noPrompt = await postCommand(app.url, "cx-1", { commandId: "cx-np", type: "cancel", payload: {} });
      assert.equal(noPrompt.json.accepted, false);
      assert.equal(noPrompt.json.reason, "prompt-required");
      const d1 = await postCommand(app.url, "cx-1", { commandId: "cx-1", type: "cancel", payload: { prompted: true, reason: "user" } });
      assert.deepEqual(d1.json, { accepted: true, reason: "cancelled", jobId: "cx-1", commandId: "cx-1" });
      const g1 = await getJob(app.url, "cx-1");
      assert.equal(g1.json.job.stage, "cancelled");
      assert.ok(g1.json.job.snapshot_id, "proofs retained");
      assert.ok(g1.json.job.ledger.some((e) => e.kind === "job:cancelled"), "intent/audit before ack");
      const ledgerN = g1.json.job.ledger.length;
      const replay = await postCommand(app.url, "cx-1", { commandId: "cx-1", type: "cancel", payload: { prompted: true } });
      assert.deepEqual(replay.json, d1.json);
      const g2 = await getJob(app.url, "cx-1");
      assert.equal(g2.json.job.ledger.length, ledgerN, "replay never executes twice");
      const again = await postCommand(app.url, "cx-1", { commandId: "cx-2", type: "cancel", payload: { prompted: true } });
      assert.equal(again.json.accepted, true);
      const g3 = await getJob(app.url, "cx-1");
      assert.equal(g3.json.job.stage, "cancelled");
      assert.equal(g3.json.job.ledger.length, ledgerN, "repeated cancel idempotent");
    } finally {
      await app.close();
    }
  });

  it("upload cancel transient stop_requested, repeated idempotent", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "up-1" });
    driveToDryPassed(job);
    grantArm(job, { attested: true, typed: job.slug });
    beginUpload(job);
    const saveId = job.save_run_id;
    writeJob(outDir, job);
    const app = await startServer({ outDir, port: 0 });
    try {
      const d1 = await postCommand(app.url, "up-1", { commandId: "up-c1", type: "cancel", payload: { reason: "user stop" } });
      assert.deepEqual(d1.json, { accepted: true, reason: "stop_requested", jobId: "up-1", commandId: "up-c1" });
      const g1 = await getJob(app.url, "up-1");
      assert.equal(g1.json.job.stage, "uploading", "transient: finish current row truthfully");
      assert.equal(g1.json.job.stopRequested, true);
      assert.ok(g1.json.job.ledger.some((e) => e.kind === "upload:stop_requested"), "intent/audit before ack");
      assert.equal(g1.json.job.save_run_id, saveId);
      const ledgerN = g1.json.job.ledger.length;
      const replay = await postCommand(app.url, "up-1", { commandId: "up-c1", type: "cancel", payload: {} });
      assert.deepEqual(replay.json, d1.json);
      const g2 = await getJob(app.url, "up-1");
      assert.equal(g2.json.job.ledger.length, ledgerN);
      const again = await postCommand(app.url, "up-1", { commandId: "up-c2", type: "cancel", payload: {} });
      assert.equal(again.json.accepted, true);
      assert.equal(again.json.reason, "stop_requested");
      const g3 = await getJob(app.url, "up-1");
      assert.equal(g3.json.job.stopRequested, true, "repeated cancel idempotent");
      assert.equal(g3.json.job.ledger.length, ledgerN);
    } finally {
      await app.close();
    }
  });

  it("live SSE pushes job:advanced on cancel (one stream per Job)", async () => {
    const outDir = tmpOut();
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "live-1" }));
    const app = await startServer({ outDir, port: 0 });
    const ctrl = new AbortController();
    try {
      const resp = await fetch(`${app.url}/jobs/live-1/events`, {
        headers: { Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      assert.equal(resp.status, 200);
      assert.match(resp.headers.get("content-type") || "", /text\/event-stream/);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      async function nextFrame() {
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const frames = parseFrames(chunk + "\n\n");
            if (frames.length) return frames[0];
          }
          if (Date.now() > deadline) throw new Error("live SSE timeout");
          const { done, value } = await reader.read();
          if (done) throw new Error("live SSE closed early");
          buf += decoder.decode(value, { stream: true });
        }
      }
      const first = await nextFrame();
      assert.equal(first.data.jobId, "live-1");
      const curCursor = `${first.data.streamId}:${first.data.seq}`;
      assert.ok(curCursor.includes(":"));
      // Trigger server push while stream open.
      const adv = await postCommand(app.url, "live-1", { commandId: "live-c1", type: "advance", payload: { to: "probing" } });
      assert.equal(adv.json.accepted, true);
      const pushed = await nextFrame();
      assert.equal(pushed.data.type, "job:advanced");
      assert.equal(pushed.data.jobId, "live-1");
      assert.equal(pushed.event, "job:advanced");
      assert.match(pushed.id || "", /:/);
    } finally {
      try {
        ctrl.abort();
      } catch {
        // ignore
      }
      await app.close();
    }
  });
});

describe("P3 bans + linkage (no watch, no parse, no global bus)", () => {
  it("no watch/poll/parse transport in server+jobs files", () => {
    const files = ["server.mjs", "jobs/events.mjs", "jobs/commands.mjs"].map((f) => join(root, f));
    const srcs = files.map((f) => readFileSync(f, "utf8"));
    const banned = ["fs.watch", "watchFile", "spawnSync", "child_process", "readFileSync(0)"];
    for (const src of srcs) {
      for (const b of banned) assert.ok(!src.includes(b), `banned transport pattern: ${b}`);
    }
    // No terminal-text parse into state: payload never built from logs.
    for (const src of srcs) {
      assert.ok(!/parse.*\.log/i.test(src), "no log parse into state");
      assert.ok(!/tail\s+-f/i.test(src), "no log tail");
    }
    // SSE cursor present, buffer bound present, envelope v:1 present.
    const eventsSrc = srcs[1];
    assert.ok(eventsSrc.includes("streamId"), "cursor streamId present");
    assert.ok(eventsSrc.includes("Last-Event") || readFileSync(join(root, "server.mjs"), "utf8").includes("last-event-id"), "Last-Event-ID replay present");
    assert.ok(eventsSrc.includes("200"), "bounded ~200 buffer present");
    assert.ok(eventsSrc.includes("v: 1") || eventsSrc.includes("v:1") || eventsSrc.includes("ENVELOPE_VERSION"), "envelope v:1 present");
  });

  it("server imports jobs/store only, no engine/CLI imports", () => {
    const src = readFileSync(join(root, "server.mjs"), "utf8");
    const targets = [
      ...src.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const t of targets) {
      assert.ok(t.startsWith("node:") || t.startsWith("./") || t.startsWith("../"), `non-builtin import: ${t}`);
    }
    const banned = [/playwright/i, /backup-page/, /pipeline/, /upload-people/, /automap/, /sectioning/, /group-guard/, /host-gate/, /verify-identity/, /cdp-port/, /target-creation/, /match\.mjs/, /child_process/, /electron/i, /tauri/i, /spawnSync/];
    for (const t of targets) for (const re of banned) assert.ok(!re.test(t), `banned import: ${t}`);
    assert.ok(!/spawnSync/.test(src));
    assert.ok(src.includes("jobs/store"), "server uses jobs/store truth");
    assert.ok(src.includes("jobs/events"), "server uses events hub");
    assert.ok(src.includes("jobs/commands"), "server uses command idempotency");
  });

  it("parseCursor shapes: Last-Event-ID, since seq, invalid resets", () => {
    assert.deepEqual(parseCursor(null), null);
    assert.deepEqual(parseCursor(""), null);
    assert.deepEqual(parseCursor("s_1:5"), { streamId: "s_1", seq: 5 });
    assert.deepEqual(parseCursor("7", "s_9"), { streamId: "s_9", seq: 7 });
    assert.ok(parseCursor("bogus", "s_1")?.invalid || parseCursor("s_1:abc")?.invalid);
  });
});
