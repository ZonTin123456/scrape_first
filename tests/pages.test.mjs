// tests/pages.test.mjs — Page Selection over the staging contract.
// GET model (pending/links/images/master) + POST-only merge save by key
// (url/seq/src), fail-closed on foreign urls/seqs/slugs. No browser.
// Run: node --test tests/pages.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.mjs";
import { createJob, writeJob, readJob } from "../jobs/store.mjs";
import { loadPagesModel, savePagesModel } from "../jobs/pages.mjs";

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "pages-"));
}

function seedStaging(outDir) {
  const st = join(outDir, "_staging");
  mkdirSync(join(st, "s"), { recursive: true });
  mkdirSync(join(st, "t"), { recursive: true });
  writeFileSync(join(st, "picked-links.json"), JSON.stringify([
    { url: "https://a.go.th/x", slug: "s", keep: true },
    { url: "https://a.go.th/y", slug: "t", keep: true },
  ]), "utf8");
  writeFileSync(join(st, "s", "probe.json"), JSON.stringify({
    source_url: "https://a.go.th/x", source_title: "X page",
    counts: { text: 10, image: 2 },
    images: [
      { seq: 1, src: "https://a.go.th/i1.jpg", width: 100, height: 100, name: "A", position: "P", alt: "", section: "sec" },
      { seq: 2, src: "https://a.go.th/i2.jpg", width: 100, height: 100, name: null, position: null, alt: "icon", section: null },
    ],
  }), "utf8");
  writeFileSync(join(st, "s", "picked-images.json"), JSON.stringify([
    { seq: 1, src: "https://a.go.th/i1.jpg", keep: true },
    { seq: 2, src: "https://a.go.th/i2.jpg", keep: false },
  ]), "utf8");
  writeFileSync(join(st, "t", "probe.json"), JSON.stringify({
    source_url: "https://a.go.th/y", source_title: "Y page", counts: { text: 1, image: 0 }, images: [],
  }), "utf8");
  writeFileSync(join(st, "t", "picked-images.json"), JSON.stringify([]), "utf8");
  writeFileSync(join(st, "master.json"), JSON.stringify({
    generated_at: "t", pages: [{ slug: "s", url: "https://a.go.th/x" }, { slug: "t", url: "https://a.go.th/y" }],
    decisions: [{ src: "https://a.go.th/i1.jpg", keep: true }, { src: "https://a.go.th/i2.jpg", keep: false }],
  }), "utf8");
}

function seedJob(outDir) {
  const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "pages-1" });
  writeJob(outDir, job);
  return job;
}

describe("pages model: load", () => {
  it("pending when no probe ran yet", () => {
    const outDir = tmpOut();
    const job = seedJob(outDir);
    const m = loadPagesModel(outDir, job);
    assert.equal(m.pending, true);
    assert.deepEqual(m.links, []);
  });

  it("filters links to the job slug with probe meta + image keep", () => {
    const outDir = tmpOut();
    seedStaging(outDir);
    const job = seedJob(outDir);
    const m = loadPagesModel(outDir, job);
    assert.equal(m.pending, false);
    assert.equal(m.links.length, 1);
    assert.equal(m.links[0].url, "https://a.go.th/x");
    assert.equal(m.links[0].title, "X page");
    assert.equal(m.links[0].counts.image, 2);
    assert.deepEqual(m.links[0].images.map((i) => [i.seq, i.keep]), [[1, true], [2, false]]);
    assert.equal(m.links[0].images[0].name, "A");
    assert.equal(m.master.decisions.length, 2);
  });
});

describe("pages model: save merges by key, fail-closed otherwise", () => {
  it("unkeep link + image fans out to picked-images + master, preserves others", () => {
    const outDir = tmpOut();
    seedStaging(outDir);
    const job = seedJob(outDir);
    const saved = savePagesModel(outDir, job, {
      links: [{ url: "https://a.go.th/x", keep: false }],
      images: { s: [{ seq: 1, keep: false }, { seq: 2, keep: false }] },
    });
    assert.equal(saved.links, 1);
    assert.equal(saved.imageUpdates, 1);
    assert.equal(saved.decisionUpdates, 1);
    assert.equal(saved.linkUpdates, 1);
  });

  it("writes land in staging files; foreign slug data untouched", async () => {
    const outDir = tmpOut();
    seedStaging(outDir);
    const job = seedJob(outDir);
    savePagesModel(outDir, job, {
      links: [{ url: "https://a.go.th/x", keep: false }],
      images: { s: [{ seq: 1, keep: false }, { seq: 2, keep: true }] },
    });
    const { readFileSync } = await import("node:fs");
    const links = JSON.parse(readFileSync(join(outDir, "_staging", "picked-links.json"), "utf8"));
    assert.equal(links.find((l) => l.url === "https://a.go.th/x").keep, false);
    assert.equal(links.find((l) => l.url === "https://a.go.th/y").keep, true, "other urls preserved");
    const imgs = JSON.parse(readFileSync(join(outDir, "_staging", "s", "picked-images.json"), "utf8"));
    assert.deepEqual(imgs.map((i) => i.keep), [false, true]);
    const master = JSON.parse(readFileSync(join(outDir, "_staging", "master.json"), "utf8"));
    assert.equal(master.decisions.find((d) => d.src === "https://a.go.th/i1.jpg").keep, false);
    assert.equal(master.decisions.find((d) => d.src === "https://a.go.th/i2.jpg").keep, true, "untouched src preserved");
  });

  it("rejects foreign urls, unknown seqs, foreign slugs", () => {
    const outDir = tmpOut();
    seedStaging(outDir);
    const job = seedJob(outDir);
    assert.throws(() => savePagesModel(outDir, job, { links: [{ url: "https://evil/x", keep: true }], images: {} }), (e) => e.code === "unknown-url");
    assert.throws(() => savePagesModel(outDir, job, { links: [{ url: "https://a.go.th/x", keep: true }], images: { s: [{ seq: 99, keep: true }] } }), (e) => e.code === "bad-seq");
    assert.throws(() => savePagesModel(outDir, job, { links: [{ url: "https://a.go.th/x", keep: true }], images: { t: [{ seq: 1, keep: true }] } }), (e) => e.code === "unknown-slug");
    assert.throws(() => savePagesModel(outDir, job, { links: "nope", images: {} }), (e) => e.code === "bad-pages");
  });
});

describe("pages routes over HTTP", () => {
  it("GET model + POST save + ledger audit; 404/400 fail-closed", async () => {
    const outDir = tmpOut();
    seedStaging(outDir);
    const app = await startServer({ outDir, port: 0 });
    try {
      const c = await (await fetch(`${app.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://a.go.th/x", group: "a", slug: "s" }),
      })).json();
      const g0 = await (await fetch(`${app.url}/jobs/${c.jobId}/pages`)).json();
      assert.equal(g0.pending, false);
      assert.equal(g0.links.length, 1);
      const post = await fetch(`${app.url}/jobs/${c.jobId}/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ links: [{ url: "https://a.go.th/x", keep: true }], images: { s: [{ seq: 1, keep: true }, { seq: 2, keep: true }] } }),
      });
      assert.equal(post.status, 200);
      const saved = await post.json();
      assert.equal(saved.ok, true);
      assert.equal(saved.imageUpdates, 1);
      const job = readJob(outDir, "s", c.jobId);
      assert.ok(job.ledger.some((e) => e.kind === "pages:saved"), "ledger audit");
      const bad = await fetch(`${app.url}/jobs/${c.jobId}/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ links: [{ url: "https://evil/x", keep: true }], images: {} }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).reason, "unknown-url");
      const ghost = await fetch(`${app.url}/jobs/ghost/pages`);
      assert.equal(ghost.status, 404);
    } finally {
      await app.close();
    }
  });
});
