// services/match-core.mjs — P1 Lift boundary for uploader/lib/match.mjs scoring.
// Verbatim re-export; single source stays ../uploader/lib/match.mjs.
// Injection: pass a dict per-call (scorePair/matchSection opts.keywordsDict)
// or process-wide via setKeywordsDict() (UI path). Omitted = lazy fs read of
// keywords.json (CLI default, unchanged behavior).
export {
  norm,
  scorePair,
  normalizePhone,
  extractPhones,
  phoneOverlap,
  normalizeName,
  isVacantName,
  memberScore,
  matchSection,
  failBlock,
  keywords,
  setKeywordsDict,
  resetKeywordsDict,
} from "../uploader/lib/match.mjs";
