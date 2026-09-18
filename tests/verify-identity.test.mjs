// Characterization: verify-identity.mjs (Lift-verbatim per #18).
// Pins per-row target identity: numeric person id in URL AND photo-form action.
// Section names are never routing decisions. Never throws.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPersonId, verifyPageIdentity } from "../uploader/lib/verify-identity.mjs";

describe("extractPersonId: both backend URL schemes", () => {
  it("canonical /personal/person/{id} and bare /personal/{id}", () => {
    assert.equal(extractPersonId("https://h/personal/person/42"), "42");
    assert.equal(extractPersonId("https://h/personal/7"), "7");
    assert.equal(extractPersonId("https://h/personal/person/9?x=1#y"), "9");
  });
  it("non-person URLs yield null", () => {
    assert.equal(extractPersonId("https://h/personal"), null);
    assert.equal(extractPersonId("https://h/other/5"), null);
    assert.equal(extractPersonId(null), null);
  });
});

describe("verifyPageIdentity: URL id + photo-form-action id", () => {
  const page = (url, info, opts = {}) => ({
    url: () => {
      if (opts.throwUrl) throw new Error("boom-url");
      return url;
    },
    evaluate: async () => {
      if (opts.throwEval) throw new Error("boom-eval");
      return info;
    },
  });

  it("skips targets without a person id", async () => {
    const r = await verifyPageIdentity(page("https://h/list", null), { personUrl: "https://h/list" });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });
  it("URL mismatch fails (deleted dept renders same URL with no form)", async () => {
    const r = await verifyPageIdentity(page("https://h/personal/person/8", null), {
      personUrl: "https://h/personal/person/9",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("URL identity mismatch"));
  });
  it("missing photo form fails (error page guard)", async () => {
    const r = await verifyPageIdentity(
      page("https://h/personal/person/9", { photoAction: null, formCount: 1 }),
      { personUrl: "https://h/personal/person/9" }
    );
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("no photo form"));
  });
  it("form posting to another id fails", async () => {
    const r = await verifyPageIdentity(
      page("https://h/personal/person/9", { photoAction: "https://h/personal/person/10", formCount: 2 }),
      { personUrl: "https://h/personal/person/9" }
    );
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("form identity mismatch"));
  });
  it("matching URL + form ids pass", async () => {
    const r = await verifyPageIdentity(
      page("https://h/personal/person/9", { photoAction: "https://h/personal/person/9", formCount: 2 }),
      { personUrl: "https://h/personal/person/9" }
    );
    assert.equal(r.ok, true);
    assert.ok(r.detail.includes("person/9"));
  });
  it("never throws: unreadable URL or evaluate both fail closed", async () => {
    const a = await verifyPageIdentity(page("", null, { throwUrl: true }), {
      personUrl: "https://h/personal/person/9",
    });
    assert.equal(a.ok, false);
    const b = await verifyPageIdentity(page("https://h/personal/person/9", null, { throwEval: true }), {
      personUrl: "https://h/personal/person/9",
    });
    assert.equal(b.ok, false);
  });
});
