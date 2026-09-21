// tests/pages-display.test.mjs — Page Selection display metadata (defect 2).
// The model must expose engine probe fields verbatim (src/note/caption_text
// plus existing dims/name/position/alt/section) with keep semantics and save
// shape unchanged; the UI must render them as escaped cards with remote-only
// thumbnails. No Real Upload anywhere.
// Run: node --test tests/pages-display.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, writeJob } from "../jobs/store.mjs";
import { loadPagesModel, savePagesModel } from "../jobs/pages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "pages-display-"));
}

function seed(outDir) {
  const st = join(outDir, "_staging");
  mkdirSync(join(st, "s"), { recursive: true });
  writeFileSync(join(st, "picked-links.json"), JSON.stringify([
    { url: "https://a.go.th/x", slug: "s", keep: true },
  ]), "utf8");
  writeFileSync(join(st, "s", "probe.json"), JSON.stringify({
    source_url: "https://a.go.th/x", source_title: "X",
    counts: { image: 2 },
    images: [
      {
        seq: 1, src: "https://a.go.th/i1.jpg", width: 640, height: 480,
        name: "A Example", position: "Board member", alt: "portrait",
        note: "caption-note", caption_text: "caption-text", section: "board",
      },
      {
        seq: 2, src: "https://a.go.th/i2.jpg", width: 100, height: 100,
        name: null, position: null, alt: "", note: null, caption_text: "", section: null,
      },
    ],
  }), "utf8");
  writeFileSync(join(st, "s", "picked-images.json"), JSON.stringify([
    { seq: 1, src: "https://a.go.th/i1.jpg", keep: true },
    { seq: 2, src: "https://a.go.th/i2.jpg", keep: false },
  ]), "utf8");
  writeFileSync(join(st, "master.json"), JSON.stringify({ generated_at: "t", pages: [], decisions: [] }), "utf8");
  const job = createJob({ slug: "s", source: "https://a.go.th/x", group: "a", jobId: "disp-1" });
  writeJob(outDir, job);
  return job;
}

describe("pages display metadata (defect 2)", () => {
  it("model exposes probe display fields verbatim", () => {
    const outDir = tmpOut();
    const job = seed(outDir);
    const m = loadPagesModel(outDir, job);
    assert.equal(m.pending, false);
    const [a, b] = m.links[0].images;
    assert.deepEqual(
      [a.src, a.width, a.height, a.name, a.position, a.alt, a.note, a.caption_text, a.section],
      ["https://a.go.th/i1.jpg", 640, 480, "A Example", "Board member", "portrait", "caption-note", "caption-text", "board"],
    );
    assert.equal(b.src, "https://a.go.th/i2.jpg");
    assert.equal(b.note, null);
  });

  it("keep defaults and save shape unchanged", () => {
    const outDir = tmpOut();
    const job = seed(outDir);
    const m = loadPagesModel(outDir, job);
    assert.deepEqual(m.links[0].images.map((i) => [i.seq, i.keep]), [[1, true], [2, false]]);
    const saved = savePagesModel(outDir, job, {
      links: [{ url: "https://a.go.th/x", keep: true }],
      images: { s: [{ seq: 1, keep: false }, { seq: 2, keep: false }] },
    });
    assert.equal(saved.imageUpdates, 1);
    const m2 = loadPagesModel(outDir, job);
    assert.deepEqual(m2.links[0].images.map((i) => [i.seq, i.keep]), [[1, false], [2, false]]);
    assert.equal(m2.links[0].images[0].src, "https://a.go.th/i1.jpg");
  });

  it("UI renders metadata as escaped cards with remote-only thumbnails", () => {
    const src = readFileSync(join(root, "web", "js", "pages", "pages.js"), "utf8");
    assert.match(src, /imageCard/, "card renderer present");
    assert.match(src, /startsWith\("http/, "remote-only thumbnail gate");
    assert.ok(!src.replace(/esc\(src\)/g, "").match(/src=\$\{[^}]*\bsrc\b/), "raw src never interpolated");
    for (const frag of ["esc(im.name)", "esc(im.position)", "esc(im.section)", "esc(note)", "esc(src)", "esc(dims)"]) {
      assert.ok(src.includes(frag), `escaped: ${frag}`);
    }
    assert.ok(!/["']file:\/\//.test(src), "no file:// thumbnails");
    assert.ok(src.includes("data-pimg") && src.includes("data-pseq"), "keep wiring preserved");
  });
});
