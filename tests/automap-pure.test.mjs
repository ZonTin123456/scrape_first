// Characterization: automap.mjs pure subset (Lift-verbatim per #18).
// Pins matchProfile, pickDeptRows, buildInventory field actions.
// Live automap()/dumpForm() need a browser: explicitly OUT of this boundary.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadProfiles,
  matchProfile,
  pickDeptRows,
  buildInventory,
} from "../uploader/lib/automap.mjs";

const stsDumped = () => ({
  forms: [
    {
      action: "https://h/personal/person/9",
      elements: [
        { tag: "INPUT", type: "file", name: "img_path", id: "img1", selector: "#img1", label: { text: "ภาพ", via: "for" }, fi: 0 },
        { tag: "INPUT", type: "text", name: "p_name", id: "", selector: 'input[name="p_name"]', label: { text: "ชื่อ-สกุล", via: "for" }, fi: 0 },
        { tag: "INPUT", type: "text", name: "p_position", id: "", selector: 'input[name="p_position"]', label: { text: "ตำแหน่ง", via: "for" }, fi: 0 },
      ],
    },
  ],
  selects: [],
  buttons: [],
});

describe("loadProfiles + matchProfile: fingerprint-first, no guessing", () => {
  it("loads the STS personnel fingerprint", () => {
    const profiles = loadProfiles();
    const sts = profiles.find((p) => p.name === "sts-personnel-v1");
    assert.ok(sts, "sts-personnel-v1 present");
    assert.ok(sts.fingerprint.file.includes("img_path"));
    assert.ok(sts.fingerprint.text.includes("p_name"));
  });
  it("matches STS-shaped dumps, rejects strangers", () => {
    const profiles = loadProfiles();
    assert.equal(matchProfile(stsDumped(), profiles).name, "sts-personnel-v1");
    const strange = {
      forms: [{ action: "https://h/x", elements: [{ tag: "INPUT", type: "text", name: "qq_xyz", id: "", selector: "x", label: { text: "?", via: "none" }, fi: 0 }] }],
      selects: [],
      buttons: [],
    };
    assert.equal(matchProfile(strange, profiles), null);
  });
});

describe("pickDeptRows: both URL schemes, id dedupe, cap 20", () => {
  it("accepts canonical + bare, ignores delete/nav/root", () => {
    const rows = pickDeptRows([
      { href: "https://h/personal/person/3", rowText: "กองคลัง" },
      { href: "https://h/personal/delete/3", rowText: "ลบ" },
      { href: "https://h/personal", rowText: "บุคลากร" },
      { href: "https://h/news/5", rowText: "ข่าว" },
      { href: "https://h/personal/4", rowText: "กองช่าง" },
    ]);
    assert.deepEqual(rows.map((r) => r.deptId).sort(), ["3", "4"]);
  });
  it("same id dedupes, canonical full wins over bare", () => {
    const rows = pickDeptRows([
      { href: "https://h/personal/3", rowText: "bare" },
      { href: "https://h/personal/person/3", rowText: "canon" },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].full, true);
    assert.equal(rows[0].rowText, "canon");
  });
  it("caps at 20 rows", () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({ href: `https://h/personal/person/${100 + i}`, rowText: `d${i}` }));
    assert.equal(pickDeptRows(raw).length, 20);
  });
});

describe("buildInventory: photo-form scoped, map-first, loud unmapped", () => {
  const dumped = () => ({
    forms: [
      {
        action: "https://h/personal/person/9",
        elements: [
          { tag: "INPUT", type: "file", name: "img_path", id: "", selector: 'input[name="img_path"]', label: { text: "ภาพ", via: "for" }, fi: 0 },
          { tag: "INPUT", type: "text", name: "p_name", id: "", selector: 'input[name="p_name"]', label: { text: "ชื่อ-สกุล", via: "for" }, fi: 0 },
          { tag: "INPUT", type: "text", name: "mystery", id: "", selector: 'input[name="mystery"]', label: { text: "ลึกลับ", via: "for" }, fi: 0 },
          { tag: "INPUT", type: "hidden", name: "_token", id: "", selector: 'input[name="_token"]', label: { text: "", via: "none" }, fi: 0 },
          { tag: "INPUT", type: "submit", name: "", id: "", selector: 'input[type="submit"]', label: { text: "บันทึก", via: "none" }, fi: 0 },
          // other-form controls are out of scope (photo-form scoping)
          { tag: "INPUT", type: "text", name: "other", id: "", selector: 'input[name="other"]', label: { text: "อื่น", via: "for" }, fi: 3 },
        ],
      },
    ],
    selects: [],
    buttons: [],
  });
  const fields = {
    photo: { selector: 'input[name="img_path"]' },
    name: { selector: 'input[name="p_name"]' },
    save: { strategy: "photo-form-submit" },
  };

  it("known selectors become fill actions; submit promotes to click", () => {
    const inv = buildInventory(dumped(), fields);
    const by = (s) => inv.find((i) => i.selector === s);
    assert.equal(by('input[name="img_path"]').action, "fill:photo");
    assert.equal(by('input[name="p_name"]').action, "fill:name");
    assert.equal(by('input[type="submit"]').action, "click");
  });
  it("unknown fillables are loud skip+unmapped; hidden + off-form excluded", () => {
    const inv = buildInventory(dumped(), fields);
    const mystery = inv.find((i) => i.selector === 'input[name="mystery"]');
    assert.equal(mystery.action, "skip");
    assert.equal(mystery.unmapped, true);
    assert.ok(!inv.some((i) => i.selector === 'input[name="_token"]'), "csrf hidden skipped");
    assert.ok(!inv.some((i) => i.selector === 'input[name="other"]'), "off-form scoped out");
  });
});
