// target-creation.mjs — zero-map runtime department creation (STS backend).
//
// Isolated helper. NOT wired into upload-people.mjs (upload keeps fail-closed;
// auto-create is never triggered by uploads in this round).
//
// Flow: discover -> scored match -> exact? use : review? ambiguous-fail :
// re-discover (duplicate guard) -> validate create form -> POST /personal
// {pg_name} -> re-discover -> exact new target? -> identity verify -> target.
// Structured results only (existing|created|ambiguous|failed), never throws
// for expected cases. No per-site knowledge: names/URLs come from arguments
// and live discovery only.
import { pickDeptRows } from "./automap.mjs";
import { matchSection, scorePair, norm } from "./match.mjs";
import { verifyPageIdentity } from "./verify-identity.mjs";

const fail = (reason, evidence = []) => ({ status: "failed", reason, evidence });

// Read department rows off the currently loaded /personal index page.
async function readDeptRows(page) {
  const raw = await page.evaluate(() => {
    const out = [];
    for (const a of document.links) {
      const href = a.href || "";
      if (!/\/personal\//i.test(href)) continue;
      let rowText = (a.innerText || "").trim().slice(0, 40);
      const tr = a.closest("tr");
      if (tr) rowText = tr.innerText.replace(/\s+/g, " ").trim().slice(0, 100);
      out.push({ href, rowText });
    }
    return out;
  });
  return pickDeptRows(raw || []);
}

// Find the department create form on the loaded /personal page.
// Required shape (audited live): POST to /personal with _token + pg_name.
// Anything else -> null (caller fails closed, no guessing).
async function readCreateForm(page) {
  const forms = await page.evaluate(() =>
    [...document.forms].map((f) => ({
      action: f.action || "",
      method: (f.method || "").toLowerCase(),
      inputs: [...f.elements].map((e) => ({
        tag: e.tagName || e.tag || "INPUT", type: (e.type || "").toLowerCase(),
        name: e.name || "", id: e.id || "",
        selector: e.id ? `#${e.id}` : (e.name ? `${String(e.tagName || e.tag || "input").toLowerCase()}[name="${e.name}"]` : null),
      })),
    }))
  );
  for (const f of forms || []) {
    let actionPath = "";
    try {
      actionPath = new URL(f.action, "http://x").pathname.replace(/\/$/, "");
    } catch { continue; }
    if (actionPath !== "/personal" || f.method !== "post") continue;
    const withSel = (e) => ({
      ...e,
      selector: e.id ? `#${e.id}` : (e.name ? `${String(e.tag || e.tagName || "input").toLowerCase()}[name="${e.name}"]` : null),
    });
    const tokenRaw = f.inputs.find((e) => e.type === "hidden" && e.name === "_token");
    const nameRaw = f.inputs.find((e) => e.name === "pg_name" || e.id === "pg_name");
    if (!tokenRaw || !nameRaw) continue;
    const token = withSel(tokenRaw), nameInput = withSel(nameRaw);
    if (!token.selector || !nameInput.selector) continue;
    const submitRaw = f.inputs.find((e) =>
      (e.tag === "BUTTON" && (e.type === "submit" || e.type === "button")) ||
      (e.tag === "INPUT" && e.type === "submit"));
    if (!submitRaw) continue;
    // Live STS submit buttons carry no id/name: scope by the create form's
    // own action (exactly one form posts to /personal — verified live).
    const submit = withSel(submitRaw);
    if (!submit.selector) {
      submit.selector = `form[action="${f.action}"] ${String(submitRaw.tag || "button").toLowerCase()}[type="${submitRaw.type}"]`;
    }
    return { action: f.action, token, nameInput, submit };
  }
  return null;
}

const asTarget = (d) => ({ personUrl: d.personUrl, deptId: d.deptId });

// createDepartment(page, { host, name, wantMembers })
// page: Playwright-compatible ({ goto, url, evaluate, locator }).
// host: backend origin (no trailing slash). name: department display name.
export async function createDepartment(page, { host, name, wantMembers = [] } = {}) {
  const deptName = norm(name);
  if (!deptName) return fail("empty department name");
  const cleanHost = String(host || "").replace(/\/$/, "");
  if (!cleanHost) return fail("missing host");
  const indexUrl = `${cleanHost}/personal`;
  const evidence = [];

  // 1. discover + scored match (same rules as upload: auto/review/fail)
  await page.goto(indexUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  let rows = await readDeptRows(page);
  const cands = () => rows.map((d) => ({ key: d.rowText, url: d.personUrl, deptId: d.deptId }));
  let r = matchSection(deptName, cands(), { wantMembers });
  if (r.verdict === "auto") {
    const d = rows.find((x) => x.personUrl === r.best.url);
    return { status: "existing", target: asTarget(d), evidence: [`matched existing: "${r.best.key}" score=${r.best.score}`] };
  }
  if (r.verdict === "review") {
    return {
      status: "ambiguous", target: null,
      reason: `ambiguous: refusing to create (would risk a duplicate)`,
      evidence: (r.tie || r.scored.slice(0, 4).map((c) => c.key)).map((k) => `candidate: "${k}"`),
    };
  }

  // 2. duplicate guard: re-discover fresh, exact match wins over creation.
  // Normalized-equal names (e.g. "สำนักปลัด" vs "สำนักปลัด") are duplicates.
  await page.goto(indexUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  rows = await readDeptRows(page);
  const dup = rows.find((d) => {
    const s = scorePair(deptName, d.rowText);
    return s.score === 1.0;
  });
  if (dup) {
    return { status: "existing", target: asTarget(dup), evidence: ["duplicate guard: exact department appeared on re-discover, using it"] };
  }

  // 3. validate the audited create-form shape (fail closed on anything else)
  const form = await readCreateForm(page);
  if (!form) {
    return fail("create form not found or shape mismatch (need POST /personal with _token + pg_name + submit)", [
      `index rows seen: ${rows.map((d) => d.rowText || d.deptId).join(" | ") || "(none)"}`,
    ]);
  }
  // _token is read straight from the live form (never hardcoded).
  let token = "";
  try {
    token = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.value || "" : "";
    }, form.token.selector);
  } catch {
    token = "";
  }
  if (!token) return fail("CSRF token missing/empty on create form — refusing to submit");

  // 4. submit exactly the audited shape: pg_name + _token (already in form)
  evidence.push(`submitting POST /personal pg_name="${deptName}"`);
  await page.locator(form.nameInput.selector).first().fill(deptName, { timeout: 10000 });
  await page.locator(form.submit.selector).first().click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
  let finalUrl = "";
  try {
    finalUrl = page.url();
  } catch { /* ignore */ }
  evidence.push(`post-submit url: ${finalUrl || "(unknown)"}`);
  try {
    const flashed = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    if (/สำเร็จ/.test(flashed)) evidence.push("success flash seen (bonus evidence, not a gate)");
  } catch { /* ignore */ }

  // 5. rediscover: the new target must exist now (never guess/compute the id)
  await page.goto(indexUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const fresh = await readDeptRows(page);
  const created = fresh.find((d) => scorePair(deptName, d.rowText).score === 1.0);
  if (!created) {
    return fail(`created submit done but "${deptName}" not found on re-discover — NOT proceeding to upload`, evidence);
  }

  // 6. identity verify before returning the target (upload stays disabled here:
  // this helper never uploads; the caller decides, and upload flow is unchanged)
  await page.goto(created.personUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const ident = await verifyPageIdentity(page, { personUrl: created.personUrl });
  if (!ident.ok) {
    return fail(`identity verification failed for new target: ${ident.reason}`, evidence);
  }
  return { status: "created", target: asTarget(created), evidence: [...evidence, ident.detail] };
}
