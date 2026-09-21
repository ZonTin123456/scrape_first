// tests/hardening.test.mjs — P8 Hardening/acceptance (ticket #29).
// Run: node --test tests/hardening.test.mjs
// Proves end to end over HTTP + job ops: single-flight executor refusal,
// restart loads + validates record/proofs with a new stream epoch (no fake
// continuity), two-tab stale conflict, stream restart clean resync, replayed
// commandIds never double-execute, guard-regression disarm path reachable,
// arm single-use over transport, dry-partial amber ledger, upload stop that
// finishes the current row truthfully then cancels, kill-SSE-mid-upload
// healing via GET resync. Happy path + review-parity spot checks included.
// Out of scope respected: no new routes, no CLI changes, no packaging.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../server.mjs";
import {
  advance,
  assessRestart,
  createJob,
  currentEngineOp,
  loadForRestart,
  readJob,
  writeJob,
} from "../jobs/store.mjs";
import { runPipelineAsJobOps } from "../jobs/pipeline.mjs";
import { dryReportPathFor } from "../jobs/safety.mjs";
import { seedReview } from "../jobs/review.mjs";

let n = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p8-harden-"));
}

function snapFixture() {
  return {
    people: [{ seq: 1, name: "A" }],
    selection: [{ seq: 1, keep: true, order: 0 }],
    sourceUrl: "https://a.go.th/x",
    sourceGroup: "a",
    backendOrigin: "https://beacon/x",
    deptMapping: { a: 1 },
    deptPlan: [{ row: 1 }],
    mappingVersion: "m1",
    profileVersion: "p1",
  };
}

function greenDryPayload(over = {}) {
  return {
    snapshotInput: snapFixture(),
    rows: [{ seq: 1, name: "A", group: "a", target: "https://beacon/x/personal/person/1", status: "dry" }],
    mapMode: "pinned",
    guardStatus: "green",
    destinationOrigin: "https://beacon/x",
    targetDepts: ["a"],
    wouldCreate: [],
    identity: { verified: true, personId: "1" },
    unmapped: [],
    shots: [{ relPath: "shots/000-seq1.png", sha256: "aa".repeat(32), byteLength: 10 }],
    ...over,
  };
}

function driveToDryRunning(job) {
  for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
    advance(job, s);
  }
  return job;
}

function parseSSE(text) {
  return String(text)
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      let data = null;
      try {
        data = out.data ? JSON.parse(out.data) : null;
      } catch {
        data = null;
      }
      return { id: out.id ?? null, event: out.event ?? null, data };
    });
}

function streamOf(id) {
  const s = String(id);
  const i = s.lastIndexOf(":");
  return { stream: s.slice(0, i), seq: Number(s.slice(i + 1)) };
}

describe("P8 happy path over HTTP (dry -> arm -> upload, proofs linked)", () => {
  let app;
  let out;
  before(async () => {
    out = tmpOut();
    app = await startServer({ outDir: out, port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  async function postCmd(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("dry -> arm (exact copy + typed slug + click) -> begin-upload, save refs dry", async () => {
    const jobId = uid("happy");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    const d = await postCmd(jobId, "p8-dry", "dry", greenDryPayload());
    assert.equal(d.accepted, true);
    assert.equal(d.reason, "dry-recorded");
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    assert.equal(m.available, true);
    assert.equal(m.gate1.ok, true);
    assert.ok(m.gate2.attestation.includes("I reviewed dry report"));
    const a = await postCmd(jobId, "p8-arm", "arm", { attestedText: m.gate2.attestation, typed: "s", clicked: true });
    assert.equal(a.accepted, true);
    const u = await postCmd(jobId, "p8-up", "begin-upload", {});
    assert.equal(u.accepted, true);
    const g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g.job.stage, "uploading");
    const dry = g.job.artifacts.find((x) => x.kind === "dry-report");
    const save = g.job.artifacts.find((x) => x.kind === "save-report");
    assert.ok(dry?.sha256 && save?.sha256, "immutable linked proofs with sha256");
    const saved = JSON.parse(readFileSync(join(out, "s", save.relPath), "utf8"));
    assert.equal(saved.dry_run_id, g.job.dry_run_id, "save references prerequisite dry");
    assert.equal(saved.dry_report_sha256, dry.sha256);
  });

  it("dry-partial amber kept in ledger, G1 stays green", async () => {
    const jobId = uid("amber");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    const payload = greenDryPayload({
      rows: [
        { seq: 1, name: "A", group: "a", target: "t", status: "dry" },
        { seq: 2, name: null, group: "a", target: "t", status: "dry-partial" },
      ],
    });
    const d = await postCmd(jobId, "p8-amber", "dry", payload);
    assert.equal(d.accepted, true);
    const g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.ok(g.job.ledger.some((e) => e.kind === "stage:amber"), "amber warning kept in ledger");
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    assert.equal(m.gate1.ok, true);
  });
});

describe("P8 replayed commandIds never double-execute (HTTP)", () => {
  let app;
  let out;
  before(async () => {
    out = tmpOut();
    app = await startServer({ outDir: out, port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  async function postCmd(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("arm + begin-upload replays return original disposition; second upload refused", async () => {
    const jobId = uid("replay");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(jobId, "r-dry", "dry", greenDryPayload());
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    const armArgs = { attestedText: m.gate2.attestation, typed: "s", clicked: true };
    const a1 = await postCmd(jobId, "r-arm", "arm", armArgs);
    assert.equal(a1.accepted, true);
    // Same commandId, different payload: original disposition, no re-execution.
    const a2 = await postCmd(jobId, "r-arm", "arm", { attestedText: "tampered", typed: "s", clicked: true });
    assert.deepEqual(a2, a1);
    const u1 = await postCmd(jobId, "r-up", "begin-upload", {});
    assert.equal(u1.accepted, true);
    const u1r = await postCmd(jobId, "r-up", "begin-upload", {});
    assert.deepEqual(u1r, u1);
    const g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g.job.stage, "uploading");
    assert.equal(g.job.artifacts.filter((x) => x.kind === "save-report").length, 1, "exactly one save proof: no double-execute");
    // Distinct commandId, arm already consumed single-use: refused, still uploading.
    const u2 = await postCmd(jobId, "r-up2", "begin-upload", {});
    assert.equal(u2.accepted, false);
    assert.equal(u2.reason, "not-armed");
    const g2 = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g2.job.stage, "uploading");
    assert.equal(g2.job.artifacts.filter((x) => x.kind === "save-report").length, 1);
  });
});

describe("P8 upload stop finishes current row truthfully then cancels (HTTP)", () => {
  let app;
  let out;
  before(async () => {
    out = tmpOut();
    app = await startServer({ outDir: out, port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  async function postCmd(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("cancel -> stop_requested (idempotent) -> finish-row -> cancelled, arm consumed", async () => {
    const jobId = uid("stop");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(jobId, "s-dry", "dry", greenDryPayload());
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    await postCmd(jobId, "s-arm", "arm", { attestedText: m.gate2.attestation, typed: "s", clicked: true });
    await postCmd(jobId, "s-up", "begin-upload", {});
    const c1 = await postCmd(jobId, "s-cancel", "cancel", { reason: "operator stop" });
    assert.deepEqual(c1, { accepted: true, reason: "stop_requested", jobId, commandId: "s-cancel" });
    let g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g.job.stage, "uploading", "upload keeps running to finish current row");
    assert.equal(g.job.stopRequested, true);
    assert.ok(g.job.ledger.some((e) => e.kind === "upload:stop_requested"), "intent/audit before ack");
    const c2 = await postCmd(jobId, "s-cancel2", "cancel", {});
    assert.equal(c2.accepted, true);
    assert.equal(c2.reason, "stop_requested", "repeated cancel idempotent");
    // Engine finished the current row truthfully; record the cancel.
    const f = await postCmd(jobId, "s-row", "finish-row", { reason: "row 1 written ok" });
    assert.equal(f.accepted, true);
    assert.equal(f.reason, "cancelled");
    g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g.job.stage, "cancelled");
    assert.equal(g.job.arm.state, "none", "stop consumes the single-use arm");
    assert.ok(g.job.save_run_id, "save proof retained after cancel");
    const f2 = await postCmd(jobId, "s-row2", "finish-row", {});
    assert.equal(f2.accepted, true, "repeated finish-row idempotent");
  });

  it("finish-row without stop_requested fails closed", async () => {
    const jobId = uid("stopneg");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(jobId, "n-dry", "dry", greenDryPayload());
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    await postCmd(jobId, "n-arm", "arm", { attestedText: m.gate2.attestation, typed: "s", clicked: true });
    await postCmd(jobId, "n-up", "begin-upload", {});
    const f = await postCmd(jobId, "n-row", "finish-row", {});
    assert.equal(f.accepted, false);
    assert.equal(f.reason, "bad-stage");
  });
});

describe("P8 two-tab stale conflict (HTTP review)", () => {
  let app;
  before(async () => {
    app = await startServer({ outDir: tmpOut(), port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  function cands() {
    return [
      { seq: 0, file: "review/files/a.png", top: 10 },
      { seq: 1, file: "review/files/b.png", top: 12 },
    ];
  }

  it("tab B saving on a stale revision gets 409, never last-wins; reload + retry works", async () => {
    const outDir = app.outDir;
    const job = createJob({ slug: "tabs", source: "https://example.go.th/p1", group: "g" });
    for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review"]) advance(job, s);
    seedReview(outDir, job, cands());
    writeJob(outDir, job);
    // Two tabs read the same revision.
    const tabA = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    const tabB = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.equal(tabA.revision, tabB.revision);
    // Tab A saves first.
    const editA = tabA.selection.map((r) => ({ ...r, order: 1 }));
    const sA = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: editA, editedFrom: tabA.revision }),
    });
    assert.equal(sA.status, 200);
    assert.equal((await sA.json()).revision, tabA.revision + 1);
    // Tab B saves on the stale revision: conflict, current revision returned.
    const editB = tabB.selection.map((r) => ({ ...r, order: 9 }));
    const sB = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: editB, editedFrom: tabB.revision }),
    });
    assert.equal(sB.status, 409);
    const cb = await sB.json();
    assert.equal(cb.reason, "stale-conflict");
    assert.equal(cb.revision, tabA.revision + 1);
    // Stored draft is tab A's (never last-wins).
    const cur = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.ok(cur.selection.every((r) => r.order === 1));
    // Tab B reloads and retries on the fresh revision: accepted.
    const retry = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: editB, editedFrom: cur.revision }),
    });
    assert.equal(retry.status, 200);
  });
});

describe("P8 kill-SSE-mid-upload heals via GET resync (HTTP)", () => {
  let app;
  let out;
  before(async () => {
    out = tmpOut();
    app = await startServer({ outDir: out, port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  async function postCmd(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("aborted live stream loses nothing: GET /jobs/:id is the truth", async () => {
    const jobId = uid("kill");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(jobId, "k-dry", "dry", greenDryPayload());
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    await postCmd(jobId, "k-arm", "arm", { attestedText: m.gate2.attestation, typed: "s", clicked: true });
    await postCmd(jobId, "k-up", "begin-upload", {});
    // Open the live per-Job stream, read one event, kill the connection.
    const ctl = new AbortController();
    const r = await fetch(`${app.url}/jobs/${jobId}/events`, { signal: ctl.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const first = await Promise.race([
      reader.read(),
      delay(5000).then(() => {
        throw new Error("sse-timeout: no event on live stream");
      }),
    ]);
    assert.ok(first.value?.length > 0, "live stream delivered at least one event");
    ctl.abort();
    try {
      await reader.cancel();
    } catch {
      // abort races cancel; either way the client is gone
    }
    // GET resync heals: authoritative record, no state inferred from the stream.
    const g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    assert.equal(g.job.stage, "uploading");
    assert.ok(g.job.save_run_id, "save proof present after stream kill");
    const once = await fetch(`${app.url}/jobs/${jobId}/events?once=1&since=0`);
    assert.equal(once.status, 200);
    const evs = parseSSE(await once.text());
    assert.ok(evs.some((e) => e.event === "job:advanced"), "buffered history replays after reconnect");
  });
});

describe("P8 restart: loads + validates record/proofs, new epoch, clean resync", () => {
  let out;
  let appA = null;
  let appB = null;
  after(async () => {
    await appA?.close().catch(() => {});
    await appB?.close().catch(() => {});
  });

  async function postCmd(app, jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("server restart keeps job truth, rotates stream epoch, old cursor resyncs clean", async () => {
    out = tmpOut();
    appA = await startServer({ outDir: out, port: 0 });
    const jobId = uid("restart");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(appA, jobId, "rs-dry", "dry", greenDryPayload());
    // A real dry writes its shot files; mirror that so restart existence checks pass.
    mkdirSync(join(out, "s", "shots"), { recursive: true });
    writeFileSync(join(out, "s", "shots", "000-seq1.png"), Buffer.alloc(10, 7));
    const before = await (await fetch(`${appA.url}/jobs/${jobId}`)).json();
    assert.equal(before.job.stage, "dry_passed");
    const evA = parseSSE(await (await fetch(`${appA.url}/jobs/${jobId}/events?once=1&since=0`)).text());
    assert.ok(evA.length > 0);
    const { stream: streamA, seq: seqA } = streamOf(evA[evA.length - 1].id);
    assert.ok(streamA && seqA >= 1);
    await appA.close();
    appA = null;
    // Restart on the same outDir: record truth survives, stream epoch is new.
    appB = await startServer({ outDir: out, port: 0 });
    const after = await (await fetch(`${appB.url}/jobs/${jobId}`)).json();
    assert.equal(after.job.stage, "dry_passed", "stage comes from the record, never stray files");
    assert.equal(after.job.dry_run_id, before.job.dry_run_id);
    assert.equal(after.job.snapshot_id, before.job.snapshot_id);
    // Old-epoch cursor: no fake continuity — reset with a GET hint.
    const stale = await fetch(`${appB.url}/jobs/${jobId}/events?once=1`, {
      headers: { "last-event-id": `${streamA}:${seqA}` },
    });
    assert.equal(stale.status, 200);
    const staleText = await stale.text();
    assert.match(staleText, /job:resynced/, "stale cursor gets a resync, not replay");
    assert.match(staleText, /epoch-changed/);
    assert.match(staleText, /GET \/jobs\/:id/);
    const staleEvs = parseSSE(staleText);
    const { stream: streamB, seq: seqB } = streamOf(staleEvs[staleEvs.length - 1].id);
    assert.notEqual(streamB, streamA, "restart yields a new streamId");
    assert.ok(seqB <= 2, `new epoch restarts clean (seq ${seqB}), no fake continuity`);
    // Restart validation: record + proofs check out on the live outDir.
    const loaded = loadForRestart(out, "s", jobId);
    assert.equal(loaded.issues.length, 0);
    assert.equal(loaded.projection.stage, "dry_passed");
  });

  it("restart with lost dry proof: safety goes red, arm refused, armed job disarms", async () => {
    const app = appB ?? (appB = await startServer({ outDir: out ?? tmpOut(), port: 0 }));
    if (!out) out = app.outDir;
    const jobId = uid("proofloss");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    await postCmd(app, jobId, "pl-dry", "dry", greenDryPayload());
    let g = await (await fetch(`${app.url}/jobs/${jobId}`)).json();
    const dryId = g.job.dry_run_id;
    // Simulate restart with proof loss: the immutable dry report is gone.
    unlinkSync(dryReportPathFor(out, "s", jobId, dryId));
    const loaded = loadForRestart(out, "s", jobId);
    assert.ok(loaded.issues.some((i) => i.code === "artifact-missing"), "restart load reports the missing proof");
    const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
    assert.equal(m.gate1.ok, false, "G1 red without the dry proof");
    const arm = await postCmd(app, jobId, "pl-arm", "arm", {
      attestedText: m.gate2.attestation,
      typed: "s",
      clicked: true,
    });
    assert.equal(arm.accepted, false, "arm fails closed on lost proof");
    // An armed job restarting into proof loss disarms to dry_running.
    const jobId2 = uid("proofloss2");
    const job2 = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: jobId2 });
    driveToDryRunning(job2);
    writeJob(out, job2);
    await postCmd(app, jobId2, "pl2-dry", "dry", greenDryPayload());
    const m2 = await (await fetch(`${app.url}/jobs/${jobId2}/safety`)).json();
    const a2 = await postCmd(app, jobId2, "pl2-arm", "arm", {
      attestedText: m2.gate2.attestation,
      typed: "s",
      clicked: true,
    });
    assert.equal(a2.accepted, true);
    g = await (await fetch(`${app.url}/jobs/${jobId2}`)).json();
    unlinkSync(dryReportPathFor(out, "s", jobId2, g.job.dry_run_id));
    const rej = readJob(out, "s", jobId2);
    const assessed = assessRestart(rej, { artifactsOk: false, fingerprintsOk: true, proofsOk: false });
    assert.equal(assessed.disarmed, true);
    assert.equal(rej.stage, "dry_running");
    assert.equal(rej.arm.state, "none");
    writeJob(out, rej);
    assert.equal(readJob(out, "s", jobId2).stage, "dry_running");
  });
});

describe("P8 single-flight: one active engine op globally, waits may sit", () => {
  it("concurrent pipeline runs refused; release on finish AND on throw", async () => {
    assert.equal(currentEngineOp(), null, "no leaked engine claim from earlier suites");
    const out = tmpOut();
    const jobA = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: uid("sf-a") });
    writeJob(out, jobA);
    const jobB = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: uid("sf-b") });
    writeJob(out, jobB);
    let openGate;
    const gate = new Promise((res) => {
      openGate = res;
    });
    const runners = { probe: async () => { await gate; return { ok: true }; } };
    const pA = runPipelineAsJobOps({ outDir: out, job: jobA, steps: ["probe"], runners });
    await delay(10);
    assert.ok(currentEngineOp()?.jobId === jobA.jobId, "first run holds the engine claim");
    // Second engine op while one is active: refused, never runs.
    let code = null;
    try {
      await runPipelineAsJobOps({ outDir: out, job: readJob(out, "s", jobB.jobId), steps: ["probe"] });
    } catch (e) {
      code = e?.code;
    }
    assert.equal(code, "single-flight");
    assert.equal(readJob(out, "s", jobB.jobId).stage, "idle", "refused run never touches the waiting job");
    openGate();
    const rA = await pA;
    assert.equal(rA.steps[0].status, "ran");
    assert.equal(currentEngineOp(), null, "claim released on finish");
    // After release the waiter may run.
    const rB = await runPipelineAsJobOps({ outDir: out, job: readJob(out, "s", jobB.jobId), steps: ["probe"] });
    assert.equal(rB.steps[0].status, "deferred");
    assert.equal(currentEngineOp(), null);
  });

  it("throwing run still releases the claim", async () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: uid("sf-t") });
    writeJob(out, job);
    const bad = { probe: async () => { throw new Error("boom"); } };
    await assert.rejects(runPipelineAsJobOps({ outDir: out, job, steps: ["probe"], runners: bad }), /boom/);
    assert.equal(currentEngineOp(), null, "claim released on throw");
  });
});
