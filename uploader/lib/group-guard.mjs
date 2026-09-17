// group-guard: safety nets for source-group integrity (pure, no I/O).
// URL-boundary guard: one people file, one source. Every row must carry the
// source_url of the file that created it, and all rows must agree. Catches
// cross-URL contamination (a record inheriting another URL's context) before
// any backend mutation. Returns null (pass) or a fail-closed reason.
export function sourceUniformityFailure(people) {
  if (!Array.isArray(people) || !people.length) return "no people rows to upload";
  const missing = people.filter((p) => !p || !p.source_url);
  if (missing.length) {
    const seqs = missing.map((p) => (p && p.seq) ?? "?").slice(0, 8).join(",");
    return `${missing.length} row(s) without source_url (seq ${seqs}) — provenance untraceable`;
  }
  const srcs = [...new Set(people.map((p) => String(p.source_url)))];
  if (srcs.length > 1) return `cross-URL contamination: ${srcs.length} distinct source_url in one file (${srcs.join(" | ")}) — refusing`;
  return null;
}
// Pure function, no I/O. Fires only when ONE people file resolves to MULTIPLE
// targets resting ENTIRELY on weak heuristic evidence (division / position
// inference) reached via DIFFERENT mechanisms, with no heading/url evidence
// anywhere. Legitimate multi-group pages (H1-H3 headings, url overrides,
// single-mechanism division groups) never match: they carry strong evidence
// or a single coherent mechanism.
// plan: [{ section, action }] with action in upload/would-create/created.
// evidence: Map (or plain object) section -> iterable of section_from strings.
// Returns null (pass) or { sections, mechanisms } (fail-closed).
const TARGET_ACTIONS = new Set(["upload", "would-create", "created"]);
const STRONG = new Set(["heading", "url"]);
const WEAK = new Set(["division", "position"]);
export function groupSplitFailure(plan, evidence) {
  const secs = [...new Set((plan || [])
    .filter((e) => e && TARGET_ACTIONS.has(e.action) && e.section)
    .map((e) => e.section))];
  if (secs.length < 2) return null;
  const get = (s) => {
    if (!evidence) return [];
    if (typeof evidence.get === "function") return [...(evidence.get(s) || [])];
    return [...(evidence[s] || [])];
  };
  const mechs = new Set();
  for (const s of secs) for (const f of get(s)) mechs.add(f);
  if ([...mechs].some((m) => STRONG.has(m))) return null;
  const weak = [...new Set([...mechs].filter((m) => WEAK.has(m)))];
  if (weak.length < 2) return null;
  return { sections: secs, mechanisms: weak };
}
