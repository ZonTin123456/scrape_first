// uploader/lib/upload-runner.mjs — production uploadRow binding for the Job/UI
// path. Binds the shared upload core (./upload-core.mjs, same mutation logic
// the CLI runs) to a Playwright page over CDP, with per-job context assembled
// from persisted artifacts: the detect snapshot (sections/fields), the slug
// people.json, and the source-groups registry.
//
// playwright-core resolves from uploader/node_modules (same as the CLI).
// jobs/pipeline.mjs imports this module relatively; the import chain keeps
// server.mjs's direct imports clean (static linkage test scans server.mjs).
// Never contact a non-loopback backend in tests: callers pass the backend
// explicitly (E2E runbook pins it to 127.0.0.1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resolvePort } from "./cdp-port.mjs";
import { buildDeptIndex, executeUploadRows } from "./upload-core.mjs";
import { resolveTargetGroup } from "../../services/sectioning.mjs";
import { verifyPageIdentity } from "../../services/identity.mjs";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

const norm = (s) => String(s || "").trim().normalize("NFC");

// Assemble one job's upload context from persisted artifacts. Throws
// fail-closed codes when the detect snapshot or people are missing.
export function buildJobUploadContext({ outDir, job }) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "upload runner: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "upload runner: job required");
  const detect = readJson(join(outDir, job.slug, "jobs", job.jobId, "detect.json"));
  if (!detect || typeof detect !== "object") fail("no-detect", "upload runner: no detect snapshot (run Detect first)");
  const backend = detect.host ?? null;
  if (!backend || typeof backend !== "string") fail("no-detect", "upload runner: detect snapshot has no backend host");
  const sections = detect?.content?.map?.sections ?? null;
  if (!sections || typeof sections !== "object" || !Object.keys(sections).length) {
    fail("no-detect-map", "upload runner: detect snapshot has no department map");
  }
  const map = { fields: detect.content.map.fields ?? null, sections };
  if (!map.fields) fail("no-detect-map", "upload runner: detect snapshot has no form fields");
  const people = readJson(join(outDir, job.slug, "people.json"));
  if (!Array.isArray(people)) fail("missing-people", "upload runner: people.json missing");
  let registry = { map: {} };
  try {
    const raw = readJson(join(process.cwd(), "source-groups.json"));
    if (raw && typeof raw === "object") registry = raw;
  } catch {
    // no registry = pure source identity (wrapped default)
  }
  const index = buildDeptIndex(sections);
  const targetGroupOf = (p) => resolveTargetGroup(p.source_url, p.source_group, registry);
  const resolveGroup = (g) => {
    if (!g) return { empty: true };
    const entry = index.get(norm(g));
    return entry
      ? { personUrl: entry.personUrl, deptId: entry.deptId ?? null, fields: entry.fields || null, inventory: entry.inventory || null, via: "detect" }
      : { missing: true };
  };
  return {
    backend,
    fieldMap: { fields: map.fields, list_url: `${backend}/personal`, success_mark: null },
    perSection: detect?.content?.map?.mode === "per-section-url",
    fromDir: join(outDir, job.slug),
    shotsDir: join(outDir, job.slug, "jobs", job.jobId, "shots"),
    people,
    personBySeq: new Map(people.map((p) => [Number(p?.seq), p])),
    targetGroupOf,
    resolveGroup,
  };
}

// Production runner: one shared page, one row per call. Caller owns close().
export async function createUploadRowRunner({ outDir, job, port = "auto", onRow = null, onArtifact = null } = {}) {
  const ctx = buildJobUploadContext({ outDir, job });
  const realPort = await resolvePort(port).catch((e) => fail("cdp-unreachable", `upload runner: ${e.message}`));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${realPort}`).catch((e) => {
    fail("cdp-unreachable", `upload runner: connect port ${realPort}: ${e.message}`);
  });
  const context = browser.contexts()[0];
  if (!context) fail("no-context", "upload runner: no browser context");
  const page = await context.newPage();
  let closed = false;
  return {
    backend: ctx.backend,
    // Same envelope as pipeline uploadStep runners: {outDir, job, entry, dir}.
    // Accepts a bare entry too (tests/debug callers).
    async uploadRow(args) {
      const entry = args && typeof args === "object" && "entry" in args ? args.entry : args;
      const person = ctx.personBySeq.get(Number(entry?.seq));
      if (!person) {
        return { seq: Number(entry?.seq), status: "failed", detail: "person missing from people.json" };
      }
      const results = await executeUploadRows({
        page,
        people: [person],
        TO: null,
        SAVE: true,
        fieldMap: ctx.fieldMap,
        listUrl: ctx.fieldMap.list_url,
        perSection: ctx.perSection,
        fromDir: ctx.fromDir,
        shotsDir: ctx.shotsDir,
        targetGroupOf: ctx.targetGroupOf,
        resolveGroup: ctx.resolveGroup,
        verifyIdentity: verifyPageIdentity,
        onRow,
        onArtifact,
      });
      return results[0] ?? { seq: Number(entry?.seq), status: "failed", detail: "no result" };
    },
    async close() {
      if (!closed) {
        closed = true;
        await page.close().catch(() => null);
      }
    },
  };
}
