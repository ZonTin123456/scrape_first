// P1 Lift boundary: services/ re-exports return identical results vs direct imports.
// UI imports Lift cores only, never CLI entries. Injection (keywords dict,
// profiles loader) is mockable; omitted = CLI fs defaults (no behavior change).
// Run: node --test tests/services.test.mjs
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as sectionDirect from "../sectioning.mjs";
import * as sectionSvc from "../services/sectioning.mjs";
import * as matchDirect from "../uploader/lib/match.mjs";
import * as matchSvc from "../services/match-core.mjs";
import * as guardDirect from "../uploader/lib/group-guard.mjs";
import * as hostDirect from "../uploader/lib/host-gate.mjs";
import * as guardsSvc from "../services/guards.mjs";
import * as identDirect from "../uploader/lib/verify-identity.mjs";
import * as identSvc from "../services/identity.mjs";
import * as autoDirect from "../uploader/lib/automap.mjs";
import * as autoSvc from "../services/automap-pure.mjs";

afterEach(() => {
  matchDirect.resetKeywordsDict();
  autoDirect.resetProfilesLoader();
});

describe("services/sectioning: exact Lift list, identical results", () => {
  const names = [
    "slugBaseOf", "newSourceContext", "resolveTargetGroup", "attachCaptions",
    "buildKept", "buildPeople", "isDivisionText", "inferSection",
    "providerOf", "imgSlotKey", "IMG_DENY", "TEXT_DENY_EXACT", "MIN_PX",
  ];
  it("exports all 13 Lift symbols as the same references", () => {
    for (const n of names) {
      assert.ok(sectionSvc[n] !== undefined, `missing ${n}`);
      assert.equal(sectionSvc[n], sectionDirect[n], `drift: ${n}`);
    }
  });
  it("computes identically (slug/context/group/division/kept/people)", () => {
    const u = "https://khiansago.go.th/officer1.php";
    assert.equal(sectionSvc.slugBaseOf(u), sectionDirect.slugBaseOf(u));
    assert.deepEqual(sectionSvc.newSourceContext(u), sectionDirect.newSourceContext(u));
    assert.equal(
      sectionSvc.resolveTargetGroup(u, "k", { map: { "khiansago": "merged" } }),
      sectionDirect.resolveTargetGroup(u, "k", { map: { "khiansago": "merged" } }),
    );
    assert.equal(sectionSvc.isDivisionText("กองคลัง"), sectionDirect.isDivisionText("กองคลัง"));
    assert.equal(sectionSvc.inferSection("ปลัด", "นาย ก"), sectionDirect.inferSection("ปลัด", "นาย ก"));
    assert.deepEqual(sectionSvc.providerOf("https://x/google.com/maps/embed"), sectionDirect.providerOf("https://x/google.com/maps/embed"));
    assert.equal(sectionSvc.imgSlotKey("s", 1, 2), sectionDirect.imgSlotKey("s", 1, 2));
    const raw = [
      { t: "img", src: "https://h/p.jpg", w: 100, h: 100, left: 0, top: 0 },
      { t: "text", text: "นาย ก" },
      { t: "text", text: "ปลัด" },
    ];
    const a = sectionSvc.buildKept(raw, "https://h");
    const b = sectionDirect.buildKept(raw, "https://h");
    assert.deepEqual(a, b);
    assert.deepEqual(sectionSvc.buildPeople(a.kept, u, "src"), sectionDirect.buildPeople(b.kept, u, "src"));
  });
});

describe("services/match-core: scoring identical, keywords injectable", () => {
  const names = [
    "norm", "scorePair", "normalizePhone", "extractPhones", "phoneOverlap",
    "normalizeName", "isVacantName", "memberScore", "matchSection", "failBlock", "keywords",
  ];
  it("exports the Lift scoring set as the same references", () => {
    for (const n of names) assert.equal(matchSvc[n], matchDirect[n], `drift: ${n}`);
  });
  it("default dict behaves identically (exact/alias/substring/token)", () => {
    assert.deepEqual(matchSvc.scorePair("กองคลัง", "กองคลัง"), matchDirect.scorePair("กองคลัง", "กองคลัง"));
    assert.deepEqual(matchSvc.scorePair("สภาท้องถิ่น", "สภา อบต"), matchDirect.scorePair("สภาท้องถิ่น", "สภา อบต"));
    const r1 = matchSvc.matchSection("กองคลัง", [{ key: "กองคลัง" }, { key: "กองช่าง" }]);
    const r2 = matchDirect.matchSection("กองคลัง", [{ key: "กองคลัง" }, { key: "กองช่าง" }]);
    assert.deepEqual(r1, r2);
    assert.deepEqual(matchSvc.failBlock("กองคลัง", r1), matchDirect.failBlock("กองคลัง", r1));
  });
  it("per-call dict injection overrides aliases without touching fs default", () => {
    const custom = { section_aliases: { "AAA": ["BBB"] } };
    assert.equal(matchSvc.scorePair("AAA", "BBB", custom).score, 0.75);
    assert.equal(matchSvc.scorePair("AAA", "BBB").score, 0);
    const r = matchSvc.matchSection("AAA", [{ key: "BBB" }], { keywordsDict: custom });
    assert.equal(r.best.score, 0.75);
  });
  it("setKeywordsDict/reset round-trips the process default", () => {
    const custom = { section_aliases: { "AAA": ["BBB"] } };
    matchSvc.setKeywordsDict(custom);
    assert.equal(matchDirect.scorePair("AAA", "BBB").score, 0.75);
    assert.deepEqual(matchSvc.keywords(), custom);
    matchSvc.resetKeywordsDict();
    assert.equal(matchDirect.scorePair("AAA", "BBB").score, 0);
  });
});

describe("services/guards: group + host gates identical", () => {
  it("re-exports the 4 gate functions as the same references", () => {
    assert.equal(guardsSvc.sourceUniformityFailure, guardDirect.sourceUniformityFailure);
    assert.equal(guardsSvc.sourceIdentityFailure, guardDirect.sourceIdentityFailure);
    assert.equal(guardsSvc.fieldsSatisfy, guardDirect.fieldsSatisfy);
    assert.equal(guardsSvc.mapHostMismatch, hostDirect.mapHostMismatch);
  });
  it("computes identically", () => {
    const rows = [{ seq: 1, source_url: "https://a.go.th/x", source_group: sectionSvc.slugBaseOf("https://a.go.th/x") }];
    assert.equal(guardsSvc.sourceUniformityFailure(rows), guardDirect.sourceUniformityFailure(rows));
    assert.equal(guardsSvc.sourceIdentityFailure(rows, sectionSvc.slugBaseOf), guardDirect.sourceIdentityFailure(rows, sectionDirect.slugBaseOf));
    assert.deepEqual(
      guardsSvc.fieldsSatisfy({ a: { selector: "x" }, b: {} }, ["a", "b"]),
      guardDirect.fieldsSatisfy({ a: { selector: "x" }, b: {} }, ["a", "b"]),
    );
    assert.equal(
      guardsSvc.mapHostMismatch("https://a.example/x", "https://a.example/"),
      hostDirect.mapHostMismatch("https://a.example/x", "https://a.example/"),
    );
  });
});

describe("services/identity: page-identity check identical, page passed through", () => {
  it("re-exports both symbols", () => {
    assert.equal(identSvc.extractPersonId, identDirect.extractPersonId);
    assert.equal(identSvc.verifyPageIdentity, identDirect.verifyPageIdentity);
  });
  it("extract + verify match on mock pages", async () => {
    assert.equal(identSvc.extractPersonId("https://h/personal/person/9"), "9");
    const page = (url, info) => ({ url: () => url, evaluate: async () => info });
    const a = await identSvc.verifyPageIdentity(
      page("https://h/personal/person/9", { photoAction: "https://h/personal/person/9", formCount: 1 }),
      { personUrl: "https://h/personal/person/9" },
    );
    const b = await identDirect.verifyPageIdentity(
      page("https://h/personal/person/9", { photoAction: "https://h/personal/person/9", formCount: 1 }),
      { personUrl: "https://h/personal/person/9" },
    );
    assert.deepEqual(a, b);
    assert.equal(a.ok, true);
  });
});

describe("services/automap-pure: pure subset identical, loaders injectable", () => {
  it("exports the Lift subset (incl. newly exported classify/helpers)", () => {
    for (const n of ["loadProfiles", "matchProfile", "pickDeptRows", "buildInventory", "classify", "fieldMatchesSel", "actionFor", "dumpForm", "dumpFormEvaluate", "DUMP_FORM_SOURCE"]) {
      assert.ok(autoSvc[n] !== undefined, `missing ${n}`);
      assert.equal(autoSvc[n], autoDirect[n], `drift: ${n}`);
    }
  });
  it("default loadProfiles reads profiles/ (CLI behavior preserved)", () => {
    const a = autoSvc.loadProfiles();
    const b = autoDirect.loadProfiles();
    assert.deepEqual(a, b);
    assert.ok(a.some((p) => p.name === "sts-personnel-v1"));
  });
  it("profiles loader injects per-call and process-wide", () => {
    const custom = [{ name: "inj-v1", fingerprint: { file: [], text: [] }, fields: {} }];
    assert.deepEqual(autoSvc.loadProfiles(() => custom), custom);
    assert.deepEqual(autoSvc.loadProfiles(custom), custom);
    autoSvc.setProfilesLoader(() => custom);
    assert.deepEqual(autoDirect.loadProfiles(), custom);
    autoSvc.resetProfilesLoader();
    assert.ok(autoDirect.loadProfiles().some((p) => p.name === "sts-personnel-v1"));
  });
  it("matchProfile/pickDeptRows/buildInventory/classify/helpers identical", () => {
    const dumped = {
      forms: [{ action: "https://h/personal/person/9", elements: [
        { tag: "INPUT", type: "file", name: "img_path", id: "img1", selector: "#img1", label: { text: "ภาพ", via: "for" }, fi: 0 },
        { tag: "INPUT", type: "text", name: "p_name", id: "", selector: 'input[name="p_name"]', label: { text: "ชื่อ-สกุล", via: "for" }, fi: 0 },
        { tag: "INPUT", type: "text", name: "p_position", id: "", selector: 'input[name="p_position"]', label: { text: "ตำแหน่ง", via: "for" }, fi: 0 },
      ] }],
      selects: [],
      buttons: [],
    };
    const profiles = autoSvc.loadProfiles();
    assert.deepEqual(autoSvc.matchProfile(dumped, profiles), autoDirect.matchProfile(dumped, profiles));
    const raw = [{ href: "https://h/personal/person/3", rowText: "กองคลัง" }, { href: "https://h/personal/4", rowText: "กองช่าง" }];
    assert.deepEqual(autoSvc.pickDeptRows(raw), autoDirect.pickDeptRows(raw));
    const fields = { photo: { selector: 'input[name="img_path"]' }, name: { selector: 'input[name="p_name"]' }, save: { strategy: "photo-form-submit" } };
    const invDumped = { forms: [{ action: "https://h/x", elements: [
      { tag: "INPUT", type: "file", name: "img_path", id: "", selector: 'input[name="img_path"]', label: { text: "ภาพ", via: "for" }, fi: 0 },
      { tag: "INPUT", type: "text", name: "p_name", id: "", selector: 'input[name="p_name"]', label: { text: "ชื่อ", via: "for" }, fi: 0 },
      { tag: "INPUT", type: "hidden", name: "_token", id: "", selector: 'input[name="_token"]', label: { text: "", via: "none" }, fi: 0 },
    ] }], selects: [], buttons: [] };
    assert.deepEqual(autoSvc.buildInventory(invDumped, fields), autoDirect.buildInventory(invDumped, fields));
    assert.deepEqual(autoSvc.classify("https://h", dumped), autoDirect.classify("https://h", dumped));
    const e = { tag: "INPUT", name: "p_name", id: "", selector: 'input[name="p_name"]' };
    assert.equal(autoSvc.fieldMatchesSel('input[name="p_name"]', e), true);
    assert.equal(autoSvc.fieldMatchesSel("#img1", { tag: "INPUT", name: "x", id: "img1", selector: "#img1" }), true);
    assert.equal(autoSvc.actionFor("photo", {}), "fill:photo");
    assert.equal(autoSvc.actionFor("save", {}), "click");
    assert.equal(autoSvc.actionFor("nope", {}), "skip");
  });
  it("dumpForm lifts as evaluate string and executes in page", async () => {
    assert.equal(typeof autoSvc.DUMP_FORM_SOURCE, "string");
    assert.equal(autoSvc.DUMP_FORM_SOURCE, autoDirect.dumpFormEvaluate.toString());
    for (const needle of ["memberNames", "location.href", "document.forms", "document.querySelectorAll"]) {
      assert.ok(autoSvc.DUMP_FORM_SOURCE.includes(needle), `evaluate string missing ${needle}`);
    }
    const canned = { url: "https://h/personal/person/9", forms: [], selects: [], buttons: [], memberNames: [] };
    let seenFn = null;
    const mock = { evaluate: async (fn) => { seenFn = fn; return canned; } };
    assert.deepEqual(await autoSvc.dumpForm(mock), canned);
    assert.deepEqual(await autoDirect.dumpForm(mock), canned);
    assert.equal(typeof seenFn, "function");
    assert.equal(seenFn.toString(), autoSvc.DUMP_FORM_SOURCE);
  });
});
