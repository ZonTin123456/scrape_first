// Characterization: uploader/lib/match.mjs scoring core (Lift-verbatim per #18).
// Pins label scoring, corroboration caps, verdict bands, failure rendering.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  norm,
  scorePair,
  normalizePhone,
  extractPhones,
  phoneOverlap,
  normalizeName,
  isVacantName,
  memberScore,
  matchSection,
  failBlock,
} from "../uploader/lib/match.mjs";

describe("norm + scorePair label ladder", () => {
  it("exact 1.0 beats alias 0.75 beats substring 0.7 beats token", () => {
    assert.equal(scorePair("กองคลัง", "กองคลัง").score, 1.0);
    const alias = scorePair("สภาท้องถิ่น", "สภา อบต");
    assert.equal(alias.score, 0.75);
    assert.ok(alias.evidence.some((e) => e.startsWith("alias:")));
    const sub = scorePair("กองคลัง", "กองคลังเทศบาล");
    assert.equal(sub.score, 0.7);
    const tok = scorePair("คลัง การเงิน", "คลัง บัญชี");
    assert.ok(tok.score > 0 && tok.score <= 0.65);
    assert.equal(scorePair("กองคลัง", "กองช่าง").score, 0);
    assert.equal(scorePair("", "กองคลัง").score, 0);
  });
  it("NFC + trim + case-insensitive exact", () => {
    assert.equal(norm("  ก ").length > 0, true);
    assert.equal(scorePair("กองคลัง", "กองคลัง ").score, 1.0);
  });
});

describe("phone evidence: format-agnostic, corroboration only", () => {
  it("normalizePhone folds +66 trunk, rejects junk", () => {
    assert.equal(normalizePhone("065-5300535"), "0655300535");
    assert.equal(normalizePhone("66812345678"), "0812345678");
    assert.equal(normalizePhone("123"), "");
    assert.equal(normalizePhone("0000000000"), "");
    assert.equal(normalizePhone(""), "");
  });
  it("extractPhones finds numbers embedded in free text", () => {
    const got = extractPhones("นาง ก (065-5300535)");
    assert.ok(got.has("0655300535"));
  });
  it("phoneOverlap counts shared normalized numbers", () => {
    const r = phoneOverlap(["tel 0812345678", "tel 0812345678"], ["081-234-5678"]);
    assert.equal(r.shared, 1);
  });
});

describe("member evidence: vacant excluded, never auto alone", () => {
  it("normalizeName strips parens/phones; vacant names excluded", () => {
    assert.equal(normalizeName("นาย ก (065-5300535)"), "นาย ก");
    assert.equal(isVacantName("ว่าง"), true);
    assert.equal(isVacantName("-"), true);
    assert.equal(isVacantName("นาย ก"), false);
  });
  it("memberScore overlaps non-vacant sets", () => {
    const r = memberScore(["นาย ก", "นาย ข", "ว่าง"], ["นาย ก", "นาย ข", "นาย ค"]);
    assert.equal(r.shared, 2);
    assert.equal(r.want, 2);
    assert.equal(r.ratio, 1);
  });
});

describe("matchSection verdicts: auto only single unambiguous >= 0.8", () => {
  it("auto on single exact top", () => {
    const r = matchSection("กองคลัง", [{ key: "กองคลัง", url: "u1" }, { key: "กองช่าง", url: "u2" }]);
    assert.equal(r.verdict, "auto");
    assert.equal(r.best.key, "กองคลัง");
  });
  it("tie at top refuses with review", () => {
    const r = matchSection("กองคลัง", [
      { key: "กองคลัง", url: "u1" },
      { key: "กองคลัง", url: "u2" },
    ]);
    assert.equal(r.verdict, "review");
    assert.ok(r.tie);
  });
  it("mid band 0.5-0.8 is review, below 0.5 is fail", () => {
    const mid = matchSection("กองคลัง", [{ key: "กองคลังเทศบาล" }]);
    assert.equal(mid.verdict, "review");
    const fail = matchSection("กองคลัง", [{ key: "กองช่างโยธาไกล" }]);
    assert.equal(fail.verdict, "fail");
  });
  it("member-only rescue caps at review, never auto", () => {
    const r = matchSection(
      "แผนกใหม่เอี่ยม",
      [{ key: "กองอื่นไกล", memberNames: ["นาย ก", "นาย ข", "นาย ค"] }],
      { wantMembers: ["นาย ก", "นาย ข", "นาย ง"] }
    );
    assert.equal(r.verdict, "review");
    assert.ok(r.best.score < 0.8);
    assert.ok(r.best.score >= 0.5);
  });
  it("single shared phone proves nothing (min 2 for bonus)", () => {
    const one = matchSection(
      "แผนกใหม่เอี่ยม",
      [{ key: "กองอื่นไกล", phoneHints: ["081-234-5678"] }],
      { wantPhones: ["0812345678"] }
    );
    assert.equal(one.verdict, "fail");
  });
});

describe("failBlock: loud failure protocol", () => {
  it("names verdict, candidates with evidence, and fix hint", () => {
    const r = matchSection("กองคลัง", [{ key: "กองช่าง", url: "u9" }]);
    const lines = failBlock("กองคลัง", r);
    const text = lines.join("\n");
    assert.ok(text.includes("กองคลัง"));
    assert.ok(text.includes("กองช่าง"));
    assert.ok(text.includes("fix:"));
  });
});
