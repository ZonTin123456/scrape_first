// Characterization: safety guards (Lift-verbatim per #18).
// Pins source uniformity/identity, field-shape gate, host gate.
// These are the upload guards the safety model (#15) requires to survive.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sourceUniformityFailure,
  sourceIdentityFailure,
  fieldsSatisfy,
} from "../uploader/lib/group-guard.mjs";
import { mapHostMismatch } from "../uploader/lib/host-gate.mjs";
import { slugBaseOf } from "../sectioning.mjs";

const row = (seq, url, group) => ({ seq, source_url: url, source_group: group });

describe("sourceUniformityFailure: one file, one source", () => {
  it("empty or missing provenance fails closed", () => {
    assert.ok(sourceUniformityFailure([]));
    assert.ok(sourceUniformityFailure([{ seq: 1 }]));
  });
  it("cross-URL contamination fails with both sources named", () => {
    const r = sourceUniformityFailure([
      row(1, "https://a.go.th/x", "g"),
      row(2, "https://b.go.th/y", "g"),
    ]);
    assert.ok(r.includes("cross-URL"));
  });
  it("uniform source passes", () => {
    assert.equal(
      sourceUniformityFailure([row(1, "https://a.go.th/x", "g"), row(2, "https://a.go.th/x", "g")]),
      null
    );
  });
});

describe("sourceIdentityFailure: group must equal own URL key", () => {
  it("missing source_group fails", () => {
    const u = "https://khiansago.go.th/officer1.php";
    assert.ok(sourceIdentityFailure([row(1, u, null)], slugBaseOf));
  });
  it("row claiming another URL group fails", () => {
    const u = "https://khiansago.go.th/officer1.php";
    const other = slugBaseOf("https://khanthuligo.go.th/house.php");
    const r = sourceIdentityFailure([row(7, u, other)], slugBaseOf);
    assert.ok(r.includes("seq 7"));
  });
  it("correct identity passes", () => {
    const u = "https://khiansago.go.th/officer1.php";
    assert.equal(sourceIdentityFailure([row(1, u, slugBaseOf(u))], slugBaseOf), null);
  });
});

describe("fieldsSatisfy: selector/strategy present, no TBD", () => {
  it("lists keys lacking usable target", () => {
    const fields = {
      name: { selector: 'input[name="p_name"]' },
      position: { selector: null },
      save: { strategy: "photo-form-submit" },
      detail: { selector: "TBD-manual" },
    };
    assert.deepEqual(fieldsSatisfy(fields, ["name", "position", "save", "detail"]), [
      "position",
      "detail",
    ]);
  });
  it("empty need is satisfied", () => {
    assert.deepEqual(fieldsSatisfy({}, []), []);
  });
});

describe("mapHostMismatch: origin compare, never raw strings", () => {
  it("gate N/A when either side unknown", () => {
    assert.equal(mapHostMismatch(null, "https://a.example"), null);
    assert.equal(mapHostMismatch("https://a.example", null), null);
  });
  it("same origin with different path/trailing slash passes", () => {
    assert.equal(mapHostMismatch("https://a.example/personal", "https://a.example/"), null);
  });
  it("host, protocol, or port change mismatches", () => {
    assert.ok(mapHostMismatch("https://a.example", "https://b.example"));
    assert.ok(mapHostMismatch("http://a.example", "https://a.example"));
    assert.ok(mapHostMismatch("https://a.example:1", "https://a.example:2"));
  });
  it("unparseable and null-origin hosts fail closed", () => {
    assert.ok(mapHostMismatch("not a url", "https://a.example"));
    assert.ok(mapHostMismatch("https://a.example", "not a url"));
    assert.ok(mapHostMismatch("about:blank", "https://a.example"));
  });
});
