// tests/upload-core.test.mjs — shared upload plan + row core, no browser.
// A fake page object implements the Playwright surface the core uses; the
// same core ships in the CLI adapter and the Job binding, so these pins cover
// both. Run: node --test tests/upload-core.test.mjs
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeptIndex,
  buildUploadPlan,
  composeDetail,
  executeUploadRows,
  resolvePhotoAbs,
  resolvePhotoFormSubmit,
} from "../uploader/lib/upload-core.mjs";

let dir;
let shotsDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ucore-"));
  shotsDir = join(dir, "shots");
  writeFileSync(join(dir, "p0.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

// Minimal fake Playwright page: records fills/clicks, serves scripted reads.
function fakePage({ bodyText = "", submitSelector = "#save", failFill = null } = {}) {
  const calls = [];
  const el = () => ({
    first: () => el(),
    isChecked: async () => true,
    check: async () => true,
  });
  return {
    calls,
    async goto(url) {
      calls.push(["goto", url]);
    },
    async evaluate(fn, ...args) {
      if (typeof fn === "function") {
        if (fn.length === 0) return bodyText; // dup-check body read
        return submitSelector; // resolvePhotoFormSubmit branch (selector known)
      }
      return null;
    },
    locator: (sel) => {
      calls.push(["locator", sel]);
      return el();
    },
    async setInputFiles(sel, val) {
      calls.push(["setInputFiles", sel, String(val)]);
    },
    async fill(sel, val) {
      calls.push(["fill", sel, String(val)]);
      if (failFill && String(sel).includes(failFill)) throw new Error("fill boom");
    },
    async selectOption(sel, opt) {
      calls.push(["selectOption", sel, JSON.stringify(opt)]);
    },
    async click(sel) {
      calls.push(["click", sel]);
    },
    getByText: () => ({ first: () => ({ waitFor: async () => true }) }),
    async waitForLoadState() {
      return true;
    },
    async screenshot({ path }) {
      writeFileSync(path, "shot");
      calls.push(["screenshot", path]);
    },
  };
}

const FIELDS = {
  photo: { selector: 'input[name="img_path"]' },
  name: { selector: 'input[name="p_name"]' },
  position: { selector: 'input[name="p_position"]' },
  detail: { selector: 'input[name="p_detail"]' },
  order: { selector: 'input[name="prarent_id"]' },
  department: { selector: null },
  publish: { selector: null },
  save: { strategy: "photo-form-submit" },
};
const fieldMap = { fields: FIELDS, list_url: "http://127.0.0.1:18731/personal", success_mark: null };

function ctx(over = {}) {
  return {
    fieldMap,
    listUrl: fieldMap.list_url,
    perSection: false,
    fromDir: dir,
    shotsDir,
    targetGroupOf: () => "g",
    resolveGroup: (g) => ({ personUrl: "http://127.0.0.1:18731/personal/person/1", via: "exact" }),
    verifyIdentity: async () => ({ ok: true }),
    ...over,
  };
}

const person = { seq: 0, order: 0, name: "A", position: "P", phone: null, note: null, photo: "p0.png", source_url: "http://x/b", source_group: "g" };

describe("upload-core pure helpers", () => {
  it("composeDetail joins phone + note; resolvePhotoAbs rules", () => {
    assert.equal(composeDetail({ phone: "1", note: "n" }), "1<br>n");
    assert.equal(composeDetail({}), null);
    assert.equal(resolvePhotoAbs(dir, "p0.png"), join(dir, "p0.png"));
    assert.equal(resolvePhotoAbs(dir, "https://x/i.png"), null);
    assert.equal(resolvePhotoAbs(dir, null), null);
  });

  it("buildUploadPlan splits existing vs would-create; dept index exact", () => {
    const index = buildDeptIndex({ g: { personUrl: "u" } });
    assert.equal(index.get("g").personUrl, "u");
    const { uploadPlan, missingGroups } = buildUploadPlan({
      people: [{ source_group: "g" }, { source_group: "new" }],
      targetGroupOf: (p) => p.source_group,
      resolveGroup: (g) => (index.has(g) ? { personUrl: "u", via: "exact" } : { missing: true }),
      TO: null,
    });
    assert.deepEqual(uploadPlan.map((e) => [e.group, e.action]), [["g", "upload"], ["new", "would-create"]]);
    assert.deepEqual(missingGroups, [{ group: "new" }]);
  });

  it("resolvePhotoFormSubmit finds the in-form submit", async () => {
    const page = fakePage({ submitSelector: "#save" });
    assert.equal(await resolvePhotoFormSubmit(page, 'input[name="img_path"]'), "#save");
  });
});

describe("upload-core row execution (fake page)", () => {
  it("dry fills + screenshots with zero saves", async () => {
    const page = fakePage();
    const results = await executeUploadRows({ page, people: [person], SAVE: false, ...ctx() });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "dry");
    assert.ok(results[0].detail.includes("shot:"));
    assert.ok(page.calls.some((c) => c[0] === "fill" && c[1] === 'input[name="p_name"]' && c[2] === "A"));
    assert.ok(page.calls.some((c) => c[0] === "setInputFiles"));
    assert.ok(!page.calls.some((c) => c[0] === "click"), "dry never clicks save");
    assert.ok(existsSync(join(shotsDir, "000-seq0.png")));
  });

  it("save clicks the resolved submit", async () => {
    const page = fakePage();
    const results = await executeUploadRows({ page, people: [person], SAVE: true, ...ctx() });
    assert.equal(results[0].status, "created");
    assert.ok(page.calls.some((c) => c[0] === "click" && c[1] === "#save"));
  });

  it("missing photo fails the row without touching the browser", async () => {
    const page = fakePage();
    const results = await executeUploadRows({
      page, people: [{ ...person, photo: "nope.png" }], SAVE: true, ...ctx(),
    });
    assert.equal(results[0].status, "failed");
    assert.match(results[0].detail, /photo missing/);
    assert.ok(!page.calls.some((c) => c[0] === "goto"));
  });

  it("identity failure fails closed before any fill", async () => {
    const page = fakePage();
    const results = await executeUploadRows({
      page, people: [person], SAVE: true,
      ...ctx({ verifyIdentity: async () => ({ ok: false, reason: "no id" }) }),
    });
    assert.equal(results[0].status, "failed");
    assert.match(results[0].detail, /target identity/);
    assert.ok(!page.calls.some((c) => c[0] === "fill"));
  });

  it("unresolvable group skips dry / fails save", async () => {
    const missing = { ...ctx(), resolveGroup: () => ({ missing: true }) };
    const page = fakePage();
    const dry = await executeUploadRows({ page, people: [person], SAVE: false, ...missing });
    assert.equal(dry[0].status, "skip-would-create");
    const save = await executeUploadRows({ page, people: [person], SAVE: true, ...missing });
    assert.equal(save[0].status, "failed");
    assert.match(save[0].detail, /unresolvable/);
  });

  it("fill errors fail the row truthfully", async () => {
    const page = fakePage({ failFill: "p_name" });
    const results = await executeUploadRows({ page, people: [person], SAVE: true, ...ctx() });
    assert.equal(results[0].status, "failed");
    assert.match(results[0].detail, /fill boom/);
  });
});
