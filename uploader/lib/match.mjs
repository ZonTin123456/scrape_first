// match.mjs — scored section matching for zero-map runtime discovery.
// Pure + deterministic (no fs, no network). Label: exact 1.0 > alias 0.75 >
// substring 0.7 > token-overlap (<=0.65). Member overlap is corroboration
// only (+0.25/+0.15, min 2 shared names, vacant excluded) and can never
// auto-match alone (caps at review band). Auto ONLY on a single unambiguous
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

// Phone-digit evidence (corroboration only, never routing alone).
// Normalization is format-agnostic, not per-site: strip every non-digit,
// fold a leading Thai country trunk (66 + 9 digits -> 0 + 9 digits; the rule
// is symmetric so both sides normalize identically and can never merge two
// different people). Valid: 9-10 digits; all-identical-digit junk rejected.
// Mirrors the repo's existing phone-text rule (7+ chars, 9+ digits).
export function normalizePhone(s) {
  let t = String(s ?? "").replace(/\D/g, "");
  if (!t) return "";
  if (/^66\d{9}$/.test(t)) t = "0" + t.slice(2);
  if (t.length < 9 || t.length > 10) return "";
  if (/^(\d)\1+$/.test(t)) return "";
  return t;
}
// extractPhones: plausible numbers embedded in free text (names like
// "นาง ก (065-5300535)", notes, details).
export function extractPhones(text) {
  const out = new Set();
  const found = String(text ?? "").match(/\+?[\d][\d\s\-().]{7,}[\d]/g) || [];
  for (const f of found) {
    const n = normalizePhone(f);
    if (n) out.add(n);
  }
  return out;
}
const flatPhones = (arr) => {
  const out = new Set();
  for (const s of arr || []) for (const n of extractPhones(s)) out.add(n);
  return out;
};
// phoneOverlap: shared normalized numbers between two string sets.
export function phoneOverlap(wantStrings, candStrings) {
  const W = flatPhones(wantStrings), C = flatPhones(candStrings);
  let shared = 0;
  for (const n of W) if (C.has(n)) shared++;
  return { shared, want: W.size, cand: C.size };
}
// Member-name evidence (cross-reference source rows vs backend page rows).
// Normalized (parens/phones stripped); vacant/blank rows excluded — they exist
// on every page and would fake corroboration.
const VACANT_NAME_RE = /^(ว่าง|-ว่าง-|ตำแหน่งว่าง|ไม่มีข้อมูล|-+|n\/a|none|null)$/i;
export function normalizeName(s) {
  return norm(s).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}
export const isVacantName = (s) => {
  const t = normalizeName(s);
  return t.length < 2 || VACANT_NAME_RE.test(t);
};
// memberScore: overlap between source member names and a candidate page's
// memberNames. {shared, want, cand, ratio} with ratio = shared/min(sizes).
export function memberScore(wantNames, candNames) {
  const W = new Set((wantNames || []).map(normalizeName).filter((n) => n && !isVacantName(n)));
  const C = new Set((candNames || []).map(normalizeName).filter((n) => n && !isVacantName(n)));
  let shared = 0;
  for (const n of W) if (C.has(n)) shared++;
  const denom = Math.min(W.size, C.size);
  const ratio = denom ? shared / denom : 0;
  return { shared, want: W.size, cand: C.size, ratio: +ratio.toFixed(3) };
}

// Score wanted against all candidate keys [{key, url, memberNames, phoneHints...}].
// opts.wantMembers / opts.wantPhones: source evidence for corroboration (never
// sufficient alone: label score < MIN caps the verdict at review even with
// full overlap). Count proximity breaks score ties (smaller |want-cand| gap).
// Phone bonus (+0.15, min 2 shared numbers) stacks under the same cap, so it
// can corroborate but never override a strongly conflicting label into auto.
// Returns {verdict, best, scored} where verdict is auto|review|fail.
export function matchSection(want, candidates, opts = {}) {
  const wantMembers = opts.wantMembers || null;
  const wantPhones = opts.wantPhones || null;
  const wantSize = wantMembers ? new Set(wantMembers.map(normalizeName).filter((n) => n && !isVacantName(n))).size : null;
  const scored = (candidates || []).map((c) => {
    const label = scorePair(want, c.key);
    let score = label.score;
    const evidence = [...label.evidence];
    let member = null;
    if (wantMembers && c.memberNames) {
      member = memberScore(wantMembers, c.memberNames);
      // corroboration only: min 2 shared names (common-name guard)
      if (member.shared >= 2) {
        if (member.ratio >= 0.5) score = Math.min(1, score + 0.25);
        else if (member.ratio >= 0.2) score = Math.min(1, score + 0.15);
      }
      evidence.push(`member:${member.shared}/${member.want}/${member.cand}`);
    }
    let phone = null;
    if (wantPhones && c.phoneHints) {
      phone = phoneOverlap(wantPhones, c.phoneHints);
      // corroboration only: min 2 shared numbers (single shared number proves nothing)
      if (phone.shared >= 2) score = Math.min(1, score + 0.15);
      evidence.push(`phone:${phone.shared}/${phone.want}/${phone.cand}`);
    }
    let final = +score.toFixed(2);
    if (label.score < MIN) {
      // member/phone-only rescue: review band at best, never auto (renamed-page suspicion)
      const memberOk = member && member.shared >= 2 && member.ratio >= 0.5;
      const phoneOk = phone && phone.shared >= 2;
      final = (memberOk || phoneOk) ? Math.max(final, 0.55) : Math.min(final, 0.49);
    }
    return { ...c, score: final, labelScore: label.score, member, phone, evidence };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (wantSize !== null && a.member && b.member) {
      const da = Math.abs(wantSize - a.member.cand), db = Math.abs(wantSize - b.member.cand);
      if (da !== db) return da - db;
    }
    return String(a.key).localeCompare(String(b.key));
  });
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
