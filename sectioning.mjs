// sectioning.mjs — generic person-section heuristics for the loader.
// Pure module (no I/O): backup-page.mjs imports attachCaptions; unit tests
// import it directly. Zero site/page-specific knowledge: rules are structural
// (DOM order, run adjacency) plus Thai administrative vocabulary shared by
// all STS backends — never per-site maps or adapters.
//
// Evidence priority (generic, current-person-first):
//   H1-H3 heading > --page-sections url override > scoped division context
//   > current-person position inference > page fallback (first section seen).
// A division-like text captured from the *trailing extras of the previous
// person* (e.g. a "รับผิดชอบ<br>สำนักปลัด" note tail) is marked TAINTED: it
// may still serve persons with no conflicting evidence, but it loses to the
// current person's own position evidence. This keeps legitimate mid-page
// division groups (bare names under a heading) working while stopping one
// person's note tail from re-sectioning the next person.

// caption = next 2 non-phone texts (name, position). phone = first tel:-flagged
// (or phone-pattern) text in the same run. extras = every trailing text after
// those (until the next image/placeholder/iframe), minus junk tails, joined
// with <br> into note for the backend detail field. section = nearest preceding H1-H3.
const PHONE_RE = /^[+\d][\d\s\-().]{7,}$/;
const isPhoneText = (t) => {
  if (!t || !PHONE_RE.test(t)) return false;
  return (t.replace(/\D/g, "").length >= 9);
};
// section priority: H1-H3 heading > --page-sections url override > scoped
// division context (tainted trailing captures lose to conflicting position
// evidence) > position inference > page fallback
const SEC_FROM_POSITION = [
  [/สภา/, "สภาท้องถิ่น"],
  [/นายก|รองนายก|เลขานุการนายก|ที่ปรึกษา/, "คณะผู้บริหาร"],
  [/ปลัด|รองปลัด|หัวหน้า|ผู้อำนวยการ|นัก|เจ้าพนักงาน|พนักงาน|ลูกจ้าง|ข้าราชการ|คนงาน|แม่บ้าน|ภารโรง|ประจำ|ผู้ช่วย|เจ้าหน้าที่|พนักงานจ้าง/, "พนักงานส่วนท้องถิ่น"],
];
// division header: สำนัก/กอง/ฝ่าย/แผนก/งาน + short name (section context for following images)
const VACANT_RE = /^(ว่าง|.*ว่าง.*|ไม่มีผู้ดำรงตำแหน่ง)$/;
// junk-only tails (punct separators, widget tails): extras stop here.
const JUNK_TEXT_RE = /^[\s.,·•\-–—_|/\\:;…!?()[\]{}"']+$/;
const isJunkText = (t) => {
  const s = String(t || "").trim();
  return s.length < 2 || JUNK_TEXT_RE.test(s);
};
export const isDivisionText = (t) => {
  if (!t) return false;
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 30) return false;
  return /^(สำนัก|กอง|ฝ่าย|แผนก|งาน)\S*( .{1,24})?$/.test(s);
};
export function inferSection(position, name) {
  const t = `${position || ""} ${name || ""}`;
  for (const [re, sec] of SEC_FROM_POSITION) if (re.test(t)) return sec;
  return null;
}
export function attachCaptions(kept, pageSection = null) {
  let lastHeading = null, lastDivision = null; // lastDivision: { text, tainted }
  let lastExtras = null; // text nodes consumed as trailing extras by the most recent image
  let prevSection = null; // section of the most recent image (diagnostic context)
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (n.type === "text") {
      if (n.h && (n.h === "H1" || n.h === "H2" || n.h === "H3") && !n.chrome) lastHeading = n.text;
      // division headers are plain texts, not menu links — but a division-like
      // text sitting inside the previous person's trailing extras (their note
      // tail, e.g. "รับผิดชอบ / สำนักปลัด") is tainted: it describes the
      // previous person, it is not a heading for the next one.
      if (!n.chrome && !n.link && isDivisionText(n.text)) {
        lastDivision = {
          text: n.text.replace(/\s+/g, " ").trim(),
          tainted: !!(lastExtras && lastExtras.has(n)),
        };
      }
      continue;
    }
    if (n.type !== "image") continue;
    const texts = [];
    for (let j = i + 1; j < kept.length; j++) {
      const m = kept[j];
      if (m.type !== "text") break; // stop at next image/placeholder/iframe-sameorigin
      if (m.chrome !== n.chrome) continue; // don't mix chrome text into content caption
      if (m.text) texts.push(m);
    }
    const cap = texts.slice(0, 2).map((m) => m.text);
    let phone = null;
    for (const m of texts) {
      if (m.tel || isPhoneText(m.text)) { phone = m.text; break; }
    }
    const rest = texts.map((m) => m.text).filter((t) => t !== phone);
    n.caption_next = (rest.slice(0, 2));
    n.caption_text = n.caption_next.join(" | ");
    n.phone = phone;
    // extras: trailing texts after the caption lines + phone, in DOM order.
    // Stops at the first junk-only tail (punct separators, widget tails).
    const extras = [];
    {
      let seenCap = 0;
      for (const m of texts) {
        if (phone !== null && m.text === phone) continue;
        if (seenCap < n.caption_next.length) { seenCap++; continue; }
        if (isJunkText(m.text)) break;
        extras.push(m);
      }
    }
    lastExtras = new Set(extras);
    n.note = extras.length ? extras.map((m) => m.text).join("<br>") : null;
    // header graphic? (division name as caption, no position/phone)
    const headName = n.caption_next[0];
    if (headName && !n.caption_next[1] && !phone && isDivisionText(headName)) {
      n.likely_header = true;
      lastDivision = { text: headName, tainted: false };
    }
    if (VACANT_RE.test(n.caption_next[0] || "")) n.vacant = true;
    const inferred = inferSection(n.caption_next[1], n.caption_next[0]);
    if (lastHeading) { n.section = lastHeading; n.section_from = "heading"; }
    else if (pageSection) { n.section = pageSection; n.section_from = "url"; }
    else if (lastDivision && !n.likely_header) {
      // Tainted division (previous person's note tail) loses to the current
      // person's own conflicting position evidence; otherwise it still
      // applies (bare names under a mid-page heading keep their group).
      if (lastDivision.tainted && inferred && inferred !== lastDivision.text) {
        n.section = inferred; n.section_from = "position";
        n.group_warn = { previous: prevSection, demoted: lastDivision.text, reason: "division from trailing person text" };
      } else { n.section = lastDivision.text; n.section_from = "division"; }
    }
    else {
      n.section = inferred; n.section_from = inferred ? "position" : null;
    }
    if (n.likely_header && !n.section) { n.section = lastDivision ? lastDivision.text : null; n.section_from = "division"; }
    if (n.type === "image" && n.section) prevSection = n.section;
  }
  // guarantee: every named image leaves with a section (first section seen on page)
  let pageFallback = null;
  for (const n of kept) { if (n.type === "image" && n.section) { pageFallback = n.section; break; } }
  if (pageFallback) {
    for (const n of kept) {
      if (n.type === "image" && !n.section && n.caption_next?.[0]) {
        n.section = pageFallback; n.section_from = "page";
      }
    }
  }
  return kept;
}
