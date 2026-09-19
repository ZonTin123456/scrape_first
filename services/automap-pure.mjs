// services/automap-pure.mjs — P1 Lift boundary for automap.mjs pure subset.
// Verbatim re-export; single source stays ../uploader/lib/automap.mjs.
// Injection: loadProfiles(loaderFn | loaderArray) per-call, or process-wide
// via setProfilesLoader() (UI path). Omitted = fs read of profiles/ (CLI
// default, unchanged). dumpForm lifts as evaluate string: DUMP_FORM_SOURCE
// is dumpFormEvaluate.toString() (page-context probe); dumpForm(page)
// executes it in the page via page.evaluate().
export {
  loadProfiles,
  setProfilesLoader,
  resetProfilesLoader,
  matchProfile,
  pickDeptRows,
  buildInventory,
  classify,
  fieldMatchesSel,
  actionFor,
  dumpForm,
  dumpFormEvaluate,
  DUMP_FORM_SOURCE,
} from "../uploader/lib/automap.mjs";
