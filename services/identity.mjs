// services/identity.mjs — P1 Lift boundary for verify-identity.mjs.
// Pass the Playwright page through (duck-type {url(), evaluate()});
// never throws (returns {ok, reason?, detail?, skipped?}).
export {
  extractPersonId,
  verifyPageIdentity,
} from "../uploader/lib/verify-identity.mjs";
