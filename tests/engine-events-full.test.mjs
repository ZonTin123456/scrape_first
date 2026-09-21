// tests/engine-events-full.test.mjs — P4b full engine event catalog.
// Run: node --test tests/engine-events-full.test.mjs
// Verifies: full catalog (upload:plan, challenge seen/cleared/blocked,
// image-downloaded/failed, group-demoted, selection-written, finalized,
// report-written) at authoritative Wrap points behind flag, payloads are
// notifications/references only, unknown-type handling per Transport
// contract, terminal/files unchanged, CLI intact.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub, validateEnvelope, formatSSE, KNOWN_TYPES } from "../jobs/events.mjs";
import {
  P4A_TYPES,
  P4B_TYPES,
  FULL_ENGINE_TYPES,
  isEngineEventsEnabled,
  createEngineEmitter,
} from "../jobs/engine-events.mjs";
import { createJob, writeJob } from "../jobs/store.mjs";
import { startServer } from "../server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

let savedJobEvents;
beforeEach(() => {
  savedJobEvents = process.env.JOB_EVENTS;
});
afterEach(() => {
  if (savedJobEvents === undefined) delete process.env.JOB_EVENTS;
  else process.env.JOB_EVENTS = savedJobEvents;
});

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p4b-engine-"));
}

function parseFrames(text) {
  const frames = [];
  for (const chunk of text.split("\n\n")) {
    const t = chunk.trim();
    if (!t) continue;
    let id = null;
    let event = null;
    const dataLines = [];
    for (const line of t.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    frames.push({ id, event, data: JSON.parse(dataLines.join("\n")) });
  }
  return frames;
}

async function getEventsOnce(url, jobId, { since = null, lastId = null } = {}) {
  let target = `${url}/jobs/${jobId}/events?once=1`;
  if (since != null) target += `&since=${encodeURIComponent(since)}`;
  const headers = {};
  if (lastId != null) headers["Last-Event-ID"] = lastId;
  const r = await fetch(target, { headers });
  const text = await r.text();
  return { status: r.status, text, frames: parseFrames(text) };
}

describe("P4b full catalog allowlist (P4a trio/row/artifact extended)", () => {
  it("P4A stays 5 for compat, P4B adds 10, FULL is 15 and all known to transport", () => {
    assert.deepEqual(
      [...P4A_TYPES].sort(),
      ["artifact:written", "scrape:url-failed", "scrape:url-finished", "scrape:url-started", "upload:row-finished"].sort()
    );
    assert.equal(P4B_TYPES.size, 10);
    assert.deepEqual(
      [...P4B_TYPES].sort(),
      [
        "upload:plan",
        "challenge:seen",
        "challenge:cleared",
        "challenge:blocked",
        "scrape:image-downloaded",
        "scrape:image-failed",
        "scrape:group-demoted",
        "review:selection-written",
        "review:finalized",
        "upload:report-written",
      ].sort()
    );
    assert.equal(FULL_ENGINE_TYPES.size, 15);
    for (const t of FULL_ENGINE_TYPES) {
      assert.ok(P4A_TYPES.has(t) || P4B_TYPES.has(t), `FULL member ${t} from P4A/P4B`);
      assert.ok(KNOWN_TYPES.has(t), `FULL member ${t} known to jobs/events.mjs transport`);
    }
  });

  it("typed emitters emit full catalog with clean reference payloads", () => {
    delete process.env.JOB_EVENTS;
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "full-1", emitEvents: true });
    assert.equal(em.enabled, true);

    const plan = em.uploadPlan({
      slug: "s",
      mode: "dry",
      total: 2,
      plan: [
        { group: "g1", action: "upload", target: "https://be/personal/1", via: "exact" },
        { group: "g2", action: "would-create", target: null },
      ],
    });
    assert.equal(plan.type, "upload:plan");
    assert.equal(plan.payload.slug, "s");
    assert.equal(plan.payload.total, 2);
    assert.equal(plan.payload.plan.length, 2);

    const seen = em.challengeSeen({ url: "https://a.go.th/x", phase: "auto-wait" });
    assert.equal(seen.type, "challenge:seen");
    const cleared = em.challengeCleared({ url: "https://a.go.th/x", elapsedMs: 123 });
    assert.equal(cleared.type, "challenge:cleared");
    const blocked = em.challengeBlocked({ url: "https://a.go.th/x", reason: "wall" });
    assert.equal(blocked.type, "challenge:blocked");

    const dl = em.imageDownloaded({ seq: 1, file: "images/0001-100x100.jpg", bytes: 1234, via: "fetch", url: "https://a.go.th/x" });
    assert.equal(dl.type, "scrape:image-downloaded");
    assert.equal(dl.payload.seq, 1);
    const fail = em.imageFailed({ seq: 2, src: "https://a.go.th/i.png", error: "http 403", via: "cdp" });
    assert.equal(fail.type, "scrape:image-failed");
    assert.match(fail.payload.error, /403/);

    const dem = em.groupDemoted({ url: "https://a.go.th/x", seq: 3, previous: "A", demoted: "B", kept: "C", reason: "tainted" });
    assert.equal(dem.type, "scrape:group-demoted");
    assert.equal(dem.payload.seq, 3);

    const sel = em.selectionWritten({ slug: "s", dir: "out/s", count: 4, relPath: "s/review/selection.json" });
    assert.equal(sel.type, "review:selection-written");
    assert.equal(sel.payload.count, 4);

    const fin = em.finalized({ slug: "s", dir: "out/s", kept: 4, removed: 1, counts: { image: 4 } });
    assert.equal(fin.type, "review:finalized");
    assert.equal(fin.payload.kept, 4);

    const rep = em.reportWritten({ slug: "s", mode: "dry", total: 2, byStatus: { dry: 2 }, relPath: "report-s.json" });
    assert.equal(rep.type, "upload:report-written");
    assert.equal(rep.payload.mode, "dry");

    // Generic emit accepts full catalog too (P4b extends safeEmit).
    assert.ok(em.emit("upload:plan", { slug: "s", plan: [] }));
    assert.ok(em.emit("challenge:seen", { url: "https://a/x" }));
    assert.ok(em.emit("scrape:group-demoted", { seq: 1 }));
    // Non-engine transport types stay out.
    assert.equal(em.emit("job:advanced", {}), null);
    assert.equal(em.emit("arm:granted", {}), null);

    const replay = hub.replay("full-1", null);
    assert.ok(replay.events.length >= 10, `full catalog buffered, got ${replay.events.length}`);
    const seqs = replay.events.map((e) => e.seq);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
    assert.ok(replay.events.every((e) => e.streamId === replay.events[0].streamId), "same epoch");
  });

  it("validators: bad full-catalog inputs return null, never throw", () => {
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "valid-full", emitEvents: true });
    assert.equal(em.uploadPlan({ slug: "s" }), null, "plan array required");
    assert.equal(em.uploadPlan({ plan: "nope" }), null);
    assert.equal(em.challengeSeen({}), null, "url required");
    assert.equal(em.challengeCleared({}), null);
    assert.equal(em.challengeBlocked({}), null);
    assert.equal(em.imageDownloaded({}), null, "seq required");
    assert.equal(em.imageDownloaded({ seq: 1, bytes: -5 }), null, "bytes int>=0");
    assert.equal(em.imageFailed({}), null);
    assert.equal(em.groupDemoted({}), null, "seq required");
    assert.equal(em.selectionWritten({}), null, "count/slug/dir required");
    assert.equal(em.finalized({}), null, "slug/dir required");
    assert.equal(em.reportWritten({}), null, "mode/total/slug required");
    assert.equal(em.reportWritten({ mode: "dry", total: 1, byStatus: [] }), null, "byStatus object required");
    assert.equal(hub.getStream("valid-full"), null, "invalid inputs emit nothing");
  });

  it("disabled emitter returns null for full catalog and touches nothing", () => {
    delete process.env.JOB_EVENTS;
    const hub = createHub();
    const off = createEngineEmitter({ hub, jobId: "off-full" });
    assert.equal(off.enabled, false);
    assert.equal(off.uploadPlan({ slug: "s", plan: [] }), null);
    assert.equal(off.challengeSeen({ url: "https://a/x" }), null);
    assert.equal(off.challengeCleared({ url: "https://a/x" }), null);
    assert.equal(off.challengeBlocked({ url: "https://a/x" }), null);
    assert.equal(off.imageDownloaded({ seq: 1 }), null);
    assert.equal(off.imageFailed({ seq: 1, error: "x" }), null);
    assert.equal(off.groupDemoted({ seq: 1 }), null);
    assert.equal(off.selectionWritten({ slug: "s", count: 1 }), null);
    assert.equal(off.finalized({ slug: "s" }), null);
    assert.equal(off.reportWritten({ slug: "s", mode: "dry", total: 1 }), null);
    assert.equal(hub.getStream("off-full"), null);
  });
});

describe("P4b payloads are notifications/references only", () => {
  it("no authoritative state, no inline bytes in any full-catalog payload", () => {
    const hub = createHub();
    const em = createEngineEmitter({ hub, jobId: "refs-1", emitEvents: true });
    em.uploadPlan({ slug: "s", mode: "dry", total: 1, plan: [{ group: "g", action: "upload", target: "https://be/p/1" }] });
    em.challengeSeen({ url: "https://a/x" });
    em.challengeCleared({ url: "https://a/x" });
    em.challengeBlocked({ url: "https://a/x", reason: "wall" });
    em.imageDownloaded({ seq: 1, file: "images/0001.jpg", bytes: 10, via: "fetch", url: "https://a/x" });
    em.imageFailed({ seq: 2, src: "https://a/i.png", error: "http 403" });
    em.groupDemoted({ url: "https://a/x", seq: 1, previous: "A", demoted: "B", kept: "C", reason: "r" });
    em.selectionWritten({ slug: "s", count: 2, relPath: "s/review/selection.json" });
    em.finalized({ slug: "s", dir: "out/s", kept: 2, removed: 0, counts: { image: 2 } });
    em.reportWritten({ slug: "s", mode: "dry", total: 2, byStatus: { dry: 2 }, relPath: "report-s.json" });
    const { events } = hub.replay("refs-1", null);
    assert.equal(events.length, 10);
    for (const env of events) {
      const v = validateEnvelope(env);
      assert.equal(v.ok, true, `${env.type} envelope ok`);
      assert.equal(v.action, "accept", `${env.type} known type accepted`);
      assert.equal(env.v, 1);
      assert.equal(env.jobId, "refs-1");
      const p = env.payload || {};
      assert.ok(!p.job || !p.job.ledger, `${env.type}: no job dump`);
      assert.ok(!("ledger" in p), `${env.type}: no ledger`);
      assert.ok(!("nodes" in p), `${env.type}: no nodes`);
      assert.ok(!("results" in p), `${env.type}: no full results (counts only)`);
      for (const k of ["bytes", "inline", "base64", "blob", "buffer", "content", "data"]) {
        assert.ok(!(k in p), `${env.type}: payload must not inline ${k}`);
      }
      const frame = formatSSE(env);
      assert.match(frame, new RegExp(`id:\\s*${env.streamId}:${env.seq}`));
    }
    // upload:plan carries group/action/target refs, never people rows.
    const planEv = events.find((e) => e.type === "upload:plan");
    assert.ok(planEv.payload.plan.every((e) => e.group && e.action), "plan entries are group/action refs");
    assert.ok(!planEv.payload.plan.some((e) => "photo" in e || "order" in e && "name" in e && "seq" in e && e.photo), "plan never carries people rows");
    // upload:report-written carries counts, never results.
    const repEv = events.find((e) => e.type === "upload:report-written");
    assert.deepEqual(repEv.payload.byStatus, { dry: 2 });
  });
});

describe("P4b unknown-type handling (Transport: ignorable iff v supported)", () => {
  it("unknown type with v:1 ignorable, unknown v resyncs never silent, full catalog accepted", () => {
    const good = { v: 1, streamId: "s_1", seq: 1, jobId: "j", type: "bogus:future", at: new Date().toISOString(), payload: {} };
    const r1 = validateEnvelope(good);
    assert.equal(r1.ok, true);
    assert.equal(r1.action, "ignore");
    assert.equal(r1.reason, "unknown-type");

    const badV = { ...good, v: 99, type: "scrape:url-started" };
    const r2 = validateEnvelope(badV);
    assert.equal(r2.ok, false);
    assert.equal(r2.action, "resync");
    assert.equal(r2.reason, "unknown-version");

    const badVUnknown = { ...good, v: 2, type: "bogus:future" };
    const r3 = validateEnvelope(badVUnknown);
    assert.equal(r3.ok, false);
    assert.equal(r3.action, "resync");

    for (const t of [...FULL_ENGINE_TYPES]) {
      const r = validateEnvelope({ v: 1, streamId: "s_1", seq: 1, jobId: "j", type: t, at: new Date().toISOString(), payload: {} });
      assert.equal(r.ok, true, `${t} accepted`);
      assert.equal(r.action, "accept", `${t} accepted`);
    }
    for (const t of ["challenge:seen", "challenge:cleared", "challenge:blocked"]) {
      assert.ok(KNOWN_TYPES.has(t), `${t} in transport KNOWN_TYPES (added in P4b)`);
    }
  });
});

describe("P4b Wrap points at authoritative mutation sites (static wiring)", () => {
  it("backup-page emits full catalog at inventory sites behind flag", () => {
    const bp = src("backup-page.mjs");
    assert.ok(bp.includes('process.env.JOB_EVENTS === "1"'), "gates events behind flag");
    // CF wait 312-336.
    assert.ok(bp.includes("challengeSeen"), "CF wait emits challenge:seen");
    assert.ok(bp.includes("challengeCleared"), "CF wait emits challenge:cleared");
    assert.ok(bp.includes("challengeBlocked"), "CF wait emits challenge:blocked");
    assert.ok(bp.includes("waitForChallengeClear"), "CF helper present");
    // downloadQueue 383-419.
    assert.ok(bp.includes("imageDownloaded"), "downloadQueue emits image-downloaded");
    assert.ok(bp.includes("imageFailed"), "downloadQueue emits image-failed");
    assert.ok(bp.includes("downloadQueue"), "downloadQueue present");
    // group-demoted 430.
    assert.ok(bp.includes("groupDemoted"), "scrapeOne emits group-demoted");
    assert.ok(bp.includes("group-integrity:"), "CLI group-integrity line unchanged");
    // selection-written 691-699.
    assert.ok(bp.includes("selectionWritten"), "writeReview emits selection-written");
    // finalized 750-827.
    assert.ok(bp.includes("__engine?.finalized"), "finalize emits review:finalized");
    // report-written/summary 829-842 (artifact pointer, P4a carries forward).
    assert.ok(bp.includes("__emitArtifact"), "artifact:written at file writes");
    // P4a trio still present.
    assert.ok(bp.includes("__engine?.urlStarted"), "trio started at URL loop");
    assert.ok(bp.includes("__engine?.urlFinished"), "trio finished at URL loop");
    assert.ok(bp.includes("__engine?.urlFailed"), "trio failed at URL loop");
  });

  it("upload-people emits plan + report behind flag, row loop unchanged", () => {
    const up = src("uploader/upload-people.mjs");
    assert.ok(up.includes('process.env.JOB_EVENTS === "1"'), "gates events behind flag");
    assert.ok(up.includes("uploadPlan"), "plan site 221-256 emits upload:plan");
    assert.ok(up.includes("__pushRow"), "row loop 309-450 emits per row");
    assert.ok(up.includes("rowFinished"), "row-finished payload");
    assert.ok(up.includes("reportWritten"), "report site 480-483 emits upload:report-written");
    assert.ok(up.includes("__emitArtifact"), "artifact:written for report/shots");
    assert.ok(up.includes("mode=${report.mode}"), "CLI report line unchanged");
  });

  it("CLI terminal lines preserved verbatim, pipeline stays CLI (P7 owns DAG ops)", () => {
    const bp = src("backup-page.mjs");
    const up = src("uploader/upload-people.mjs");
    const pipe = src("pipeline.mjs");
    assert.ok(bp.includes("OK ${r.url} -> ${r.dir}") || bp.includes("OK ${r.url}"), "CLI OK line unchanged");
    assert.ok(bp.includes("finalized ${dir}:"), "CLI finalized line unchanged");
    assert.ok(bp.includes("summary:"), "CLI summary line unchanged");
    assert.ok(up.includes("report:"), "CLI report path line unchanged");
    // Pipeline DAG stays CLI in P4b; P7 converts sh/pause to job ops.
    assert.ok(pipe.includes("spawnSync"), "pipeline sh still spawnSync (P7 owns conversion)");
    assert.ok(pipe.includes("readFileSync(0)"), "pipeline pause still stdin (P7 owns gate)");
    assert.ok(!pipe.includes("createEngineEmitter"), "pipeline has no engine emitter in P4b");
  });

  it("no log parsing into state, engine has no browser/CLI coupling", () => {
    const eng = src("jobs/engine-events.mjs");
    const ev = src("jobs/events.mjs");
    const srv = src("server.mjs");
    for (const [name, text] of [["engine-events", eng], ["events", ev], ["server", srv]]) {
      assert.ok(!text.includes("fs.watch"), `${name}: no fs.watch transport`);
      assert.ok(!text.includes("watchFile"), `${name}: no watchFile`);
      assert.ok(!/parse.*\.log/i.test(text), `${name}: logs never parsed`);
    }
    assert.ok(!eng.includes("spawnSync"), "engine: no spawnSync on UI path");
    assert.ok(!eng.includes("child_process"), "engine: no child_process");
    assert.ok(!eng.includes("readFileSync(0)"), "engine: no stdin pause");
    const targets = [...eng.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const t of targets) {
      assert.ok(t.startsWith("node:") || t.startsWith("./") || t.startsWith("../"), `non-builtin import: ${t}`);
    }
    for (const re of [/playwright/i, /backup-page/, /pipeline/, /upload-people/, /automap/, /sectioning/, /child_process/, /electron/i, /tauri/i, /spawnSync/]) {
      for (const t of targets) assert.ok(!re.test(t), `banned import in engine-events: ${t}`);
    }
    assert.ok(eng.includes("./events.mjs"), "wraps jobs/events hub, no parallel emitter");
    assert.ok(!eng.includes("createHub("), "engine never creates its own hub (caller passes hub)");
  });
});

describe("P4b SSE via server hub for full catalog", () => {
  it("full events bound to server hub appear over SSE with cursor replay", async () => {
    const outDir = tmpOut();
    writeJob(outDir, createJob({ slug: "s", source: "https://a.go.th/x", jobId: "sse-full" }));
    const app = await startServer({ outDir, port: 0 });
    try {
      const em = createEngineEmitter({ hub: app.hub, jobId: "sse-full", emitEvents: true });
      em.uploadPlan({ slug: "s", mode: "dry", total: 1, plan: [{ group: "g", action: "upload", target: "https://be/p/1" }] });
      em.challengeSeen({ url: "https://a.go.th/x" });
      em.challengeCleared({ url: "https://a.go.th/x" });
      em.imageDownloaded({ seq: 1, file: "images/0001.jpg", bytes: 10, via: "fetch" });
      em.imageFailed({ seq: 2, error: "http 403" });
      em.groupDemoted({ url: "https://a.go.th/x", seq: 1, previous: "A", demoted: "B", kept: "C" });
      em.selectionWritten({ slug: "s", count: 2, relPath: "s/review/selection.json" });
      em.finalized({ slug: "s", dir: "out/s", kept: 2, removed: 0 });
      em.reportWritten({ slug: "s", mode: "dry", total: 1, byStatus: { dry: 1 } });

      const first = await getEventsOnce(app.url, "sse-full");
      assert.equal(first.status, 200);
      const types = first.frames.map((f) => f.data.type);
      for (const t of ["upload:plan", "challenge:seen", "challenge:cleared", "scrape:image-downloaded", "scrape:image-failed", "scrape:group-demoted", "review:selection-written", "review:finalized", "upload:report-written"]) {
        assert.ok(types.includes(t), `SSE shows ${t}, got ${types}`);
      }
      for (const f of first.frames) {
        assert.equal(f.data.v, 1);
        assert.equal(f.data.jobId, "sse-full");
        assert.equal(f.event, f.data.type);
      }
      const cur = first.frames[0].data;
      const replay = await getEventsOnce(app.url, "sse-full", { lastId: `${cur.streamId}:${cur.seq}` });
      assert.ok(replay.frames.length >= 1);
      assert.equal(replay.frames[replay.frames.length - 1].data.streamId, cur.streamId);
    } finally {
      await app.close();
    }
  });
});

describe("P4b terminal/files unchanged + logs display-only", () => {
  it("Wrap with full emitter on/off writes identical files and identical console", () => {
    const dir = tmpOut();
    function fakeWrap({ emitter, tag }) {
      const abs = join(dir, `content-${tag}.json`);
      const payload = { manifest: { source_url: "https://a.go.th/x" }, nodes: [{ seq: 1 }] };
      writeFileSync(abs, JSON.stringify(payload, null, 1), "utf8");
      console.log(`OK https://a.go.th/x -> ${abs}`);
      console.error(`group-integrity: display-only note`);
      console.log(`finalized ${abs}: kept 1 images, removed 0`);
      emitter?.urlFinished({ url: "https://a.go.th/x", slug: "x", dir: abs });
      emitter?.uploadPlan({ slug: "x", mode: "dry", total: 1, plan: [{ group: "g", action: "upload", target: "https://be/p/1" }] });
      emitter?.challengeSeen({ url: "https://a.go.th/x" });
      emitter?.challengeCleared({ url: "https://a.go.th/x" });
      emitter?.imageDownloaded({ seq: 1, file: "images/0001.jpg", bytes: 10, via: "fetch" });
      emitter?.imageFailed({ seq: 2, error: "http 403" });
      emitter?.groupDemoted({ url: "https://a.go.th/x", seq: 1, previous: "A", demoted: "B", kept: "C" });
      emitter?.selectionWritten({ slug: "x", count: 1, relPath: "x/review/selection.json" });
      emitter?.finalized({ slug: "x", dir: abs, kept: 1, removed: 0 });
      emitter?.reportWritten({ slug: "x", mode: "dry", total: 1, byStatus: { dry: 1 } });
      emitter?.artifactFromFile({ absPath: abs, relPath: `x/content-${tag}.json`, kind: "content" });
      return abs;
    }
    function capture(fn) {
      const out = [];
      const err = [];
      const olog = console.log;
      const oerr = console.error;
      console.log = (...a) => out.push(a.join(" "));
      console.error = (...a) => err.push(a.join(" "));
      try {
        const ret = fn();
        return { ret, out, err };
      } finally {
        console.log = olog;
        console.error = oerr;
      }
    }
    delete process.env.JOB_EVENTS;
    const hubOff = createHub();
    const off = createEngineEmitter({ hub: hubOff, jobId: "t-full" });
    const rOff = capture(() => fakeWrap({ emitter: off, tag: "off" }));

    const hubOn = createHub();
    const on = createEngineEmitter({ hub: hubOn, jobId: "t-full", emitEvents: true });
    const rOn = capture(() => fakeWrap({ emitter: on, tag: "on" }));

    assert.deepEqual(rOn.out, rOff.out.map((s) => s.replace("content-off", "content-on")));
    assert.deepEqual(rOn.err, rOff.err);
    const hOff = createHash("sha256").update(readFileSync(rOff.ret)).digest("hex");
    const hOn = createHash("sha256").update(readFileSync(rOn.ret)).digest("hex");
    assert.equal(hOff, hOn, "emitter on/off must not alter file bytes");
    assert.equal(hubOff.getStream("t-full"), null);
    assert.equal(hubOn.replay("t-full", null).events.length, 11);
  });
});
