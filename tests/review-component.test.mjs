// tests/review-component.test.mjs — P5 review-first wide component.
// Run: node --test tests/review-component.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";
import { createJob, writeJob, advance, readJob } from "../jobs/store.mjs";
import { assertArtifactPointer } from "../jobs/events.mjs";
import {
  coerceOrder,
  suggestOrders,
  buildInitialSelection,
  applyBulkAssign,
  keptOnly,
  effectiveSort,
  detectDuplicates,
  validateForFinalize,
  buildWarningPreview,
  fingerprintSelection,
  seedReview,
  importScrapeSelection,
  loadReviewModel,
  groupBySrc,
} from "../jobs/review.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478d6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "p5-review-"));
}

function makeJob(outDir, slug = "s1") {
  const job = createJob({ slug, source: "https://example.go.th/p1", group: "g" });
  const path = ["probing", "waiting_for_page_selection", "scraping", "waiting_for_people_review"];
  for (const s of path) advance(job, s);
  writeJob(outDir, job);
  return job;
}

function cands() {
  return [
    { seq: 0, file: "review/files/a.png", top: 10 },
    { seq: 1, file: "review/files/b.png", top: 12 },
    { seq: 2, file: "review/files/c.png", top: 100 },
    { seq: 3, file: "review/files/d.png", top: 102 },
  ];
}

function writeThumbs(outDir, job) {
  for (const c of cands()) {
    const abs = join(outDir, job.slug, "jobs", job.jobId, c.file);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, PNG);
  }
}

describe("P5 pure semantics: engine owns order/bulk/dup/sort", () => {
  it("coerceOrder: invalid -> 0, valid kept", () => {
    assert.equal(coerceOrder(""), 0);
    assert.equal(coerceOrder(null), 0);
    assert.equal(coerceOrder(undefined), 0);
    assert.equal(coerceOrder("abc"), 0);
    assert.equal(coerceOrder(-1), 0);
    assert.equal(coerceOrder("-3"), 0);
    assert.equal(coerceOrder(2.5), 0);
    assert.equal(coerceOrder("2.5"), 0);
    assert.equal(coerceOrder(0), 0);
    assert.equal(coerceOrder("3"), 3);
    assert.equal(coerceOrder(7), 7);
  });

  it("suggestOrders groups visual rows (ROW_TOL parity)", () => {
    const groups = suggestOrders(cands());
    assert.deepEqual(groups, [0, 0, 1, 1]);
  });

  it("buildInitialSelection: keep true + suggested orders", () => {
    const sel = buildInitialSelection(cands());
    assert.equal(sel.length, 4);
    for (const r of sel) assert.equal(r.keep, true);
    assert.deepEqual(sel.map((r) => r.order), [0, 0, 1, 1]);
    for (const r of sel) {
      assert.ok(Number.isInteger(r.seq));
      assert.ok(typeof r.file === "string" && r.file);
      assert.ok(Number.isInteger(r.order));
    }
  });

  it("applyBulkAssign is checked-only", () => {
    const sel = buildInitialSelection(cands());
    const out = applyBulkAssign(sel, [0, 2], 9);
    assert.equal(out.find((r) => r.seq === 0).order, 9);
    assert.equal(out.find((r) => r.seq === 2).order, 9);
    assert.equal(out.find((r) => r.seq === 1).order, 0);
    assert.equal(out.find((r) => r.seq === 3).order, 1);
  });

  it("dup-allowed but warned + effective sort (order,seq)", () => {
    const sel = [
      { seq: 2, file: "review/files/c.png", keep: true, order: 0 },
      { seq: 0, file: "review/files/a.png", keep: true, order: 0 },
      { seq: 1, file: "review/files/b.png", keep: true, order: 1 },
    ];
    const kept = keptOnly(sel);
    assert.equal(kept.length, 3);
    const sorted = effectiveSort(kept);
    assert.deepEqual(sorted.map((r) => r.seq), [0, 2, 1]);
    const dups = detectDuplicates(kept);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].order, 0);
    assert.deepEqual(dups[0].seqs, [0, 2]);
    const preview = buildWarningPreview(sel);
    assert.ok(preview.warnings.length >= 1);
    assert.match(preview.warnings[0], /duplicate orders/);
    assert.deepEqual(preview.effectiveOrder.map((e) => e.seq), [0, 2, 1]);
  });

  it("groupBySrc keeps src-grouping + anyNamed defaults in service", () => {
    const groups = groupBySrc([
      { slug: "p1", images: [{ src: "https://x/a.png", name: "Anna", likely_header: false }] },
      { slug: "p2", images: [{ src: "https://x/a.png", name: "", likely_header: false }] },
      { slug: "p1", images: [{ src: "https://x/b.png", name: "", likely_header: true }] },
    ]);
    const a = groups.find((g) => g.src === "https://x/a.png");
    const b = groups.find((g) => g.src === "https://x/b.png");
    assert.equal(a.keep, true);
    assert.deepEqual(a.pages.sort(), ["p1", "p2"]);
    assert.equal(b.keep, false);
  });
});

describe("P5 server: POST-only save, stale conflict, preview, thumbs", () => {
  let app;
  before(async () => {
    app = await startServer({ outDir: mkdtempSync(join(tmpdir(), "p5-srv-")), port: 0 });
  });
  after(async () => {
    await app?.close();
  });

  async function seed() {
    const outDir = app.outDir;
    const job = makeJob(outDir, `s${Date.now()}${Math.floor(Math.random() * 1e6)}`);
    seedReview(outDir, job, cands());
    writeJob(outDir, job);
    writeThumbs(outDir, job);
    return job;
  }

  it("POST-only save bumps revision + returns fingerprint; GET never writes", async () => {
    const job = await seed();
    const r1 = await fetch(`${app.url}/jobs/${job.jobId}/review`);
    assert.equal(r1.status, 200);
    const m1 = await r1.json();
    assert.equal(m1.revision, 1);
    assert.ok(m1.fingerprint);
    assert.ok(Array.isArray(m1.selection) && m1.selection.length === 4);
    // Compatible selection output schema.
    for (const row of m1.selection) {
      assert.deepEqual(Object.keys(row).sort(), ["file", "keep", "order", "seq"]);
    }
    const draft = m1.selection.map((r) => ({ ...r, keep: r.seq !== 3, order: r.seq === 0 ? 5 : r.order }));
    const s1 = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: draft, editedFrom: m1.revision }),
    });
    assert.equal(s1.status, 200);
    const b1 = await s1.json();
    assert.equal(b1.ok, true);
    assert.equal(b1.revision, 2);
    assert.ok(b1.fingerprint);
    const r2 = await fetch(`${app.url}/jobs/${job.jobId}/review`);
    const m2 = await r2.json();
    assert.equal(m2.revision, 2);
    assert.equal(m2.selection.find((r) => r.seq === 3).keep, false);
    assert.equal(m2.selection.find((r) => r.seq === 0).order, 5);
    // Emits artifact:written + review:selection-written via SSE buffer.
    const ev = await fetch(`${app.url}/jobs/${job.jobId}/events?once=1&since=0`);
    const text = await ev.text();
    assert.match(text, /review:selection-written/);
    assert.match(text, /artifact:written/);
  });

  it("stale conflict: old editedFrom never last-wins", async () => {
    const job = await seed();
    const m1 = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    const first = m1.selection.map((r) => ({ ...r, order: 1 }));
    const ok = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: first, editedFrom: m1.revision }),
    });
    assert.equal(ok.status, 200);
    // Second save with the same (now stale) editedFrom must conflict.
    const stale = m1.selection.map((r) => ({ ...r, order: 9 }));
    const c = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: stale, editedFrom: m1.revision }),
    });
    assert.equal(c.status, 409);
    const cb = await c.json();
    assert.equal(cb.ok, false);
    assert.equal(cb.reason, "stale-conflict");
    // Stored draft unchanged (still order 1, not 9).
    const cur = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.equal(cur.revision, m1.revision + 1);
    for (const r of cur.selection) assert.equal(r.order, 1);
  });

  it("HTTP-pointer thumbs: localhost HTTP only, never file:// nor inline", async () => {
    const job = await seed();
    const m = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.ok(m.thumbs.length >= 4);
    for (const t of m.thumbs) {
      assert.ok(typeof t.url === "string");
      assert.ok(!t.url.startsWith("file://"), `file:// banned: ${t.url}`);
      assert.ok(!t.url.startsWith("data:"), `inline banned: ${t.url}`);
      assert.match(t.url, /\/jobs\/.+\/review\/thumbs\//);
      // Pointer-only: no inline payload keys on the wire model.
      assert.equal(t.bytes ?? null, null);
      assert.equal(t.blob ?? null, null);
      assert.equal(t.data ?? null, null);
      assert.equal(t.base64 ?? null, null);
      const absolute = t.url.startsWith("http") ? t.url : `${app.url}${t.url}`;
      assert.match(absolute, /^http:\/\/(127\.0\.0\.1|localhost)/);
      const r = await fetch(absolute);
      assert.equal(r.status, 200);
      const ct = r.headers.get("content-type") || "";
      assert.match(ct, /image|octet-stream/);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.ok(buf.length > 0);
      assert.deepEqual(buf.subarray(0, 4), PNG.subarray(0, 4));
    }
    // No file:// or inline bytes anywhere in model JSON.
    const raw = JSON.stringify(m);
    assert.ok(!raw.includes("file://"));
    assert.ok(!raw.includes("data:image"));
    assert.ok(!raw.includes("base64"));
  });

  it("server warning preview is non-persisting (same shared logic)", async () => {
    const job = await seed();
    const m = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    const duped = m.selection.map((r) => ({ ...r, keep: true, order: 0 }));
    const p = await fetch(`${app.url}/jobs/${job.jobId}/review/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: duped }),
    });
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.persisted, false);
    assert.ok(pb.warnings.length >= 1);
    assert.match(pb.warnings[0], /duplicate orders/);
    // Nothing persisted: revision + disk unchanged.
    const after = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.equal(after.revision, m.revision);
    assert.deepEqual(after.selection, m.selection);
    // GET warnings agrees without persisting.
    const w = await (await fetch(`${app.url}/jobs/${job.jobId}/review/warnings`)).json();
    assert.equal(w.persisted, false);
    assert.equal(w.revision, m.revision);
  });

  it("fingerprint detects out-of-band disk edits -> stale/disarmed save", async () => {
    const job = await seed();
    const m = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    // Out-of-band edit: bypass POST, rewrite the file directly.
    const selPath = join(app.outDir, job.slug, "jobs", job.jobId, "review", "selection.json");
    const tampered = m.selection.map((r) => ({ ...r, keep: r.seq !== 0 }));
    writeFileSync(selPath, JSON.stringify(tampered, null, 1), "utf8");
    const stale = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    assert.equal(stale.stale, true);
    assert.equal(stale.staleReason, "fingerprint-mismatch");
    // POST with the (numerically current) revision still conflicts on fingerprint drift.
    const c = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: m.selection, editedFrom: m.revision }),
    });
    assert.equal(c.status, 409);
    assert.equal((await c.json()).reason, "stale-conflict");
  });

  it("parity: POST output is schema-compatible selection.json consumed unchanged by finalize logic", async () => {
    const job = await seed();
    const m = await (await fetch(`${app.url}/jobs/${job.jobId}/review`)).json();
    const draft = m.selection.map((r) => ({ ...r, keep: r.seq !== 2, order: r.seq === 0 ? 3 : r.seq === 1 ? 3 : 7 }));
    const s = await fetch(`${app.url}/jobs/${job.jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: draft, editedFrom: m.revision }),
    });
    assert.equal(s.status, 200);
    // Disk file is the CLI contract: [{seq,file,keep,order}].
    const selPath = join(app.outDir, job.slug, "jobs", job.jobId, "review", "selection.json");
    const onDisk = JSON.parse(readFileSync(selPath, "utf8"));
    assert.ok(Array.isArray(onDisk));
    for (const row of onDisk) assert.deepEqual(Object.keys(row).sort(), ["file", "keep", "order", "seq"]);
    // Finalize-equivalent consumption (mirrors backup-page.mjs finalize keep-filter,
    // explicit orders, free-fill, (order,seq) sort, dup-warn) matches shared service.
    const v = validateForFinalize(onDisk);
    const keep = new Set(onDisk.filter((x) => x.keep).map((x) => x.seq));
    assert.ok(!keep.has(2));
    assert.ok(keep.has(0) && keep.has(1));
    const eff = v.effectiveOrder;
    // Orders 3,3,7 with kept seqs 0,1,3 -> sorted (order,seq): 0@3,1@3,3@7.
    assert.deepEqual(eff.map((e) => e.seq), [0, 1, 3]);
    assert.ok(v.warnings.some((w) => w.includes("duplicate orders")));
    assert.ok(v.warnings.some((w) => w.includes("3 (seq 0,1)")));
    // Fingerprint of stored draft matches server-returned fingerprint.
    assert.equal(fingerprintSelection(onDisk), (await s.json()).fingerprint ?? fingerprintSelection(onDisk));
  });

  it("legacy builders untouched; no iframe; no file/inline previews", () => {
    const cli = readFileSync(join(root, "backup-page.mjs"), "utf8");
    for (const name of ["pickLinksHTML", "masterPickHTML", "pickImagesHTML", "reviewHTML", "writeReview"]) {
      assert.ok(cli.includes(name), `legacy builder stays: ${name}`);
    }
    const shell = readFileSync(join(root, "web", "shell.html"), "utf8");
    const stageMap = readFileSync(join(root, "web", "js", "stage-map.js"), "utf8");
    const activity = readFileSync(join(root, "web", "js", "activity.js"), "utf8");
    for (const src of [shell, stageMap, activity]) {
      assert.ok(!/<iframe/i.test(src), "no iframe in light shell");
      assert.ok(!/src=["']file:\/\//i.test(src), "no file:// thumbs");
      assert.ok(!/href=["']file:\/\//i.test(src), "no file:// links");
      assert.ok(!/src=["']data:/i.test(src), "no inline bytes in light shell");
    }
    assert.match(stageMap, /waiting_for_people_review/);
    assert.match(shell, /activity-mount/);
    assert.match(activity, /<details/);
  });
});

describe("P5 scrape->review handoff: importScrapeSelection seeds once", () => {
  it("seeds rev 1 from slug selection; second call already-seeded; missing file reports missing", () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s1", source: "https://example.go.th/p1", group: "g" });
    writeJob(outDir, job);
    assert.deepEqual(importScrapeSelection(outDir, job), { status: "missing" });
    mkdirSync(join(outDir, "s1", "review"), { recursive: true });
    writeFileSync(join(outDir, "s1", "review", "selection.json"),
      JSON.stringify([{ seq: 0, file: "images/0000-100x100.jpg", keep: true, order: 0 }]), "utf8");
    const seeded = importScrapeSelection(outDir, job);
    assert.equal(seeded.status, "seeded");
    assert.equal(seeded.revision, 1);
    assert.equal(seeded.kept, 1);
    writeJob(outDir, job);
    const model = loadReviewModel(outDir, readJob(outDir, "s1", job.jobId));
    assert.equal(model.selection.length, 1);
    assert.equal(model.revision, 1);
    assert.deepEqual(importScrapeSelection(outDir, job), { status: "already-seeded", revision: 1 });
  });

  it("invalid slug selection fails closed with invalid-selection", () => {
    const outDir = tmpOut();
    const job = createJob({ slug: "s1", source: "https://example.go.th/p1", group: "g" });
    writeJob(outDir, job);
    mkdirSync(join(outDir, "s1", "review"), { recursive: true });
    writeFileSync(join(outDir, "s1", "review", "selection.json"), "not json", "utf8");
    assert.throws(() => importScrapeSelection(outDir, job), (e) => e.code === "invalid-selection");
  });
});
