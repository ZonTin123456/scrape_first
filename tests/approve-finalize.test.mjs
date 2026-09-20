// tests/approve-finalize.test.mjs — durable page approval + finalize completion.
// Approve records server-side approval only (no advance; reload remembers;
// scrape requires it and invalidates on re-save). Finalize advances
// waiting_for_people_review -> detecting_backend synchronously; replay never
// double-advances; validation failure stays put. Ends with a full spine audit
// idle -> dry_passed pinning every accept-stage and completion-stage.
// No Real Upload anywhere. Run: node --test tests/approve-finalize.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, readJob, writeJob } from "../jobs/store.mjs";
import { saveReviewState } from "../jobs/review.mjs";
import { slugBaseOf } from "../services/sectioning.mjs";
import { pageFor } from "../web/js/stage-map.js";

let app;
let url;
let outDir;

const SOURCE = "https://example.invalid/approve-finalize";
const SLUG = slugBaseOf(SOURCE);

function fakeEngine() {
  return {
    probeUrl: async ({ url: u, emit }) => {
      emit?.("scrape:url-finished", { url: u, slug: SLUG });
      return { slug: SLUG, probe: { counts: { image: 1 } }, counts: { image: 1 } };
    },
    scrapeUrl: async ({ slug }) => {
      return { dir: join(outDir, slug), slug, title: "t", manifest: { counts: {} }, nCands: 1, nPeople: 1 };
    },
    detectBackend: async ({ slug, jobId }) => {
      return { host: "https://be.invalid", relPath: `${slug}/jobs/${jobId}/detect.json`, sha256: "ab", byteLength: 2, sectionCount: 1, profile: null, departments: [SLUG] };
    },
  };
}

async function createJob() {
  const r = await fetch(`${url}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE, slug: SLUG }),
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

async function getJob(jobId) {
  return (await (await fetch(`${url}/jobs/${jobId}`)).json()).job;
}

async function waitLedger(jobId, commandId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(jobId);
    const hit = (job.ledger || []).filter((e) =>
      e && e.commandId === commandId && ["pipeline:finished", "pipeline:failed", "pipeline:superseded"].includes(e.kind));
    if (hit.length) return { entry: hit[hit.length - 1], job };
    if (Date.now() - t0 > timeoutMs) throw new Error(`bg timeout for ${commandId}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function seedStaging() {
  const st = join(outDir, "_staging");
  mkdirSync(join(st, SLUG), { recursive: true });
  writeFileSync(join(st, "picked-links.json"), JSON.stringify([
    { url: SOURCE, slug: SLUG, keep: true },
  ]), "utf8");
  writeFileSync(join(st, SLUG, "probe.json"), JSON.stringify({
    source_url: SOURCE, source_title: "T", counts: { image: 1 },
    images: [{ seq: 0, src: "https://example.invalid/i.png", width: 10, height: 10 }],
  }), "utf8");
  writeFileSync(join(st, SLUG, "picked-images.json"), JSON.stringify([
    { seq: 0, src: "https://example.invalid/i.png", keep: true },
  ]), "utf8");
}

function toStage(jobId, stage) {
  const order = ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review", "finalizing", "detecting_backend", "dry_running"];
  const job = readJob(outDir, SLUG, jobId);
  for (const s of order) {
    advance(job, s);
    if (s === stage) break;
  }
  writeJob(outDir, job);
}

function seedSelection(jobId) {
  const job = readJob(outDir, SLUG, jobId);
  saveReviewState(outDir, job, { selection: [{ seq: 0, file: "a.png", keep: true, order: 0 }], editedFrom: 0 });
  writeJob(outDir, job);
}

function advancedCount(job) {
  return (job.ledger || []).filter((e) => e && e.kind === "job:advanced" && /->/.test(e.message || "")).length;
}

async function startApp() {
  outDir = mkdtempSync(join(tmpdir(), "appr-fin-"));
  const { startServer } = await import("../server.mjs");
  app = await startServer({ outDir, port: 0, engine: fakeEngine() });
  url = app.url;
}

describe("approve records durable approval without advancing", () => {
  before(startApp);
  after(async () => {
    await app?.close();
  });

  it("approve stays at wait; reload remembers the approval", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_page_selection");
    seedStaging();
    const a = await postCmd(jobId, "ap-1", "approve-page");
    assert.equal(a.json.accepted, true);
    assert.equal(a.json.reason, "page-approved");
    const job = await getJob(jobId);
    assert.equal(job.stage, "waiting_for_page_selection", "no advance on approve");
    assert.equal(job.pageApproval?.approved, true, "durable approval on the record");
    assert.match(job.pageApproval.fingerprint, /^appr_/, "bound to staging fingerprint");
    const reloaded = readJob(outDir, SLUG, jobId);
    assert.equal(reloaded.pageApproval?.approved, true, "reload remembers approval");
  });

  it("save-after-approve invalidates: scrape refused approval-stale", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_page_selection");
    seedStaging();
    await postCmd(jobId, "ap-2a", "approve-page");
    const save = await (await fetch(`${url}/jobs/${jobId}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        links: [{ url: SOURCE, keep: true }],
        images: { [SLUG]: [{ seq: 0, keep: false }] },
      }),
    })).json();
    assert.equal(save.ok, true);
    const s = await postCmd(jobId, "ap-2b", "scrape");
    assert.equal(s.json.accepted, false);
    assert.equal(s.json.reason, "approval-stale");
    assert.equal((await getJob(jobId)).stage, "waiting_for_page_selection");
  });

  it("scrape without approval never claims scraping", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_page_selection");
    seedStaging();
    const s = await postCmd(jobId, "ap-3", "scrape");
    assert.equal(s.json.accepted, false);
    assert.equal(s.json.reason, "approval-required");
    assert.equal((await getJob(jobId)).stage, "waiting_for_page_selection");
  });

  it("approve then scrape runs: scraping on start, review-wait on success", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_page_selection");
    seedStaging();
    await postCmd(jobId, "ap-4a", "approve-page");
    const s = await postCmd(jobId, "ap-4b", "scrape");
    assert.equal(s.json.accepted, true);
    // Accept walks to scraping; the instant fake engine may already have
    // finished into waiting_for_people_review.
    assert.ok(["scraping", "waiting_for_people_review"].includes((await getJob(jobId)).stage), "scraping begins at real start");
    const { job } = await waitLedger(jobId, "ap-4b");
    assert.equal(job.stage, "waiting_for_people_review");
  });

  it("approve replay returns the disposition once", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_page_selection");
    seedStaging();
    const first = await postCmd(jobId, "ap-5", "approve-page");
    const replay = await postCmd(jobId, "ap-5", "approve-page");
    assert.deepEqual(replay.json, first.json);
    const approvals = (await getJob(jobId)).ledger.filter((e) => e && e.kind === "pipeline:approved").length;
    assert.equal(approvals, 1);
  });

  it("approve at idle refused; past the wait already-past", async () => {
    const idleId = await createJob();
    const bad = await postCmd(idleId, "ap-6a", "approve-page");
    assert.equal(bad.json.accepted, false);
    assert.equal(bad.json.reason, "bad-stage");
    const pastId = await createJob();
    toStage(pastId, "scraping");
    const past = await postCmd(pastId, "ap-6b", "approve-page");
    assert.equal(past.json.accepted, true);
    assert.equal(past.json.reason, "already-past");
  });
});

describe("finalize advances to detecting_backend exactly once", () => {
  before(startApp);
  after(async () => {
    await app?.close();
  });

  it("success lands detecting_backend; Safety owns next", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_people_review");
    seedSelection(jobId);
    const f = await postCmd(jobId, "fin-1", "finalize");
    assert.equal(f.json.accepted, true);
    assert.equal(f.json.reason, "finalized");
    assert.equal((await getJob(jobId)).stage, "detecting_backend");
    assert.equal(pageFor("detecting_backend"), "safety");
  });

  it("replay returns the disposition without double-advance", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_people_review");
    seedSelection(jobId);
    const first = await postCmd(jobId, "fin-2", "finalize");
    const before = advancedCount(await getJob(jobId));
    const replay = await postCmd(jobId, "fin-2", "finalize");
    assert.deepEqual(replay.json, first.json);
    const after = await getJob(jobId);
    assert.equal(after.stage, "detecting_backend");
    assert.equal(advancedCount(after), before);
  });

  it("empty selection stays put (fail-closed, no advance)", async () => {
    const jobId = await createJob();
    toStage(jobId, "waiting_for_people_review");
    const f = await postCmd(jobId, "fin-3", "finalize");
    assert.equal((await getJob(jobId)).stage, "waiting_for_people_review");
    void f;
  });
});

describe("spine audit idle -> dry_passed (accept-stage + completion-stage)", () => {
  before(startApp);
  after(async () => {
    await app?.close();
  });

  it("every in-progress stage begins at its real start; every success lands stable", async () => {
    const jobId = await createJob();
    assert.equal((await getJob(jobId)).stage, "idle");

    const probe = await postCmd(jobId, "au-probe", "probe");
    assert.equal(probe.json.accepted, true);
    assert.ok(["probing", "waiting_for_page_selection"].includes((await getJob(jobId)).stage));
    assert.equal((await waitLedger(jobId, "au-probe")).job.stage, "waiting_for_page_selection");

    seedStaging();
    const save = await (await fetch(`${url}/jobs/${jobId}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ links: [{ url: SOURCE, keep: true }], images: { [SLUG]: [{ seq: 0, keep: true }] } }),
    })).json();
    assert.equal(save.ok, true);
    const appr = await postCmd(jobId, "au-appr", "approve-page");
    assert.equal(appr.json.reason, "page-approved");
    assert.equal((await getJob(jobId)).stage, "waiting_for_page_selection");

    const scrape = await postCmd(jobId, "au-scrape", "scrape");
    assert.equal(scrape.json.accepted, true);
    assert.equal((await waitLedger(jobId, "au-scrape")).job.stage, "waiting_for_people_review");

    seedSelection(jobId);
    const fin = await postCmd(jobId, "au-fin", "finalize");
    assert.equal(fin.json.reason, "finalized");
    assert.equal((await getJob(jobId)).stage, "detecting_backend");

    const det = await postCmd(jobId, "au-det", "detect");
    assert.equal(det.json.accepted, true);
    assert.equal((await waitLedger(jobId, "au-det")).job.stage, "dry_running");

    writeFileSync(join(outDir, SLUG, "people.json"), JSON.stringify([
      { seq: 0, name: "A", section: "g", source_url: SOURCE, source_group: SLUG },
    ]), "utf8");
    mkdirSync(join(outDir, SLUG, "jobs", jobId), { recursive: true });
    writeFileSync(join(outDir, SLUG, "jobs", jobId, "detect.json"), JSON.stringify({
      host: "https://be.invalid", jobId, slug: SLUG, profile: null,
      department_options: [SLUG], ambiguous: [],
    }), "utf8");
    const dry = await postCmd(jobId, "au-dry", "dry", {});
    assert.equal(dry.json.reason, "dry-recorded");
    assert.equal((await getJob(jobId)).stage, "dry_passed");
  });
});
