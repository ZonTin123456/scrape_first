// Characterization: dry-run + finalize + pipeline contract (Wrap-op signatures per #18).
// These behaviors today live inline in upload-people.mjs / backup-page.mjs /
// pipeline.mjs behind browser/fsargv tangles, so this file pins them as
// STATIC source assertions + the report-status taxonomy. A UI-service refactor
// must preserve every gate below; if a gate moves into a job op, move the
// corresponding assertion to import that op instead of deleting it.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const has = (text, needle) => assert.ok(text.includes(needle), `missing pin: ${needle}`);

describe("upload-people.mjs dry-run gates (fail-closed, zero writes on dry)", () => {
  const up = src("uploader/upload-people.mjs");

  it("--save requires reviewed map or explicit verification", () => {
    has(up, "refusing --save without --map (reviewed) or --i-verified");
  });
  it("pinned --map files cannot learn departments (re-run zero-map discovery)", () => {
    has(up, "cannot auto-create");
    has(up, "pinned --map");
  });
  it("dry plan renders WOULD-CREATE with zero writes; rows skip", () => {
    has(up, "WOULD-CREATE");
    // Row-execution strings live in the shared core (CLI is the adapter).
    const core = src("uploader/lib/upload-core.mjs");
    has(core, "dry: zero writes");
    has(core, "skip-would-create");
  });
  it("created departments are re-discovered, never trusted from computed ids", () => {
    has(up, "re-discovering backend after creation");
    has(up, "still unresolvable after creation");
  });
  it("field gate runs up front (and re-gate after bootstrap)", () => {
    has(up, "has no selector/strategy");
    has(up, "checkFields();");
  });
  it("every row verifies target identity before any fill", () => {
    has(up, "verifyPageIdentity");
    has(src("uploader/lib/upload-core.mjs"), "target identity:");
  });
});

describe("stale-finalize guard (people.json vs human ticks)", () => {
  const up = src("uploader/upload-people.mjs");
  const bp = src("backup-page.mjs");

  it("refuses ticked-keep/order drift and unreviewed finalize", () => {
    has(up, "REFUSING stale finalize output");
    has(up, "ticked-keep but missing in people.json");
    has(up, "order mismatch");
    has(up, "not ticked-keep in selection.json");
    has(up, "not marked reviewed (finalize never ran)");
  });
  it("finalize marks the reviewed manifest bit the guard reads", () => {
    has(bp, "cj.manifest.reviewed = true");
    has(bp, "review/selection.json");
  });
});

describe("report contract: mode + per-row status taxonomy", () => {
  const up = src("uploader/upload-people.mjs");

  it("mode is save|dry and every status the UI will render exists", () => {
    has(up, 'mode: SAVE ? "save" : "dry"');
    // Status taxonomy lives in the shared row core.
    const core = src("uploader/lib/upload-core.mjs");
    for (const s of ["dry", "dry-partial", "skip-would-create", "created", "created-partial", "failed"]) {
      has(core, `"${s}"`);
    }
    has(up, "by_status");
  });
  it("save path resolves the photo-form submit (never a guessed button)", () => {
    has(src("uploader/lib/upload-core.mjs"), "resolvePhotoFormSubmit");
    has(src("uploader/lib/upload-core.mjs"), "save unresolved: no submit button in photo form");
  });
});

describe("pipeline.mjs DAG + backup-page step surface (job-op seams)", () => {
  const pl = src("pipeline.mjs");

  it("step order pinned; --yes only skips pauses, never gates", () => {
    has(pl, '"probe", "pick-links", "master", "apply-master", "run", "pick-images", "finalize", "upload"');
    has(pl, "spawnSync");
    has(pl, "--yes: skip pause");
    has(pl, "readFileSync(0)");
  });
});
