// tests/engine-cdp.test.mjs — lifted CDP engine unit pins (no browser).
// Pure helpers + fail-fast validation paths only. Live browser behavior is
// verified manually against headed Chrome :9333 (see session notes).
// Run: node --test tests/engine-cdp.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_VERSION,
  cdpContext,
  detectBackend,
  extOf,
  isChallengeProbe,
  loadPageSections,
  probeUrl,
  resolveSlug,
  scrapeUrl,
  upsertSummary,
} from "../jobs/engine-cdp.mjs";

function tmpOut() {
  return mkdtempSync(join(tmpdir(), "engine-cdp-"));
}

describe("engine-cdp pure helpers", () => {
  it("extOf sniffs magic bytes, falls back to content-type then url", () => {
    assert.equal(extOf(Buffer.from([0x89, 0x50, 0x00, 0x00]), "", "http://x/y"), "png");
    assert.equal(extOf(Buffer.from([0xff, 0xd8, 0x00]), "", "http://x/y"), "jpg");
    assert.equal(extOf(Buffer.from("GIF89a"), "", "http://x/y"), "gif");
    assert.equal(extOf(Buffer.from("<svg width='1'>"), "", "http://x/y"), "svg");
    assert.equal(extOf(Buffer.from("RIFFxxxxWEBP"), "", "http://x/y"), "webp");
    assert.equal(extOf(Buffer.from("hello"), "image/png", "http://x/y"), "png");
    assert.equal(extOf(Buffer.from("hello"), "", "http://x/y.png"), "png");
    assert.equal(extOf(Buffer.from("hello"), "", "http://x/y"), "jpg");
  });

  it("resolveSlug reuses the free slot and the same-URL slot", () => {
    const outDir = tmpOut();
    const slug = resolveSlug("https://www.example.go.th/manage.php", outDir);
    assert.ok(slug.length > 0);
    mkdirSync(join(outDir, slug), { recursive: true });
    // Empty dir = free slot, same slug reused.
    assert.equal(resolveSlug("https://www.example.go.th/manage.php", outDir), slug);
    // Foreign owner forces a suffixed slot.
    writeFileSync(join(outDir, slug, "content.json"), JSON.stringify({ manifest: { source_url: "https://other/x" } }), "utf8");
    assert.notEqual(resolveSlug("https://www.example.go.th/manage.php", outDir), slug);
    // Same URL reuses despite occupation.
    writeFileSync(join(outDir, slug, "content.json"), JSON.stringify({ manifest: { source_url: "https://www.example.go.th/manage.php" } }), "utf8");
    assert.equal(resolveSlug("https://www.example.go.th/manage.php", outDir), slug);
  });

  it("upsertSummary merges by slug with ok/failed counts", () => {
    const outDir = tmpOut();
    upsertSummary(outDir, { url: "https://a/x", slug: "s", dir: "d1" });
    upsertSummary(outDir, { url: "https://a/y", slug: "t", dir: "d2", error: "boom" });
    upsertSummary(outDir, { url: "https://a/x", slug: "s", dir: "d1b" });
    const s = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
    assert.equal(s.total, 2);
    assert.equal(s.ok, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.results.find((r) => r.slug === "s").dir, "d1b");
  });

  it("loadPageSections returns an object; cdpContext exposes newPage", () => {
    assert.equal(typeof loadPageSections(), "object");
    assert.equal(typeof cdpContext(9333).newPage, "function");
  });

  it("ENGINE_VERSION matches the CLI engine value", () => {
    assert.equal(ENGINE_VERSION, "1.3.0");
  });

  it("challenge probe catches English + Thai walls, passes real pages", () => {
    assert.equal(isChallengeProbe({ title: "Just a moment...", hasTurnstile: false, body: "" }), true);
    assert.equal(isChallengeProbe({ title: "รอสักครู่...", hasTurnstile: false, body: "" }), true);
    assert.equal(isChallengeProbe({ title: "x", hasTurnstile: false, body: "กำลังทำการตรวจสอบความปลอดภัย" }), true);
    assert.equal(isChallengeProbe({ title: "x", hasTurnstile: true, body: "" }), true);
    assert.equal(isChallengeProbe({ title: "บุคลากร", hasTurnstile: false, body: "รายชื่อผู้บริหาร" }), false);
    assert.equal(isChallengeProbe(null), false);
  });
});

describe("engine-cdp fail-fast paths (no browser touched)", () => {
  it("probeUrl/scrapeUrl validate outDir + url first", async () => {
    await assert.rejects(probeUrl({ outDir: "", url: "https://a/x" }), (e) => e.code === "bad-outDir");
    await assert.rejects(probeUrl({ outDir: tmpOut(), url: "" }), (e) => e.code === "bad-source");
    await assert.rejects(scrapeUrl({ outDir: "", url: "https://a/x" }), (e) => e.code === "bad-outDir");
    await assert.rejects(scrapeUrl({ outDir: tmpOut(), url: "" }), (e) => e.code === "bad-source");
  });

  it("detectBackend requires slug/jobId/people before any browser contact", async () => {
    const outDir = tmpOut();
    await assert.rejects(detectBackend({ outDir, slug: "", jobId: "j" }), (e) => e.code === "bad-slug");
    await assert.rejects(detectBackend({ outDir, slug: "s", jobId: "" }), (e) => e.code === "bad-job");
    await assert.rejects(detectBackend({ outDir, slug: "s", jobId: "j" }), (e) => e.code === "missing-people");
    mkdirSync(join(outDir, "s"), { recursive: true });
    writeFileSync(join(outDir, "s", "people.json"), JSON.stringify([{ seq: 1, name: "A" }]), "utf8");
    await assert.rejects(detectBackend({ outDir, slug: "s", jobId: "j" }), (e) => e.code === "missing-people");
  });
});
