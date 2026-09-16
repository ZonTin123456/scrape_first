#!/usr/bin/env node
// upload-people: people.json (loader output) -> STS backend personnel form.
// READS out/<slug>/ only. NEVER writes there. Default is --dry (fill + screenshot, no save).
// Usage:
//   node upload-people.mjs --from out/<slug>/people.json --backend https://host [--port 9444] [--save] [--limit N] [--map uploader/maps/<host>.json]
//   Login: reuse the logged-in Chrome on --port (no passwords stored).
// Backend rule: phone + trailing note go into รายละเอียด (p_detail) joined with <br>; skipped when both absent.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePort, discoverBackends } from "./lib/cdp-port.mjs";
import { automap } from "./lib/automap.mjs";
import { matchSection, failBlock } from "./lib/match.mjs";
import { verifyPageIdentity } from "./lib/verify-identity.mjs";

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
  console.log("  named-but-unresolvable sections fail closed in per-section mode (no silent misroute);");
  console.log("  rows with no section keep the old flex path (default form + partial note)");
  console.log("  --save refuses stale finalize output (people.json vs review/selection.json) unless --ignore-selection-check");
  process.exit(2);
}
const FROM = opt("--from", null);
let BACKEND = (opt("--backend", null) || "").replace(/\/$/, "");
const PORT = await resolvePort(opt("--port", "auto")).catch((e) => fail(e.message));
const MAP = opt("--map", null);
const SAVE = argv.includes("--save");
const STRICT_SECTIONS = argv.includes("--strict-sections"); // explicit fail-fast (also the default for named sections, see pre-flight)
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
const sectionMap = readJson("section-map.json").map || {};
const peopleAll = JSON.parse(readFileSync(FROM, "utf8"));
if (!Array.isArray(peopleAll) || !peopleAll.length) fail("people.json is empty");
// creation sequence follows selection order (backend may list by insertion,
// not by the order field). Stable within duplicate orders.
const orderedAll = [...peopleAll].sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0)));
const people = LIMIT > 0 ? orderedAll.slice(0, LIMIT) : orderedAll;
const fromDir = dirname(resolve(FROM));
const slug = basename(fromDir);
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
const hasSel = (k) => {
  const f = fieldMap.fields?.[k];
  return !!(f && (f.selector || f.strategy) && !/^TBD/.test(f.selector || ""));
};
const fill = (s) => String(s || "").replace("{backend}", BACKEND);
let listUrl = null; // set after fieldMap final (ephemeral automap may fill it)
const norm = (s) => String(s || "").trim().normalize("NFC");
const normSectionMap = Object.fromEntries(Object.entries(sectionMap).map(([k, v]) => [norm(k), v]));
// detail (รายละเอียด) = phone + trailing note lines; backend renders <br> as breaks.
const detailVal = (p) => [p.phone, p.note].filter((v) => v != null && v !== "").join("<br>") || null;
// Scored section resolution (zero-map discovery). Explicit user alias
// (section-map.json personUrl) wins; otherwise scored match over live
// discovered sections — auto ONLY on a single unambiguous top (score>=0.8).
const secCache = new Map();
const secCandidates = () => Object.entries(mapMeta?.map?.sections || {})
  .map(([key, v]) => ({ key, url: v.personUrl, deptId: v.deptId, memberNames: v.memberNames || [], phoneHints: v.memberNames || [] }));
// source member names + phone-bearing strings per section (match evidence)
const secMembers = new Map();
const secPhones = new Map();
for (const p of people) {
  if (!secMembers.has(p.section)) secMembers.set(p.section, []);
  if (!secPhones.has(p.section)) secPhones.set(p.section, []);
  if (p.name) { secMembers.get(p.section).push(p.name); secPhones.get(p.section).push(p.name); }
  if (p.phone) secPhones.get(p.section).push(p.phone);
  if (p.note) secPhones.get(p.section).push(p.note);
}
const resolveSection = (sec) => {
  if (!sec) return { empty: true };
  if (secCache.has(sec)) return secCache.get(sec);
  const ov = normSectionMap[norm(sec)];
  let out;
  if (ov && /\/personal\/(?:person\/)?\d+(?:[/?#]|$)/.test(ov)) {
    out = { personUrl: ov, deptId: null, fields: null, inventory: null, via: "section-map" };
  } else {
    const r = matchSection(sec, secCandidates(), { wantMembers: secMembers.get(sec) || [], wantPhones: secPhones.get(sec) || [] });
    if (r.verdict === "auto") {
      const entry = (mapMeta?.map?.sections || {})[r.best.key] || {};
      out = { personUrl: r.best.url, deptId: r.best.deptId ?? null, fields: entry.fields || null, inventory: entry.inventory || null, via: `discovery:${r.best.score}` };
    } else {
      out = { fail: failBlock(sec, r) };
    }
  }
  secCache.set(sec, out);
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
  const probeSections = [...new Set(people.map((p) => p.section).filter(Boolean))];
  if (!probeSections.length) fail("people.json has no sections for auto-detect (give --map instead)");
  console.log(`no --map: auto-detecting ${BACKEND} ...`);
  const auto = await automap(context, BACKEND, probeSections, { write: false });
  if (!auto.ok) fail(`auto-detect failed: ${auto.error}`);
  mapMeta = { host: BACKEND, map: auto.content.map };
  const firstSec = Object.values(auto.content.map.sections || {})[0];
  fieldMap = { fields: auto.content.map.fields, create_url: firstSec?.personUrl || null, list_url: `${BACKEND}/personal`, success_mark: null };
  console.log(`auto-detect: ${auto.content.profile ? "profile:" + auto.content.profile : "full-classify"} (${Object.keys(auto.content.map.sections || {}).length} sections)`);
}
const perSection = perSectionMode();
const need = perSection ? ["photo", "name", "position", "save"] : ["photo", "name", "position", "department", "save"];
for (const k of need) {
  if (!hasSel(k)) fail(`map fields.${k} has no selector/strategy (ambiguous? check ${MAP || "auto-detect output"})`);
}
listUrl = fill(fieldMap.list_url);
// pre-flight: section existence gate (F2). Named-but-unresolvable sections
// fail closed in per-section mode (a silent default-form upload misroutes).
// Rows with no section keep the old flex path. --to skips resolution entirely.
{
  const missing = []; // [{sec, lines}] — fail blocks with evidence trail
  let emptySections = 0;
  const warnedSingle = new Set();
  const deptOpts = mapMeta?.map?.department_options || [];
  if (TO) {
    console.log(`section resolution skipped (--to ${TO})`);
  } else for (const p of people) {
    if (perSection) {
      if (!p.section) { emptySections++; continue; }
      const r = resolveSection(p.section);
      if (r.fail && !missing.some((m) => m.sec === p.section)) missing.push({ sec: p.section, lines: r.fail });
    } else if (p.section && !normSectionMap[norm(p.section)] && !deptOpts.includes(p.section) && fieldMap.fields.department?.selector) {
      // single-form backends can't misroute (one fixed page): strict fails, else warn once
      if (STRICT_SECTIONS) {
        if (!missing.some((m) => m.sec === p.section)) missing.push({ sec: p.section, lines: [`section "${p.section}": unmapped department select (strict) — add to section-map or cut scope`] });
      } else if (!warnedSingle.has(p.section)) {
        warnedSingle.add(p.section);
        console.log(`warn: unmapped section (single form, select left untouched): ${p.section}`);
      }
    }
  }
  if (missing.length) {
    console.error("upload-people: unresolvable sections (refusing: would misroute):");
    for (const m of missing) for (const l of m.lines.slice(0, 8)) console.error("  " + l);
    fail(`${missing.length} section(s) need a backend department, scope cut, or --to <personUrl>`);
  }
  if (emptySections) console.log(`note: ${emptySections} row(s) with no section use the default form`);
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
        results.push(rec); continue;
      }
      // 2. resolve section: scored discovery (resolveSection). Pre-flight already
      // failed closed on named-but-unresolvable sections, so a fail here is
      // defensive only — never fall back to the default form silently.
      const F0 = fieldMap.fields;
      const partialNotes = [];
      if (!p.name) partialNotes.push("name blank");
      let deptOption = null, formUrl = TO || fill(fieldMap.create_url);
      let secFields = null, secInv = null;
      if (TO) {
        partialNotes.push(`forced target (--to)`);
      } else if (perSection) {
        if (!p.section) {
          partialNotes.push("no section (used default form)");
        } else {
          const r = resolveSection(p.section);
          if (r.fail) {
            rec.status = "failed";
            rec.detail = r.fail[0] + " (pre-flight should have caught this)";
            results.push(rec); continue;
          }
          formUrl = r.personUrl; deptOption = r.deptId || null;
          secFields = r.fields; secInv = r.inventory;
          if (r.via) partialNotes.push(`section via ${r.via}`);
        }
      } else {
        const deptOpts = mapMeta?.map?.department_options || [];
        const autoDept = p.section && !normSectionMap[norm(p.section)] && deptOpts.includes(p.section);
        deptOption = p.section ? (normSectionMap[norm(p.section)] || (autoDept ? p.section : null)) : null;
        if (!deptOption && F0.department?.selector) {
          if (STRICT_SECTIONS) {
            rec.status = "failed"; rec.detail = `section unresolved: ${p.section || "(none)"}`;
            results.push(rec); continue;
          }
          partialNotes.push(`section unresolved: ${p.section || "(none)"} (select left untouched)`);
        }
        if (autoDept) rec.detail = "section auto-matched to department option";
      }
      if (!formUrl) { rec.status = "failed"; rec.detail = "no form URL resolved"; results.push(rec); continue; }
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
        results.push(rec); continue;
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
      if (partialNotes.length) rec.detail = ((rec.detail ? rec.detail + "; " : "") + `partial: ${partialNotes.join("; ")}`);
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + `shot: ${shot}`);
      if (!SAVE) {
        rec.status = partialNotes.length ? "dry-partial" : "dry"; results.push(rec); continue;
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
      rec.status = partialNotes.length ? "created-partial" : "created"; results.push(rec);
    } catch (e) {
      rec.status = rec.status || "failed";
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + String(e.message || e).slice(0, 160));
      results.push(rec);
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
  results,
};
const reportPath = join(uploaderDir, `report-${slug}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 1), "utf8");
console.log(`mode=${report.mode} total=${report.total} ${JSON.stringify(report.by_status)}`);
console.log(`report: ${reportPath}`);
const failed = results.some((r) => r.status === "failed");
await browser.close().catch(() => null);
process.exit(failed ? 1 : 0);
