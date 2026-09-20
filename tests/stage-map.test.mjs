// stage-map contract: every spine stage has a next action on a valid page.
// Run: node --test tests/stage-map.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NEXT, SPINE, STEPS, nextFor, stepIndex } from "../web/js/stage-map.js";

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
