// tests/dry-defaults.test.mjs — server-authoritative one-click dry (Safety defect).
// dry {} at dry_running builds inputs from finalized selection + people.json +
// detect snapshot: success mints snapshot/dry ids + immutable proof and
// advances to dry_passed with zero backend writes. Missing/invalid inputs fail
// closed with visible reasons; replay never executes twice; explicit Advanced
// JSON keeps legacy behavior. No Real Upload anywhere.
// Run: node --test tests/dry-defaults.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, readJob, writeJob } from "../jobs/store.mjs";
import { saveReviewState } from "../jobs/review.mjs";
import { slugBaseOf } from "../services/sectioning.mjs";
import { dryReportPathFor } from "../jobs/safety.mjs";

let app;
let url;
let outDir;

const SOURCE = "https://example.invalid/dry-defaults";
const SLUG = slugBaseOf(SOURCE);

async function createJob() {
  const r = await fetch(`${url}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, slug: SLUG }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).jobId;
}

async function postDry(jobId, commandId, payload = {}) {
  const r = await fetch(`${url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, type: "dry", payload }),
  });
  return { status: r.status, json: await r.json() };
}

async function getJob(jobId) {
  return (await (await fetch(`${url}/jobs/${jobId}`)).json()).job;
}

async function getSafety(jobId) {
  return await (await fetch(`${url}/jobs/${jobId}/safety`)).json();
}

function toDryRunning(jobId) {
  const job = readJob(outDir, SLUG, jobId);
  for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
    advance(job, s);
  }
  writeJob(outDir, job);
  return readJob(outDir, SLUG, jobId);
}

function seedPeople() {
  writeFileSync(join(outDir, SLUG, "people.json"), JSON.stringify([
    { seq: 0, name: "A", section: "g", source_url: SOURCE, source_group: SLUG },
  ]), "utf8");
}

function seedSelection(jobId) {
  const job = readJob(outDir, SLUG, jobId);
  saveReviewState(outDir, job, { selection: [{ seq: 0, file: "a.png", keep: true, order: 0 }], editedFrom: 0 });
  writeJob(outDir, job);
}

function seedDetect(jobId, departments) {
  mkdirSync(join(outDir, SLUG, "jobs", jobId), { recursive: true });
  writeFileSync(join(outDir, SLUG, "jobs", jobId, "detect.json"), JSON.stringify({
    host: "https://be.invalid",
    detected_at: new Date().toISOString(),
    jobId,
    slug: SLUG,
    profile: null,
    department_options: departments,
    ambiguous: [],
  }), "utf8");
}

function dryReports(jobId) {
  return readdirSync(join(outDir, SLUG, "jobs", jobId)).filter((f) => f.startsWith("dry-") && f.endsWith(".json"));
}

describe("one-click dry builds server defaults", () => {
  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), "dry-defaults-"));
    const { startServer } = await import("../server.mjs");
    app = await startServer({ outDir, port: 0 });
    url = app.url;
  });
  after(async () => {
    await app?.close();
  });

  it("Detect success lands dry_running; dry {} mints ids + proof and advances", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    seedPeople();
    seedSelection(jobId);
    seedDetect(jobId, [SLUG]);
    const d = await postDry(jobId, "dd-ok-1", {});
    assert.equal(d.json.accepted, true);
    assert.equal(d.json.reason, "dry-recorded");
    const job = await getJob(jobId);
    assert.equal(job.stage, "dry_passed");
    assert.match(job.snapshot_id, /^snap_/);
    assert.match(job.dry_run_id, /^dry_/);
    assert.equal(job.save_run_id, null, "dry never mints a save id");
    const kinds = (job.artifacts || []).map((a) => a.kind);
    assert.ok(kinds.includes("dry-report"), "immutable dry proof registered");
    assert.ok(!kinds.includes("save-report"), "no backend save occurred");
    const dry = (job.artifacts || []).find((a) => a.kind === "dry-report");
    assert.ok(dry.sha256 && dry.byteLength > 0, "proof has sha256 + length");
    assert.ok(existsSync(dryReportPathFor(outDir, SLUG, jobId, job.dry_run_id)), "proof file on disk");
    const safety = await getSafety(jobId);
    assert.equal(safety.available, true, "visibility bundle exposed");
    assert.equal(safety.gate1.ok, true, "G1 green");
    assert.ok((safety.bundle.rows || []).length === 1, "real row results");
  });

  it("missing selection fails closed with a visible reason (stays dry_running)", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    const d = await postDry(jobId, "dd-nosel-1", {});
    assert.equal(d.json.accepted, false);
    assert.equal(d.json.reason, "no-selection");
    const job = await getJob(jobId);
    assert.equal(job.stage, "dry_running");
    assert.equal(job.snapshot_id, null);
    assert.equal(job.dry_run_id, null);
  });

  it("missing detect snapshot fails closed (stays dry_running)", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    seedPeople();
    seedSelection(jobId);
    const d = await postDry(jobId, "dd-nodet-1", {});
    assert.equal(d.json.accepted, false);
    assert.equal(d.json.reason, "no-detect");
    assert.equal((await getJob(jobId)).stage, "dry_running");
  });

  it("unmapped target fails G1 pinned-would-create (real bankhuan case: 0 departments)", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    seedPeople();
    seedSelection(jobId);
    seedDetect(jobId, []);
    const d = await postDry(jobId, "dd-would-1", {});
    assert.equal(d.json.accepted, false);
    assert.equal(d.json.reason, "gate1-failed");
    const job = await getJob(jobId);
    assert.equal(job.stage, "dry_running");
    assert.equal(job.snapshot_id, null, "no ids minted on G1 red");
    assert.equal(job.dry_run_id, null);
  });

  it("command replay returns the disposition without executing dry twice", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    seedPeople();
    seedSelection(jobId);
    seedDetect(jobId, [SLUG]);
    const first = await postDry(jobId, "dd-replay-1", {});
    assert.equal(first.json.accepted, true);
    const idBefore = (await getJob(jobId)).dry_run_id;
    assert.match(idBefore, /^dry_/);
    const replay = await postDry(jobId, "dd-replay-1", {});
    assert.deepEqual(replay.json, first.json);
    assert.equal(dryReports(jobId).length, 1, "exactly one dry proof file");
    assert.equal((await getJob(jobId)).dry_run_id, idBefore, "replay mints no second dry id");
  });

  it("explicit Advanced JSON keeps legacy behavior", async () => {
    const jobId = await createJob();
    toDryRunning(jobId);
    const payload = {
      snapshotInput: {
        people: [{ seq: 1, name: "A" }],
        selection: [{ seq: 1, keep: true, order: 0 }],
        sourceUrl: SOURCE,
        sourceGroup: SLUG,
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
    const d = await postDry(jobId, "dd-adv-1", payload);
    assert.equal(d.json.accepted, true);
    assert.equal(d.json.reason, "dry-recorded");
    assert.equal((await getJob(jobId)).stage, "dry_passed");
  });
});
