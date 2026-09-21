// jobs/dry-defaults.mjs — server-authoritative one-click dry inputs.
// Builds recordDryPass inputs from persisted artifacts only: the finalized
// review selection + scrape people.json + the detect snapshot. No browser, no
// backend writes, no invented mapping.
//
// Per-row targets use the wrapped resolveTargetGroup rule (Lift core, same
// rule the CLI upload path uses): registry alias wins, else the row's own
// source identity. Targets absent from the detected departments become
// would-create entries (pinned-map G1 red per contract — never synthetic
// green). Kept seqs missing from people.json become unresolved rows.
// Guards run for real over the kept subset: any failure surfaces as the
// guard status, which G1 fails closed on with a visible reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewModel } from "./review.mjs";
import { resolveTargetGroup, slugBaseOf } from "../services/sectioning.mjs";
import { sourceIdentityFailure } from "../services/guards.mjs";

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

export function buildDryDefaults(outDir, job) {
  if (!outDir || typeof outDir !== "string") fail("bad-outDir", "dry: outDir required");
  if (!job || typeof job !== "object" || !job.jobId) fail("bad-job", "dry: job required");

  // 1. Finalized selection: only kept rows matter. Empty = finalize first.
  const model = loadReviewModel(outDir, job);
  const kept = (model?.selection || []).filter((r) => r && r.keep !== false);
  if (!kept.length) {
    fail("no-selection", "dry: no kept people in the review selection (finalize People Review first)");
  }

  // 2. Scrape people content: the mutation-relevant population.
  const people = readJson(join(outDir, job.slug, "people.json"));
  if (!Array.isArray(people)) {
    fail("missing-people", "dry: people.json missing (scrape first)");
  }
  const bySeq = new Map(people.map((p) => [Number(p?.seq), p]));

  // 3. Detect snapshot: backend origin + department mapping state.
  const detect = readJson(join(outDir, job.slug, "jobs", job.jobId, "detect.json"));
  if (!detect || typeof detect !== "object") {
    fail("no-detect", "dry: no detect snapshot (run Detect first)");
  }
  const backendOrigin = detect.host ?? null;
  if (!backendOrigin || typeof backendOrigin !== "string") {
    fail("no-detect", "dry: detect snapshot has no backend host (re-run Detect)");
  }
  const departments = Array.isArray(detect.department_options)
    ? detect.department_options.map((d) => String(d))
    : [];
  const deptSet = new Set(departments.map((d) => d.toLowerCase()));

  // 4. Rows + would-create + unmapped. Registry aliases come from an explicit
  // operator map only; one-click dry passes none, so targets resolve to row
  // source identity via the wrapped rule.
  const rows = [];
  const unmapped = [];
  const wouldCreate = [];
  const seenWould = new Set();
  for (const s of kept) {
    const seq = Number(s.seq);
    const person = bySeq.get(seq);
    if (!person || typeof person !== "object") {
      rows.push({ seq, status: "unresolved", name: null, group: null, target: null, detail: "kept seq missing from people.json" });
      unmapped.push(`seq ${seq} (kept, no person record)`);
      continue;
    }
    const target = resolveTargetGroup(person.source_url ?? job.source, person.source_group ?? job.group, null);
    if (target && !deptSet.has(String(target).toLowerCase())) {
      if (!seenWould.has(target)) {
        seenWould.add(target);
        wouldCreate.push(target);
      }
    }
    rows.push({
      seq,
      status: "dry",
      name: person.name ?? null,
      group: person.source_group ?? job.group ?? null,
      target,
      detail: null,
    });
  }

  // 5. Guard status for real over the kept subset (uniformity + identity).
  const keptPeople = kept.map((s) => bySeq.get(Number(s.seq))).filter((p) => p && typeof p === "object");
  const guardFailure = sourceIdentityFailure(keptPeople, slugBaseOf);
  // Pass the raw guard detail through: guardStatusReason fails G1 closed on
  // any non-green value with the detail visible (no synthetic green).
  const guard = guardFailure == null ? "green" : String(guardFailure).slice(0, 300);

  return {
    snapshotInput: {
      people,
      selection: kept.map((s) => ({ seq: Number(s.seq), keep: true, order: Number(s.order ?? 0) })),
      sourceUrl: job.source,
      sourceGroup: job.group,
      backendOrigin,
      deptMapping: {
        departments,
        profile: detect.profile ?? null,
        ambiguous: Array.isArray(detect.ambiguous) ? detect.ambiguous : [],
      },
      deptPlan: rows.map((r) => ({ seq: r.seq, target: r.target })),
      mappingVersion: null,
      profileVersion: detect.profile ?? null,
    },
    rows,
    mapMode: "pinned",
    guardStatus: guard,
    listedPath: null,
    destinationOrigin: backendOrigin,
    targetDepts: departments,
    wouldCreate,
    identity: null,
    unmapped,
    shots: [],
  };
}
