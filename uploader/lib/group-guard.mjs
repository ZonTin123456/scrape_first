// group-guard: safety nets for source identity (pure, no I/O).
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
// Source-identity gate (1 URL = 1 source group): uniformity PLUS every row
// present source_group PLUS every row's group equal to its own source URL's
// stable key (slugOf). A row whose group belongs to another URL (tampered or
// cross-contaminated) fails here, before any planning or backend mutation.
export function sourceIdentityFailure(people, slugOf) {
  const u = sourceUniformityFailure(people);
  if (u) return u;
  const nogroup = people.filter((p) => !p.source_group);
  if (nogroup.length) {
    const seqs = nogroup.map((p) => p.seq ?? "?").slice(0, 8).join(",");
    return `${nogroup.length} row(s) without source_group (seq ${seqs}) — source identity incomplete`;
  }
  for (const p of people) {
    const want = slugOf(p.source_url);
    if (String(p.source_group) !== String(want)) {
      return `row seq ${p.seq ?? "?"} claims source_group ${JSON.stringify(p.source_group)} but its source_url ${p.source_url} owns ${JSON.stringify(want)} — cross-source contamination`;
    }
  }
  return null;
}
// Field-shape check (pure): which required field keys lack a usable
// selector/strategy (null, missing, or TBD placeholder). Returns the missing
// keys (empty = satisfied). Used by the upload field gate, including the
// post-rediscovery re-gate on bootstrapped backends.
export function fieldsSatisfy(fields, need) {
  const f = fields || {};
  return (need || []).filter((k) => {
    const v = f[k];
    return !(v && (v.selector || v.strategy) && !/^TBD/.test(v.selector || ""));
  });
}
// NOTE: groupSplitFailure (weak mixed-evidence multi-target) was retired with
// the source-group architecture: target identity is the source URL's own key
// now, never an HTML label contest, so that failure mode cannot occur.
