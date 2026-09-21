// services/sectioning.mjs — P1 Lift boundary (verbatim re-export).
// UI imports Lift + Wrap cores only, never CLI entries. CLI adapters import
// these same symbols from here so both paths share one core. No behavior
// change: single source remains ../sectioning.mjs (pure, no I/O).
export {
  slugBaseOf,
  newSourceContext,
  resolveTargetGroup,
  attachCaptions,
  buildKept,
  buildPeople,
  isDivisionText,
  inferSection,
  providerOf,
  imgSlotKey,
  IMG_DENY,
  TEXT_DENY_EXACT,
  MIN_PX,
} from "../sectioning.mjs";
