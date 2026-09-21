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
// person* (e.g. a "รับผิดชอบ<br>สำนักปลัด" note tail) is marked TAINTED, and
// the second-and-later distinct division texts since the last person block
// mark a MENU/ENUMERATION region: neither is a group heading. Suspect
// divisions still serve persons with no conflicting evidence, but lose to
// the current person's own position evidence. This keeps legitimate mid-page
// division groups (bare names under a heading) working while stopping note
// tails and menu lists from re-sectioning the next person.

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
// ---- Source identity (1 URL = 1 source group) ----
// source_key is derived deterministically from the normalized source URL
// (slugBaseOf: pure, no counters, no timestamps), so the same URL always
// yields the same key regardless of batch order or batch membership.
// Backend target departments are named by source group; intentional merges
// of several URLs into one group go through source-groups.json, never HTML.
export function slugBaseOf(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, "").split(".").slice(0, -1).join("") || x.hostname.replace(/\./g, "");
    const path = (x.pathname + (x.search ? `-${x.search}` : "")).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "index";
    return `${host}-${path}`.toLowerCase();
  } catch { return "page-index"; }
}
// SourceContext: the isolated identity of one source URL. Fresh object per
// URL — never shared, never mutated downstream (rows copy its values).
export function newSourceContext(source_url) {
  return { source_url, source_key: slugBaseOf(source_url) };
}
// Resolve the backend target group for a row: an explicit registry alias for
// the row's source URL wins (intentional merge); otherwise the row's own
// source identity. Registry shape: { map: { "<url substring>": "<group>" } }.
export function resolveTargetGroup(source_url, source_group, registry) {
  const map = (registry && registry.map) || {};
  const url = String(source_url || "");
  for (const [sub, g] of Object.entries(map)) {
    if (sub && !sub.startsWith("_") && url.includes(sub)) return g;
  }
  return source_group;
}

// URL isolation: this module holds NO mutable cross-call state (only frozen
// patterns). Every attachCaptions()/buildKept()/buildPeople() call creates a fresh source
// context (lastHeading/lastDivision/extras/enumeration window are locals),
// so state from URL A can never leak into URL B. One call = one source URL.
export function attachCaptions(kept, pageSection = null) {
  let lastHeading = null, lastDivision = null; // { text, seq, tainted?, enumerated? }
  let lastExtras = null; // text nodes consumed as trailing extras by the most recent image
  let prevSection = null; // section of the most recent image (diagnostic context)
  let divsSincePerson = new Set(); // DISTINCT division texts since the last person block
  // Provenance for audit/debug: every assignment records its evidence.
  // { by, setter_seq, state, demoted_from?, reason? } — additive only;
  // guards and matching use section/section_from, never this field.
  const ev = (by, setter_seq, state, extra) => ({ by, setter_seq: setter_seq ?? null, state, ...(extra || {}) });
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (n.type === "text") {
      if (n.h && (n.h === "H1" || n.h === "H2" || n.h === "H3") && !n.chrome) lastHeading = { text: n.text, seq: n.seq };
      // division headers are plain texts, not menu links — but a division-like
      // text sitting inside the previous person's trailing extras (their note
      // tail, e.g. "รับผิดชอบ / สำนักปลัด") is tainted: it describes the
      // previous person, it is not a heading for the next one. Likewise, the
      // second-and-later DISTINCT division texts since the last person block
      // mark a menu/enumeration region (e.g. สำนักปลัด/กองคลัง/กองช่าง listed
      // together): enumerations are not group headings either.
      if (!n.chrome && !n.link && isDivisionText(n.text)) {
        const dt = n.text.replace(/\s+/g, " ").trim();
        divsSincePerson.add(dt);
        lastDivision = {
          text: dt, seq: n.seq,
          tainted: !!(lastExtras && lastExtras.has(n)),
          enumerated: divsSincePerson.size >= 2,
        };
      }
      continue;
    }
    if (n.type !== "image") continue;
    divsSincePerson = new Set(); // new person block: enumeration window restarts
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
      lastDivision = { text: headName, seq: n.seq, tainted: false, enumerated: false };
    }
    if (VACANT_RE.test(n.caption_next[0] || "")) n.vacant = true;
    const inferred = inferSection(n.caption_next[1], n.caption_next[0]);
    if (lastHeading) {
      n.section = lastHeading.text; n.section_from = "heading";
      n.section_evidence = ev("heading", lastHeading.seq, "clean");
    }
    else if (pageSection) {
      n.section = pageSection; n.section_from = "url";
      n.section_evidence = ev("url", null, "clean");
    }
    else if (lastDivision && !n.likely_header) {
      // Suspect division (previous person's note tail, or a menu enumeration)
      // loses to the current person's own conflicting position evidence;
      // otherwise it still applies (bare names under a heading keep group).
      const suspect = lastDivision.tainted || lastDivision.enumerated;
      const state = lastDivision.tainted ? "tainted" : (lastDivision.enumerated ? "enumerated" : "clean");
      if (suspect && inferred && inferred !== lastDivision.text) {
        n.section = inferred; n.section_from = "position";
        n.group_warn = { previous: prevSection, demoted: lastDivision.text, reason: lastDivision.tainted ? "division from trailing person text" : "division from menu enumeration" };
        n.section_evidence = ev("position", null, "position", { demoted_from: { value: lastDivision.text, setter_seq: lastDivision.seq, state }, reason: n.group_warn.reason });
      } else {
        n.section = lastDivision.text; n.section_from = "division";
        n.section_evidence = ev("division", lastDivision.seq, state);
      }
    }
    else {
      n.section = inferred; n.section_from = inferred ? "position" : null;
      n.section_evidence = inferred ? ev("position", null, "position") : ev(null, null, null);
    }
    if (n.likely_header && !n.section) {
      n.section = lastDivision ? lastDivision.text : null; n.section_from = "division";
      n.section_evidence = ev("division", lastDivision ? lastDivision.seq : null, "clean");
    }
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

export const IMG_DENY = /(cleardot|blank\.gif|j1\.gif|rblue\.gif|spacer|pixel)/i;
export const TEXT_DENY_EXACT = new Set(["เลือกภาษา"]);
export const MIN_PX = 12;

export function providerOf(src) {  if (/google\.com\/maps|maps\/embed/.test(src)) return ["maps", "แผนที่ Google Maps"];
  if (/sharethis/.test(src)) return ["sharethis", "ปุ่มแชร์ (sharethis)"];
  if (/cjworld.*hotmenu/.test(src)) return ["hotmenu", "เมนูลัดจังหวัด (hotmenu)"];
  return ["other", "เนื้อหาฝังภายนอก"];
}

// Person-slot identity for image dedupe (generic, structural).
// The same image URL may legitimately repeat across person slots (shared
// placeholders such as a vacancy gif): image-URL identity is NOT person
// identity. Dedupe only repeats at the same page position (the same card
// rendered twice), keyed by document coordinates the extractor already
// records. Nodes without coordinates fall back to the legacy src-only key.
// Deliberate bias: over-keep (a visible duplicate is unticked in review)
// beats over-drop (a missing person is a silent loss).
export const imgSlotKey = (src, left, top) =>
  (left == null || top == null) ? `src:${src}` : `src:${src}@${left}x${top}`;

export function buildKept(rawNodes, origin, pageSection = null) {
  const stats = { text: 0, image: 0, placeholder: 0, "iframe-sameorigin": 0, cut: 0 };
  const kept = [], queue = [], seen = new Set();
  const cut = () => stats.cut++;
  rawNodes.forEach((n, i) => {
    if (n.t === "text") {
      if (n.goog || TEXT_DENY_EXACT.has(n.text)) return cut();
      stats.text++;
      const rec = { seq: i, type: "text", chrome: n.chrome, text: n.text };
      if (n.h) rec.h = n.h;
      if (n.tel) rec.tel = n.tel;
      if (n.link) rec.link = true;
      kept.push(rec);
    } else if (n.t === "img") {
      if (!n.src || n.src.startsWith("data:")) return cut(); // inline data-URI icons, not content
      if (IMG_DENY.test(n.src)) return cut();
      if (n.w < MIN_PX || n.h < MIN_PX) return cut();
      if (n.chrome) return cut();
      const key = imgSlotKey(n.src, n.left, n.top);
      if (seen.has(key)) return cut();
      seen.add(key);
      stats.image++;
      const rec = { seq: i, type: "image", chrome: false, file: null, src: n.src, width: n.w, height: n.h,
        top: (Number.isFinite(n.top) ? n.top : null), left: (Number.isFinite(n.left) ? n.left : null) };
      if (n.alt) rec.alt = n.alt;
      if (n.full && n.full !== n.src && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(n.full)) rec.fullres_candidate = n.full;
      kept.push(rec); queue.push(rec);
    } else if (n.t === "iframe") {
      if (!n.abs || n.abs === "about:blank") return cut();
      let cross = true;
      try { cross = new URL(n.abs).origin !== origin; } catch { /* placeholder */ }
      if (!cross) {
        stats["iframe-sameorigin"]++;
        kept.push({ seq: i, type: "iframe-sameorigin", chrome: n.chrome, src: n.abs });
        return;
      }
      const [provider, label] = providerOf(n.abs);
      stats.placeholder++;
      kept.push({ seq: i, type: "placeholder", kind: "iframe", provider, label, src: n.abs, title: n.title || null });
    }
  });
  attachCaptions(kept, pageSection);
  return { kept, queue, stats };
}

// Personnel records for the uploader. Every row carries its SourceContext
// (source_url + source_group = the URL's own stable key). HTML-derived
// section/division/position stay as evidence/debug metadata only — they are
// NEVER the upload target identity.
export function buildPeople(kept, url, photoKey) {
  const ctx = newSourceContext(url);
  const imgs = kept.filter((n) => n.type === "image");
  return imgs.map((n, idx) => ({
    seq: n.seq,
    order: idx, // 0-based DOM sequence: backend ตำแหน่งภาพ starts at 0
    photo: (photoKey === "file" ? (n.file || n.src || null) : (n.src || null)),
    name: n.caption_next?.[0] || null,
    position: n.caption_next?.[1] || null,
    phone: n.phone || null,
    note: n.note || null,
    section: n.section || null, section_from: n.section_from || null, group_warn: n.group_warn || null, section_evidence: n.section_evidence || null,
    likely_header: !!n.likely_header, vacant: !!n.vacant,
    width: n.width, height: n.height,
    alt: n.alt || null,
    source_url: ctx.source_url,
    source_group: ctx.source_key,
  }));
}
