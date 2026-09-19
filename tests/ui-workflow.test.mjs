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
import { createJob, currentEngineOp, writeJob, readJob, advance } from "../jobs/store.mjs";
import { createCommandStore } from "../jobs/commands.mjs";
import { BG_STEPS, getDefaultRunners, UI_STEPS, UI_STEP_STAGES, runUiStepSync, startUiStep } from "../jobs/pipeline.mjs";
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

// Fake CDP engine: no browser, deterministic results. Real engine is covered
// by live verification (headed Chrome :9333) + tests/engine-cdp.test.mjs.
function fakeEngine(calls = []) {
  return {
    probeUrl: async ({ url, emit }) => {
      calls.push("probe");
      emit?.("scrape:url-finished", { url, slug: "s" });
      return { slug: "s", probe: { counts: { image: 2 } }, counts: { image: 2 } };
    },
    scrapeUrl: async ({ outDir, url, slug, emit }) => {
      calls.push("scrape");
      return { dir: join(outDir, slug), slug, title: "t", manifest: { counts: {} }, nCands: 1, nPeople: 1 };
    },
    detectBackend: async ({ slug, jobId }) => {
      calls.push("detect");
      return { host: "https://be.invalid", relPath: `${slug}/jobs/${jobId}/detect.json`, sha256: "ab", byteLength: 2, sectionCount: 1, profile: null, departments: ["g"] };
    },
  };
}

// Poll GET until the background step completes (finished/failed/superseded
// ledger entry tagged with the accept commandId).
async function waitLedger(url, jobId, commandId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const g = await getJob(url, jobId);
    const hit = (g.json.job.ledger || []).filter((e) =>
      e && e.commandId === commandId && ["pipeline:finished", "pipeline:failed", "pipeline:superseded"].includes(e.kind));
    if (hit.length) return hit[hit.length - 1];
    if (Date.now() - t0 > timeoutMs) throw new Error(`bg timeout for ${commandId}`);
    await new Promise((r) => setTimeout(r, 100));
  }
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

  it("default slug equals the CLI slugBaseOf for the same URL (1 URL = 1 group)", async () => {
    const { slugBaseOf } = await import("../services/sectioning.mjs");
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0 });
    try {
      const url = "https://www.laemsorm.go.th/manage.php";
      const r = await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: url }),
      });
      assert.equal(r.status, 201);
      assert.equal((await r.json()).job.slug, slugBaseOf(url));
    } finally {
      await app.close();
    }
  });
});

describe("UI workflow: Probe -> Approve -> Scrape -> Finalize -> Detect via POST", () => {
  it("drives spine end-to-end to detecting_backend with ledger + SSE truth", async () => {
    const outDir = tmpOut();
    const calls = [];
    const app = await startServer({ outDir, port: 0, engine: fakeEngine(calls) });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      })).json();
      const jobId = c.jobId;

      // Background accept: stage walks synchronously, work completes async.
      const probe = await postCommand(app.url, jobId, { commandId: "u-probe", type: "probe", payload: {} });
      assert.deepEqual(probe.json, { accepted: true, reason: "started", jobId, commandId: "u-probe" });
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "probing");
      const probeDone = await waitLedger(app.url, jobId, "u-probe");
      assert.equal(probeDone.kind, "pipeline:finished");

      const probeReplay = await postCommand(app.url, jobId, { commandId: "u-probe", type: "probe", payload: {} });
      assert.deepEqual(probeReplay.json, probe.json);
      assert.deepEqual(calls.filter((x) => x === "probe").length, 1, "replay never executes twice");

      const approve = await postCommand(app.url, jobId, { commandId: "u-appr", type: "approve-page", payload: {} });
      assert.equal(approve.json.accepted, true);
      assert.equal(approve.json.reason, "page-approved");
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "scraping");

      const scrape = await postCommand(app.url, jobId, { commandId: "u-scrape", type: "scrape", payload: {} });
      assert.deepEqual(scrape.json, { accepted: true, reason: "started", jobId, commandId: "u-scrape" });
      await waitLedger(app.url, jobId, "u-scrape");

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
      assert.deepEqual(det.json, { accepted: true, reason: "started", jobId, commandId: "u-det" });
      await waitLedger(app.url, jobId, "u-det");
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "detecting_backend");

      const ledger = (await getJob(app.url, jobId)).json.job.ledger.map((e) => e.kind);
      assert.ok(ledger.includes("pipeline:started") && ledger.includes("pipeline:finished"));
    } finally {
      await app.close();
    }
  });

  it("run-step single DAG step with approval gate (awaiting-approval, no bypass)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0, engine: fakeEngine() });
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
      // run-step probe from an idle job runs the background probe.
      const c2 = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://b.go.th/y", slug: "s2" }),
      })).json();
      const d3 = await postCommand(app.url, c2.jobId, { commandId: "u-rs3", type: "run-step", payload: { step: "probe" } });
      assert.equal(d3.json.accepted, true);
      assert.equal(d3.json.reason, "started");
      await waitLedger(app.url, c2.jobId, "u-rs3");
    } finally {
      await app.close();
    }
  });

  it("retry / resume / cancel exposed where applicable (no CLI)", async () => {
    const outDir = tmpOut();
    const app = await startServer({ outDir, port: 0, engine: fakeEngine() });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      await postCommand(app.url, jobId, { commandId: "u-p1", type: "probe", payload: {} });
      await waitLedger(app.url, jobId, "u-p1");
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
    const app = await startServer({ outDir, port: 0, engine: fakeEngine() });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      await postCommand(app.url, jobId, { commandId: "u-p", type: "probe", payload: {} });
      await waitLedger(app.url, jobId, "u-p");
      await postCommand(app.url, jobId, { commandId: "u-a", type: "approve-page", payload: {} });
      await postCommand(app.url, jobId, { commandId: "u-s", type: "scrape", payload: {} });
      await waitLedger(app.url, jobId, "u-s");
      // Seed review + finalize + detect to reach dry_running.
      const j0 = readJob(outDir, "s", jobId);
      try { advance(j0, "waiting_for_people_review"); } catch {}
      writeJob(outDir, j0);
      seedReview(outDir, readJob(outDir, "s", jobId), [{ seq: 1, file: "a.png", top: 0 }]);
      writeJob(outDir, readJob(outDir, "s", jobId));
      await postCommand(app.url, jobId, { commandId: "u-f", type: "finalize", payload: {} });
      await postCommand(app.url, jobId, { commandId: "u-d", type: "detect", payload: {} });
      await waitLedger(app.url, jobId, "u-d");
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
    const calls = [];
    const app = await startServer({ outDir, port: 0, engine: fakeEngine(calls) });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      const d1 = await postCommand(app.url, jobId, { commandId: "idem-probe", type: "probe", payload: {} });
      assert.equal(d1.json.accepted, true);
      const d2 = await postCommand(app.url, jobId, { commandId: "idem-probe", type: "probe", payload: {} });
      assert.deepEqual(d2.json, d1.json);
      assert.deepEqual(calls.filter((x) => x === "probe").length, 1, "replay never executes twice");
      const done = await waitLedger(app.url, jobId, "idem-probe");
      assert.equal(done.kind, "pipeline:finished");
      const finished = (await getJob(app.url, jobId)).json.job.ledger.filter((e) => e.commandId === "idem-probe" && e.kind === "pipeline:finished");
      assert.equal(finished.length, 1, "single completion for one commandId");
    } finally {
      await app.close();
    }
  });

  it("background engine holds single-flight; cancel supersedes", async () => {
    const outDir = tmpOut();
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const gated = {
      probeUrl: async () => { await gate; return { slug: "s", probe: { counts: {} }, counts: {} }; },
      scrapeUrl: async () => { throw new Error("unused"); },
      detectBackend: async () => { throw new Error("unused"); },
    };
    const app = await startServer({ outDir, port: 0, engine: gated });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      const d1 = await postCommand(app.url, jobId, { commandId: "bg-1", type: "probe", payload: {} });
      assert.equal(d1.json.reason, "started");
      // Second engine op while the first holds the claim: refused, never cached.
      const busy = await postCommand(app.url, jobId, { commandId: "bg-2", type: "scrape", payload: {} });
      assert.deepEqual(busy.json, { accepted: false, reason: "single-flight", jobId, commandId: "bg-2" });
      const dryBusy = await postCommand(app.url, jobId, { commandId: "bg-3", type: "dry", payload: greenDryPayload() });
      assert.equal(dryBusy.json.reason, "single-flight");
      // Cancel is never gated: lands immediately.
      const cx = await postCommand(app.url, jobId, { commandId: "bg-cx", type: "cancel", payload: { prompted: true, reason: "stop bg" } });
      assert.equal(cx.json.accepted, true);
      assert.equal((await getJob(app.url, jobId)).json.job.stage, "cancelled");
      release();
      const done = await waitLedger(app.url, jobId, "bg-1");
      assert.equal(done.kind, "pipeline:superseded", "cancelled record is never clobbered");
      assert.equal(currentEngineOp(), null, "claim released after supersede");
    } finally {
      await app.close();
    }
  });

  it("background failure fails closed with blocker + released claim", async () => {
    const outDir = tmpOut();
    const failing = {
      probeUrl: async () => { const e = new Error("wall persists"); e.code = "cloudflare-blocked"; throw e; },
      scrapeUrl: async () => { throw new Error("unused"); },
      detectBackend: async () => { throw new Error("unused"); },
    };
    const app = await startServer({ outDir, port: 0, engine: failing });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", slug: "s" }),
      })).json();
      const jobId = c.jobId;
      await postCommand(app.url, jobId, { commandId: "bg-f1", type: "probe", payload: {} });
      const done = await waitLedger(app.url, jobId, "bg-f1");
      assert.equal(done.kind, "pipeline:failed");
      const g = await getJob(app.url, jobId);
      assert.equal(g.json.job.stage, "probing", "failure keeps the stage for Retry");
      assert.ok(g.json.job.blockers.some((b) => b.type === "cloudflare"), "CF blocker raised");
      // Claim released: human gate still works.
      const ap = await postCommand(app.url, jobId, { commandId: "bg-a1", type: "approve-page", payload: {} });
      assert.equal(ap.json.accepted, true);
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
    assert.ok(BG_STEPS.has("probe") && BG_STEPS.has("scrape") && BG_STEPS.has("detect"), "browser steps run in background");
    assert.ok(!BG_STEPS.has("approve-page") && !BG_STEPS.has("finalize"), "human gate + pure finalize stay sync");
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
    // Sync UI probe now routes to background start (use-start fail-closed).
    const job2 = createJob({ slug: "s", source: "https://a.go.th/x", jobId: "sync-1" });
    writeJob(outDir, job2);
    assert.throws(() => runUiStepSync({ outDir, job: job2, uiStep: "probe", hub: null, payload: {} }), (e) => e.code === "use-start");
    // Background accept walks the stage synchronously with a fake engine.
    const r = startUiStep({ outDir, job: job2, uiStep: "probe", hub: null, payload: { commandId: "t-probe" }, engine: fakeEngine() });
    assert.equal(r.status, "started");
    assert.equal(readJob(outDir, "s", "sync-1").stage, "probing");
    const t0 = Date.now();
    while (currentEngineOp() !== null) {
      if (Date.now() - t0 > 5000) throw new Error("bg claim leak");
      await new Promise((res) => setTimeout(res, 25));
    }
  });
});

describe("UI shell carries Create + Steps + Recovery controls", () => {
  it("web client has source form, step buttons, pages pane, retry/resume/cancel (static)", () => {
    const html = readFileSync(join(root, "web", "index.html"), "utf8");
    for (const id of ["src-url", "src-slug", "src-group", "create-btn", "jobs-btn", "probe-btn", "approve-btn", "scrape-btn", "finalize-btn", "detect-btn",
      "pages-pane", "pages-load-btn", "pages-save-btn", "pages-reload-btn", "pages-msg", "pages-body", "pages-images",
      "retry-to", "retry-btn", "resume-btn", "cancel-btn"]) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.ok(html.includes("/jobs") && html.includes("POST"), "client uses POST job transport");
    assert.ok(html.includes("/pages"), "client drives Page Selection routes");
  });
});
