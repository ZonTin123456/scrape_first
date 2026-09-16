// match.mjs — scored section matching for zero-map runtime discovery.
// Pure + deterministic (no fs, no network). Scores: exact 1.0 > alias 0.75 >
// substring 0.7 > token-overlap (<=0.65). Auto ONLY on a single unambiguous
// top at >= AUTO (0.8); ties or mid band (0.5-0.8) -> review/fail with the
// candidate list (non-interactive: caller fails closed and reports them).
// Below MIN (0.5) -> fail. Never guesses silently.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTO = 0.8, MIN = 0.5;

let _kw = null;
export function keywords() {
  if (!_kw) {
    _kw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "keywords.json"), "utf8"));
  }
  return _kw;
}

export const norm = (s) => String(s ?? "").trim().normalize("NFC");
const normLo = (s) => norm(s).toLowerCase();
const toks = (s) => normLo(s).split(/[\s_\/-]+/).filter((t) => t.length > 1);

function aliasHit(want, key) {
  const aliases = keywords().section_aliases || {};
  for (const [canon, alts] of Object.entries(aliases)) {
    const group = new Set([normLo(canon), ...alts.map(normLo)]);
    if (group.has(normLo(want)) && group.has(normLo(key))) return canon;
  }
  return null;
}

// Score ONE wanted label against ONE candidate key. Returns {score, evidence[]}.
export function scorePair(want, key) {
  const w = norm(want), k = norm(key);
  if (!w || !k) return { score: 0, evidence: [] };
  if (normLo(w) === normLo(k)) return { score: 1.0, evidence: ["exact"] };
  const wl = normLo(w), kl = normLo(k);
  const alias = aliasHit(w, k);
  if (alias) return { score: 0.75, evidence: [`alias:${alias}`] };
  if (kl.includes(wl) || wl.includes(kl)) {
    const dir = kl.includes(wl) ? "key-contains-want" : "want-contains-key";
    return { score: 0.7, evidence: [`substring:${dir}`] };
  }
  const wt = new Set(toks(w)), kt = new Set(toks(k));
  let overlap = 0;
  for (const t of wt) if (kt.has(t)) overlap++;
  const denom = Math.min(wt.size, kt.size) || 1;
  const ratio = overlap / denom;
  if (overlap > 0) return { score: Math.min(0.65, +(ratio * 0.6).toFixed(2)), evidence: [`token:${overlap}/${denom}`] };
  return { score: 0, evidence: [] };
}

// Score wanted against all candidate keys [{key, url, ...}].
// Returns {verdict, best, scored} where verdict is auto|review|fail.
export function matchSection(want, candidates) {
  const scored = (candidates || []).map((c) => ({ ...c, ...scorePair(want, c.key) }));
  scored.sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key, undefined)));
  const best = scored[0] || null;
  if (!best || best.score < MIN) return { verdict: "fail", best, scored };
  const tied = scored.filter((c) => c.score === best.score);
  if (tied.length > 1) return { verdict: "review", best, scored, tie: tied.map((c) => c.key) };
  if (best.score >= AUTO) return { verdict: "auto", best, scored };
  return { verdict: "review", best, scored };
}

// Human-readable failure block with evidence trail (approved failure protocol).
export function failBlock(want, result, excess = 6) {
  const lines = [`section "${want}": no confident backend match (${result.verdict})`];
  for (const c of (result.scored || []).slice(0, excess)) {
    lines.push(`  - candidate "${c.key}" score=${c.score} [${(c.evidence || []).join(",") || "no-evidence"}]${c.url ? " <" + c.url + ">" : ""}`);
  }
  if ((result.scored || []).length > excess) lines.push(`  ... +${result.scored.length - excess} more candidates`);
  if (result.tie) lines.push(`  tie between: ${result.tie.join(" | ")} (ambiguous — refusing)`);
  lines.push("  fix: create the department on the backend, cut scope, or pass --to <personUrl>");
  return lines;
}
