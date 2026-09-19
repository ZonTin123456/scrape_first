#!/usr/bin/env node
// upload-people: people.json (loader output) -> STS backend personnel form.
// READS out/<slug>/ only. NEVER writes there. Default is --dry (fill + screenshot, no save).
// Usage:
//   node upload-people.mjs --from out/<slug>/people.json --backend https://host [--port 9444] [--save] [--limit N] [--map uploader/maps/<host>.json]
//   Login: reuse the logged-in Chrome on --port (no passwords stored).
// Backend rule: phone + trailing note go into รายละเอียด (p_detail) joined with <br>; skipped when both absent.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePort, discoverBackends } from "./lib/cdp-port.mjs";
import { automap } from "./lib/automap.mjs";
import { mapHostMismatch, sourceIdentityFailure, fieldsSatisfy } from "../services/guards.mjs";
import { slugBaseOf, resolveTargetGroup } from "../services/sectioning.mjs";
import { verifyPageIdentity } from "../services/identity.mjs";
import { createDepartment } from "./lib/target-creation.mjs";
import { createHub } from "../jobs/events.mjs";
import { createEngineEmitter } from "../jobs/engine-events.mjs";

// P4b full engine event catalog behind JOB_EVENTS=1 only.
// Disabled by default so CLI terminal/files are exactly as before.
const __engineOn = process.env.JOB_EVENTS === "1";
const __engineHub = __engineOn ? createHub() : null;
const __engine = __engineOn
  ? createEngineEmitter({ hub: __engineHub, jobId: process.env.JOB_ID || "cli", emitEvents: true })
  : null;
function __pushRow(results, rec) {
  results.push(rec);
  try {
    __engine?.rowFinished({
      seq: rec.seq,
      order: rec.order ?? null,
      name: rec.name ?? null,
      status: rec.status,
      detail: rec.detail ?? null,
      group: rec.group ?? null,
      form: rec.form ?? null,
    });
  } catch {
    // events never break CLI
  }
  return rec;
}
function __emitArtifact(absPath, relPath, kind, url) {
  try {
    return __engine?.artifactFromFile({ absPath, relPath, kind, url }) ?? null;
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const fail = (m) => { console.error("upload-people: " + m); process.exit(1); };
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node upload-people.mjs --from out/<slug>/people.json [--backend https://host] [--port auto] [--save] [--limit N] [--map uploader/maps/<host>.json] [--i-verified]");
  console.log("  --port auto scans 9333 -> 9444 -> 9222; backend auto-discovered from open tabs when omitted");
  console.log("  no --map: zero-map runtime discovery runs inline (dry free, --save needs --map or --i-verified)");
  console.log("  --map is deprecated (reader kept 1 version); discovery is the default workflow");
  console.log("  --to <personUrl>: escape hatch — force every row to one form, skip section resolution");
  console.log("  default = --dry (fill + screenshot per person, never clicks save)");
  console.log("  dry shows the plan per section: existing target URL, or WOULD-CREATE (zero writes)");
  console.log("  --save auto-creates missing departments (explicit opt-in: needs --map or --i-verified),");
  console.log("  then rediscovers, verifies identity, and only then uploads; any failure stops the run");
  console.log("  named-but-unresolvable sections fail closed in per-section mode (no silent misroute);");
  console.log("  rows with no section keep the old flex path (default form + partial note)");
  console.log("  --save refuses stale finalize output (people.json vs review/selection.json) unless --ignore-selection-check");
  console.log("  --save needs --dry-proof <dry-report.json> (fresh dry prerequisite; --yes never bypasses dry proof)");
  console.log("  --save interactive prints a safety summary and requires typing the exact slug; --yes is non-interactive confirm only");
  process.exit(2);
}
const FROM = opt("--from", null);
const BACKEND_OPT = (opt("--backend", null) || "").replace(/\/$/, ""); // explicit CLI value (may be empty)
let BACKEND = BACKEND_OPT;
const PORT = await resolvePort(opt("--port", "auto")).catch((e) => fail(e.message));
const MAP = opt("--map", null);
const SAVE = argv.includes("--save");
const YES = argv.includes("--yes");
const DRY_PROOF = opt("--dry-proof", null);
const TO = (opt("--to", null) || "").replace(/\/$/, "");
if (TO && !/\/personal\/(?:person\/)?\d+(?:[/?#]|$)/.test(TO)) fail("bad --to (want a .../personal/... form URL)");
const LIMIT = Number(opt("--limit", "0")) || 0;
if (!FROM) fail("missing --from out/<slug>/people.json");
if (!existsSync(FROM)) fail(`people file not found: ${FROM}`);

const uploaderDir = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(uploaderDir, p), "utf8"));
let fieldMap, mapMeta = null;
if (MAP) {
  const m = JSON.parse(readFileSync(MAP, "utf8"));
  if (m.map && m.map.fields) {
    // auto-detected map file from detect.mjs
    mapMeta = m;
    const firstSec = m.map.sections ? Object.values(m.map.sections)[0] : null;
    fieldMap = { fields: m.map.fields, create_url: firstSec?.personUrl || m.formUrl || null, list_url: `${m.host}/personal`, success_mark: null };
    console.log(`using detected map ${MAP} - REVIEW it before --save`);
  } else {
    fieldMap = m;
    if (fieldMap._status !== "locked") {
      fail(`map file is "${fieldMap._status}": lock it first (map-check.mjs) or use an automap maps/<host>.json`);
    }
  }
}
// Host-consistency gate (2B-2): explicit --backend + automap-shape map must
// share a URL origin. Fires before derivation/discovery/resolution/upload.
// Locked/manual maps have no mapMeta.host, so they are unaffected.
if (BACKEND_OPT && mapMeta?.host) {
  const mismatch = mapHostMismatch(mapMeta.host, BACKEND_OPT);
  if (mismatch) fail(`${mismatch} — use the same host for --map and --backend, or drop --backend so the map defines it`);
}
if (!BACKEND && mapMeta?.host) BACKEND = mapMeta.host; // --map knows its backend
if (!BACKEND) {
  const found = await discoverBackends(PORT).catch(() => []);
  if (found.length === 1) { BACKEND = found[0]; console.log(`backend auto-discovered: ${BACKEND}`); }
  else if (found.length > 1) fail(`multiple backends open (${found.join(", ")}): specify --backend`);
  else fail("missing --backend https://tenant.host (no /personal tab found on CDP)");
}
if (!MAP) {
  // fieldMap filled via inline automap after browser connect (below).
}
// section-map.json is superseded: target identity is the source URL's own
// group now (source-groups.json only for intentional merges). Kept on disk
// as a compatibility artifact, no longer read here.
const groupRegistry = (() => { try { return readJson("../source-groups.json"); } catch { return { map: {} }; } })();
const peopleAll = JSON.parse(readFileSync(FROM, "utf8"));
if (!Array.isArray(peopleAll) || !peopleAll.length) fail("people.json is empty");
// creation sequence follows selection order (backend may list by insertion,
// not by the order field). Stable within duplicate orders.
const orderedAll = [...peopleAll].sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0)));
const people = LIMIT > 0 ? orderedAll.slice(0, LIMIT) : orderedAll;
const fromDir = dirname(resolve(FROM));
const slug = basename(fromDir);
// P6 Safety: --save needs a fresh dry proof (--dry-proof <dry-report.json>).
// Fail closed on missing/invalid proof even with --yes: --yes is
// non-interactive confirm only and never bypasses the dry prerequisite,
// group/host/field/identity guards, or the failed-row policy.
let dryProof = null;
if (SAVE) {
  if (!DRY_PROOF) fail("refusing --save without --dry-proof <dry-report.json> (fresh dry prerequisite; --yes never bypasses)");
  let raw;
  try { raw = readFileSync(DRY_PROOF); }
  catch { fail(`refusing --save: dry proof unreadable: ${DRY_PROOF}`); }
  let proof;
  try { proof = JSON.parse(raw.toString("utf8")); }
  catch { fail(`refusing --save: dry proof invalid JSON: ${DRY_PROOF}`); }
  if (proof.mode !== "dry") fail(`refusing --save: dry proof mode must be "dry" (was ${proof.mode})`);
  if (proof.slug !== slug) fail(`refusing --save: dry proof slug "${proof.slug}" != current "${slug}" (stale snapshot: re-dry)`);
  const failedByStatus = (proof.by_status && proof.by_status.failed) || 0;
  const failedRows = Array.isArray(proof.results) ? proof.results.filter((r) => r && r.status === "failed") : [];
  if (failedByStatus > 0 || failedRows.length > 0) fail("refusing --save: dry proof has failed rows (G1 red until rows pass)");
  const sha = createHash("sha256").update(raw).digest("hex");
  const total = proof.total ?? (Array.isArray(proof.results) ? proof.results.length : "?");
  dryProof = { path: DRY_PROOF, sha256: sha, total, by_status: proof.by_status ?? {} };
  console.log(`dry proof verified: ${DRY_PROOF} sha256=${sha.slice(0, 16)}... total=${total} ${JSON.stringify(dryProof.by_status)}`);
}
// F1: refuse stale finalize output (people.json must match human ticks).
// Escape hatch: --ignore-selection-check (loudly logged, your responsibility).
{
  const selPath = join(fromDir, "review", "selection.json");
  const cjPath = join(fromDir, "content.json");
  if (!existsSync(selPath)) {
    console.log("warn: no review/selection.json — stale-finalize check skipped");
  } else {
    const issues = [];
    let sel = null;
    try { sel = JSON.parse(readFileSync(selPath, "utf8")); }
    catch (e) { issues.push(`selection.json unreadable: ${String(e.message || e).slice(0, 80)}`); }
    if (sel) {
      const keepSel = new Map(sel.filter((s) => s && s.keep).map((s) => [Number(s.seq), s]));
      const ppl = new Map(peopleAll.map((p) => [Number(p.seq), p]));
      for (const [seq, s] of keepSel) {
        const p = ppl.get(seq);
        if (!p) issues.push(`seq ${seq} ticked-keep but missing in people.json`);
        else if (s.order !== undefined && s.order !== null && s.order !== "" && Number(p.order) !== Number(s.order))
          issues.push(`seq ${seq} order mismatch: selection=${s.order} people=${p.order}`);
      }
      for (const seq of ppl.keys()) {
        if (!keepSel.has(seq)) issues.push(`seq ${seq} in people.json but not ticked-keep in selection.json`);
      }
    }
    if (existsSync(cjPath)) {
      try {
        if (!JSON.parse(readFileSync(cjPath, "utf8")).manifest?.reviewed)
          issues.push("content.json not marked reviewed (finalize never ran)");
      } catch { issues.push("content.json unreadable"); }
    }
    if (issues.length && !argv.includes("--ignore-selection-check")) {
      console.error("upload-people: REFUSING stale finalize output:");
      for (const i of issues.slice(0, 15)) console.error("  - " + i);
      if (issues.length > 15) console.error(`  ... +${issues.length - 15} more`);
      fail(`re-run: node backup-page.mjs --finalize ${fromDir} (or pass --ignore-selection-check)`);
    } else if (issues.length) {
      console.log(`warn: ignoring ${issues.length} stale-finalize issue(s) (--ignore-selection-check)`);
    }
  }
}
const perSectionMode = () => mapMeta?.map?.mode === "per-section-url";
// Source identity gate (1 URL = 1 source group): uniform source_url, present
// source_group, and every row's group must equal its own URL's stable key.
// Runs before any planning, discovery follow-ups, or backend mutation.
{
  const ifail = sourceIdentityFailure(peopleAll, slugBaseOf);
  if (ifail) fail(`source identity: ${ifail}`);
}
const fill = (s) => String(s || "").replace("{backend}", BACKEND);
let listUrl = null; // set after fieldMap final (ephemeral automap may fill it)
const norm = (s) => String(s || "").trim().normalize("NFC");
// detail (รายละเอียด) = phone + trailing note lines; backend renders <br> as breaks.
const detailVal = (p) => [p.phone, p.note].filter((v) => v != null && v !== "").join("<br>") || null;
// Source-group routing (1 URL = 1 source group). The backend target for a
// row is its source identity (registry alias for intentional merges,
// otherwise the row's own source_group) — HTML section labels are evidence
// only and never participate in target identity.
// member names per target group (creation duplicate-guard evidence)
const groupMembers = new Map();
const targetGroupOf = (p) => resolveTargetGroup(p.source_url, p.source_group, groupRegistry);
for (const p of people) {
  const g = targetGroupOf(p);
  if (!groupMembers.has(g)) groupMembers.set(g, []);
  if (p.name) groupMembers.get(g).push(p.name);
}
// Backend dept index from discovery (live or pinned map): norm(label) -> entry
const deptIndex = () => {
  const m = new Map();
  for (const [key, v] of Object.entries(mapMeta?.map?.sections || {})) m.set(norm(key), { key, ...(v || {}) });
  return m;
};
const groupCache = new Map();
const resolveGroup = (g) => {
  if (!g) return { empty: true };
  if (groupCache.has(g)) return groupCache.get(g);
  const entry = deptIndex().get(norm(g));
  const out = entry
    ? { personUrl: entry.personUrl, deptId: entry.deptId ?? null, fields: entry.fields || null, inventory: entry.inventory || null, via: "exact" }
    : { missing: true };
  groupCache.set(g, out);
  return out;
};
const shotsDir = join(uploaderDir, "shots", slug);
mkdirSync(shotsDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((e) => fail(`connect port ${PORT}: ${e.message}`));
const context = browser.contexts()[0];
if (!context) fail("no browser context");
if (!MAP) {
  // no map: inline profile auto-detect (ephemeral, not saved). Dry is free; save needs approval.
  if (SAVE && !argv.includes("--i-verified")) fail("refusing --save without --map (reviewed) or --i-verified");
  const probeGroups = [...new Set(people.map(targetGroupOf))];
  if (!probeGroups.length) fail("people.json has no source groups for auto-detect (give --map instead)");
  console.log(`no --map: auto-detecting ${BACKEND} ...`);
  const auto = await automap(context, BACKEND, probeGroups, { write: false });
  if (!auto.ok) fail(`auto-detect failed: ${auto.error}`);
  mapMeta = { host: BACKEND, map: auto.content.map };
  const firstSec = Object.values(auto.content.map.sections || {})[0];
  fieldMap = { fields: auto.content.map.fields, create_url: firstSec?.personUrl || null, list_url: `${BACKEND}/personal`, success_mark: null };
  console.log(`auto-detect: ${auto.content.profile ? "profile:" + auto.content.profile : "full-classify"} (${Object.keys(auto.content.map.sections || {}).length} sections)`);
}
let perSection = perSectionMode();
const need = perSection ? ["photo", "name", "position", "save"] : ["photo", "name", "position", "department", "save"];
const checkFields = () => {
  const lacking = fieldsSatisfy(fieldMap.fields, need);
  if (lacking.length) fail(`map fields.${lacking[0]} has no selector/strategy (ambiguous? check ${MAP || "auto-detect output"})`);
};
// Empty-backend bootstrap (generic, discovery-result only): zero discovered
// departments defers the field gate until after creation + rediscovery —
// otherwise no empty tenant could ever be bootstrapped (chicken-and-egg).
// Non-empty backends keep the existing gate unchanged.
const emptyBackend = Object.keys(mapMeta?.map?.sections || {}).length === 0;
if (emptyBackend) console.log("empty backend (0 departments discovered): deferring field check until after bootstrap");
else checkFields();
listUrl = fill(fieldMap.list_url);
// pre-flight: every distinct source target group resolves to exactly one
// backend department by exact name. Missing groups show WOULD-CREATE in
// dry-run, or trigger auto-create in --save (phase below). HTML section
// labels are evidence only and never decide targets. --to skips resolution.
// uploadPlan feeds the dry-run plan block and the final report.
let uploadPlan = [];
const missingGroups = []; // unresolved target groups shared with creation below
{
  const missing = missingGroups; // missing -> creatable (save) / would-create (dry)
  const planSeen = new Set();
  const planAdd = (group, action, target, via) => {
    if (planSeen.has(group)) return;
    planSeen.add(group);
    uploadPlan.push({ group, action, target: target || null, via: via || null });
  };
  if (TO) {
    console.log(`target resolution skipped (--to ${TO})`);
  } else for (const p of people) {
    const g = targetGroupOf(p);
    const r = resolveGroup(g);
    if (r.missing) {
      if (!missing.some((m) => m.group === g)) missing.push({ group: g });
      planAdd(g, "would-create", null);
    } else {
      planAdd(g, "upload", r.personUrl, r.via || null);
    }
  }
  if (missing.length && !SAVE) {
    console.log(`dry-run plan: ${missing.length} group(s) would be CREATED on --save (zero writes now):`);
    for (const m of missing) console.log(`  - WOULD-CREATE department "${m.group}"`);
  }
  if (!SAVE && !TO) {
    console.log("upload plan (dry, no writes):");
    for (const e of uploadPlan) {
      if (e.action === "upload") console.log(`  - group "${e.group}" -> ${e.target} (existing)`);
      else if (e.action === "would-create") console.log(`  - group "${e.group}" -> WOULD-CREATE`);
      else console.log(`  - group "${e.group}" -> ${e.action}`);
    }
    console.log(`  rows: ${people.length} total (see report for per-row status)`);
  }
}
try { __engine?.uploadPlan({ slug, mode: SAVE ? "save" : "dry", total: people.length, plan: uploadPlan }); } catch { /* ignore */ }
// auto-create missing departments (save mode, zero-map path only).
// Pinned --map files cannot learn new departments: refuse and point at discovery.
if (SAVE && !TO && missingGroups.length && MAP) {
  fail(`cannot auto-create ${missingGroups.length} missing group(s) with a pinned --map (${missingGroups.map((m) => m.group).join(", ")}) — re-run without --map (zero-map discovery) or pass --to <personUrl>`);
}
// P6 Safety: interactive --save prints a safety summary and requires typing
// the exact slug. --yes is non-interactive confirm only — every gate above
// and below stays enforced (--yes never bypasses dry proof, guards, rows).
if (SAVE) {
  console.log(`safety summary (REAL upload): backend=${BACKEND} slug=${slug} from=${FROM}`);
  console.log(`  dry proof: ${dryProof.path} sha256=${dryProof.sha256.slice(0, 16)}...`);
  console.log(`  plan: ${uploadPlan.map((e) => `${e.group}->${e.action}`).join(", ")}`);
  if (YES) {
    console.log("( --yes: non-interactive confirm; dry proof + guards + row policy still enforced )");
  } else if (process.stdin.isTTY) {
    process.stdout.write(`type exact slug "${slug}" to arm real upload: `);
    const typed = readFileSync(0, "utf8").trim().split(/\s+/)[0] ?? "";
    if (typed !== slug) fail(`typed slug mismatch (want exact "${slug}"): NOT uploading (fail-closed)`);
    console.log("slug confirmed.");
  } else {
    fail("refusing --save: non-interactive stdin needs --yes (non-interactive confirm only; dry proof still required)");
  }
}
if (SAVE && !TO && missingGroups.length && !MAP) {
  const cpage = await context.newPage();
  try {
    for (const m of missingGroups) {
      console.log(`creating department "${m.group}" ...`);
      let cr;
      try {
        cr = await createDepartment(cpage, { host: BACKEND, name: m.group, wantMembers: groupMembers.get(m.group) || [] });
      } catch (e) {
        fail(`department creation threw for "${m.group}": ${String((e && e.message) || e).slice(0, 120)} — NOT uploading (fail-closed)`);
      }
      if (!cr || cr.status !== "created") {
        if (cr && cr.evidence) for (const l of cr.evidence.slice(0, 6)) console.error("  " + l);
        fail(`department creation failed for "${m.group}": ${(cr && (cr.reason || cr.status)) || "unknown"} — NOT uploading (fail-closed)`);
      }
      console.log(`created department "${m.group}" -> ${cr.target.personUrl} (backend id ${cr.target.deptId})`);
      const pe = uploadPlan.find((e) => e.group === m.group);
      if (pe) { pe.action = "created"; pe.target = cr.target.personUrl; }
    }
  } finally {
    await cpage.close().catch(() => null);
  }
  // rediscover from the backend (never trust computed ids), then re-resolve all
  console.log("re-discovering backend after creation ...");
  const probeGroups = [...new Set(people.map(targetGroupOf))];
  const auto2 = await automap(context, BACKEND, probeGroups, { write: false });
  if (!auto2.ok) fail(`re-discovery failed after creation: ${auto2.error} — NOT uploading (fail-closed)`);
  mapMeta = { host: BACKEND, map: auto2.content.map };
  const firstSec2 = Object.values(auto2.content.map.sections || {})[0];
  fieldMap = { fields: auto2.content.map.fields, create_url: firstSec2?.personUrl || null, list_url: `${BACKEND}/personal`, success_mark: null };
  groupCache.clear();
  perSection = perSectionMode();
  listUrl = fill(fieldMap.list_url);
  const stillFailing = [];
  for (const p of people) {
    const g = targetGroupOf(p);
    const r = resolveGroup(g);
    if (r.missing && !stillFailing.includes(g)) stillFailing.push(g);
  }
  if (stillFailing.length) fail(`groups still unresolvable after creation: ${stillFailing.join(", ")} — NOT uploading (fail-closed)`);
  // Bootstrap re-gate: person-form fields are required from here on. If the
  // freshly created department yields no usable form, fail closed instead of
  // uploading blind. (Non-empty backends passed the same gate up front.)
  checkFields();
  console.log(`re-discovery ok (${Object.keys(auto2.content.map.sections || {}).length} departments), all rows resolved`);
}
const page = await context.newPage();
const results = [];

try {
  for (const p of people) {
    const rec = { seq: p.seq, order: p.order, name: p.name, status: null, detail: null };
    try {
      // ticked = upload. Only a missing local photo file can stop a record (genuine error).
      // 1. photo must exist locally
      const photoAbs = p.photo && !/^https?:/.test(p.photo) ? resolve(fromDir, p.photo) : null;
      if (!photoAbs || !existsSync(photoAbs)) {
        rec.status = "failed"; rec.detail = `photo missing: ${p.photo}`;
        __pushRow(results, rec); continue;
      }
      // 2. resolve target group: exact backend-department lookup by source
      // identity. Pre-flight already ensured every group exists (or failed
      // closed), so a miss here is defensive only — never guess a target.
      const F0 = fieldMap.fields;
      const partialNotes = [];
      if (!p.name) partialNotes.push("name blank");
      let deptOption = null, formUrl = TO || fill(fieldMap.create_url);
      let secFields = null, secInv = null;
      const rowGroup = TO ? null : targetGroupOf(p);
      if (TO) {
        partialNotes.push(`forced target (--to)`);
      } else {
        const r = resolveGroup(rowGroup);
        if (r.missing) {
          // save mode: unreachable (pre-flight created or failed closed).
          // dry mode: skip without any writes; the plan block already showed WOULD-CREATE.
          if (!SAVE) {
            rec.status = "skip-would-create";
            rec.detail = `would-create department "${rowGroup}" (dry: zero writes)`;
            __pushRow(results, rec); continue;
          }
          rec.status = "failed";
          rec.detail = `group "${rowGroup}" unresolvable (pre-flight should have caught this)`;
          __pushRow(results, rec); continue;
        }
        formUrl = r.personUrl; deptOption = perSection ? (r.deptId || null) : rowGroup;
        secFields = r.fields; secInv = r.inventory;
      }
      rec.group = rowGroup;
      if (!formUrl) { rec.status = "failed"; rec.detail = "no form URL resolved"; __pushRow(results, rec); continue; }
      rec.form = formUrl;
      // 3. duplicate note (informational only — ticked rows upload anyway)
      try {
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const body = (await page.evaluate(() => document.body.innerText)).slice(0, 20000);
        if (p.name && body.includes(p.name)) {
          rec.detail = ((rec.detail ? rec.detail + "; " : "") + "duplicate: name already on list page (uploading anyway)");
        }
      } catch { /* list check failed -> proceed */ }
      // 4. fill person form: inventory-driven when available, legacy fields fallback.
      // Identity guard: the page AND its photo form must carry the target
      // person id before any fill. No name-based routing anywhere here.
      await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const ident = await verifyPageIdentity(page, { personUrl: formUrl });
      if (!ident.ok) {
        rec.status = "failed";
        rec.detail = ((rec.detail ? rec.detail + "; " : "") + `target identity: ${ident.reason}`);
        __pushRow(results, rec); continue;
      }
      if (ident.detail) rec.detail = ((rec.detail ? rec.detail + "; " : "") + ident.detail);
      const F = (secFields?.photo?.selector) ? secFields : fieldMap.fields;
      const inv = (secInv && secInv.length) ? secInv : null;
      const unmapped = [];
      if (inv && inv.length) {
        for (const item of inv) {
          if (!item || item.action === "skip") { if (item?.unmapped) unmapped.push(item.label || item.name || item.selector); continue; }
          if (item.action === "click" || item.action === "click-candidate") continue; // save phase only
          if (item.action === "const:true") {
            if (item.selector) {
              const box = page.locator(item.selector).first();
              if (!(await box.isChecked().catch(() => true))) await box.check({ timeout: 5000 }).catch(() => null);
            }
            continue;
          }
          if (item.action && item.action.startsWith("fill:")) {
            const key = item.action.slice(5);
            // STS backends map logical "phone" straight into the detail box
            // (#p_detail) with no separate fill:detail item — compose there.
            const hasDetailItem = inv.some((x) => x && x.action === "fill:detail");
            const val = key === "photo" ? photoAbs : key === "section" ? deptOption
              : key === "detail" ? detailVal(p)
              : key === "phone" && !hasDetailItem ? detailVal(p) : p[key];
            if (val == null || val === "") continue;
            if (!item.selector) { unmapped.push(item.label || item.name || key); continue; }
            if (key === "photo") await page.setInputFiles(item.selector, val, { timeout: 15000 });
            else if (item.tag === "SELECT") await page.selectOption(item.selector, { label: String(val) }, { timeout: 10000 });
            else if (item.tag === "INPUT" && item.type === "checkbox") { if (val) await page.locator(item.selector).first().check({ timeout: 5000 }).catch(() => null); }
            else await page.fill(item.selector, String(val), { timeout: 10000 });
            continue;
          }
        }
        if (unmapped.length) rec.detail = ((rec.detail ? rec.detail + "; " : "") + `unmapped fields (skipped by map, edit inventory): ${unmapped.join(", ")}`);
      } else {
        await page.setInputFiles(F.photo.selector, photoAbs, { timeout: 15000 });
        if (p.name) await page.fill(F.name.selector, p.name, { timeout: 10000 });
        if (p.position) await page.fill(F.position.selector, p.position, { timeout: 10000 });
        if (F.order?.selector && p.order != null) {
          await page.fill(F.order.selector, String(p.order), { timeout: 10000 }).catch(() => null);
        }
        const detailText = detailVal(p);
        if (F.detail?.selector && detailText) {
          await page.fill(F.detail.selector, detailText, { timeout: 10000 });
        }
        if (p.phone && F.phone?.selector && !/^TBD/.test(F.phone.selector) && F.phone.selector !== F.detail?.selector) {
          await page.fill(F.phone.selector, p.phone, { timeout: 10000 });
        }
        if (deptOption && !perSection) {
          await page.selectOption(F.department.selector, { label: deptOption }, { timeout: 10000 });
        }
        if (F.publish?.selector && !/^TBD/.test(F.publish.selector)) {
          const box = page.locator(F.publish.selector).first();
          if (!(await box.isChecked().catch(() => true))) await box.check({ timeout: 5000 }).catch(() => null);
        }
      }
      const shot = join(shotsDir, `${String(p.order).padStart(3, "0")}-seq${p.seq}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      __emitArtifact(shot, null, "shot", null);
      if (partialNotes.length) rec.detail = ((rec.detail ? rec.detail + "; " : "") + `partial: ${partialNotes.join("; ")}`);
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + `shot: ${shot}`);
      if (!SAVE) {
        rec.status = partialNotes.length ? "dry-partial" : "dry"; __pushRow(results, rec); continue;
      }
      // 5. real save (only with --save)
      const Fsave = (inv && inv.length && inv.find((i) => i.action === "click")) || F.save;
      let saveSel = Fsave.selector;
      if (!saveSel && (Fsave.strategy === "photo-form-submit" || !Fsave.selector)) {
        saveSel = await resolvePhotoFormSubmit(page, (F.photo || {}).selector || 'input[type="file"]');
        if (!saveSel) throw new Error("save unresolved: no submit button in photo form (check inventory click item)");
      }
      await page.click(saveSel, { timeout: 10000 });
      const mark = fieldMap.success_mark && !/^TBD/.test(fieldMap.success_mark) ? fieldMap.success_mark : null;
      if (mark) await page.getByText(mark, { exact: false }).first().waitFor({ timeout: 15000 });
      else await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      rec.status = partialNotes.length ? "created-partial" : "created"; __pushRow(results, rec);
    } catch (e) {
      rec.status = rec.status || "failed";
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + String(e.message || e).slice(0, 160));
      __pushRow(results, rec);
    }
  }
} finally {
  await page.close().catch(() => null);
}

// strategy save: submit button in the exact <form> as the photo input (profile-based maps).
async function resolvePhotoFormSubmit(page, photoSelector) {
  return page.evaluate((psel) => {
    const photo = document.querySelector(psel);
    const form = photo ? photo.closest("form") : null;
    const scope = form || document;
    const btns = [...scope.querySelectorAll('button[type="submit"], input[type="submit"]')];
    const b = btns[0];
    if (!b) return null;
    if (b.id) return `#${b.id}`;
    if (b.name) return `${b.tagName.toLowerCase()}[name="${b.name}"]`;
    const fa = form ? form.getAttribute("action") : null;
    if (fa) return `form[action="${fa}"] ${b.tagName.toLowerCase()}[type="submit"]`;
    return null;
  }, photoSelector);
}

const report = {
  generated_at: new Date().toISOString(), mode: SAVE ? "save" : "dry",
  backend: BACKEND, from: FROM, slug,
  total: results.length,
  by_status: results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}),
  plan: uploadPlan,
  results,
};
const reportPath = join(uploaderDir, `report-${slug}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 1), "utf8");
__emitArtifact(reportPath, `report-${slug}.json`, "upload-report", null);
try { __engine?.reportWritten({ slug, mode: report.mode, total: report.total, byStatus: report.by_status, relPath: `report-${slug}.json` }); } catch { /* ignore */ }
console.log(`mode=${report.mode} total=${report.total} ${JSON.stringify(report.by_status)}`);
console.log(`report: ${reportPath}`);
const failed = results.some((r) => r.status === "failed");
await browser.close().catch(() => null);
process.exit(failed ? 1 : 0);
