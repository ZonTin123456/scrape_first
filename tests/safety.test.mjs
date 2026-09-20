// tests/safety.test.mjs — P6 Safety UI + upload G1/G2 trinity.
// Run: node --test tests/safety.test.mjs
// G1/G2 enforced in UI adapter (server commands + safety model) AND CLI
// (upload-people --dry-proof/--save gates). Proofs immutable sha256, save
// references prerequisite dry. 5 walkthroughs pass through this module.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJob,
  writeJob,
  readJob,
  advance,
  grantArm,
  beginUpload,
  finishUpload,
  raiseBlocker,
  clearBlocker,
  retry,
  computeSnapshotId,
  notifyGuardRegression,
} from "../jobs/store.mjs";
import { createHub } from "../jobs/events.mjs";
import { createCommandStore } from "../jobs/commands.mjs";
import {
  MODES,
  VISIBILITY_SECTIONS,
  attestationText,
  evaluateRowPolicy,
  checkGate1,
  checkGate2,
  proofShotCount,
  sha256Hex,
  dryReportPathFor,
  saveReportPathFor,
  recordDryPass,
  readDryReport,
  verifyDryReport,
  beginUploadWithProof,
  grantArmFromSafety,
  buildSafetyBundle,
  safetyModel,
} from "../jobs/safety.mjs";
import { startServer } from "../server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p6-safety-"));
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

function driveToDryRunning(job) {
  for (const s of ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"]) {
    advance(job, s);
  }
  return job;
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

function dryPass(outDir, job, over = {}) {
  return recordDryPass(outDir, job, greenDryPayload(over));
}

describe("P6 attestation exact copy + G2 triple", () => {
  it("template pins exact wording with dry id, shot count, snapshot", () => {
    assert.equal(
      attestationText({ dryRunId: "dry_abc", shotCount: 3, snapshotId: "snap_0123456789abcdef" }),
      "I reviewed dry report dry_abc and all 3 screenshots for snapshot snap_0123456789abcdef"
    );
    assert.throws(() => attestationText({ shotCount: 1, snapshotId: "s" }), /dryRunId/);
  });

  it("G2 needs exact copy + typed slug + click, all mandatory", () => {
    const exp = attestationText({ dryRunId: "dry_x", shotCount: 0, snapshotId: "snap_1" });
    assert.equal(checkGate2({ attestedText: exp, expectedAttestation: exp, typed: "s", slug: "s", clicked: true }).ok, true);
    assert.match(checkGate2({ attestedText: exp + " ", expectedAttestation: exp, typed: "s", slug: "s", clicked: true }).reasons.join(" "), /attestation/);
    assert.match(checkGate2({ attestedText: exp, expectedAttestation: exp, typed: "wrong", slug: "s", clicked: true }).reasons.join(" "), /typed slug/);
    assert.match(checkGate2({ attestedText: exp, expectedAttestation: exp, typed: "s", slug: "s", clicked: false }).reasons.join(" "), /click/);
    assert.equal(checkGate2({ attestedText: null, expectedAttestation: exp, typed: "s", slug: "s", clicked: true }).ok, false);
    assert.match(checkGate2({ attestedText: null, expectedAttestation: null, typed: "s", slug: "s", clicked: true }).reasons.join(" "), /G1 must pass first/);
  });
});

describe("P6 row policy (failed blocks; pinned vs zero-map; amber partial)", () => {
  const row = (seq, status) => ({ seq, status });

  it("any failed row blocks", () => {
    const r = evaluateRowPolicy([row(1, "dry"), row(2, "failed")], { mapMode: "pinned" });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(" "), /row-failed.*seq 2/);
    assert.equal(r.counts.failed, 1);
  });

  it("pinned-map would-create/unresolved block", () => {
    const w = evaluateRowPolicy([row(1, "skip-would-create")], { mapMode: "pinned" });
    assert.equal(w.ok, false);
    assert.match(w.reasons.join(" "), /pinned-would-create/);
    const u = evaluateRowPolicy([row(1, "unresolved")], { mapMode: "pinned" });
    assert.equal(u.ok, false);
    assert.match(u.reasons.join(" "), /unresolved/);
    const listed = evaluateRowPolicy([row(1, "dry")], { mapMode: "pinned", wouldCreate: ["g-new"] });
    assert.equal(listed.ok, false);
    assert.match(listed.reasons.join(" "), /pinned-would-create/);
  });

  it("zero-map would-create is a listed path: needs rediscover + re-gate + identity verify", () => {
    const bare = evaluateRowPolicy([row(1, "skip-would-create")], { mapMode: "zero" });
    assert.equal(bare.ok, false);
    assert.match(bare.reasons.join(" "), /zero-would-create-unverified/);
    assert.match(bare.reasons.join(" "), /rediscovered/);
    const part = evaluateRowPolicy([row(1, "skip-would-create")], {
      mapMode: "zero",
      listedPath: { rediscovered: true, regated: true, identityVerified: false },
    });
    assert.equal(part.ok, false);
    const full = evaluateRowPolicy([row(1, "skip-would-create")], {
      mapMode: "zero",
      listedPath: { rediscovered: true, regated: true, identityVerified: true },
    });
    assert.equal(full.ok, true);
    assert.match(full.warnings.join(" "), /listed-path/);
  });

  it("dry-partial amber allowed with warnings; clean rows pass", () => {
    const a = evaluateRowPolicy([row(1, "dry"), row(2, "dry-partial")], { mapMode: "pinned" });
    assert.equal(a.ok, true);
    assert.match(a.warnings.join(" "), /dry-partial amber/);
    assert.equal(a.counts.partial, 1);
    assert.equal(evaluateRowPolicy([row(1, "dry")], { mapMode: "pinned" }).ok, true);
  });
});

describe("P6 G1 (all-green + fresh dry same snapshot)", () => {
  it("green when snapshot fresh, proof verified, rows/guards green", () => {
    const job = createJob({ slug: "s", source: "https://a.go.th/x" });
    job.snapshot_id = "snap_1";
    job.dry_run_id = "dry_1";
    const g = checkGate1(job, {
      rows: [{ seq: 1, status: "dry" }],
      dryVerified: true,
      snapshotFresh: true,
    });
    assert.equal(g.ok, true);
    assert.equal(g.code, "green");
    assert.ok(g.attestation.startsWith("I reviewed dry report dry_1"));
  });

  it("red on stale snapshot, missing proof, guard red, failed rows", () => {
    const job = createJob({ slug: "s", source: "https://a.go.th/x" });
    job.snapshot_id = "snap_1";
    job.dry_run_id = "dry_1";
    const stale = checkGate1(job, { rows: [{ seq: 1, status: "dry" }], dryVerified: true, snapshotFresh: false });
    assert.equal(stale.ok, false);
    assert.match(stale.reasons.join(" "), /stale/);
    const noproof = checkGate1(job, { rows: [{ seq: 1, status: "dry" }], dryVerified: false, snapshotFresh: true });
    assert.equal(noproof.ok, false);
    assert.match(noproof.reasons.join(" "), /dry proof/);
    const guard = checkGate1(job, { rows: [{ seq: 1, status: "dry" }], dryVerified: true, snapshotFresh: true, guardStatus: "red" });
    assert.equal(guard.ok, false);
    assert.match(guard.reasons.join(" "), /guard red/);
    const rows = checkGate1(job, { rows: [{ seq: 1, status: "failed" }], dryVerified: true, snapshotFresh: true });
    assert.equal(rows.ok, false);
    assert.match(rows.reasons.join(" "), /row-failed/);
  });
});

describe("P6 proofs: immutable dry/save with sha256, save references dry", () => {
  it("recordDryPass writes immutable report, registers sha256 artifacts, advances", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "dry-1" });
    driveToDryRunning(job);
    const r = dryPass(out, job);
    assert.match(r.dryRunId, /^dry_/);
    assert.equal(job.stage, "dry_passed");
    assert.equal(job.dry_run_id, r.dryRunId);
    const art = job.artifacts.find((a) => a.kind === "dry-report");
    assert.equal(art.sha256, r.sha256);
    assert.equal(art.byteLength, r.byteLength);
    assert.ok(r.attestation.includes(r.dryRunId));
    const shot = job.artifacts.find((a) => a.kind === "shot");
    assert.ok(shot.sha256, "shots carry sha256");
    assert.equal(proofShotCount(job), 1, "attestation shot count from proof artifacts");
    // file bytes hash == registered sha256
    const raw = readFileSync(dryReportPathFor(out, "s", "dry-1", r.dryRunId));
    assert.equal(sha256Hex(raw), r.sha256);
  });

  it("G1-red dry fails closed: stays dry_running, gate:failed ledger", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "dry-2" });
    driveToDryRunning(job);
    assert.throws(
      () => recordDryPass(out, job, greenDryPayload({ rows: [{ seq: 1, status: "failed" }] })),
      (e) => e.code === "gate1-failed"
    );
    assert.equal(job.stage, "dry_running");
    assert.ok(job.ledger.some((e) => e.kind === "gate:failed"));
    assert.throws(
      () => recordDryPass(out, job, greenDryPayload({ guardStatus: "red" })),
      (e) => e.code === "gate1-failed"
    );
  });

  it("recordDryPass requires dry_running stage + snapshot", () => {
    const out = tmpOut();
    const early = createJob({ slug: "s", source: "https://a.go.th/x" });
    assert.throws(() => dryPass(out, early), (e) => e.code === "bad-stage");
    const job = createJob({ slug: "s", source: "https://a.go.th/x" });
    driveToDryRunning(job);
    assert.throws(() => recordDryPass(out, job, { rows: [] }), (e) => e.code === "missing-snapshot");
  });

  it("verifyDryReport fails closed on drift; save references prerequisite dry", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "dry-3" });
    driveToDryRunning(job);
    const r = dryPass(out, job);
    const v = verifyDryReport(out, job);
    assert.equal(v.ok, true);
    assert.equal(v.sha256, r.sha256);
    // snapshot drift invalidates
    const stale = verifyDryReport(out, job, { expectedSnapshotId: "snap_other00000001" });
    assert.equal(stale.ok, false);
    assert.match(stale.reasons.join(" "), /re-dry/);
    // proof file loss fails closed
    const gone = verifyDryReport(out, job, { expectedDryRunId: "dry_missing0000" });
    assert.equal(gone.ok, false);
  });

  it("save proof immutable + references dry; missing dry refuses", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "save-1" });
    driveToDryRunning(job);
    const d = dryPass(out, job);
    grantArmFromSafety(out, job, { attestedText: d.attestation, typed: "s", clicked: true });
    const s = beginUploadWithProof(out, job, {});
    assert.equal(job.stage, "uploading");
    assert.equal(job.arm.state, "none", "any real-upload attempt consumes the arm");
    const saved = JSON.parse(readFileSync(saveReportPathFor(out, "s", "save-1", s.saveRunId), "utf8"));
    assert.equal(saved.dry_run_id, d.dryRunId, "save references prerequisite dry");
    assert.equal(saved.dry_report_sha256, d.sha256);
    const art = job.artifacts.find((a) => a.kind === "save-report");
    assert.equal(art.sha256, s.sha256);
    // second attempt refused: arm single-use, no overwrite path through API
    assert.throws(() => beginUploadWithProof(out, job, { saveRunId: s.saveRunId }), /armed/);
    // no-dry job refuses save fail-closed
    const bare = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "save-2" });
    driveToDryRunning(bare);
    assert.throws(() => beginUploadWithProof(out, bare, {}), (e) => e.code === "missing-proof");
  });

  it("proof files never overwrite: source pins immutability", () => {
    const sz = src("jobs/safety.mjs");
    assert.ok(sz.includes("proof immutable"), "missing pin: proof immutable");
    assert.ok(sz.includes("never overwrite"), "missing pin: never overwrite");
    assert.ok(sz.includes("proof-exists"), "missing pin: proof-exists");
  });
});

describe("P6 visibility bundle undroppable", () => {
  it("all 10 sections present; missing key throws", () => {
    assert.deepEqual(VISIBILITY_SECTIONS.length, 10);
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "g" });
    const b = buildSafetyBundle(job, {
      destinationOrigin: "https://beacon/x",
      targetDepts: ["g"],
      wouldCreate: [],
      identity: { verified: true },
      unmapped: ["phone"],
      rows: [{ seq: 1, name: "A", group: "g", target: "t", status: "dry", detail: null }],
      proofs: [{ kind: "dry-report", relPath: "jobs/x/dry.json", sha256: "ff", byteLength: 3 }],
    });
    for (const k of VISIBILITY_SECTIONS) assert.ok(b[k] !== undefined, `drops ${k}`);
    assert.equal(b.counts.total, 1);
    assert.equal(b.counts.unmapped, 1);
    assert.throws(() => buildSafetyBundle(job, {}), (e) => e.code === "bundle-incomplete");
  });

  it("safetyModel: pending before dry, full bundle + G1 after", () => {
    const out = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "g", jobId: "mod-1" });
    driveToDryRunning(job);
    writeJob(out, job);
    const before = safetyModel(out, job);
    assert.equal(before.available, false);
    assert.deepEqual(before.pending, VISIBILITY_SECTIONS);
    assert.equal(before.gate1.ok, false);
    assert.equal(before.gate2.required.length, 3);
    dryPass(out, job);
    writeJob(out, job);
    const after = safetyModel(out, job);
    assert.equal(after.available, true);
    assert.equal(after.gate1.ok, true);
    assert.ok(after.gate2.attestation.startsWith("I reviewed dry report"));
    for (const k of VISIBILITY_SECTIONS) assert.ok(after.bundle[k] !== undefined, `drops ${k}`);
  });
});

describe("P6 commands: dry/arm/begin-upload via POST shape + idempotent replay", () => {
  function appJob(out, jobId = "cmd-1") {
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    return job;
  }

  it("dry enforces G1, arm enforces G2, replay never executes twice", () => {
    const out = tmpOut();
    appJob(out);
    const hub = createHub();
    const seen = [];
    const unsub = hub.subscribe("cmd-1", (e) => seen.push(e.type));
    const store = createCommandStore({ hub });
    const payload = greenDryPayload();
    const d1 = store.execute({ outDir: out, jobId: "cmd-1", commandId: "c-dry", type: "dry", payload });
    assert.equal(d1.accepted, true);
    assert.equal(d1.reason, "dry-recorded");
    const d1r = store.execute({ outDir: out, jobId: "cmd-1", commandId: "c-dry", type: "dry", payload });
    assert.deepEqual(d1r, d1, "replay returns original disposition");
    let job = readJob(out, "s", "cmd-1");
    assert.equal(job.stage, "dry_passed");
    assert.ok(seen.includes("artifact:written"));
    // arm with wrong copy refuses
    const bad = store.execute({ outDir: out, jobId: "cmd-1", commandId: "c-arm-bad", type: "arm", payload: { attestedText: "nope", typed: "s", clicked: true } });
    assert.equal(bad.accepted, false);
    assert.equal(bad.reason, "g2-required");
    assert.ok(seen.includes("gate:failed"));
    // arm exact
    const model = safetyModel(out, readJob(out, "s", "cmd-1"));
    const a1 = store.execute({
      outDir: out, jobId: "cmd-1", commandId: "c-arm", type: "arm",
      payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true },
    });
    assert.equal(a1.accepted, true);
    const a1r = store.execute({
      outDir: out, jobId: "cmd-1", commandId: "c-arm", type: "arm",
      payload: { attestedText: "tampered", typed: "evil", clicked: true },
    });
    assert.deepEqual(a1r, a1, "tampered replay still returns original");
    job = readJob(out, "s", "cmd-1");
    assert.equal(job.stage, "armed");
    // begin-upload consumes single-use arm + writes save proof
    const u1 = store.execute({ outDir: out, jobId: "cmd-1", commandId: "c-up", type: "begin-upload", payload: {} });
    assert.equal(u1.accepted, true);
    const u1r = store.execute({ outDir: out, jobId: "cmd-1", commandId: "c-up", type: "begin-upload", payload: {} });
    assert.deepEqual(u1r, u1);
    job = readJob(out, "s", "cmd-1");
    assert.equal(job.stage, "uploading");
    assert.equal(job.arm.state, "none");
    assert.ok((job.artifacts || []).some((a) => a.kind === "save-report"));
    unsub();
  });

  it("dry on unknown job fails job-not-found (no phantom execution)", () => {
    const out = tmpOut();
    const store = createCommandStore({});
    const d = store.execute({
      outDir: out, jobId: "missing-job", commandId: "c-x", type: "dry", payload: greenDryPayload(),
    });
    assert.equal(d.accepted, false);
    assert.equal(d.reason, "job-not-found");
  });

  it("dry with failed rows rejected fail-closed via command (stays dry_running)", () => {
    const out = tmpOut();
    appJob(out, "cmd-2");
    const store = createCommandStore({});
    const d = store.execute({
      outDir: out, jobId: "cmd-2", commandId: "c-dry-red", type: "dry",
      payload: greenDryPayload({ rows: [{ seq: 1, status: "failed" }] }),
    });
    assert.equal(d.accepted, false);
    assert.equal(d.reason, "gate1-failed");
    assert.equal(readJob(out, "s", "cmd-2").stage, "dry_running");
  });
});

describe("P6 server: GET safety + command flow over HTTP", () => {
  let app;
  let out;
  before(async () => {
    out = tmpOut();
    app = await startServer({ outDir: out, port: 0 });
  });
  after(async () => {
    await app.close();
  });

  async function postCmd(jobId, commandId, type, payload = {}) {
    const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return r.json();
  }

  it("safety endpoint: pending bundle before dry, full trinity after", async () => {
    const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "http-1" });
    driveToDryRunning(job);
    writeJob(out, job);
    let r = await fetch(`${app.url}/jobs/http-1/safety`);
    assert.equal(r.status, 200);
    let m = await r.json();
    assert.equal(m.available, false);
    assert.equal(m.pending.length, 10);
    assert.equal(m.gate1.ok, false);
    const d = await postCmd("http-1", "h-dry", "dry", greenDryPayload());
    assert.equal(d.accepted, true);
    r = await fetch(`${app.url}/jobs/http-1/safety`);
    m = await r.json();
    assert.equal(m.available, true);
    for (const k of VISIBILITY_SECTIONS) assert.ok(m.bundle[k] !== undefined, `drops ${k}`);
    assert.equal(m.bundle.rows.length, 1);
    assert.equal(m.gate1.ok, true);
    assert.ok(m.gate2.attestation.includes("I reviewed dry report"));
    assert.equal(m.bundle.proofs.length >= 2, true, "dry report + shot proofs listed");
    // unknown job 404s
    const nf = await fetch(`${app.url}/jobs/nope/safety`);
    assert.equal(nf.status, 404);
  });

  it("arm + upload over HTTP with G1/G2 enforcement + no double arm", async () => {
    const job = createJob({ slug: "exact", source: "https://a.go.th/x", group: "a", jobId: "http-2" });
    driveToDryRunning(job);
    writeJob(out, job);
    const m0 = await (await fetch(`${app.url}/jobs/http-2/safety`)).json();
    // G2 before G1 refuses (bad-stage: not dry_passed yet)
    const early = await postCmd("http-2", "h-arm-early", "arm", { attestedText: "x", typed: "exact", clicked: true });
    assert.equal(early.accepted, false);
    assert.equal(m0.gate1.ok, false);
    await postCmd("http-2", "h-dry", "dry", greenDryPayload());
    const m1 = await (await fetch(`${app.url}/jobs/http-2/safety`)).json();
    const wrong = await postCmd("http-2", "h-arm-wrong", "arm", { attestedText: "almost", typed: "exact", clicked: true });
    assert.equal(wrong.accepted, false);
    const ok = await postCmd("http-2", "h-arm", "arm", { attestedText: m1.gate2.attestation, typed: "exact", clicked: true });
    assert.equal(ok.accepted, true);
    const up = await postCmd("http-2", "h-up", "begin-upload", {});
    assert.equal(up.accepted, true);
    // replay same commandIds: original dispositions, no second execution
    const upR = await postCmd("http-2", "h-up", "begin-upload", {});
    assert.deepEqual(upR, up);
    const g = await (await fetch(`${app.url}/jobs/http-2`)).json();
    assert.equal(g.job.stage, "uploading");
  });
});

describe("P6 CLI parity pins (--save/--i-verified/--yes + dry proof fail-closed)", () => {
  it("upload-people gates: dry-proof required, --yes never bypasses, typed slug", () => {
    const up = src("uploader/upload-people.mjs");
    assert.ok(up.includes("refusing --save without --map (reviewed) or --i-verified"), "keep --i-verified gate");
    assert.ok(up.includes("refusing --save without --dry-proof"), "missing pin: --dry-proof required");
    assert.ok(up.includes("--yes never bypasses"), "missing pin: --yes never bypasses");
    assert.ok(up.includes("--yes: non-interactive confirm"), "missing pin: --yes confirm-only");
    assert.ok(up.includes("dry proof verified"), "missing pin: dry proof verified");
    assert.ok(up.includes("dry proof slug"), "missing pin: dry proof slug match");
    assert.ok(up.includes("dry proof has failed rows"), "missing pin: failed-row policy");
    assert.ok(up.includes("safety summary (REAL upload)"), "missing pin: safety summary");
    assert.ok(up.includes("type exact slug"), "missing pin: typed slug");
    assert.ok(up.includes("typed slug mismatch"), "missing pin: typed slug mismatch");
  });

  it("pipeline passes --dry-proof/--yes through to upload step", () => {
    const pl = src("pipeline.mjs");
    assert.ok(pl.includes('"--dry-proof"'), "missing pin: --dry-proof passthrough");
    assert.ok(pl.includes('--yes') || pl.includes('"--yes"'), "missing pin: --yes passthrough");
  });
});

describe("P6 walkthroughs (happy, CF-preserves-arm, dry-partial amber, guard-red blocks, arm single-use)", () => {
  function freshJob(out, jobId, slug = "s") {
    const job = createJob({ slug, source: "https://a.go.th/x", group: "a", jobId });
    driveToDryRunning(job);
    writeJob(out, job);
    return job;
  }

  it("W1 happy: dry -> arm (exact copy + typed slug + click) -> upload -> done, save refs dry", () => {
    const out = tmpOut();
    freshJob(out, "w1");
    const store = createCommandStore({});
    assert.equal(store.execute({ outDir: out, jobId: "w1", commandId: "w1-dry", type: "dry", payload: greenDryPayload() }).accepted, true);
    let job = readJob(out, "s", "w1");
    const model = safetyModel(out, job);
    assert.equal(model.gate1.ok, true);
    assert.equal(model.available, true);
    assert.equal(
      store.execute({ outDir: out, jobId: "w1", commandId: "w1-arm", type: "arm", payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true } }).accepted,
      true
    );
    assert.equal(store.execute({ outDir: out, jobId: "w1", commandId: "w1-up", type: "begin-upload", payload: {} }).accepted, true);
    job = readJob(out, "s", "w1");
    const save = job.artifacts.find((a) => a.kind === "save-report");
    const dry = job.artifacts.find((a) => a.kind === "dry-report");
    assert.ok(save && dry);
    finishUpload(job);
    writeJob(out, job);
    assert.equal(readJob(out, "s", "w1").stage, "done");
  });

  it("W2 CF-preserves-arm: blocker raised while armed keeps arm when proofs validate", () => {
    const out = tmpOut();
    freshJob(out, "w2");
    const store = createCommandStore({});
    store.execute({ outDir: out, jobId: "w2", commandId: "w2-dry", type: "dry", payload: greenDryPayload() });
    let job = readJob(out, "s", "w2");
    const model = safetyModel(out, job);
    store.execute({ outDir: out, jobId: "w2", commandId: "w2-arm", type: "arm", payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true } });
    job = readJob(out, "s", "w2");
    raiseBlocker(job, { type: "cloudflare", ctx: "turnstile" });
    writeJob(out, job);
    job = readJob(out, "s", "w2");
    assert.equal(job.arm.state, "armed", "CF alone preserves arm");
    clearBlocker(job, "cloudflare");
    writeJob(out, job);
    assert.equal(store.execute({ outDir: out, jobId: "w2", commandId: "w2-up", type: "begin-upload", payload: {} }).accepted, true);
    assert.equal(readJob(out, "s", "w2").stage, "uploading");
  });

  it("W3 dry-partial amber: partial rows allowed with ledger warnings", () => {
    const out = tmpOut();
    freshJob(out, "w3");
    const store = createCommandStore({});
    const payload = greenDryPayload({ rows: [
      { seq: 1, name: "A", group: "a", target: "t", status: "dry" },
      { seq: 2, name: null, group: "a", target: "t", status: "dry-partial" },
    ] });
    assert.equal(store.execute({ outDir: out, jobId: "w3", commandId: "w3-dry", type: "dry", payload }).accepted, true);
    const job = readJob(out, "s", "w3");
    assert.ok(job.ledger.some((e) => e.kind === "stage:amber"), "amber ledger warning recorded");
    assert.equal(safetyModel(out, job).gate1.ok, true);
  });

  it("W4 guard-red blocks: red dry refused, regression disarms armed job", () => {
    const out = tmpOut();
    freshJob(out, "w4");
    const store = createCommandStore({});
    const red = store.execute({ outDir: out, jobId: "w4", commandId: "w4-dry-red", type: "dry", payload: greenDryPayload({ guardStatus: "red" }) });
    assert.equal(red.accepted, false);
    assert.equal(red.reason, "gate1-failed");
    assert.equal(readJob(out, "s", "w4").stage, "dry_running");
    // green dry -> arm -> guard regression disarms to dry_running
    store.execute({ outDir: out, jobId: "w4", commandId: "w4-dry", type: "dry", payload: greenDryPayload() });
    let job = readJob(out, "s", "w4");
    const model = safetyModel(out, job);
    store.execute({ outDir: out, jobId: "w4", commandId: "w4-arm", type: "arm", payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true } });
    job = readJob(out, "s", "w4");
    assert.equal(job.stage, "armed");
    notifyGuardRegression(job, { detail: "fields unsatisfy" });
    writeJob(out, job);
    job = readJob(out, "s", "w4");
    assert.equal(job.stage, "dry_running");
    assert.equal(job.arm.state, "none");
  });

  it("W5 arm single-use: second upload refused, retry retreat consumes arm", () => {
    const out = tmpOut();
    freshJob(out, "w5");
    const store = createCommandStore({});
    store.execute({ outDir: out, jobId: "w5", commandId: "w5-dry", type: "dry", payload: greenDryPayload() });
    let job = readJob(out, "s", "w5");
    const model = safetyModel(out, job);
    store.execute({ outDir: out, jobId: "w5", commandId: "w5-arm", type: "arm", payload: { attestedText: model.gate2.attestation, typed: "s", clicked: true } });
    assert.equal(store.execute({ outDir: out, jobId: "w5", commandId: "w5-up1", type: "begin-upload", payload: {} }).accepted, true);
    const second = store.execute({ outDir: out, jobId: "w5", commandId: "w5-up2", type: "begin-upload", payload: {} });
    assert.equal(second.accepted, false, "arm single-use: second attempt refused");
    job = readJob(out, "s", "w5");
    assert.equal(job.stage, "uploading");
    // retreat path consumes arm too (fresh armed job retreating to dry_running)
    freshJob(out, "w5b");
    const j2 = readJob(out, "s", "w5b");
    const dd = dryPass(out, j2);
    writeJob(out, j2);
    grantArmFromSafety(out, j2, { attestedText: dd.attestation, typed: "s", clicked: true });
    assert.equal(j2.arm.state, "armed");
    beginUpload(j2, {});
    assert.equal(j2.arm.state, "none", "real-upload attempt consumes arm");
    assert.throws(() => beginUpload(j2, {}), /armed/, "second attempt refused");
    freshJob(out, "w5c");
    const j3 = readJob(out, "s", "w5c");
    const dd3 = dryPass(out, j3);
    writeJob(out, j3);
    grantArmFromSafety(out, j3, { attestedText: dd3.attestation, typed: "s", clicked: true });
    retry(j3, { to: "dry_running", reason: "re-dry" });
    assert.equal(j3.arm.state, "none");
    assert.equal(j3.stage, "dry_running");
  });
});

describe("P6 trinity modes + danger-zone screen contract pins", () => {
  it("web client carries discover/dry/real screens, fenced danger zone, auto-pin", () => {
    const html = src("web/index.html");
    assert.ok(html.includes("DISCOVER — inspect only"), "missing pin: discover screen");
    assert.ok(html.includes("DRY — fill + screenshot, never save"), "missing pin: dry screen");
    assert.ok(html.includes("REAL — danger zone"), "missing pin: real danger zone");
    assert.ok(html.includes("danger zone (red fence)"), "missing pin: fenced red zone");
    assert.ok(html.includes("auto-pinned at"), "missing pin: context auto-pin");
    assert.ok(html.includes("drawer allowed only before dry_running"), "missing pin: drawer rule");
    assert.ok(html.includes("I reviewed dry report") || html.includes("attestation"), "missing pin: attestation UI");
    assert.ok(html.includes("PASS: Gate 1 green") && html.includes("BLOCKED: Gate 1 red"), "missing pin: G1 text status");
    assert.ok(html.includes("MODES") || html.includes("MODE "), "missing pin: mode+stage pill");
  });

  it("modes frozen: discover/dry/real trinity", () => {
    assert.deepEqual(MODES, ["discover", "dry", "real"]);
  });
});
