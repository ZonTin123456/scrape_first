// Shared auto-detect core: filter -> dept rows -> person form -> profile-first classify.
// Used by detect.mjs (writes maps/) and upload-people.mjs (ephemeral map when --map absent).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(here, "..", "profiles");

export function loadProfiles() {
  let files = [];
  try { files = readdirSync(profilesDir).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => JSON.parse(readFileSync(join(profilesDir, f), "utf8")));
}

export async function dumpForm(page) {
  return page.evaluate(() => {
    const labelOf = (e) => {
      if (e.id) { const l = document.querySelector(`label[for="${e.id}"]`); if (l) return { text: l.innerText.trim().slice(0, 60), via: "for" }; }
      const w = e.closest("label"); if (w) return { text: w.innerText.trim().slice(0, 60), via: "wrap" };
      if (e.placeholder) return { text: e.placeholder.slice(0, 60), via: "placeholder" };
      let s = e.previousElementSibling; let k = 0;
      while (s && k < 3) { const t = (s.innerText || "").trim(); if (t && t.length < 80) return { text: t.slice(0, 60), via: "sibling" }; s = s.previousElementSibling; k++; }
      return { text: "", via: "none" };
    };
    const selOf = (e) => {
      if (e.id) return `#${e.id}`;
      if (e.name) return `${e.tagName.toLowerCase()}[name="${e.name}"]`;
      const t = e.tagName.toLowerCase(), ty = e.type ? `[type="${e.type}"]` : "";
      const f = e.closest("form");
      const fa = f ? f.getAttribute("action") : null;
      if (fa) return `form[action="${fa}"] ${t}${ty}`;
      return `${t}${ty}`;
    };
    const forms = [...document.forms].map((f, fi) => ({
      action: f.action, method: f.method,
      elements: [...f.elements].map((e) => ({ tag: e.tagName, type: e.type || null, name: e.name || null, id: e.id || null, selector: selOf(e), label: labelOf(e), accept: e.accept || null, required: !!e.required, fi })),
    }));
    const formIndexOf = (e) => { const f = e.closest("form"); return f ? [...document.forms].indexOf(f) : -1; };
    return {
      url: location.href, title: document.title,
      forms,
      selects: [...document.querySelectorAll("select")].map((s) => ({ selector: selOf(s), label: labelOf(s), options: [...s.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 40) })),
      buttons: [...document.querySelectorAll("button, input[type=submit]")].slice(0, 15).map((e) => ({ selector: selOf(e), text: (e.innerText || e.value || "").trim().slice(0, 40), type: e.type || null, formAction: (e.closest("form") || {}).action || null, fi: formIndexOf(e) })),
    };
  });
}

// Field inventory: every fillable element on the person form becomes DATA
// (action fill:<peopleKey> | const:<json> | click | skip), so new templates
// need map review — never code patches. Unclassified fillables => skip + unmapped:true (loud in report).
export function buildInventory(dumped, fields) {
  // scope to the form holding the photo input (excludes row toggles/tables/groups)
  let photoFi = null;
  for (const f of dumped.forms) {
    const fe = f.elements.findIndex((e) => (e.type || "").toLowerCase() === "file");
    if (fe >= 0) { photoFi = f.elements[fe].fi; break; }
  }
  const matchField = (e) => {
    for (const [key, m] of Object.entries(fields || {})) {
      if (!m || (!m.selector && !m.strategy)) continue;
      if (m.selector && fieldMatchesSel(m.selector, e)) return { key, ...m };
    }
    return null;
  };
  const inv = [];
  for (const f of dumped.forms) {
    for (const e of f.elements) {
      if (photoFi != null && e.fi !== photoFi) continue;
      const m = matchField(e);
      if (m) { inv.push(invEntry(e, actionFor(m.key, m), false)); continue; }
      const tag = e.tag, type = (e.type || "").toLowerCase();
      if (tag === "INPUT" && ["hidden", "submit", "button", "reset", "image"].includes(type)) {
        if (type === "hidden") continue; // csrf tokens etc.
        inv.push(invEntry(e, type === "submit" ? "click-candidate" : "skip", type !== "submit"));
        continue;
      }
      if (tag === "BUTTON") { inv.push(invEntry(e, "click-candidate", true)); continue; }
      if (tag === "INPUT" && ["text", "search", "tel", "number", "email", "url", "date"].includes(type)) {
        inv.push(invEntry(e, "skip", true)); continue;
      }
      if (tag === "TEXTAREA" || tag === "SELECT") { inv.push(invEntry(e, "skip", true)); continue; }
      if (tag === "INPUT" && ["checkbox", "radio"].includes(type)) { inv.push(invEntry(e, "skip", true)); continue; }
      if (tag === "INPUT" && type === "file") { inv.push(invEntry(e, "skip", true)); continue; }
    }
  }
  // save strategy (no concrete selector): resolve at upload time — unless the
  // photo form already has a concrete submit (promote it to the click item)
  const save = fields?.save;
  const photoSubmit = inv.find((i) => i.action === "click-candidate" && i.type === "submit" && (photoFi == null || i.fi === photoFi));
  if (photoSubmit) { photoSubmit.action = "click"; photoSubmit.unmapped = false; }
  else if (save && save.strategy && !inv.some((i) => i.action === "click")) {
    inv.push({ selector: null, strategy: save.strategy, tag: "BUTTON", type: "submit", label: save.label || null, action: "click", unmapped: false, fi: photoFi });
  }
  return inv;
}

// match a known field selector against a dumped element (exact, name-attr, or id form)
function fieldMatchesSel(fieldSel, e) {
  if (!fieldSel) return false;
  if (fieldSel === e.selector) return true;
  let m = /^([a-z]+)\[name="([^"]+)"\]$/i.exec(fieldSel);
  if (m && (e.tag || "").toLowerCase() === m[1].toLowerCase() && e.name === m[2]) return true;
  m = /^#(.+)$/.exec(fieldSel);
  if (m && e.id === m[1]) return true;
  return false;
}

function invEntry(e, action, unmapped) {
  return { selector: e.selector || null, tag: e.tag, type: e.type || null, name: e.name || null, label: (e.label && e.label.text) || null, action, unmapped: !!unmapped, fi: e.fi ?? null };
}

function actionFor(key, m) {
  switch (key) {
    case "photo": return "fill:photo";
    case "name": return "fill:name";
    case "position": return "fill:position";
    case "phone": return "fill:phone";
    case "detail": return "fill:phone"; // STS rule: phone goes to รายละเอียด; edit in map if different
    case "order": return "fill:order";
    case "department": return m.kind === "select" ? "fill:section" : "fill:section";
    case "publish": return "const:true";
    case "save": return "click";
    default: return "skip";
  }
}

function classify(host, dumped) {
  const els = dumped.forms.flatMap((f) => f.elements.map((e) => ({ ...e, formAction: f.action })));
  const has = (t, ...keys) => { const s = (t || "").toLowerCase(); return keys.some((k) => s.includes(k)); };
  const attr = (e) => `${e.name || ""} ${e.id || ""}`.toLowerCase();
  const fields = {};
  const ambiguous = [];
  const take = (key, cands) => {
    const withSel = cands.filter((c) => c.selector);
    if (!withSel.length) { fields[key] = { selector: null, kind: null, confidence: "missing" }; return; }
    const best = withSel[0];
    fields[key] = { selector: best.selector, kind: best.kind, confidence: best.conf, label: best.labelText || null };
    if (withSel.length > 1) ambiguous.push(`${key}: ${withSel.length} candidates (${withSel.map((c) => c.labelText || c.name).join(" | ").slice(0, 120)})`);
  };
  const files = els.filter((e) => (e.type || "").toLowerCase() === "file").map((e) => ({ ...e, kind: "file", conf: "high", labelText: e.label.text }));
  take("photo", files.length ? files : els.filter((e) => has(attr(e), "img", "photo", "pic", "image")).map((e) => ({ ...e, kind: "file", conf: "low", labelText: e.label.text || attr(e) })));
  const texts = els.filter((e) => e.tag === "INPUT" && /^(TEXT|SEARCH|TEL|NUMBER|EMAIL)$/i.test(e.type || "") || e.tag === "TEXTAREA");
  const deptTexts = [], nameTexts = [], posTexts = [], phoneTexts = [], detailTexts = [], orderTexts = [], otherTexts = [];
  for (const e of texts) {
    const t = e.label.text, a = attr(e);
    if (has(t, "แผนก", "ฝ่าย", "กอง", "สังกัด", "department", "division")) deptTexts.push({ ...e, kind: "text", conf: e.label.via === "none" ? "low" : "high", labelText: t });
    else if (has(t, "เบอร์", "โทร", "phone", "tel", "mobile") || /phone|tel|mobile|p_tel/.test(a)) phoneTexts.push({ ...e, kind: "text", conf: "high", labelText: t || a });
    else if (has(t, "ตำแหน่งภาพ", "ลำดับ", "order", "sort") || /prarent|parent|order|sort|seq/.test(a)) orderTexts.push({ ...e, kind: "text", conf: "high", labelText: t || a });
    else if (has(t, "รายละเอียด", "detail", "desc") || /detail|desc/.test(a)) detailTexts.push({ ...e, kind: "text", conf: "high", labelText: t || a });
    else if (has(t, "ตำแหน่ง", "position", "title") || /p_position|position/.test(a)) posTexts.push({ ...e, kind: "text", conf: "high", labelText: t || a });
    else if (has(t, "ชื่อ", "name") || /p_name|fname|fullname|^name$/.test(a)) nameTexts.push({ ...e, kind: "text", conf: "high", labelText: t || a });
    else otherTexts.push(e);
  }
  if (!nameTexts.length && otherTexts.length) nameTexts.push({ ...otherTexts.shift(), kind: "text", conf: "low", labelText: "(positional guess #1)" });
  if (!posTexts.length && otherTexts.length) posTexts.push({ ...otherTexts.shift(), kind: "text", conf: "low", labelText: "(positional guess #2)" });
  take("name", nameTexts); take("position", posTexts); take("phone", phoneTexts);
  take("detail", detailTexts); take("order", orderTexts);
  const selects = dumped.selects.map((s) => ({ ...s, kind: "select", conf: "high", labelText: s.label.text }));
  const deptSel = selects.filter((s) => has(s.label.text, "แผนก", "ฝ่าย", "กอง", "สังกัด", "department", "division", "category"));
  take("department", deptSel.length ? deptSel : (selects.length === 1 ? [{ ...selects[0], conf: "medium", labelText: selects[0].label.text + " (only select)" }] : selects.map((s) => ({ ...s, conf: "low" }))));
  if (!fields.department.selector && deptTexts.length) fields.department = { selector: deptTexts[0].selector, kind: "text", confidence: "medium", label: deptTexts[0].labelText };
  const checks = els.filter((e) => (e.type || "").toLowerCase() === "checkbox").map((e) => ({ ...e, kind: "checkbox", conf: "high", labelText: e.label.text }));
  take("publish", checks.filter((e) => has(e.label.text, "เผยแพร่", "แสดง", "เปิดใช้", "publish", "active", "status")));
  const btns = dumped.buttons.map((b) => ({ ...b, kind: "button", conf: "high", labelText: b.text }));
  const photoFi = fields.photo?.selector ? els.find((e) => e.selector === fields.photo.selector)?.fi : null;
  const inPhotoForm = btns.filter((b) => /submit/i.test(b.type || "") && (photoFi == null || b.fi === photoFi));
  let saveCands = inPhotoForm.filter((b) => has(b.text, "บันทึก", "ตกลง", "save", "submit", "confirm"));
  if (!saveCands.length) saveCands = inPhotoForm.map((b) => ({ ...b, conf: "medium", labelText: b.text || "(submit in photo form)" }));
  if (!saveCands.length) saveCands = btns.filter((b) => has(b.text, "บันทึก", "ตกลง", "save", "submit", "confirm"));
  take("save", saveCands);
  return { fields, ambiguous, department_options: (dumped.selects.find((s) => s.selector === fields.department.selector) || {}).options || null, success_mark: null };
}

// Profile-first match: all fingerprint names present? Returns {profile} or null.
export function matchProfile(dumped, profiles) {
  const names = new Set();
  for (const f of dumped.forms) for (const e of f.elements) {
    if (e.name) names.add(`${(e.type || "").toLowerCase()}:${e.name.toLowerCase()}`);
  }
  for (const p of profiles) {
    const fp = p.fingerprint || {};
    const okFile = (fp.file || []).every((n) => names.has(`file:${String(n).toLowerCase()}`));
    const okText = (fp.text || []).every((n) => [...names].some((k) => k.endsWith(`:${String(n).toLowerCase()}`)));
    if (okFile && okText) return p;
  }
  return null;
}

const slugOf = (host) => host.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

// Full per-host auto-detect. Returns the maps/<host>.json content object.
// opts.write=true writes it to mapsDir (detect.mjs); false keeps it ephemeral (upload-people.mjs).
export async function automap(context, host, sections, opts = {}) {
  const { mapsDir = null, write = false } = opts;
  const rec = { host, ok: false };
  const page = await context.newPage();
  try {
    await page.goto(`${host}/personal`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const filterProbe = await page.evaluate(() => {
      const forms = [...document.forms];
      const cands = [];
      for (const f of forms) {
        const inputs = [...f.elements].filter((e) => /^(TEXT|SEARCH)$/i.test(e.type || "") && !/hidden/i.test(e.type || ""));
        if (inputs.length) cands.push({ action: f.action, input: inputs[0].name || inputs[0].id || null, selector: inputs[0].id ? `#${inputs[0].id}` : (inputs[0].name ? `${inputs[0].tagName.toLowerCase()}[name="${inputs[0].name}"]` : null) });
      }
      return { title: document.title, forms: forms.length, filterCandidates: cands };
    });
    rec.filter = filterProbe;
    let rows = [];
    if (filterProbe.filterCandidates.length && filterProbe.filterCandidates[0].selector) {
      const fc = filterProbe.filterCandidates[0];
      const readRows = () => page.evaluate(() => {
        const links = [...document.links].map((a) => a.href).filter((h) => /personal/i.test(h));
        const body = document.body.innerText.slice(0, 3000);
        const imgs = [...document.images].filter((i) => /person_/i.test(i.src)).map((i) => i.src.slice(-60));
        return { url: location.href, links: [...new Set(links)].slice(0, 20), personImgs: imgs.slice(0, 10), bodyHead: body.slice(0, 500) };
      });
      const submitFilter = async (value) => {
        await page.fill(fc.selector, value, { timeout: 10000 });
        await Promise.all([
          page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null),
          page.locator(fc.selector).press("Enter").catch(() => null),
        ]);
        await page.waitForTimeout(2500);
      };
      await submitFilter(sections[0]);
      rows = await readRows();
      if (!rows.personImgs.length) {
        await submitFilter("");
        const all = await readRows();
        if (all.personImgs.length > rows.personImgs.length) { rows = all; rows.filterNote = "empty-filter fallback"; }
        else rows.filterNote = `section "${sections[0]}" gave no person rows; dept rows found: ${(all.links || []).filter((h) => /person\/\d+/.test(h)).length}`;
      }
    }
    rec.rowsAfterFilter = rows;
    const deptRows = await page.evaluate(() => {
      const out = [];
      for (const a of document.links) {
        const m = /\/personal\/person\/(\d+)/.exec(a.href || "");
        if (!m) continue;
        let rowText = (a.innerText || "").trim().slice(0, 40);
        const tr = a.closest("tr");
        if (tr) rowText = tr.innerText.replace(/\s+/g, " ").trim().slice(0, 100);
        out.push({ deptId: m[1], personUrl: a.href, rowText });
      }
      const seen = new Set();
      return out.filter((d) => (seen.has(d.deptId) ? false : (seen.add(d.deptId), true))).slice(0, 20);
    });
    rec.deptRows = deptRows;
    // prioritize rows matching requested sections (new divisions live past the cap)
    const normLo = (s) => String(s || "").trim().normalize("NFC").toLowerCase();
    const wanted = sections.map(normLo);
    // probe every discovered department link (no top-N cap: a cap silently drops
    // sections and caused non-deterministic routing across runs). Wanted
    // (requested) sections first so their failures surface early.
    const ranked = [...deptRows].sort((a, b) => {
      const am = wanted.some((w) => w && normLo(a.rowText).includes(w)) ? 0 : 1;
      const bm = wanted.some((w) => w && normLo(b.rowText).includes(w)) ? 0 : 1;
      return am - bm;
    });
    // profile-first: dump first dept form, match profiles before full classify
    const profiles = loadProfiles();
    const sectionsMap = {};
    let profileName = null;
    for (const d of ranked) {
      await page.goto(d.personUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
      const dumped = await dumpForm(page);
      const matched = matchProfile(dumped, profiles);
      let fields, ambiguous;
      if (matched) {
        profileName = matched.name;
        fields = structuredClone(matched.fields);
        ambiguous = [];
      } else {
        const c = classify(host, dumped);
        fields = c.fields; ambiguous = c.ambiguous;
      }
      sectionsMap[d.rowText || `dept-${d.deptId}`] = { deptId: d.deptId, personUrl: dumped.url, fields, ambiguous, profile: matched?.name || null, inventory: buildInventory(dumped, fields) };
    }
    const firstKey = Object.keys(sectionsMap)[0];
    const firstFields = firstKey ? sectionsMap[firstKey].fields : classify(host, { forms: [], selects: [], buttons: [] }).fields;
    const content = {
      _status: profileName ? `profile:${profileName} - REVIEW then use` : "detected - REVIEW then use with upload-people.mjs --map",
      host, detected_at: new Date().toISOString(), profile: profileName,
      sections_probed: sections.slice(0, 5), filter: rec.filter,
      rowsAfterFilter: { url: (rows || {}).url, personImgs: (rows || {}).personImgs, links: ((rows || {}).links || []).slice(0, 10), bodyHead: (rows || {}).bodyHead, filterNote: (rows || {}).filterNote },
      deptRows,
      map: { mode: "per-section-url", fields: firstFields, sections: sectionsMap, ambiguous: Object.entries(sectionsMap).flatMap(([k, v]) => v.ambiguous.map((a) => `${k}: ${a}`)), department_options: Object.keys(sectionsMap) },
    };
    rec.content = content;
    rec.ok = true;
    if (write && mapsDir) {
      mkdirSync(mapsDir, { recursive: true });
      const outPath = join(mapsDir, `${slugOf(host)}.json`);
      // merge with existing map (never drop previously known sections)
      let prev = null;
      try { prev = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* first run */ }
      const mergedSections = { ...((prev && prev.map && prev.map.sections) || {}), ...sectionsMap };
      const firstKey = Object.keys(mergedSections)[0];
      content.map.sections = mergedSections;
      content.map.fields = firstKey ? mergedSections[firstKey].fields : content.map.fields;
      content.map.department_options = Object.keys(mergedSections);
      content.merged_from = prev ? prev.detected_at || true : null;
      writeFileSync(outPath, JSON.stringify(content, null, 1), "utf8");
      rec.mapPath = outPath;
    }
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200);
  } finally {
    await page.close().catch(() => null);
  }
  return rec;
}
