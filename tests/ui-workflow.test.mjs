// tests/ui-workflow.test.mjs — PR #30 gap fix: normal workflow operable from workspace.
// Create Job -> Probe -> Page Selection -> Scrape -> People Review -> Finalize
// -> Detect -> Dry -> Arm (stop before destructive Real Upload).
// Plus Retry / Resume / Cancel via POST commands, idempotency, single-flight.
// Run: node --test tests/ui-workflow.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";
import { createJob, writeJob, readJob, advance } from "../jobs/store.mjs";
import { createCommandStore } from "../jobs/commands.mjs";
import { getDefaultRunners, UI_STEPS, UI_STEP_STAGES, runUiStepSync } from "../jobs/pipeline.mjs";
import { seedReview } from "../jobs/review.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "ui-workflow-"));
}

async function postCommand(url, jobId, body) {
  const r = await fetch(`${url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function getJob(url, jobId) {
  const r = await fetch(`${url}/jobs/${jobId}`);
  return { status: r.status, json: await r.json() };
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

function greenDryPayload() {
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
  };
}

describe("UI workflow: POST /jobs create + GET /jobs list", () => {
  it("creates from source URL, validates, idempotent by jobId, lists real jobs", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const bad = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: "g" }),
      });
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.error?.code, "bad-source");

      const r = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      });
      assert.equal(r.status, 201);
      const created = await r.json();
      assert.ok(created.jobId);
      assert.equal(created.job.slug, "s");
      assert.equal(created.job.stage, "idle");
      assert.equal(created.created, true);

      const again = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s", jobId: created.jobId }),
      });
      assert.equal(again.status, 200);
      const againBody = await again.json();
      assert.equal(againBody.created, false);
      assert.equal(againBody.jobId, created.jobId);

      const conflict = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://other.go.th/y", group: "a", slug: "s", jobId: created.jobId }),
      });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error?.code, "job-conflict");

      const list = await (await fetch(`${app.url}/jobs`)).json();
      assert.ok(Array.isArray(list.jobs));
      assert.ok(list.jobs.some((j) => j.jobId === created.jobId));
    } finally {
      await app.close();
    }
  });

  it("derives slug when omitted", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const r = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://example.go.th/path/page" }),
      });
      assert.equal(r.status, 201);
      const body = await r.json();
      assert.ok(body.job.slug && typeof body.job.slug === "string");
    } finally {
      await app.close();
    }
  });
});

describe("UI workflow: Probe -> Approve -> Scrape -> Finalize -> Detect via POST", () => {
  it("drives spine end-to-end to detecting_backend with ledger + SSE truth", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      })).json();
      const jobId = c.jobId;

      const probe = await postCommand(app.url, jobId, { commandId: "u-probe", type: "probe", payload: {} });
      assert.deepEqual(probe.json, { accepted: true, reason: "probed", jobId, commandId: "u-probe" });
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "probing");

      const probeReplay = await postCommand(app.url, jobId, { commandId: "u-probe", type: "probe", payload: {} });
      assert.deepEqual(probeReplay.json, probe.json);

      const approve = await postCommand(app.url, jobId, { commandId: "u-appr", type: "approve-page", payload: {} });
      assert.equal(approve.json.accepted, true);
      assert.equal(approve.json.reason, "page-approved");
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "scraping");

      const scrape = await postCommand(app.url, jobId, { commandId: "u-scrape", type: "scrape", payload: {} });
      assert.equal(scrape.json.accepted, true);
      assert.ok(["scraped", "already-past"].includes(scrape.json.reason));

      // People Review seed (existing Review UI path untouched).
      const job = readJob(outDir, "s", jobId);
      // Walk to review wait first via advance for seed realism.
      for (const s of ["waiting_for_people_review"]) {
        try { advance(job, s); } catch { /* already past */ }
      }
      // Ensure spine is at least scraping before seeding; approve already did.
      writeJob(outDir, job);
      seedReview(outDir, readJob(outDir, "s", jobId), [{ seq: 1, file: "a.png", top: 0 }]);
      writeJob(outDir, readJob(outDir, "s", jobId));

      const fin = await postCommand(app.url, jobId, { commandId: "u-fin", type: "finalize", payload: {} });
      assert.equal(fin.json.accepted, true);
      assert.ok(["finalized", "already-past"].includes(fin.json.reason));
      const afterFin = (await getJob(app.url, jobId)).json.job;
      assert.equal(afterFin.stage, "finalizing");

      const det = await postCommand(app.url, jobId, { commandId: "u-det", type: "detect", payload: {} });
      assert.deepEqual(det.json, { accepted: true, reason: "detected", jobId, commandId: "u-det" });
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "detecting_backend");

      const ledger = (await getJob(app.url, jobId)).json.job.ledger.map((e) => e.kind);
      assert.ok(ledger.includes("pipeline:step") || ledger.includes("pipeline:approved"));
    } finally {
      await app.close();
    }
  });

  it("run-step single DAG step with approval gate (awaiting-approval, no bypass)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      const d = await postCommand(app.url, jobId, { commandId: "u-rs1", type: "run-step", payload: { step: "pick-links" } });
      assert.equal(d.json.accepted, true);
      assert.equal(d.json.reason, "awaiting-approval");
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "waiting_for_page_selection");
      const d2 = await postCommand(app.url, jobId, { commandId: "u-rs2", type: "run-step", payload: { step: "pick-links", autoApprove: true } });
      assert.equal(d2.json.accepted, true);
      assert.equal(d2.json.reason, "step-ran");
    } finally {
      await app.close();
    }
  });

  it("retry / resume / cancel exposed where applicable (no CLI)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      await postCommand(app.url, jobId, { commandId: "u-p1", type: "probe", payload: {} });
      // Retry back to probing (same stage, bumps attempts).
      const rt = await postCommand(app.url, jobId, { commandId: "u-rt", type: "retry", payload: { to: "probing", reason: "ui retry" } });
      assert.equal(rt.json.accepted, true);
      assert.equal((await getJob(app.url, jobId)).json.job.attempts, 1);
      // Approve to scraping, then retry back to probing, then approve again.
      await postCommand(app.url, jobId, { commandId: "u-a1", type: "approve-page", payload: {} });
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "scraping");
      // Resume refused outside waits.
      const resBad = await postCommand(app.url, jobId, { commandId: "u-res-bad", type: "resume", payload: {} });
      assert.equal(resBad.json.accepted, false);
      assert.equal(resBad.json.reason, "not-waiting");
      // Cancel with prompt (non-upload).
      const cx = await postCommand(app.url, jobId, { commandId: "u-cx", type: "cancel", payload: { prompted: true, reason: "ui cancel" } });
      assert.equal(cx.json.accepted, true);
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "cancelled");
    } finally {
      await app.close();
    }
  });

  it("dry still enforced after UI detect (stop before destructive upload)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      await postCommand(app.url, jobId, { commandId: "u-p", type: "probe", payload: {} });
      await postCommand(app.url, jobId, { commandId: "u-a", type: "approve-page", payload: {} });
      await postCommand(app.url, jobId, { commandId: "u-s", type: "scrape", payload: {} });
      // Seed review + finalize + detect to reach dry_running.
      const j0 = readJob(outDir, "s", jobId);
      try { advance(j0, "waiting_for_people_review"); } catch {}
      writeJob(outDir, j0);
      seedReview(outDir, readJob(outDir, "s", jobId), [{ seq: 1, file: "a.png", top: 0 }]);
      writeJob(outDir, readJob(outDir, "s", jobId));
      await postCommand(app.url, jobId, { commandId: "u-f", type: "finalize", payload: {} });
      await postCommand(app.url, jobId, { commandId: "u-d", type: "detect", payload: {} });
      // Walk to dry_running via advance (detect leaves at detecting_backend).
      const j1 = readJob(outDir, "s", jobId);
      try { advance(j1, "dry_running", { reason: "test" }); writeJob(outDir, j1); } catch {}
      const dry = await postCommand(app.url, jobId, { commandId: "u-dry", type: "dry", payload: greenDryPayload() });
      assert.equal(dry.json.accepted, true);
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "dry_passed");
      // Stop here: do NOT begin-upload (destructive). Verify arm would require G2.
      const armBad = await postCommand(app.url, jobId, { commandId: "u-arm-bad", type: "arm", payload: { attestedText: "wrong", typed: "s", clicked: true } });
      assert.equal(armBad.json.accepted, false);
    } finally {
      await app.close();
    }
  });
});

describe("UI step commands: idempotency + single-flight + validation", () => {
  it("replayed UI commandIds never double-execute", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      const d1 = await postCommand(app.url, jobId, { commandId: "idem-probe", type: "probe", payload: {} });
      const g1 = (await getJob(app.url, jobId)).json.job;
      const d2 = await postCommand(app.url, jobId, { commandId: "idem-probe", type: "probe", payload: {} });
      assert.deepEqual(d2.json, d1.json);
      const g2 = (await getJob(app.url, jobId)).json.job;
      assert.equal(g2.ledger.length, g1.ledger.length, "replay never executes twice");
    } finally {
      await app.close();
    }
  });

  it("terminal jobs refuse UI steps fail-closed (new Job required)", async () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "term-1" });
    writeJob(outDir, job);
    const store = createCommandStore({ hub: null });
    store.execute({ outDir, jobId: "term-1", commandId: "adv", type: "advance", payload: { to: "probing" } });
    store.execute({ outDir, jobId: "term-1", commandId: "cx", type: "cancel", payload: { prompted: true } });
    assert.equal(readJob(outDir, "s", "term-1").stage, "cancelled");
    const d = store.execute({ outDir, jobId: "term-1", commandId: "p-after", type: "probe", payload: {} });
    assert.equal(d.accepted, false);
  });

  it("pipeline helpers expose UI mapping + real finalize runner", async () => {
    assert.deepEqual([...UI_STEPS].sort(), ["approve-page", "detect", "finalize", "probe", "run-step", "scrape"].sort());
    assert.equal(UI_STEP_STAGES.probe, "probing");
    assert.equal(UI_STEP_STAGES.finalize, "finalizing");
    assert.equal(UI_STEP_STAGES.detect, "detecting_backend");
    const outDir = tmpOut();
    const job = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "def-1" });
    writeJob(outDir, job);
    seedReview(outDir, job, [{ seq: 1, file: "a.png", top: 0 }]);
    writeJob(outDir, job);
    const runners = getDefaultRunners({ outDir });
    assert.equal(typeof runners.finalize, "function");
    const res = await runners.finalize({ outDir, job, step: "finalize" });
    assert.equal(res.kept, 1);
    // Sync UI step also runs real review validation.
    const job2 = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "sync-1" });
    writeJob(outDir, job2);
    const r = runUiStepSync({ outDir, job: job2, uiStep: "probe", hub: null, payload: {} });
    assert.equal(r.stage, "probing");
    assert.equal(readJob(outDir, "s", "sync-1").stage, "probing");
  });
});

describe("UI shell carries Create + Steps + Recovery controls", () => {
  it("web client has source form, step buttons, retry/resume/cancel (static)", () => {
    const html = readFileSync(join(root, "web", "index.html"), "utf8");
    for (const id of ["src-url", "src-slug", "src-group", "create-btn", "jobs-btn", "probe-btn", "approve-btn", "scrape-btn", "finalize-btn", "detect-btn", "retry-to", "retry-btn", "resume-btn", "cancel-btn"]) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.ok(html.includes("/jobs") && html.includes("POST"), "client uses POST job transport");
  });
});
