// uploader/lib/upload-core.mjs — shared upload plan + row execution core.
// Lifted verbatim from upload-people.mjs CLI main so CLI and Job/UI run the
// SAME mutation logic with no duplication. CLI stays the adapter (argv,
// guards, discovery, creation, safety summary, reports); Job/UI binds through
// these functions with injected runners.
//
// Boundary: page/context objects are injected (Playwright API) — this module
// never imports playwright-core, argv, stdin, or process.exit, so jobs/* can
// import it (same precedent as services/* and uploader/lib/automap.mjs).
// Pure helpers take explicit arguments; browser work takes {page}.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// detail (รายละเอียด) = phone + trailing note lines; backend renders <br> as breaks.
export function composeDetail(p) {
  return [p.phone, p.note].filter((v) => v != null && v !== "").join("<br>") || null;
}

// Local photo resolution: remote URLs are never files; relative paths resolve
// against the people.json directory. Null when unresolvable (caller fails).
export function resolvePhotoAbs(fromDir, photo) {
  if (!photo || /^https?:/.test(photo)) return null;
  return resolve(fromDir, photo);
}

// Backend department index from discovery (live or pinned map):
// normalized label -> entry. Shared by CLI pre-flight and Job binding.
export function buildDeptIndex(sections) {
  const norm = (s) => String(s || "").trim().normalize("NFC");
  const m = new Map();
  for (const [key, v] of Object.entries(sections || {})) m.set(norm(key), { key, ...(v || {}) });
  return m;
}

// Upload plan from resolved groups: existing target URL, or WOULD-CREATE.
// Pure data; printing stays with the caller. TO forces every row to one form.
export function buildUploadPlan({ people, targetGroupOf, resolveGroup, TO }) {
  const uploadPlan = [];
  const missingGroups = [];
  const planSeen = new Set();
  const planAdd = (group, action, target, via) => {
    if (planSeen.has(group)) return;
    planSeen.add(group);
    uploadPlan.push({ group, action, target: target || null, via: via || null });
  };
  if (!TO) {
    for (const p of people) {
      const g = targetGroupOf(p);
      const r = resolveGroup(g);
      if (r.missing) {
        if (!missingGroups.some((m) => m.group === g)) missingGroups.push({ group: g });
        planAdd(g, "would-create", null);
      } else {
        planAdd(g, "upload", r.personUrl, r.via || null);
      }
    }
  }
  return { uploadPlan, missingGroups };
}

// strategy save: submit button in the exact <form> as the photo input
// (profile-based maps).
export async function resolvePhotoFormSubmit(page, photoSelector) {
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

// Execute every row against the backend through one page. ctx carries the
// resolved environment; onRow/onArtifact stream structured callbacks.
// SAVE=false fills + screenshots only (dry: zero writes, never clicks save).
// Returns results[] with CLI-taxonomy statuses (dry/dry-partial/
// skip-would-create/created/created-partial/failed).
export async function executeUploadRows({
  page,
  people,
  TO = null,
  SAVE = false,
  fieldMap,
  listUrl,
  perSection = false,
  fromDir,
  shotsDir,
  targetGroupOf,
  resolveGroup,
  verifyIdentity,
  onRow = null,
  onArtifact = null,
} = {}) {
  if (!page) throw new Error("executeUploadRows: page required");
  if (!Array.isArray(people)) throw new Error("executeUploadRows: people array required");
  if (!fieldMap || !fieldMap.fields) throw new Error("executeUploadRows: fieldMap.fields required");
  if (typeof verifyIdentity !== "function") throw new Error("executeUploadRows: verifyIdentity required");
  mkdirSync(shotsDir, { recursive: true });
  const results = [];
  const pushRow = (rec) => {
    results.push(rec);
    try {
      onRow?.(rec);
    } catch {
      // callbacks never break row execution
    }
    return rec;
  };
  const emitArtifact = (absPath, relPath, kind, url) => {
    try {
      return onArtifact?.({ absPath, relPath, kind, url }) ?? null;
    } catch {
      return null;
    }
  };

  for (const p of people) {
    const rec = { seq: p.seq, order: p.order, name: p.name, status: null, detail: null };
    try {
      // ticked = upload. Only a missing local photo file can stop a record (genuine error).
      // 1. photo must exist locally
      const photoAbs = resolvePhotoAbs(fromDir, p.photo);
      if (!photoAbs || !existsSync(photoAbs)) {
        rec.status = "failed"; rec.detail = `photo missing: ${p.photo}`;
        pushRow(rec); continue;
      }
      // 2. resolve target group: exact backend-department lookup by source
      // identity. Pre-flight already ensured every group exists (or failed
      // closed), so a miss here is defensive only — never guess a target.
      const F0 = fieldMap.fields;
      const partialNotes = [];
      if (!p.name) partialNotes.push("name blank");
      let deptOption = null, formUrl = TO || null;
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
            pushRow(rec); continue;
          }
          rec.status = "failed";
          rec.detail = `group "${rowGroup}" unresolvable (pre-flight should have caught this)`;
          pushRow(rec); continue;
        }
        formUrl = r.personUrl; deptOption = perSection ? (r.deptId || null) : rowGroup;
        secFields = r.fields; secInv = r.inventory;
      }
      rec.group = rowGroup;
      if (!formUrl) { rec.status = "failed"; rec.detail = "no form URL resolved"; pushRow(rec); continue; }
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
      const ident = await verifyIdentity(page, { personUrl: formUrl });
      if (!ident.ok) {
        rec.status = "failed";
        rec.detail = ((rec.detail ? rec.detail + "; " : "") + `target identity: ${ident.reason}`);
        pushRow(rec); continue;
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
              : key === "detail" ? composeDetail(p)
              : key === "phone" && !hasDetailItem ? composeDetail(p) : p[key];
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
        const detailText = composeDetail(p);
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
      emitArtifact(shot, null, "shot", null);
      if (partialNotes.length) rec.detail = ((rec.detail ? rec.detail + "; " : "") + `partial: ${partialNotes.join("; ")}`);
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + `shot: ${shot}`);
      if (!SAVE) {
        rec.status = partialNotes.length ? "dry-partial" : "dry"; pushRow(rec); continue;
      }
      // 5. real save (only with SAVE)
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
      rec.status = partialNotes.length ? "created-partial" : "created"; pushRow(rec);
    } catch (e) {
      rec.status = rec.status || "failed";
      rec.detail = ((rec.detail ? rec.detail + "; " : "") + String(e.message || e).slice(0, 160));
      pushRow(rec);
    }
  }
  return results;
}
