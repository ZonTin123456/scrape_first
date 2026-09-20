// stage-map contract: every spine stage has a next action on a valid page.
// Run: node --test tests/stage-map.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT, SPINE, STEPS, nextFor, pageFor, stepIndex } from "../web/js/stage-map.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = new Set(["dashboard", "overview", "pages", "review", "safety"]);

describe("stage-map display contract (#40)", () => {
  it("every spine stage maps to a next action on a known page", () => {
    for (const s of SPINE) {
      const [label, page] = nextFor(s);
      assert.ok(label && label.length > 0, `${s}: missing label`);
      assert.ok(PAGES.has(page), `${s}: unknown page ${page}`);
    }
    assert.deepEqual(nextFor("bogus-stage"), ["Open overview", "overview"]);
  });

  it("NEXT covers SPINE exactly (no gaps, no extras)", () => {
    assert.deepEqual(Object.keys(NEXT).sort(), [...SPINE].sort());
  });

  it("10 workflow steps reference ordered stages", () => {
    assert.equal(STEPS.length, 10);
    let last = -1;
    for (const [, s] of STEPS) {
      const i = stepIndex(s);
      assert.ok(i > last, `${s} out of order`);
      last = i;
    }
  });
});

describe("wrong-stage destinations: single map, no page-to-page loops", () => {
  // Locked destination table (human acceptance): every stage resolves to the
  // page that owns it. No auto-redirect; cards link here with an explanation.
  const EXPECTED = {
    detecting_backend: "safety",
    dry_running: "safety",
    dry_passed: "safety",
    armed: "safety",
    uploading: "safety",
    waiting_for_page_selection: "pages",
    scraping: "pages",
    waiting_for_people_review: "review",
    finalizing: "review",
    idle: "overview",
    probing: "overview",
    failed: "overview",
    cancelled: "overview",
    done: "overview",
  };

  it("pageFor matches the locked destination table exactly", () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...SPINE].sort());
    for (const [stage, page] of Object.entries(EXPECTED)) {
      assert.equal(pageFor(stage), page, `${stage} must link to ${page}`);
    }
    assert.equal(pageFor("bogus-stage"), "overview");
  });

  it("one hop terminates: the target page always owns the stage (no chains, no loops)", () => {
    // Overview is valid at all stages; pages/review/safety own their gated
    // stages (progress views count as owning). A link depending only on stage
    // therefore lands on content, never on another wrong-stage card.
    const OWNS = {
      overview: new Set(SPINE),
      pages: new Set(["waiting_for_page_selection", "scraping"]),
      review: new Set(["waiting_for_people_review", "finalizing"]),
      safety: new Set(["finalizing", "detecting_backend", "dry_running", "dry_passed", "armed", "uploading", "done", "failed", "cancelled"]),
    };
    for (const s of SPINE) {
      const t = pageFor(s);
      assert.ok(OWNS[t]?.has(s), `${s} -> ${t}, but ${t} does not own ${s} (loop risk)`);
    }
  });

  it("gate cards derive destinations from the map, never hardcoded guesses", () => {
    for (const [file, banned] of [
      ["pages/pages.js", 'linkTarget(route, "review")'],
      ["pages/review.js", 'linkTarget(route, "pages")'],
      ["pages/safety.js", 'linkTarget(route, "review")'],
    ]) {
      const src = readFileSync(join(root, "web", "js", file), "utf8");
      assert.ok(src.includes("nextFor("), `${file}: gate must derive from nextFor`);
      assert.ok(!src.includes(banned), `${file}: hardcoded ${banned} (loop risk)`);
    }
  });
});
