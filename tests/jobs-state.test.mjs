// tests/jobs-state.test.mjs — P2 Job record + state machine, no browser.
// Run: node --test tests/jobs-state.test.mjs
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPINE,
  TERMINALS,
  ALL_STAGES,
  STAGE_POLICY,
  evaluateStageResult,
  applyStageResult,
  newJobId,
  newDryRunId,
  newSaveRunId,
  computeSnapshotId,
  jobDirFor,
  jobPathFor,
  pointerPathFor,
  getPointer,
  createJob,
  validateJob,
  writeJob,
  readJob,
  readPointer,
  findJobById,
  loadForRestart,
  assessRestart,
  isTerminal,
  canAdvance,
  advance,
  retry,
  resume,
  uploadResumePlan,
  raiseBlocker,
  clearBlocker,
  hasBlocker,
  grantArm,
  consumeArm,
  beginUpload,
  finishUpload,
  failJob,
  requestCancel,
  finishUploadRowAndCancel,
  notifyFingerprintChanged,
  notifyGuardRegression,
  notifyProofLost,
  addArtifact,
  claimEngineOp,
  releaseEngineOp,
  currentEngineOp,
  resetEngineOp,
} from "../jobs/store.mjs";

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p2-job-"));
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

// Drive idle -> dry_passed (sets proofs), caller grants arm.
function driveToDryPassed(job) {
  const path = ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"];
  for (const s of path) advance(job, s);
  job.snapshot_id = computeSnapshotId(snapFixture());
  job.fingerprints = { snapshot: job.snapshot_id };
  job.dry_run_id = newDryRunId();
  advance(job, "dry_passed");
  return job;
}

function driveToArmed(job) {
  driveToDryPassed(job);
  grantArm(job, { attested: true, typed: job.slug });
  return job;
}

beforeEach(() => {
  resetEngineOp();
});

describe("P2 create/validate/ids", () => {
  it("createJob defaults: idle, attempts 0, arm none, ledger seeded", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x", group: "a" });
    assert.equal(j.stage, "idle");
    assert.equal(j.attempts, 0);
    assert.deepEqual(j.arm, { state: "none", attested: false, typed: null, dry_run_id: null });
    assert.equal(j.ledger.length, 1);
    assert.ok(validateJob(j).ok);
  });

  it("createJob requires slug + source", () => {
    assert.throws(() => createJob({ slug: "", source: "https://a.go.th/x" }), /slug/);
    assert.throws(() => createJob({ slug: "s", source: "" }), /source/);
  });

  it("validateJob rejects unknown stage and bad blocker", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.equal(validateJob({ ...j, stage: "nope" }).ok, false);
    assert.equal(validateJob({ ...j, blockers: [{ type: "nope", at: "x" }] }).ok, false);
  });

  it("snapshot_id deterministic; selection order matters; key order does not", () => {
    const a = computeSnapshotId(snapFixture());
    const b = computeSnapshotId(snapFixture());
    assert.equal(a, b);
    assert.match(a, /^snap_[0-9a-f]{16}$/);
    const swapped = { ...snapFixture(), selection: [{ seq: 1, keep: true, order: 2 }] };
    assert.notEqual(computeSnapshotId(swapped), a);
    const reordered = { ...snapFixture(), selection: [{ seq: 2, keep: true, order: 1 }, { seq: 1, keep: true, order: 1 }] };
    assert.notEqual(computeSnapshotId(reordered), computeSnapshotId(snapFixture()));
    // people content mutation changes id
    assert.notEqual(computeSnapshotId({ ...snapFixture(), people: [{ seq: 9, name: "Z" }] }), a);
    // source/group/backend/mapping/profile versions all feed the hash
    assert.notEqual(computeSnapshotId({ ...snapFixture(), sourceUrl: "https://other/x" }), a);
    assert.notEqual(computeSnapshotId({ ...snapFixture(), sourceGroup: "other" }), a);
    assert.notEqual(computeSnapshotId({ ...snapFixture(), backendOrigin: "https://other/" }), a);
    assert.notEqual(computeSnapshotId({ ...snapFixture(), mappingVersion: "m2" }), a);
    assert.notEqual(computeSnapshotId({ ...snapFixture(), profileVersion: "p2" }), a);
  });

  it("dry/save ids generated unique with prefixes; excluded from snapshot hash", () => {
    const d1 = newDryRunId();
    const d2 = newDryRunId();
    assert.match(d1, /^dry_[0-9a-f]+$/);
    assert.notEqual(d1, d2);
    const s1 = newSaveRunId();
    assert.match(s1, /^save_[0-9a-f]+$/);
    assert.notEqual(newSaveRunId(), s1);
    assert.ok(typeof newJobId() === "string");
    assert.notEqual(newJobId(), newJobId());
    // snapshot fn takes no dry_run_id: same inputs -> same id regardless of dry proof
    assert.equal(computeSnapshotId(snapFixture()), computeSnapshotId(snapFixture()));
  });
});

describe("P2 persistence: canonical + pointer + restart load", () => {
  it("writeJob creates canonical + pointer; readJob roundtrips; pointer projects", () => {
    const out = tmpOut();
    const j = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "job-1" });
    const { jobPath, pointerPath } = writeJob(out, j);
    assert.equal(jobPath, jobPathFor(out, "s", "job-1"));
    assert.equal(pointerPath, pointerPathFor(out, "s"));
    const back = readJob(out, "s", "job-1");
    assert.equal(back.jobId, "job-1");
    assert.equal(back.stage, "idle");
    const ptr = readPointer(out, "s");
    assert.equal(ptr.jobId, "job-1");
    assert.equal(ptr.stage, "idle");
    assert.equal(ptr.jobPath, "jobs/job-1/job.json");
    assert.deepEqual(getPointer(back), ptr);
  });

  it("readJob not-found throws code; corrupt json throws", () => {
    const out = tmpOut();
    assert.throws(() => readJob(out, "s", "missing"), (e) => e.code === "not-found");
    mkdirSync(jobDirFor(out, "s", "bad"), { recursive: true });
    writeFileSync(jobPathFor(out, "s", "bad"), "{oops", "utf8");
    assert.throws(() => readJob(out, "s", "bad"), (e) => e.code === "corrupt");
  });

  it("findJobById scans slugs; null when absent", () => {
    const out = tmpOut();
    const j = createJob({ slug: "alpha", source: "https://a.go.th/x", jobId: "j9" });
    writeJob(out, j);
    const hit = findJobById(out, "j9");
    assert.equal(hit.slug, "alpha");
    assert.equal(hit.job.jobId, "j9");
    assert.equal(findJobById(out, "nope"), null);
    assert.equal(findJobById(tmpOut(), "nope"), null);
  });

  it("loadForRestart validates artifacts + fingerprints, never infers stage from stray files", () => {
    const out = tmpOut();
    const j = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "jr" });
    driveToArmed(j);
    addArtifact(j, { kind: "dry-report", relPath: "reports/dry.json", sha256: "ab", byteLength: 2 });
    writeJob(out, j);
    // proof file missing -> issue reported, record stage untouched on disk
    const loaded = loadForRestart(out, "s", "jr");
    assert.equal(loaded.job.stage, "armed");
    assert.ok(loaded.issues.some((i) => i.code === "artifact-missing"));
    assert.equal(loaded.projection.jobId, "jr");
    // stray files do not move the stage
    mkdirSync(join(out, "s", "reports"), { recursive: true });
    writeFileSync(join(out, "s", "reports", "stray.json"), "{}", "utf8");
    const reloaded = loadForRestart(out, "s", "jr", { checkFiles: false });
    assert.equal(reloaded.job.stage, "armed");
    assert.equal(reloaded.issues.length, 0);
    // fingerprint mismatch surfaces
    const tampered = readJob(out, "s", "jr");
    tampered.fingerprints.snapshot = "snap_deadbeefdeadbeef";
    writeJob(out, tampered);
    const bad = loadForRestart(out, "s", "jr", { checkFiles: false });
    assert.ok(bad.issues.some((i) => i.code === "fingerprint-mismatch"));
  });
});

describe("P2 spine transitions", () => {
  it("walks the full spine idle -> done", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    assert.equal(j.stage, "armed");
    beginUpload(j);
    assert.equal(j.stage, "uploading");
    finishUpload(j);
    assert.equal(j.stage, "done");
    assert.deepEqual(SPINE.length, 12);
  });

  it("rejects skips, backward moves, and unknown stages", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.throws(() => advance(j, "scraping"), /illegal/);
    assert.throws(() => advance(j, "done"), /illegal/);
    assert.throws(() => advance(j, "nope"), /illegal/);
    advance(j, "probing");
    assert.throws(() => advance(j, "idle"), /illegal/);
    assert.throws(() => advance(j, "probing"), /illegal/);
  });

  it("advance to failed allowed from any active stage and consumes arm", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    assert.equal(j.arm.state, "armed");
    advance(j, "failed", { reason: "boom" });
    assert.equal(j.stage, "failed");
    assert.equal(j.arm.state, "none");
    assert.ok(j.ledger.some((e) => e.kind === "arm:consumed"));
  });

  it("advance to cancelled is refused: use requestCancel", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(j, "probing");
    assert.throws(() => advance(j, "cancelled"), /illegal/);
  });

  it("retry bumps attempts + audit, re-enters checkpoint, refuses forward/terminal", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(j, "probing");
    advance(j, "waiting_for_page_selection");
    const n = j.attempts;
    retry(j, { to: "probing", reason: "flake" });
    assert.equal(j.stage, "probing");
    assert.equal(j.attempts, n + 1);
    assert.ok(j.ledger.some((e) => e.kind === "job:retry"));
    assert.throws(() => retry(j, { to: "scraping" }), /current or earlier/);
    assert.throws(() => retry(j, { to: "done" }), /bad checkpoint/);
    const d = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(d);
    beginUpload(d);
    finishUpload(d);
    assert.throws(() => retry(d, { to: "probing" }), /new Job/);
  });

  it("retry retreating from armed consumes the single-use arm", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    retry(j, { to: "dry_running", reason: "re-dry" });
    assert.equal(j.arm.state, "none");
    assert.equal(j.stage, "dry_running");
  });

  it("resume explicit only: waits advance, others refuse", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(j, "probing");
    advance(j, "waiting_for_page_selection");
    resume(j);
    assert.equal(j.stage, "scraping");
    const k = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.throws(() => resume(k), /not a wait/);
    advance(k, "probing");
    assert.throws(() => resume(k), /not a wait/);
  });

  it("uploadResumePlan: minimum fresh dry; structural routes via detecting_backend", () => {
    assert.deepEqual(uploadResumePlan(), ["dry_running", "dry_passed", "armed", "uploading"]);
    assert.deepEqual(uploadResumePlan({ structural: true }), [
      "detecting_backend",
      "dry_running",
      "dry_passed",
      "armed",
      "uploading",
    ]);
  });

  it("canAdvance table: linear + disarm + structural edges", () => {
    assert.equal(canAdvance("idle", "probing"), true);
    assert.equal(canAdvance("dry_running", "dry_passed"), true);
    assert.equal(canAdvance("dry_passed", "armed"), false); // arm only via grantArm, not advance
    assert.equal(canAdvance("armed", "uploading"), false); // upload only via beginUpload (consumes arm)
    assert.equal(canAdvance("uploading", "done"), true);
    assert.equal(canAdvance("dry_passed", "dry_running"), true);
    assert.equal(canAdvance("armed", "dry_running"), true);
    assert.equal(canAdvance("dry_running", "detecting_backend"), true);
    assert.equal(canAdvance("probing", "failed"), true);
    assert.equal(canAdvance("done", "probing"), false);
    assert.equal(canAdvance("failed", "probing"), false);
    assert.equal(canAdvance("cancelled", "probing"), false);
    assert.ok(TERMINALS.includes("failed") && TERMINALS.includes("cancelled"));
    assert.ok(ALL_STAGES.includes("done"));
  });
});

describe("P2 blockers orthogonal, preserve arm when proofs validate", () => {
  it("raise/clear/has roundtrip; bad type throws", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.throws(() => raiseBlocker(j, { type: "nope" }), /bad blocker/);
    raiseBlocker(j, { type: "cloudflare", ctx: "turnstile" });
    raiseBlocker(j, { type: "cdp", ctx: "disconnect" });
    assert.equal(hasBlocker(j, "cloudflare"), true);
    assert.equal(hasBlocker(j, "cdp"), true);
    clearBlocker(j, "cloudflare");
    assert.equal(hasBlocker(j, "cloudflare"), false);
    assert.equal(hasBlocker(j, "cdp"), true);
  });

  it("CF/CDP preserve arm: grant + stay armed with blockers present", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryPassed(j);
    raiseBlocker(j, { type: "cloudflare", ctx: "wall" });
    grantArm(j, { attested: true, typed: j.slug });
    assert.equal(j.arm.state, "armed");
    raiseBlocker(j, { type: "cdp", ctx: "drop" });
    assert.equal(j.arm.state, "armed");
    assert.equal(j.stage, "armed");
    clearBlocker(j, "cloudflare");
    clearBlocker(j, "cdp");
    assert.equal(j.arm.state, "armed");
  });
});

describe("P2 arm grant/consume + disarm rules", () => {
  it("grantArm enforces G1 proof + G2 attest/typed + dry_passed stage", () => {
    const j = createJob({ slug: "exact", source: "https://a.go.th/x" });
    assert.throws(() => grantArm(j, { attested: true, typed: "exact" }), /dry_passed/);
    driveToDryPassed(j);
    assert.throws(() => grantArm(j, { attested: false, typed: "exact" }), /G2/);
    assert.throws(() => grantArm(j, { attested: true, typed: "wrong" }), /G2/);
    const noProof = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryPassed(noProof);
    noProof.dry_run_id = null;
    assert.throws(() => grantArm(noProof, { attested: true, typed: "s" }), /proof/);
    grantArm(j, { attested: true, typed: "exact" });
    assert.equal(j.stage, "armed");
    assert.equal(j.arm.dry_run_id, j.dry_run_id);
  });

  it("fingerprint mutation disarms dry_passed/armed to dry_running", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryPassed(j);
    const { disarmed } = notifyFingerprintChanged(j, "snap_changed0000001");
    assert.equal(disarmed, true);
    assert.equal(j.stage, "dry_running");
    assert.equal(j.snapshot_id, "snap_changed0000001");
    const early = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(early, "probing");
    const r2 = notifyFingerprintChanged(early, "snap_x0000000000001");
    assert.equal(r2.disarmed, false);
    assert.equal(early.stage, "probing");
  });

  it("guard regression + proof loss disarm armed to dry_running", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    const g = notifyGuardRegression(j, { detail: "fields unsatisfy" });
    assert.equal(g.disarmed, true);
    assert.equal(j.stage, "dry_running");
    assert.equal(j.arm.state, "none");
    advance(j, "dry_passed");
    grantArm(j, { attested: true, typed: j.slug });
    const p = notifyProofLost(j, { detail: "dry report gone" });
    assert.equal(p.disarmed, true);
    assert.equal(j.stage, "dry_running");
  });

  it("assessRestart disarms on artifact/fingerprint/proof loss; records early issues", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    const r = assessRestart(j, { artifactsOk: false });
    assert.equal(r.disarmed, true);
    assert.deepEqual(r.reasons, ["artifact-missing"]);
    assert.equal(j.stage, "dry_running");
    assert.equal(j.arm.state, "none");
    const e2 = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(e2, "probing");
    const r2 = assessRestart(e2, { proofsOk: false });
    assert.equal(r2.disarmed, false);
    assert.equal(e2.stage, "probing");
    const ok = assessRestart(e2, {});
    assert.equal(ok.disarmed, false);
    assert.deepEqual(ok.reasons, []);
  });
});

describe("P2 stage policy table", () => {
  it("encodes the locked policy + unclassified blocking default", () => {
    assert.equal(evaluateStageResult("scraping", "image-error").disposition, "allow");
    assert.equal(evaluateStageResult("scraping", "image-failed").disposition, "allow");
    assert.equal(evaluateStageResult("probing", "stage-error").disposition, "block");
    assert.equal(evaluateStageResult("finalizing", "stage-error").disposition, "block");
    assert.equal(evaluateStageResult("detecting_backend", "stage-error").disposition, "block");
    assert.equal(evaluateStageResult("dry_running", "guard-red").disposition, "block");
    assert.equal(evaluateStageResult("dry_running", "row-failed").disposition, "block");
    assert.equal(evaluateStageResult("dry_running", "dry-partial").disposition, "amber");
    assert.equal(evaluateStageResult("uploading", "row-failed").disposition, "block");
    assert.equal(evaluateStageResult("uploading", "guard-regression").disposition, "block");
    assert.equal(evaluateStageResult("scraping", "something-new").disposition, "block");
    assert.equal(evaluateStageResult("nope-stage", "ok").disposition, "block");
    assert.ok(STAGE_POLICY.dry_running && STAGE_POLICY.uploading);
  });

  it("applyStageResult: dry-partial amber stays with ledger; upload block fails truthfully", () => {
    const d = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryPassed(d);
    retry(d, { to: "dry_running" });
    const r = applyStageResult(d, { outcome: "dry-partial", detail: "1 skipped" });
    assert.equal(r.disposition, "amber");
    assert.equal(d.stage, "dry_running");
    assert.ok(d.ledger.some((e) => e.kind === "stage:amber"));
    const u = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(u);
    beginUpload(u);
    const b = applyStageResult(u, { outcome: "row-failed", detail: "row 3" });
    assert.equal(b.disposition, "block");
    assert.equal(u.stage, "failed");
    assert.equal(u.arm.state, "none");
    assert.ok(u.save_run_id, "written rows truthfully keep save_run_id");
  });
});

describe("P2 cancel + upload semantics", () => {
  it("non-upload cancel needs prompt; idempotent; retains proofs", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    advance(j, "probing");
    assert.throws(() => requestCancel(j, {}), /prompt/);
    j.snapshot_id = computeSnapshotId(snapFixture());
    j.dry_run_id = newDryRunId();
    requestCancel(j, { prompted: true, reason: "user" });
    assert.equal(j.stage, "cancelled");
    assert.equal(j.snapshot_id != null, true);
    assert.equal(j.dry_run_id != null, true);
    const ledgerN = j.ledger.length;
    requestCancel(j, { prompted: true });
    assert.equal(j.ledger.length, ledgerN, "second cancel is a no-op");
  });

  it("upload stop_requested finishes current row then cancels; consumes arm", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    beginUpload(j);
    assert.equal(j.arm.state, "none", "real-upload attempt consumes arm on entry");
    const saveId = j.save_run_id;
    requestCancel(j, { reason: "user stop" });
    assert.equal(j.stage, "uploading");
    assert.equal(j.stopRequested, true);
    assert.ok(j.ledger.some((e) => e.kind === "upload:stop_requested"));
    requestCancel(j, {});
    assert.equal(j.stopRequested, true, "repeated cancel idempotent");
    finishUploadRowAndCancel(j, { reason: "row done" });
    assert.equal(j.stage, "cancelled");
    assert.equal(j.save_run_id, saveId, "proofs retained");
    assert.equal(j.arm.state, "none");
    finishUploadRowAndCancel(j, {});
    assert.equal(j.stage, "cancelled");
  });

  it("finishUploadRowAndCancel without stop_requested throws; finishUpload blocked when stopping", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    beginUpload(j);
    assert.throws(() => finishUploadRowAndCancel(j, {}), /stop_requested/);
    requestCancel(j, {});
    assert.throws(() => finishUpload(j, {}), /stop requested/);
  });

  it("beginUpload single-use: needs live arm, second attempt refused", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryPassed(j);
    assert.throws(() => beginUpload(j, {}), /armed/);
    grantArm(j, { attested: true, typed: j.slug });
    beginUpload(j);
    assert.throws(() => beginUpload(j, {}), /armed/);
  });

  it("failed/cancelled consume arm; done never reopens", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(j);
    failJob(j, { reason: "probe wall" });
    assert.equal(j.stage, "failed");
    assert.equal(j.arm.state, "none");
    assert.throws(() => advance(j, "probing"), /never reopen|illegal/);
    const d = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToArmed(d);
    beginUpload(d);
    finishUpload(d);
    assert.equal(d.stage, "done");
    assert.equal(isTerminal("done"), false, "done is spine end, not in TERMINALS");
    assert.throws(() => advance(d, "probing"), /never reopen|illegal/);
    assert.throws(() => retry(d, { to: "probing" }), /new Job/);
    assert.throws(() => requestCancel(d, { prompted: true }), /terminal/);
    // same source rerun = new Job with distinct id
    const rerun = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.notEqual(rerun.jobId, d.jobId);
    assert.equal(rerun.stage, "idle");
  });
});

describe("P2 single-flight v1", () => {
  it("one active engine op globally; same job re-claims; release frees", () => {
    assert.equal(currentEngineOp(), null);
    claimEngineOp("job-a", "scraping");
    assert.equal(currentEngineOp().jobId, "job-a");
    assert.throws(() => claimEngineOp("job-b", "uploading"), (e) => e.code === "single-flight");
    claimEngineOp("job-a", "scraping");
    assert.equal(currentEngineOp().jobId, "job-a");
    releaseEngineOp("job-a");
    assert.equal(currentEngineOp(), null);
    claimEngineOp("job-b", "uploading");
    assert.equal(currentEngineOp().jobId, "job-b");
    releaseEngineOp();
    assert.equal(currentEngineOp(), null);
  });
});

describe("P2 artifacts + ledger", () => {
  it("addArtifact records pointer-only entry + ledger", () => {
    const j = createJob({ slug: "s", source: "https://a.go.th/x" });
    addArtifact(j, { kind: "dry-report", relPath: "reports/d.json", sha256: "ff", byteLength: 10 });
    assert.equal(j.artifacts.length, 1);
    assert.equal(j.artifacts[0].kind, "dry-report");
    assert.ok(j.ledger.some((e) => e.kind === "artifact:written"));
    assert.throws(() => addArtifact(j, { kind: "" }), /kind/);
  });
});
