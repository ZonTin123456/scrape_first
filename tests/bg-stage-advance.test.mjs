// tests/bg-stage-advance.test.mjs — background engine success advances the Job
// to the next stable stage exactly once (human-acceptance defect 1).
// probe -> waiting_for_page_selection, scrape -> waiting_for_people_review,
// detect -> dry_running. Cancel/terminal supersession, failure freeze, and
// commandId replay no-double-advance pinned. No Real Upload anywhere.
// Run: node --test tests/bg-stage-advance.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app;
let url;
let outDir;

function fakeEngine(calls = [], failProbe = false) {
  return {
    probeUrl: async ({ url: u, emit }) => {
      calls.push("probe");
      if (failProbe) throw new Error("probe-boom");
      emit?.("scrape:url-finished", { url: u, slug: "s" });
      return { slug: "s", probe: { counts: { image: 1 } }, counts: { image: 1 } };
    },
    scrapeUrl: async ({ slug }) => {
      calls.push("scrape");
      return { dir: join(outDir, slug), slug, title: "t", manifest: { counts: {} }, nCands: 1, nPeople: 1 };
    },
    detectBackend: async ({ slug, jobId }) => {
      calls.push("detect");
      return { host: "https://be.invalid", relPath: `${slug}/jobs/${jobId}/detect.json`, sha256: "ab", byteLength: 2, sectionCount: 1, profile: null, departments: ["g"] };
    },
  };
}

async function createJob(source = "https://example.invalid/bg") {
  const r = await fetch(`${url}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).jobId;
}

async function postCmd(jobId, commandId, type, payload = {}) {
  const r = await fetch(`${url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, type, payload }),
  });
  return { status: r.status, json: await r.json() };
}

async function getStage(jobId) {
  const r = await fetch(`${url}/jobs/${jobId}`);
  return (await r.json()).job;
}

async function waitLedger(jobId, commandId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const g = await getStage(jobId);
    const hit = (g.ledger || []).filter((e) =>
      e && e.commandId === commandId && ["pipeline:finished", "pipeline:failed", "pipeline:superseded"].includes(e.kind));
    if (hit.length) return { entry: hit[hit.length - 1], job: g };
    if (Date.now() - t0 > timeoutMs) throw new Error(`bg timeout for ${commandId}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function advancedCount(job) {
  return (job.ledger || []).filter((e) => e && e.kind === "job:advanced" && /->/.test(e.message || "")).length;
}

describe("bg success advances stage exactly once", () => {
  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), "bg-advance-"));
    const { startServer } = await import("../server.mjs");
    app = await startServer({ outDir, port: 0, engine: fakeEngine() });
    url = app.url;
  });
  after(async () => {
    await app?.close();
  });

  it("successful Probe advances probing -> waiting_for_page_selection", async () => {
    const jobId = await createJob("https://example.invalid/bg-probe");
    const acc = await postCmd(jobId, "bg-probe-1", "probe");
    assert.equal(acc.json.accepted, true);
    const { entry, job } = await waitLedger(jobId, "bg-probe-1");
    assert.equal(entry.kind, "pipeline:finished");
    assert.equal(job.stage, "waiting_for_page_selection");
  });

  it("successful Scrape advances scraping -> waiting_for_people_review", async () => {
    const jobId = await createJob("https://example.invalid/bg-scrape");
    const slug = (await getStage(jobId)).slug;
    mkdirSync(join(outDir, "_staging"), { recursive: true });
    writeFileSync(join(outDir, "_staging", "picked-links.json"), JSON.stringify([
      { url: "https://example.invalid/bg-scrape", slug, keep: true },
    ]), "utf8");
    const acc = await postCmd(jobId, "bg-scrape-1", "scrape");
    assert.equal(acc.json.accepted, true);
    const { entry, job } = await waitLedger(jobId, "bg-scrape-1");
    assert.equal(entry.kind, "pipeline:finished");
    assert.equal(job.stage, "waiting_for_people_review");
  });

  it("successful Detect advances detecting_backend -> dry_running", async () => {
    const jobId = await createJob("https://example.invalid/bg-detect");
    const acc = await postCmd(jobId, "bg-detect-1", "detect");
    assert.equal(acc.json.accepted, true);
    const { entry, job } = await waitLedger(jobId, "bg-detect-1");
    assert.equal(entry.kind, "pipeline:finished");
    assert.equal(job.stage, "dry_running");
  });

  it("command replay returns the accept disposition without double-advance", async () => {
    const jobId = await createJob("https://example.invalid/bg-replay");
    const first = await postCmd(jobId, "bg-replay-1", "probe");
    assert.equal(first.json.accepted, true);
    const { job: done } = await waitLedger(jobId, "bg-replay-1");
    assert.equal(done.stage, "waiting_for_page_selection");
    const before = advancedCount(done);
    const replay = await postCmd(jobId, "bg-replay-1", "probe");
    assert.deepEqual(replay.json, first.json);
    const afterJob = await getStage(jobId);
    assert.equal(afterJob.stage, "waiting_for_page_selection");
    assert.equal(advancedCount(afterJob), before);
  });
});

describe("cancel during bg run supersedes (slow engine, deterministic)", () => {
  let app3;
  let url3;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-cancel-"));
    const { startServer } = await import("../server.mjs");
    const slow = fakeEngine([], false);
    const origProbe = slow.probeUrl;
    slow.probeUrl = async (args) => {
      await new Promise((r) => setTimeout(r, 800));
      return origProbe(args);
    };
    app3 = await startServer({ outDir: dir, port: 0, engine: slow });
    url3 = app3.url;
  });
  after(async () => {
    await app3?.close();
  });

  it("cancel wins the race: superseded ledger, stage stays cancelled", async () => {
    const r = await fetch(`${url3}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.invalid/bg-cancel" }),
    });
    const jobId = (await r.json()).jobId;
    const acc = await (await fetch(`${url3}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "bg-cancel-1", type: "probe", payload: {} }),
    })).json();
    assert.equal(acc.accepted, true);
    const cancelled = await (await fetch(`${url3}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "bg-cancel-2", type: "cancel", payload: { prompted: true, reason: "test" } }),
    })).json();
    assert.equal(cancelled.accepted, true);
    const t0 = Date.now();
    let entry = null;
    let job = null;
    for (;;) {
      job = (await (await fetch(`${url3}/jobs/${jobId}`)).json()).job;
      entry = (job.ledger || []).filter((e) => e && e.commandId === "bg-cancel-1" &&
        ["pipeline:finished", "pipeline:failed", "pipeline:superseded"].includes(e.kind)).pop() || null;
      if (entry || Date.now() - t0 > 15000) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(entry?.kind, "pipeline:superseded");
    assert.equal(job.stage, "cancelled");
  });
});

describe("bg failure freezes stage (fail-closed, no advance)", () => {
  let app2;
  let url2;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-fail-"));
    const { startServer } = await import("../server.mjs");
    app2 = await startServer({ outDir: dir, port: 0, engine: fakeEngine([], true) });
    url2 = app2.url;
  });
  after(async () => {
    await app2?.close();
  });

  it("failed Probe keeps probing and records pipeline:failed", async () => {
    const r = await fetch(`${url2}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.invalid/bg-fail" }),
    });
    const jobId = (await r.json()).jobId;
    const acc = await (await fetch(`${url2}/jobs/${jobId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "bg-fail-1", type: "probe", payload: {} }),
    })).json();
    assert.equal(acc.accepted, true);
    const t0 = Date.now();
    let hit = null;
    let job = null;
    for (;;) {
      const g = await (await fetch(`${url2}/jobs/${jobId}`)).json();
      job = g.job;
      hit = (job.ledger || []).find((e) => e && e.commandId === "bg-fail-1" && e.kind === "pipeline:failed");
      if (hit || Date.now() - t0 > 15000) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(hit, "expected pipeline:failed ledger entry");
    assert.equal(job.stage, "probing");
  });
});
