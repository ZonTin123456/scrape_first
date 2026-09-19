// tests/pipeline.test.mjs — P7 Pipeline DAG as job ops.
// Run: node --test tests/pipeline.test.mjs
// DAG steps run in-process as job ops with approval events (no spawnSync,
// no stdin pause on the UI path). CLI flags select the same steps over the
// same DAG with unchanged file outputs; staging files stay the step contract;
// autoApprove maps old --yes without bypassing safety prerequisites.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, writeJob, readJob, advance } from "../jobs/store.mjs";
import { createHub } from "../jobs/events.mjs";
import { attestationText } from "../jobs/safety.mjs";
import {
  ALL,
  HUMAN_STEPS,
  STEP_STAGES,
  STAGING_CONTRACT,
  describePipeline,
  parseSteps,
  orderSubs,
  peopleCountFor,
  buildUploadQueue,
  runPipelineAsJobOps,
} from "../jobs/pipeline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p7-pipeline-"));
}

function newJob(outDir, over = {}) {
  const job = createJob({ slug: "s1", source: "https://a.go.th/x", group: "a", ...over });
  writeJob(outDir, job);
  return job;
}

function collectEvents(hub, jobId) {
  const seen = [];
  hub.subscribe(jobId, (env) => seen.push(env));
  return seen;
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

// Staging fixtures for one slug dir (absolute), mirroring the file contract.
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

describe("P7 DAG parity with pipeline.mjs CLI", () => {
  it("step order pinned and shared with the CLI adapter", () => {
    const pl = src("pipeline.mjs");
    assert.ok(
      pl.includes('"probe", "pick-links", "master", "apply-master", "run", "pick-images", "finalize", "upload"'),
      "CLI step list pin"
    );
    assert.deepEqual(ALL, ["probe", "pick-links", "master", "apply-master", "run", "pick-images", "finalize", "upload"]);
  });

  it("parseSteps defaults to all, trims, rejects unknown fail-closed", () => {
    assert.deepEqual(parseSteps(null), ALL);
    assert.deepEqual(parseSteps("probe,run"), ["probe", "run"]);
    assert.deepEqual(parseSteps("  run , finalize "), ["run", "finalize"]);
    assert.throws(() => parseSteps("probe,bogus"), (e) => e.code === "unknown-step");
  });

  it("orderSubs fans out like --order (slug then url, first-match wins)", () => {
    const subs = [
      { slug: "alpha", url: "https://a.go.th/alpha" },
      { slug: "beta", url: "https://a.go.th/beta" },
      { slug: "gamma", url: "https://a.go.th/gamma" },
    ];
    assert.deepEqual(orderSubs(subs, "beta").map((r) => r.slug), ["beta", "alpha", "gamma"]);
    assert.deepEqual(orderSubs(subs, "gamma,alpha").map((r) => r.slug), ["gamma", "alpha", "beta"]);
    // url fallback + unmatched tokens warn without reordering the rest
    const warns = [];
    const out = orderSubs(subs, "go.th/beta,nothing", { onWarn: (t) => warns.push(t) });
    assert.deepEqual(out.map((r) => r.slug), ["beta", "alpha", "gamma"]);
    assert.deepEqual(warns, ["nothing"]);
    assert.deepEqual(orderSubs(subs, ""), subs);
  });

  it("UI path bans spawned subprocesses and stdin pauses (static)", () => {
    const jl = src("jobs/pipeline.mjs");
    assert.ok(!jl.includes("spawnSync"), "no spawnSync on UI path");
    assert.ok(!jl.includes("child_process"), "no child_process on UI path");
    assert.ok(!jl.includes("readFileSync(0)"), "no stdin pause on UI path");
    assert.ok(!/from\s+["'][^"']*backup-page\.mjs["']/.test(jl), "never imports backup-page CLI entry");
    assert.ok(!/from\s+["'][^"']*upload-people\.mjs["']/.test(jl), "never imports upload-people CLI entry");
    assert.ok(!/from\s+["'][^"']*pipeline\.mjs["']/.test(jl), "never imports pipeline CLI entry");
  });

  it("describePipeline maps every step to a spine stage + human flag", () => {
    const d = describePipeline();
    assert.equal(d.length, 8);
    assert.deepEqual(d.map((e) => e.step), ALL);
    for (const e of d) {
      assert.ok(e.stage, `${e.step} has a stage`);
      assert.equal(e.human, HUMAN_STEPS.includes(e.step));
      assert.ok(STAGING_CONTRACT[e.step]?.reads?.length, `${e.step} declares reads`);
      assert.ok(STEP_STAGES[e.step], `${e.step} in STEP_STAGES`);
    }
  });
});

describe("P7 approval gates replace terminal pauses", () => {
  it("human step without autoApprove/approvals waits (approval-required)", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    const hub = createHub();
    const events = collectEvents(hub, job.jobId);
    await assert.rejects(runPipelineAsJobOps({ outDir, job, steps: ["pick-links"], hub }), (e) => e.code === "approval-required");
    assert.equal(readJob(outDir, "s1", job.jobId).stage, "waiting_for_page_selection");
    const gate = events.find((e) => e.type === "job:advanced" && e.payload?.awaitingApproval);
    assert.ok(gate, "approval event emitted");
    assert.equal(gate.payload.step, "pick-links");
  });

  it("approvals callback approves with ledger audit", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    const hub = createHub();
    const events = collectEvents(hub, job.jobId);
    const seen = [];
    const res = await runPipelineAsJobOps({
      outDir,
      job,
      steps: ["pick-links"],
      hub,
      approvals: { "pick-links": async ({ step }) => void seen.push(step) || true },
    });
    assert.deepEqual(res.steps, [{ step: "pick-links", status: "approved" }]);
    assert.ok(readJob(outDir, "s1", job.jobId).ledger.some((l) => l.kind === "pipeline:approved"));
    assert.ok(events.some((e) => e.payload?.approved === true && e.payload?.autoApproved !== true));
  });

  it("autoApprove maps --yes (skips pauses, ledger names the mapping)", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    const res = await runPipelineAsJobOps({ outDir, job, steps: ["pick-links", "master"], autoApprove: true, hub: createHub() });
    assert.deepEqual(res.steps.map((r) => r.status), ["auto-approved", "auto-approved"]);
    const ledger = readJob(outDir, "s1", job.jobId).ledger;
    assert.ok(ledger.some((l) => l.kind === "pipeline:auto-approved" && /--yes/.test(l.message)));
  });
});

describe("P7 staging files stay the step contract", () => {
  it("apply-master fails closed without master.json", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    await assert.rejects(runPipelineAsJobOps({ outDir, job, steps: ["apply-master"], autoApprove: true }), (e) => e.code === "missing-master");
  });

  it("run fails closed without picked-links.json", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    await assert.rejects(runPipelineAsJobOps({ outDir, job, steps: ["run"], autoApprove: true }), (e) => e.code === "missing-picked-links");
  });

  it("finalize fails closed without summary.json", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    await assert.rejects(runPipelineAsJobOps({ outDir, job, steps: ["finalize"], autoApprove: true }), (e) => e.code === "nothing-to-finalize");
  });

  it("upload fails closed without summary.json", async () => {
    const outDir = tmpOut();
    const job = newJob(outDir);
    await assert.rejects(runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true }), (e) => e.code === "missing-summary");
  });

  it("machine steps validate then defer without a runner (arms untouched)", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    const hub = createHub();
    const events = collectEvents(hub, job.jobId);
    const res = await runPipelineAsJobOps({ outDir, job, steps: ["probe", "apply-master", "run"], hub, autoApprove: true });
    assert.deepEqual(res.steps.map((r) => r.status), ["deferred", "deferred", "deferred"]);
    assert.ok(events.some((e) => e.payload?.deferred === true));
    assert.equal(readJob(outDir, "s1", job.jobId).stage, "scraping");
  });

  it("injected runners drive steps in-process with ctx file paths", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    const calls = [];
    const runners = {
      probe: async (ctx) => void calls.push(["probe", ctx.paths.pickedLinks]) || { ok: true },
      run: async (ctx) => void calls.push(["run", ctx.from]) || { ok: true },
    };
    const res = await runPipelineAsJobOps({ outDir, job, steps: ["probe", "run"], runners, from: join(outDir, "_staging", "picked-links.json"), autoApprove: true });
    assert.deepEqual(res.steps.map((r) => r.status), ["ran", "ran"]);
    assert.ok(calls[0][1].endsWith("picked-links.json"));
  });

  it("peopleCountFor mirrors CLI peopleCount (? on missing)", () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    assert.equal(peopleCountFor(join(outDir, "s1")), 1);
    assert.equal(peopleCountFor(join(outDir, "nope")), "?");
  });
});

describe("P7 upload queue + safety never bypassed", () => {
  it("buildUploadQueue filters errors and orders via --order tokens", () => {
    const summary = {
      results: [
        { slug: "a", url: "https://h/a", dir: "/tmp/a" },
        { slug: "b", url: "https://h/b", dir: "/tmp/b" },
        { url: "https://h/bad", error: "cdp boom" },
      ],
    };
    const warns = [];
    const q = buildUploadQueue(summary, "b", { onWarn: (t) => warns.push(t) });
    assert.deepEqual(q.map((r) => r.slug), ["b", "a"]);
    assert.throws(() => buildUploadQueue({ results: [] }, ""), (e) => e.code === "no-successful-scrapes");
    assert.throws(() => buildUploadQueue(null, ""), (e) => e.code === "missing-summary");
  });

  it("upload without a dry proof fails closed even with autoApprove", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    const hub = createHub();
    const events = collectEvents(hub, job.jobId);
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, hub }),
      (e) => e.code === "missing-proof"
    );
    const reread = readJob(outDir, "s1", job.jobId);
    assert.equal(reread.arm.state, "none");
    assert.equal(reread.stage, "detecting_backend");
    assert.ok(events.some((e) => e.type === "gate:failed"));
  });

  it("autoApprove never bypasses G1 (guard-red dry fails)", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, dryInputs: greenDryInputs({ guardStatus: "red" }) }),
      (e) => e.code === "gate1-failed"
    );
    assert.equal(readJob(outDir, "s1", job.jobId).stage, "dry_running");
  });

  it("autoApprove never mints arms (dry passes, G2 still required)", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, dryInputs: greenDryInputs() }),
      (e) => e.code === "not-armed"
    );
    const reread = readJob(outDir, "s1", job.jobId);
    assert.equal(reread.stage, "dry_passed");
    assert.equal(reread.arm.state, "none");
    assert.ok(reread.dry_run_id, "dry proof threaded");
  });

  it("wrong G2 triple fails even with autoApprove", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    const job = newJob(outDir);
    await assert.rejects(
      runPipelineAsJobOps({
        outDir,
        job,
        steps: ["upload"],
        autoApprove: true,
        dryInputs: greenDryInputs(),
        armInputs: { attestedText: "wrong copy", typed: "s1", clicked: true },
      }),
      (e) => e.code === "g2-required"
    );
    assert.equal(readJob(outDir, "s1", job.jobId).arm.state, "none");
  });

  it("dry + G2 arm + uploadRow runs upload to done with plan/row/report events", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir, ["s1", "s2"]);
    let job = newJob(outDir);
    const hub = createHub();
    const events = collectEvents(hub, job.jobId);
    // Phase 1: in-process dry threads the job-layer proof (arm still required).
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, hub, dryInputs: greenDryInputs() }),
      (e) => e.code === "not-armed"
    );
    job = readJob(outDir, "s1", job.jobId);
    assert.equal(job.stage, "dry_passed");
    const attested = attestationText({ dryRunId: job.dry_run_id, shotCount: 1, snapshotId: job.snapshot_id });
    // Phase 2: exact G2 triple arms, injected rows upload in-process.
    const uploaded = [];
    const res = await runPipelineAsJobOps({
      outDir,
      job,
      steps: ["upload"],
      order: "s2",
      autoApprove: true,
      hub,
      armInputs: { attestedText: attested, typed: "s1", clicked: true },
      runners: { uploadRow: async ({ entry }) => void uploaded.push(entry.slug) || { status: "done" } },
    });
    assert.equal(res.steps[0].status, "done");
    assert.deepEqual(res.steps[0].queue.map((q) => q.slug), ["s2", "s1"]);
    assert.deepEqual(uploaded, ["s2", "s1"]);
    assert.ok(res.steps[0].saveRunId, "save proof minted");
    const done = readJob(outDir, "s1", job.jobId);
    assert.equal(done.stage, "done");
    assert.ok(done.artifacts.some((a) => a.kind === "save-report" && a.sha256), "save proof artifact registered");
    const types = events.map((e) => e.type);
    for (const t of ["upload:plan", "arm:granted", "arm:consumed", "upload:row-finished", "upload:report-written", "artifact:written", "job:advanced"]) {
      assert.ok(types.includes(t), `event ${t} emitted`);
    }
  });

  it("failed rows block: failed terminal, arm consumed, rows kept truthfully", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir);
    let job = newJob(outDir);
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, dryInputs: greenDryInputs() }),
      (e) => e.code === "not-armed"
    );
    job = readJob(outDir, "s1", job.jobId);
    const attested = attestationText({ dryRunId: job.dry_run_id, shotCount: 1, snapshotId: job.snapshot_id });
    await assert.rejects(
      runPipelineAsJobOps({
        outDir,
        job,
        steps: ["upload"],
        autoApprove: true,
        armInputs: { attestedText: attested, typed: "s1", clicked: true },
        runners: { uploadRow: async () => ({ status: "failed", detail: " fier wall" }) },
      }),
      (e) => e.code === "row-failed"
    );
    const failed = readJob(outDir, "s1", job.jobId);
    assert.equal(failed.stage, "failed");
    assert.equal(failed.arm.state, "none");
  });
});

describe("P7 CLI parity: selection, order, non-interactive flag", () => {
  it("CLI --from/--steps/--order/--yes surface preserved", () => {
    const pl = src("pipeline.mjs");
    assert.ok(pl.includes("spawnSync"), "CLI still spawns per-step processes");
    assert.ok(pl.includes("--yes: skip pause"), "CLI --yes still skips pauses only");
    assert.ok(pl.includes("--dry-proof"), "CLI still threads --dry-proof to upload");
    const up = src("uploader/upload-people.mjs");
    assert.ok(up.includes("--dry-proof"), "upload CLI still requires dry proof");
    const bp = src("backup-page.mjs");
    assert.ok(bp.includes("--probe") && bp.includes("--finalize"), "backup-page CLIs preserved");
  });

  it("subset + order + autoApprove behave as before over the same DAG", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir, ["s1", "s2"]);
    const job = newJob(outDir);
    const calls = [];
    const res = await runPipelineAsJobOps({
      outDir,
      job,
      steps: ["probe", "run", "finalize"],
      autoApprove: true,
      hub: createHub(),
      runners: {
        probe: async () => void calls.push("probe") || null,
        run: async () => void calls.push("run") || null,
        finalize: async () => void calls.push("finalize") || null,
      },
    });
    assert.deepEqual(res.steps.map((r) => r.step), ["probe", "run", "finalize"]);
    assert.deepEqual(calls, ["probe", "run", "finalize"]);
    assert.equal(readJob(outDir, "s1", job.jobId).stage, "finalizing");
    // Upload queue honors --order over the same summary the CLI reads.
    const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
    assert.deepEqual(buildUploadQueue(summary, "s2").map((r) => r.slug), ["s2", "s1"]);
  });

  it("skips dirs without people.json like the CLI (queue truthful)", async () => {
    const outDir = tmpOut();
    stagingFixtures(outDir, ["s1"]);
    const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
    summary.results.push({ slug: "ghost", url: "https://a.go.th/ghost", dir: join(outDir, "ghost") });
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary), "utf8");
    const job = newJob(outDir);
    await assert.rejects(
      runPipelineAsJobOps({ outDir, job, steps: ["upload"], autoApprove: true, dryInputs: greenDryInputs() }),
      (e) => e.code === "not-armed"
    );
    job.stage; // proof threaded; re-read for the deferred check below
    const reread = readJob(outDir, "s1", job.jobId);
    assert.equal(reread.stage, "dry_passed");
    assert.ok(existsSync(join(outDir, "_staging", "picked-links.json")), "staging contract intact");
  });
});
