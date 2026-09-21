#!/usr/bin/env node
// tools/e2e-walkthrough.mjs — DEV-ONLY isolated E2E driver for #43 acceptance.
// Drives the REAL UI/transport path (no CLI, no manual state edits) against
// the loopback stub backend + headed Chrome. Human preflight:
//   1. node tools/stub-backend.mjs --port 18731 --dept <slug> --out out-stub
//   2. headed Chrome --remote-debugging-port=9333 (loopback tabs only)
//   3. node tools/e2e-walkthrough.mjs [--out out-e2e] [--source URL]
// Refuses to run unless every backend/source origin is loopback.
// Usage: node tools/e2e-walkthrough.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const OUT = opt("--out", "./out-e2e");
const SOURCE = opt("--source", "http://127.0.0.1:18731/board");
// Dedicated E2E browser: never the shared 9333 (human tabs may hold real
// backends). Human preflight: headed/headless Chrome on --cdp-port alone.
const CDP_PORT = opt("--cdp-port", "9445");
const BACKEND = opt("--backend", "http://127.0.0.1:18731");

function loopbackOnly(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost";
  } catch {
    return false;
  }
}

if (!loopbackOnly(SOURCE) || !loopbackOnly(BACKEND)) {
  console.error(`e2e: refusing non-loopback source/backend`);
  process.exit(1);
}
// Engine command payloads shared by every bg step: pinned browser + backend
// so discovery can never wander onto another Chrome's tabs.
const ENG = { port: CDP_PORT, backend: BACKEND };

const { startServer } = await import("../server.mjs");
const app = await startServer({ outDir: OUT, port: 0 });
console.log(`e2e: app ${app.url} out ${OUT}`);

const post = async (jobId, commandId, type, payload = {}) => {
  const r = await fetch(`${app.url}/jobs/${jobId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, type, payload }),
  });
  return r.json();
};
const getJob = async (jobId) => (await (await fetch(`${app.url}/jobs/${jobId}`)).json()).job;
const step = (n, s) => console.log(`\n=== [${n}] ${s} ===`);

async function waitLedger(jobId, commandId, wants = ["pipeline:finished", "pipeline:failed", "pipeline:superseded"]) {
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(jobId);
    const hit = (job.ledger || []).filter((e) => e && e.commandId === commandId && wants.includes(e.kind));
    if (hit.length) return { entry: hit[hit.length - 1], job };
    if (Date.now() - t0 > 240000) throw new Error(`e2e timeout waiting ${commandId}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function waitStage(jobId, stages, timeoutMs = 240000) {
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(jobId);
    if (stages.includes(job.stage)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`e2e stage timeout at ${job.stage}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

try {
  step(1, "Create");
  const created = await (await fetch(`${app.url}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: SOURCE }),
  })).json();
  const jobId = created.jobId;
  const slug = created.job.slug;
  console.log(`job=${jobId} slug=${slug} stage=${created.job.stage}`);

  step(2, "Probe");
  console.log(JSON.stringify(await post(jobId, "e2e-probe", "probe", ENG)));
  console.log("done:", (await waitLedger(jobId, "e2e-probe")).job.stage);

  step(3, "Pages: save + approve + scrape");
  const pages = await (await fetch(`${app.url}/jobs/${jobId}/pages`)).json();
  console.log(`pending=${pages.pending} links=${pages.links.length} images=${pages.links[0]?.images?.length ?? 0}`);
  const savePayload = {
    links: pages.links.map((l) => ({ url: l.url, keep: true })),
    images: Object.fromEntries(pages.links.map((l) => [l.slug, (l.images || []).map((im) => ({ seq: im.seq, keep: true }))])),
  };
  console.log("pages-save:", JSON.stringify(await (await fetch(`${app.url}/jobs/${jobId}/pages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(savePayload),
  })).json()));
  console.log("approve:", JSON.stringify(await post(jobId, "e2e-approve", "approve-page")));
  console.log("scrape:", JSON.stringify(await post(jobId, "e2e-scrape", "scrape", ENG)));
  console.log("done:", (await waitLedger(jobId, "e2e-scrape")).job.stage);

  step(4, "Review: save + finalize");
  const review = await (await fetch(`${app.url}/jobs/${jobId}/review`)).json();
  console.log(`rev=${review.revision} rows=${review.selection.length}`);
  const selRes = await (await fetch(`${app.url}/jobs/${jobId}/review`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection: review.selection, editedFrom: review.revision }),
  })).json();
  console.log("review-save rev:", selRes.revision);
  console.log("finalize:", JSON.stringify(await post(jobId, "e2e-fin", "finalize")));
  console.log("stage:", (await getJob(jobId)).stage);

  step(5, "Detect");
  console.log("detect:", JSON.stringify(await post(jobId, "e2e-det", "detect", ENG)));
  console.log("done:", (await waitLedger(jobId, "e2e-det")).job.stage);

  step(6, "Dry (one-click server defaults)");
  const dry = await post(jobId, "e2e-dry", "dry", {});
  console.log("dry:", JSON.stringify(dry));
  console.log("stage:", (await getJob(jobId)).stage);

  step(7, "G1 + proofs");
  const safety = await (await fetch(`${app.url}/jobs/${jobId}/safety`)).json();
  console.log(`bundle=${safety.available} g1=${safety.gate1.ok} proofs=${(safety.bundle?.proofs || []).length}`);
  console.log("attestation:", safety.gate2.attestation);

  step(8, "Arm");
  const arm = await post(jobId, "e2e-arm", "arm", {
    attestedText: safety.gate2.attestation, typed: slug, clicked: true,
  });
  console.log("arm:", JSON.stringify(arm));

  step(9, "Real Upload (loopback only)");
  // Port pinned so the row runner attaches to the dedicated E2E browser.
  const up = await post(jobId, "e2e-up", "begin-upload", { port: CDP_PORT });
  console.log("begin-upload:", JSON.stringify(up));
  const doneJob = await waitStage(jobId, ["done", "failed", "cancelled"]);
  console.log("final stage:", doneJob.stage);
  console.log("save_run_id:", doneJob.save_run_id, "arm:", doneJob.arm?.state);
  const kinds = (doneJob.artifacts || []).map((a) => `${a.kind}:${(a.sha256 || "").slice(0, 12)}`);
  console.log("artifacts:", JSON.stringify(kinds));

  step(10, "Replay + idempotency");
  const replay = await post(jobId, "e2e-up", "begin-upload", {});
  console.log("replay identical:", JSON.stringify(replay) === JSON.stringify(up));

  mkdirSync(join(OUT, "e2e-evidence"), { recursive: true });
  writeFileSync(join(OUT, "e2e-evidence", `${jobId}.json`), JSON.stringify({
    jobId, slug,
    snapshot_id: doneJob.snapshot_id,
    dry_run_id: doneJob.dry_run_id,
    save_run_id: doneJob.save_run_id,
    stage: doneJob.stage,
    artifacts: doneJob.artifacts,
  }, null, 1));
  console.log(`\nE2E ${doneJob.stage === "done" ? "PASSED" : "INCOMPLETE"}: evidence in ${OUT}/e2e-evidence/${jobId}.json`);
} finally {
  // Dev script: never hang on keep-alive sockets; the job record on disk is
  // the source of truth and already persisted every step.
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
