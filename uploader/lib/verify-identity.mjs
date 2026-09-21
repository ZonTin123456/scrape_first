// verify-identity.mjs — post-goto target identity guard.
// Source of truth: numeric person ID in target URL. Verified stable signals:
//   1. current page URL carries /personal/person/{id}
//   2. the photo form exists and its action carries the SAME id
// (Observed live: deleted departments render an error page at the same URL
// with no form — URL match alone is NOT sufficient.)
// Section names/H1 are never routing decisions (secondary evidence at most).
// Targets without a person id (e.g. single-form backends) skip with a note.
// Both backend URL schemes carry the stable numeric id:
// /personal/person/{id} (canonical) and bare /personal/{id}.
const ID_RE = /\/personal\/(?:person\/)?(\d+)(?:[/?#]|$)/;

export const extractPersonId = (url) => {
  const m = ID_RE.exec(String(url || ""));
  return m ? m[1] : null;
};

// page: { url(): string, evaluate(fn): Promise<any> } (Playwright-compatible).
// Returns { ok, reason?, detail?, skipped? } — never throws.
export async function verifyPageIdentity(page, target) {
  const want = extractPersonId(target && target.personUrl);
  if (!want) {
    return { ok: true, skipped: true, detail: "identity check skipped (no person id in target)" };
  }
  let cur = "";
  try {
    cur = page.url();
  } catch (e) {
    return { ok: false, reason: `cannot read page URL: ${String((e && e.message) || e).slice(0, 80)}` };
  }
  const got = extractPersonId(cur);
  if (!got || got !== want) {
    return { ok: false, reason: `URL identity mismatch: expected person/${want}, at ${cur || "(unknown)"}` };
  }
  let info;
  try {
    info = await page.evaluate(() => {
      const forms = [...document.forms].map((f) => ({
        action: f.action || "",
        hasFile: !!f.querySelector('input[type="file"]'),
      }));
      const photo = forms.find((f) => f.hasFile);
      return { photoAction: photo ? photo.action : null, formCount: forms.length };
    });
  } catch (e) {
    return { ok: false, reason: `identity read failed: ${String((e && e.message) || e).slice(0, 80)}` };
  }
  if (!info || !info.photoAction) {
    return { ok: false, reason: `no photo form on ${cur} (invalid/error page?)` };
  }
  const formId = extractPersonId(info.photoAction);
  if (!formId || formId !== want) {
    return { ok: false, reason: `form identity mismatch: expected person/${want}, form posts to ${info.photoAction}` };
  }
  return { ok: true, detail: `identity ok: person/${want} (url+form)` };
}
