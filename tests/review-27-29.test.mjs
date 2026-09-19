// tests/review-27-29.test.mjs — Single fix pass for code-review findings on
// diff 67d5a1f...96ea710 (tickets #27 P6, #28 P7, #29 P8).
// Each finding is fixed in code and pinned here, or rebutted with evidence.
// Run: node --test tests/review-27-29.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../server.mjs";
import {
  advance,
  createJob,
  currentEngineOp,
  readJob,
  requestCancel,
  writeJob,
} from "../jobs/store.mjs";
import { createCommandStore } from "../jobs/commands.mjs";
import { currentPipelineJobs, runPipelineAsJobOps } from "../jobs/pipeline.mjs";
import { attestationText, dryReportPathFor, safetyModel } from "../jobs/safety.mjs";

let n = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p-fix-"));
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
// Materialize shot files the way a real dry does, so restart existence
// checks reflect a healthy record (mirrors hardening.test.mjs).
function materializeShots(out, slug = "s") {
  mkdirSync(join(out, slug, "shots"), { recursive: true });
  writeFileSync(join(out, slug, "shots", "000-seq1.png"), Buffer.alloc(10, 7));
}
function armViaStore(out, store, jobId, slug = "s") {
  const model = safetyModel(out, readJob(out, slug, jobId));
  const a = store.execute({
    outDir: out, jobId, commandId: `${jobId}-arm`, type: "arm",
    payload: { attestedText: model.gate2.attestation, typed: slug, clicked: true },
  });
  assert.equal(a.accepted, true);
}
function stagingFixtures(outDir, slugs = ["s1"]) {
  const staging = join(outDir, "_staging");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "picked-links.json"), JSON.stringify([{ url: "https://a.go.th/x", keep: true }]), "utf8");
  writeFileSync(join(staging, "master.json"), JSON.stringify({ generated_at: "t", pages: [], decisions: [] }), "utf8");
  const results = slugs.map((slug) => {
    const dir = join(outDir, slug);
    mkdirSync(join(dir, "review"), { recursive: true });
    writeFileSync(join(dir, "people.json"), JSON.stringify([{ seq: 1, name: "A", order: 0 }]), "utf8");
    writeFileSync(join(dir, "review", "selection.json"), JSON.stringify([{ seq: 1, file: "a.png", keep: true, order: 0 }]), "utf8");
    return { slug, url: `https://a.go.th/${slug}`, dir };
  });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ generated_at: "t", total: results.length, results }), "utf8");
  return results;
}
function greenDryInputs(over = {}) {
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
// Dry via job ops (phase 1), return the live job at dry_passed.
async function dryToPassed(outDir, slug, jobId) {
  let job = readJob(outDir, slug, jobId);
  await assert.rejects(
    runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, dryInputs: greenDryInputs() }),
    (e) => e.code === "not-armed"
  );
  job = readJob(outDir, slug, jobId);
  assert.equal(job.stage, "dry_passed");
  return job;
}
function g2For(job) {
  return { attestedText: attestationText({ dryRunId: job.dry_run_id, shotCount: 1, snapshotId: job.snapshot_id }), typed: job.slug, clicked: true };
}

describe("finding 1: boot validates records/proofs, disarms on proof loss", () => {
  it("healthy dry_passed untouched; armed job with lost dry proof disarms", async () => {
    const out = tmpOut();
    const store = createCommandStore({});
    for (const [slug, jobId] of [["s", "boot-healthy"], ["s", "boot-armed"]]) {
      const job = createJob({ slug, source: "https://a.go.th/x", group: "a", jobId });
      driveToDryRunning(job);
      writeJob(out, job);
      assert.equal(store.execute({ outDir: out, jobId, commandId: `${jobId}-dry`, type: "dry", payload: greenDryPayload() }).accepted, true);
    }
    materializeShots(out, "s");
    armViaStore(out, store, "boot-armed");
    assert.equal(readJob(out, "s", "boot-armed").stage, "armed");
    unlinkSync(dryReportPathFor(out, "s", "boot-armed", readJob(out, "s", "boot-armed").dry_run_id));
    const app = await startServer({ outDir: out, port: 0 });
    try {
      const healthy = readJob(out, "s", "boot-healthy");
      assert.equal(healthy.stage, "dry_passed", "healthy record untouched by boot");
      const disarmed = readJob(out, "s", "boot-armed");
      assert.equal(disarmed.stage, "dry_running");
      assert.equal(disarmed.arm.state, "none");
      assert.ok(disarmed.ledger.some((e) => e.kind === "job:disarmed"), "disarm audited");
    } finally {
      await app.close();
    }
    assert.equal(currentEngineOp(), null, "boot holds no engine claim");
  });
});

describe("finding 2 (rebutted): stale-tab safety needs no revision — stage gates + G2 binding + single-use arm already refuse", () => {
  it("second-tab arm refused bad-stage, second upload refused not-armed, exactly one save proof", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "stale" });
    driveToDryRunning(job);
    writeJob(out, job);
    const store = createCommandStore({});
    assert.equal(store.execute({ outDir: out, jobId: "stale", commandId: "t-dry", type: "dry", payload: greenDryPayload() }).accepted, true);
    // Tab A arms + uploads (consumes the single-use arm).
    armViaStore(out, store, "stale");
    assert.equal(store.execute({ outDir: out, jobId: "stale", commandId: "t-up-a", type: "begin-upload", payload: {} }).accepted, true);
    // Tab B, holding the same (now stale) attestation, is refused everywhere.
    const model = safetyModel(out, readJob(out, "s", "stale"));
    const staleArm = store.execute({
      outDir: out, jobId: "stale", commandId: "t-arm-b", type: "arm",
      payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
    });
    assert.equal(staleArm.accepted, false);
    assert.equal(staleArm.reason, "bad-stage");
    const staleUp = store.execute({ outDir: out, jobId: "stale", commandId: "t-up-b", type: "begin-upload", payload: {} });
    assert.equal(staleUp.accepted, false);
    assert.equal(staleUp.reason, "not-armed");
    const done = readJob(out, "s", "stale");
    assert.equal(done.stage, "uploading");
    assert.equal(done.artifacts.filter((a) => a.kind === "save-report").length, 1, "no double-execute");
  });
});

describe("finding 3: guard regression re-checked per row, disarms fail-closed", () => {
  it("guardCheck red on row 2: row 1 kept, job failed, arm consumed", async () => {
    const out = tmpOut();
    stagingFixtures(out, ["s1", "s2"]);
    const jid = uid("guard");
    const job = createJob({ slug: "s1", source: "https://a.go.th/x", group: "a", jobId: jid });
    writeJob(out, job);
    await dryToPassed(out, "s1", jid);
    const executed = [];
    await assert.rejects(
      runPipelineAsJobOps({
        outDir: out, job: readJob(out, "s1", jid), steps: ["upload"], autoApprove: true,
        armInputs: g2For(readJob(out, "s1", jid)),
        runners: {
          uploadRow: async ({ entry }) => void executed.push(entry.slug) || { status: "done" },
          guardCheck: async ({ entry }) => (entry.slug === "s2" ? { regression: true, detail: "fields unsatisfy" } : { guardStatus: "green" }),
        },
      }),
      (e) => e.code === "guard-regression"
    );
    assert.deepEqual(executed, ["s1"], "row 1 finished truthfully, row 2 never ran");
    const failed = readJob(out, "s1", jid);
    assert.equal(failed.stage, "failed");
    assert.equal(failed.arm.state, "none", "arm consumed");
    assert.ok(failed.ledger.some((e) => e.kind === "guard:regression"), "regression audited");
    assert.ok(failed.save_run_id, "save proof retained");
  });

  it("row result guardStatus red fails closed the same way", async () => {
    const out = tmpOut();
    stagingFixtures(out, ["s1", "s2"]);
    const jid = uid("guardrow");
    const job = createJob({ slug: "s1", source: "https://a.go.th/x", group: "a", jobId: jid });
    writeJob(out, job);
    await dryToPassed(out, "s1", jid);
    await assert.rejects(
      runPipelineAsJobOps({
        outDir: out, job: readJob(out, "s1", jid), steps: ["upload"], autoApprove: true,
        armInputs: g2For(readJob(out, "s1", jid)),
        runners: { uploadRow: async ({ entry }) => (entry.slug === "s2" ? { status: "done", guardStatus: "red", detail: "identity drift" } : { status: "done" }) },
      }),
      (e) => e.code === "guard-regression"
    );
    assert.equal(readJob(out, "s1", jid).stage, "failed");
  });

  it("dry proof lost mid-queue fails closed with missing-proof", async () => {
    const out = tmpOut();
    stagingFixtures(out, ["s1", "s2"]);
    const jid = uid("proofloss");
    const job = createJob({ slug: "s1", source: "https://a.go.th/x", group: "a", jobId: jid });
    writeJob(out, job);
    await dryToPassed(out, "s1", jid);
    const dryId = readJob(out, "s1", jid).dry_run_id;
    await assert.rejects(
      runPipelineAsJobOps({
        outDir: out, job: readJob(out, "s1", jid), steps: ["upload"], autoApprove: true,
        armInputs: g2For(readJob(out, "s1", jid)),
        runners: {
          uploadRow: async () => {
            unlinkSync(dryReportPathFor(out, "s1", jid, dryId));
            return { status: "done" };
          },
        },
      }),
      (e) => e.code === "missing-proof"
    );
    const failed = readJob(out, "s1", jid);
    assert.equal(failed.stage, "failed");
    assert.ok(failed.ledger.some((e) => e.kind === "proof:lost"), "proof loss audited");
  });
});

describe("finding 4 gap: guard-red dry refused over HTTP fail-closed", () => {
  it("red dry rejected, job stays dry_running", async () => {
    const out = tmpOut();
    const app = await startServer({ outDir: out, port: 0 });
    try {
      const jobId = uid("httpred");
      const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
      driveToDryRunning(job);
      writeJob(out, job);
      const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: "red-dry", type: "dry", payload: greenDryPayload({ guardStatus: "red" }) }),
      });
      const d = await r.json();
      assert.equal(d.accepted, false);
      assert.equal(d.reason, "gate1-failed");
      assert.equal(readJob(out, "s", jobId).stage, "dry_running");
    } finally {
      await app.close();
    }
  });
});

describe("finding 5: single-flight enforced across command paths", () => {
  it("dry/arm/begin-upload refused while pipeline holds claim (any job); cancel never gated; same commandId retries fresh after release", async () => {
    assert.equal(currentEngineOp(), null);
    const out = tmpOut();
    const app = await startServer({ outDir: out, port: 0 });
    const postCmd = async (jobId, commandId, type, payload = {}) => {
      const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, type, payload }),
      });
      return r.json();
    };
    try {
      const holder = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: uid("holder") });
      writeJob(out, holder);
      for (const jid of ["cmdb", "cmdc"]) {
        const j = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: jid });
        driveToDryRunning(j);
        writeJob(out, j);
      }
      let openGate;
      const gate = new Promise((res) => { openGate = res; });
      const pHold = runPipelineAsJobOps({ outDir: out, job: holder, steps: ["probe"], runners: { probe: async () => { await gate; return { ok: true }; } } });
      await delay(20);
      assert.equal(currentEngineOp()?.jobId, holder.jobId, "pipeline holds the engine claim");
      // Cross-job AND same-job safety commands refused while busy.
      assert.deepEqual(await postCmd("cmdb", "busy-1", "dry", greenDryPayload()), { accepted: false, reason: "single-flight", jobId: "cmdb", commandId: "busy-1" });
      assert.deepEqual(await postCmd(holder.jobId, "busy-2", "dry", greenDryPayload()), { accepted: false, reason: "single-flight", jobId: holder.jobId, commandId: "busy-2" });
      assert.deepEqual(await postCmd("cmdb", "busy-3", "arm", {}), { accepted: false, reason: "single-flight", jobId: "cmdb", commandId: "busy-3" });
      assert.deepEqual(await postCmd("cmdb", "busy-4", "begin-upload", {}), { accepted: false, reason: "single-flight", jobId: "cmdb", commandId: "busy-4" });
      // Cancel (the stop path) is never gated.
      const c = await postCmd("cmdb", "busy-cancel", "cancel", { prompted: true, reason: "test" });
      assert.equal(c.accepted, true);
      // Transient refusal is not cached: same commandId executes after release.
      openGate();
      const held = await pHold;
      assert.equal(held.steps[0].status, "ran");
      assert.equal(currentEngineOp(), null);
      assert.deepEqual(currentPipelineJobs(), []);
      const retry = await postCmd("cmdc", "busy-1", "dry", greenDryPayload());
      assert.equal(retry.accepted, true, "same commandId retries fresh after release");
      assert.equal(retry.reason, "dry-recorded");
    } finally {
      await app.close();
    }
    assert.equal(currentEngineOp(), null, "no leaked engine claim");
  });

  it("same-job pipeline re-entry refused while its run is active", async () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: uid("reentry") });
    writeJob(out, job);
    let openGate;
    const gate = new Promise((res) => { openGate = res; });
    const p1 = runPipelineAsJobOps({ outDir: out, job, steps: ["probe"], runners: { probe: async () => { await gate; return { ok: true }; } } });
    await delay(20);
    await assert.rejects(
      runPipelineAsJobOps({ outDir: out, job: readJob(out, "s", job.jobId), steps: ["probe"] }),
      (e) => e.code === "single-flight"
    );
    openGate();
    assert.equal((await p1).steps[0].status, "ran");
    assert.equal(currentEngineOp(), null);
    assert.deepEqual(currentPipelineJobs(), []);
  });
});

describe("finding 7: command dispositions persist per job across restart", () => {
  it("replayed dry commandId returns original disposition, no second dry report", async () => {
    const out = tmpOut();
    let app = await startServer({ outDir: out, port: 0 });
    const postCmd = async (jobId, commandId, type, payload = {}) => {
      const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, type, payload }),
      });
      return r.json();
    };
    const jobId = uid("persist");
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    const d1 = await postCmd(jobId, "persist-dry", "dry", greenDryPayload());
    assert.equal(d1.accepted, true);
    materializeShots(out, "s");
    assert.equal(readJob(out, "s", jobId).artifacts.filter((a) => a.kind === "dry-report").length, 1);
    await app.close();
    app = await startServer({ outDir: out, port: 0 });
    try {
      // Same commandId, tampered payload: original disposition, never re-executes.
      const d2 = await postCmd(jobId, "persist-dry", "dry", greenDryPayload({ guardStatus: "red" }));
      assert.deepEqual(d2, d1);
      assert.equal(readJob(out, "s", jobId).artifacts.filter((a) => a.kind === "dry-report").length, 1, "no double-execute across restart");
      assert.equal(readJob(out, "s", jobId).stage, "dry_passed");
      // Server stays functional: fresh arm command executes.
      const m = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
      const a = await postCmd(jobId, "persist-arm", "arm", { attestedText: m.gate2.attestation, typed: "s", clicked: true });
      assert.equal(a.accepted, true);
    } finally {
      await app.close();
    }
  });
});

describe("finding 8: upload loop observes stop per row, cancels after current row", () => {
  it("stop during row 1: row 2 never runs, cancelled with arm consumed", async () => {
    const out = tmpOut();
    stagingFixtures(out, ["s1", "s2"]);
    const jid = uid("midstop");
    const job = createJob({ slug: "s1", source: "https://a.go.th/x", group: "a", jobId: jid });
    writeJob(out, job);
    await dryToPassed(out, "s1", jid);
    const executed = [];
    const res = await runPipelineAsJobOps({
      outDir: out, job: readJob(out, "s1", jid), steps: ["upload"], autoApprove: true,
      armInputs: g2For(readJob(out, "s1", jid)),
      runners: {
        uploadRow: async ({ entry }) => {
          executed.push(entry.slug);
          if (entry.slug === "s1") {
            // Operator POST cancel lands on disk mid-run.
            const live = readJob(out, "s1", jid);
            requestCancel(live, { reason: "operator stop" });
            writeJob(out, live);
          }
          return { status: "done" };
        },
      },
    });
    assert.equal(res.steps[0].status, "cancelled");
    assert.deepEqual(executed, ["s1"], "current row finished truthfully, next row never started");
    assert.deepEqual(res.steps[0].rowResults.map((r) => r.slug), ["s1"]);
    const cancelled = readJob(out, "s1", jid);
    assert.equal(cancelled.stage, "cancelled");
    assert.equal(cancelled.arm.state, "none", "stop consumes the single-use arm");
    assert.ok(cancelled.save_run_id, "save proof retained after cancel");
    assert.equal(currentEngineOp(), null, "claim released on cancel path");
  });
});
