// group-guard: safety net against accidental source-group splits.
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
