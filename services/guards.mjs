// services/guards.mjs — P1 Lift boundary for group + host guards.
// Pure, no I/O. Combines group-guard.mjs and host-gate.mjs so one import
// covers the upload gate set. Verbatim re-export, no behavior change.
export {
  sourceUniformityFailure,
  sourceIdentityFailure,
  fieldsSatisfy,
} from "../uploader/lib/group-guard.mjs";
export { mapHostMismatch } from "../uploader/lib/host-gate.mjs";
