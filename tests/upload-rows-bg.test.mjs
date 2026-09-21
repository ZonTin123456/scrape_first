// tests/upload-rows-bg.test.mjs — Job/UI row-execution binding (Part B).
// begin-upload enters uploading, then the shared real upload core runs in the
// background: injected uploadRow per dry row, completion advances to done,
// failure fails truthfully, stop cancels, replay never re-runs rows, second
// attempts refuse on the consumed arm. No browser needed (injected runner).
// Run: node --test tests/upload-rows-bg.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, createJob, readJob, writeJob } from "../jobs/store.mjs";
import { createCommandStore } from "../jobs/commands.mjs";
import { safetyModel } from "../jobs/safety.mjs";

let app;
let url;
let outDir;
let calls;

function greenPayload() {
  return {
    snapshotInput: {
      people: [{ seq: 1, name: "A" }],
      selection: [{ seq: 1, keep: true, order: 0 }],
      sourceUrl: "https://a.go.th/x",
      sourceGroup: "s",
      backendOrigin: "https://be.invalid",
      deptMapping: { a: 1 },
      deptPlan: [{ row: 1 }],
      mappingVersion: "m1",
      profileVersion: "p1",
    },
    rows: [{ seq: 1, name: "A", group: "a", target: "https://be.invalid/personal/person/1", status: "dry" }],
    mapMode: "pinned",
    guardStatus: "green",
    destinationOrigin: "https://be.invalid",
    targetDepts: ["a"],
    wouldCreate: [],
    identity: { verified: true, personId: "1" },
    unmapped: [],
    shots: [],
  };
}

function driveArmed(jobId) {
  const store = createCommandStore({ hub: null });
  const dry = store.execute({ outDir, jobId, commandId: `${jobId}-dry`, type: "dry", payload: greenPayload() });
  assert.equal(dry.accepted, true);
  const model = safetyModel(outDir, readJob(outDir, "s", jobId));
  const arm = store.execute({
    outDir, jobId, commandId: `${jobId}-arm`, type: "arm",
    payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
  });
  assert.equal(arm.accepted, true);
}

function seedJob() {
  const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a" });
  for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
    advance(job, s);
  }
  writeJob(outDir, job);
  return job.jobId;
}

async function postCmd(jobId, commandId, type, payload = {}) {
  const r = await fetch(`${url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, type, payload }),
  });
  return { status: r.status, json: await r.json() };
}

async function getJob(jobId) {
  return (await (await fetch(`${url}/jobs/${jobId}`)).json()).job;
}

async function waitStage(jobId, stages, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(jobId);
    if (stages.includes(job.stage)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`stage timeout for ${jobId} (at ${job.stage})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("bg row execution binding", () => {
  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), "uprows-"));
    calls = [];
    const { startServer } = await import("../server.mjs");
    app = await startServer({
      outDir,
      port: 0,
      engine: {
        uploadRow: async ({ entry }) => {
          calls.push(entry?.seq);
          return { seq: entry?.seq, status: "created", detail: "injected ok" };
        },
      },
    });
    url = app.url;
  });
  after(async () => {
    await app?.close();
  });

  it("rows execute after begin-upload; done only on completion", async () => {
    const jobId = seedJob();
    driveArmed(jobId);
    const before = calls.length;
    const u = await postCmd(jobId, "up-1", "begin-upload");
    assert.equal(u.json.accepted, true);
    assert.equal(u.json.reason, "upload-started");
    const job = await waitStage(jobId, ["done"]);
    assert.ok(calls.length > before, "real row runner invoked");
    assert.deepEqual(calls.slice(before), [1], "dry-report seq executed");
    assert.equal(job.save_run_id === null, false, "save id minted");
    assert.equal(job.arm.state, "none", "arm consumed exactly once");
    const dry = (job.artifacts || []).find((a) => a.kind === "dry-report");
    const save = (job.artifacts || []).find((a) => a.kind === "save-report");
    assert.ok(dry?.sha256 && save?.sha256, "immutable proofs exist");
  });

  it("save proof references the exact dry proof", async () => {
    const jobId = seedJob();
    driveArmed(jobId);
    await postCmd(jobId, "up-2", "begin-upload");
    const job = await waitStage(jobId, ["done"]);
    const { readDryReport, saveReportPathFor } = await import("../jobs/safety.mjs");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dry = readDryReport(outDir, "s", jobId, job.dry_run_id);
    const saved = JSON.parse(readFileSync(saveReportPathFor(outDir, "s", jobId, job.save_run_id), "utf8"));
    assert.equal(saved.dry_run_id, job.dry_run_id);
    assert.equal(saved.dry_report_sha256, dry.sha256);
  });

  it("replay returns the disposition without re-running rows", async () => {
    const jobId = seedJob();
    driveArmed(jobId);
    const first = await postCmd(jobId, "up-3", "begin-upload");
    await waitStage(jobId, ["done"]);
    const before = calls.length;
    const replay = await postCmd(jobId, "up-3", "begin-upload");
    assert.deepEqual(replay.json, first.json);
    assert.equal(calls.length, before, "no second row execution");
  });

  it("second attempt refuses on the consumed arm", async () => {
    const jobId = seedJob();
    driveArmed(jobId);
    await postCmd(jobId, "up-4a", "begin-upload");
    await waitStage(jobId, ["done"]);
    const saves = (await getJob(jobId)).artifacts.filter((a) => a.kind === "save-report").length;
    const again = await postCmd(jobId, "up-4b", "begin-upload");
    assert.equal(again.json.accepted, false);
    assert.equal((await getJob(jobId)).artifacts.filter((a) => a.kind === "save-report").length, saves, "no second save proof");
  });
});

describe("no row driver available (no browser)", () => {
  let app3;
  let url3;
  let outDir3;
  before(async () => {
    outDir3 = mkdtempSync(join(tmpdir(), "uprows-norunner-"));
    const { startServer } = await import("../server.mjs");
    app3 = await startServer({ outDir: outDir3, port: 0, engine: {} });
    url3 = app3.url;
  });
  after(async () => {
    await app3?.close();
  });

  it("stays uploading with a visible deferred note (never done, never failed)", async () => {
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a" });
    for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
      advance(job, s);
    }
    writeJob(outDir3, job);
    const store = createCommandStore({ hub: null });
    // Store bound to outDir3 via explicit outDir per call.
    const dry = store.execute({ outDir: outDir3, jobId: job.jobId, commandId: "nr-dry", type: "dry", payload: greenPayload() });
    assert.equal(dry.accepted, true);
    const model = safetyModel(outDir3, readJob(outDir3, "s", job.jobId));
    const arm = store.execute({
      outDir: outDir3, jobId: job.jobId, commandId: "nr-arm", type: "arm",
      payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
    });
    assert.equal(arm.accepted, true);
    const u = await (await fetch(`${url3}/jobs/${job.jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "nr-up", type: "begin-upload", payload: {} }),
    })).json();
    assert.equal(u.accepted, true);
    await new Promise((r) => setTimeout(r, 800));
    const after = (await (await fetch(`${url3}/jobs/${job.jobId}`)).json()).job;
    assert.equal(after.stage, "uploading", "no driver: holds uploading, never done/failed");
    assert.ok((after.ledger || []).some((e) => e && e.kind === "pipeline:deferred"), "deferred note visible");
  });
});

describe("bg row failure + cancellation", () => {
  let app2;
  let url2;
  let outDir2;
  let failCalls;
  let failMode = true;
  before(async () => {
    outDir2 = mkdtempSync(join(tmpdir(), "uprows-fail-"));
    const { startServer } = await import("../server.mjs");
    app2 = await startServer({
      outDir: outDir2,
      port: 0,
      engine: {
        uploadRow: async ({ entry }) => {
          failCalls.push(entry?.seq);
          if (!failMode && Number(entry?.seq) === 1) return { seq: entry?.seq, status: "created", detail: "ok" };
          await new Promise((r) => setTimeout(r, 1200));
          return failMode
            ? { seq: entry?.seq, status: "failed", detail: "injected boom" }
            : { seq: entry?.seq, status: "created", detail: "ok" };
        },
      },
    });
    url2 = app2.url;
    failCalls = [];
  });
  after(async () => {
    await app2?.close();
  });

  async function postCmd2(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${url2}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return { status: r.status, json: await r.json() };
  }

  async function getJob2(jobId) {
    return (await (await fetch(`${url2}/jobs/${jobId}`)).json()).job;
  }

  async function waitStage2(jobId, stages, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      const job = await getJob2(jobId);
      if (stages.includes(job.stage)) return job;
      if (Date.now() - t0 > timeoutMs) throw new Error(`stage timeout (at ${job.stage})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function driveArmed2(jobId) {
    const store = createCommandStore({ hub: null });
    const dry = store.execute({ outDir: outDir2, jobId, commandId: `${jobId}-dry`, type: "dry", payload: greenPayload() });
    assert.equal(dry.accepted, true);
    const model = safetyModel(outDir2, readJob(outDir2, "s", jobId));
    const arm = store.execute({
      outDir: outDir2, jobId, commandId: `${jobId}-arm`, type: "arm",
      payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
    });
    assert.equal(arm.accepted, true);
  }

  function seedJob2() {
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a" });
    for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
      advance(job, s);
    }
    writeJob(outDir2, job);
    return job.jobId;
  }

  it("row failure fails the job truthfully, never done", async () => {
    failMode = true;
    const jobId = seedJob2();
    driveArmed2(jobId);
    const u = await postCmd2(jobId, "up-f1", "begin-upload");
    assert.equal(u.json.accepted, true);
    const job = await waitStage2(jobId, ["failed"]);
    assert.ok(failCalls.length >= 1, "row runner invoked");
    assert.ok((job.artifacts || []).some((a) => a.kind === "save-report"), "save proof stands (attempt rule)");
    assert.equal(job.save_run_id === null, false, "save id minted at entry (attempt rule)");
  });

  it("cancel during rows follows the finish-row contract (cancelled)", async () => {
    failMode = false;
    // Two-row dry so the stop lands on a row boundary: row 1 completes
    // truthfully, the boundary before row 2 observes the stop (existing
    // single-flight/stop contract: finish the current row, then cancel).
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a" });
    for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
      advance(job, s);
    }
    writeJob(outDir2, job);
    const jobId = job.jobId;
    const store = createCommandStore({ hub: null });
    const twoRow = { ...greenPayload(), rows: [1, 2].map((seq) => ({ seq, name: `P${seq}`, group: "a", target: "https://be.invalid/personal/person/1", status: "dry" })) };
    assert.equal(store.execute({ outDir: outDir2, jobId, commandId: `${jobId}-dry2`, type: "dry", payload: twoRow }).accepted, true);
    const model = safetyModel(outDir2, readJob(outDir2, "s", jobId));
    assert.equal(store.execute({
      outDir: outDir2, jobId, commandId: `${jobId}-arm2`, type: "arm",
      payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
    }).accepted, true);
    // Slow the runner: first row fast, rows after wait past the cancel.
    const u = await postCmd2(jobId, "up-c1", "begin-upload");
    assert.equal(u.json.accepted, true);
    const cx = await postCmd2(jobId, "up-c2", "cancel", { prompted: true, reason: "test stop" });
    assert.equal(cx.json.accepted, true);
    const endJob = await waitStage2(jobId, ["cancelled", "failed"]);
    assert.equal(endJob.stage, "cancelled", "stop finishes truthfully, never done");
  });
});
