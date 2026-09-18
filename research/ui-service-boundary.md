# Research: reusable engine boundary for UI service layer

Ticket: Audit reusable engine boundary for UI service layer (research) — #18, part of #10.
Branch: `research/ui-service-boundary`. Audited commit `7e4f887` (feat/people-shortlist lineage, backup-page v1.3.0) 2026-09-18. Ground facts in ticket verified against code, not re-derived from zero.

## Question

Which exact functions/modules of today's engine become the reusable service layer behind the UI's application/job layer, and which stay CLI-bound — so UI work never duplicates scraper/uploader logic?

## Verdict (extraction list)

- **Lift verbatim** (pure, no I/O, no browser, no argv): all of `sectioning.mjs`; `uploader/lib/match.mjs` scoring core; all of `group-guard.mjs` + `host-gate.mjs`; `verify-identity.mjs` logic; pure subset of `automap.mjs` (`loadProfiles`, `matchProfile`, `pickDeptRows`, `buildInventory`, `classify` + helpers).
- **Wrap behind job API** (valuable logic tangled with browser/fs/process — expose as async job ops, never import the CLI entry): `backup-page.mjs` scrape/probe/review/finalize core; `automap()` full discovery; `createDepartment()`; `cdp-port.mjs` preflight; `upload-people.mjs` plan/gate/row-loop fragments; `pipeline.mjs` orchestration (step DAG, order, flag fan-out).
- **Stays CLI** (thin adapters: argv/stdin/stdout/process-exit/Chrome-launch/HTML strings): `pipeline.mjs` entry + `sh()`/`pause()`; `backup-page.mjs` dispatch + CDP bootstrap + HTML builders; `upload-people.mjs` entry + browser connect + save click + report write; all of `detect.mjs` + `map-check.mjs`; config/artifact files as data.

Rule: UI service imports only Lift + job-wrapped Wrap. CLI entries are never imported — both adapters call the same service core (Core Logic → CLI adapter + UI adapter, per map Notes).

## A. Lift verbatim — evidence per item

| Item | Location | Why it lifts as-is |
|---|---|---|
| Module purity claim | sectioning.mjs:1-5, 86-89 | Header states pure/no-I/O, no mutable cross-call state; locals per call (`lastHeading/lastDivision/extras/enumeration` are function locals) |
| `isDivisionText` | sectioning.mjs:44-49 | Pure regex predicate, no deps |
| `inferSection` | sectioning.mjs:50-54 | Pure table lookup over `SEC_FROM_POSITION` (:31-35) |
| `slugBaseOf` | sectioning.mjs:61-68 | Pure URL→key; already shared by backup-page resolveSlug (:80) and upload-people identity gate (:146) |
| `newSourceContext` | sectioning.mjs:71-73 | Pure constructor, fresh object per URL |
| `resolveTargetGroup` | sectioning.mjs:77-84 | Pure registry-alias lookup; upload target identity (:160-161) |
| `attachCaptions` | sectioning.mjs:90-205 | Pure transform over `kept[]`; already imported by backup-page.mjs:93 |
| `IMG_DENY`, `TEXT_DENY_EXACT`, `MIN_PX` | sectioning.mjs:207-209 | Frozen constants; filter rules |
| `providerOf` | sectioning.mjs:211-215 | Pure iframe→placeholder classifier |
| `imgSlotKey` | sectioning.mjs:225-226 | Pure dedupe key (src+coords) |
| `buildKept` | sectioning.mjs:228-271 | Pure raw-nodes→kept/queue/stats; calls `attachCaptions` (:269); only caller-side I/O is outside |
| `buildPeople` | sectioning.mjs:277-295 | Pure kept→personnel rows incl. SourceContext; contract cited in backup-page.mjs:94 |
| `norm`, `scorePair` | uploader/lib/match.mjs:23-55 | Pure label scoring (exact 1.0 / alias 0.75 / substring 0.7 / token ≤0.65); header guarantees determinism (:1-8) |
| `normalizePhone`, `extractPhones`, `phoneOverlap` | uploader/lib/match.mjs:63-93 | Pure phone corroboration; format-agnostic digit fold |
| `normalizeName`, `isVacantName`, `memberScore` | uploader/lib/match.mjs:98-115 | Pure member-name evidence; vacant excluded |
| `matchSection` | uploader/lib/match.mjs:124-172 | Pure wanted×candidates→auto/review/fail (AUTO 0.8 / MIN 0.5, :13); corroboration capped so members/phones never auto-match alone (:150-155) |
| `failBlock` | uploader/lib/match.mjs:175-184 | Pure human-readable failure rendering |
| `keywords()` | uploader/lib/match.mjs:16-21 | Only impurity in match.mjs: sync fs read of `keywords.json`. Lift with injected dict or keep the 3-line lazy read — not a blocker |
| `sourceUniformityFailure` | uploader/lib/group-guard.mjs:6-16 | Pure URL-boundary guard; header pure/no-I/O (:1-5) |
| `sourceIdentityFailure` | uploader/lib/group-guard.mjs:21-36 | Pure uniformity+group==slugOf(URL) gate |
| `fieldsSatisfy` | uploader/lib/group-guard.mjs:41-47 | Pure field-shape check (selector/strategy present, no TBD) |
| `mapHostMismatch` | uploader/lib/host-gate.mjs:7-23 | Pure origin compare; returns null when gate N/A |
| `extractPersonId` | uploader/lib/verify-identity.mjs:13-16 | Pure regex over both URL schemes (`/personal/person/{id}` + bare `/personal/{id}`) |
| `verifyPageIdentity` | uploader/lib/verify-identity.mjs:20-56 | Page duck-type `{url(), evaluate()}` (:18), never throws (:19); URL+photo-form-action double check. Lifts verbatim; service passes the Playwright page through |
| `loadProfiles` | uploader/lib/automap.mjs:10-14 | Sync profiles/ read; lift with injected loader or keep (same pattern as `keywords()`) |
| `matchProfile` | uploader/lib/automap.mjs:213-225 | Pure fingerprint match over dumped form names |
| `pickDeptRows` | uploader/lib/automap.mjs:235-251 | Pure link→dept-row picker, both URL schemes, id-dedupe; shared by automap (:297) and target-creation |
| `buildInventory` | uploader/lib/automap.mjs:89-133 | Pure dumped-form→fill inventory (photo-form scoped); new templates need map review, never code patches |
| `classify` + `fieldMatchesSel` + `actionFor` | uploader/lib/automap.mjs:136-210 | Pure form→fields classifier; `dumpForm` (:16-84) is the page-evaluated half — lifts verbatim as the evaluate string, executes in page context |

## B. Wrap behind job API — evidence per item

| Job op | Core function(s) | CLI tangle to cut (stays out of service) |
|---|---|---|
| `env.preflight` | `resolvePort` cdp-port.mjs:2-12, `discoverBackends` cdp-port.mjs:24-28 | Today called with `--port` argv (upload-people.mjs:44, detect.mjs:37); service passes port explicitly, no argv |
| `scrape.runUrl` / `scrape.probeUrl` | `navigateAndExtract` backup-page.mjs:338-375, `downloadQueue` backup-page.mjs:377-421, `scrapeOne` backup-page.mjs:424-457, `probeOne` backup-page.mjs:460-486 | CDP client (:146-167), `ensureChrome` launch (:114-144), `resolveSlug` fs-collision check (:79-92), `pageSectionFor` file load (:905-911), top-level target open/close loop (:964-988). CF sub-helpers wrap too: `probeChallenge` (:304), `waitForChallengeClear` (:312-336) with stdin fallback `waitForEnter` (:292-303) → becomes `challenge-blocked` job event, never stdin |
| `review.*` | `buildMasterGroups` backup-page.mjs:586-607, `applyMaster` backup-page.mjs:639-673, `suggestOrders` backup-page.mjs:682-690, `writeReview` backup-page.mjs:691-699, `finalize` backup-page.mjs:750-827, `writeSummary` backup-page.mjs:829-842 | `finalize` reads/writes `content.json`+`people.json`+`selection.json` + unlinks images (:750-827) — keep the logic, job owns paths/locks; `--compact-orders` flag (:793) becomes an op option |
| `discover.backend` | `automap` automap.mjs:255-363 (filter probe :262-271, unfiltered enumerate :276-284, deptRaw :285-296, wanted-rank :300-309, per-dept goto+dump+classify :314-329, merge :347-355) | Playwright `context` + `write:true` maps/ merge (:342-356) — service forces ephemeral (`write:false`, as upload-people.mjs:195-200 already does) |
| `backend.ensureDepartment` | `createDepartment` target-creation.mjs:86-173 (via `readDeptRows` :19-33, `readCreateForm` :38-79) | Needs live `page`; POSTs `/personal pg_name` (:142-146) — job op with duplicate-guard evidence, never auto-called by uploads. STALE HEADER: target-creation.mjs:1-4 claims "NOT wired into upload-people.mjs" — false since zero-map round: upload-people.mjs:18 imports it, :262-307 calls it. Fix header on touch |
| `upload.plan` | `targetGroupOf` upload-people.mjs:160-161, `deptIndex` :167-171, `resolveGroup`+`groupCache` :172-182, plan block :221-256, `detailVal` :153, `groupMembers` :159-165 | Pure logic except `console.log` plan rendering (:244-255) → becomes structured `upload:plan` payload (see #19) |
| `upload.preflight` | stale-finalize check upload-people.mjs:102-140, identity gate :145-148, field gate `checkFields` :204-214 (+:212-214 empty-backend deferral), creation bootstrap :262-307 | fs reads (`selection.json`, `content.json`, `people.json`), `process.exit` via `fail()` (:25) → return typed failures instead |
| `upload.executeRow` | per-row loop upload-people.mjs:311-450 (photo resolve :317, duplicate list check :355-360, `verifyPageIdentity` :365, inventory/legacy fill :372-425, screenshot :426-429, save click :434-442 via `resolvePhotoFormSubmit` :456-470) | `page`/`context` lifecycle (:186-188, :308, :451-453), `shotsDir` mkdir (:183-184), `saveSel` click + `success_mark` wait (:434-442), report assembly (:472-481) + `process.exit` (:486). Row statuses (`failed/skip-would-create/dry/dry-partial/created/created-partial`) are the job's per-row states |
| `pipeline.dag` | step list pipeline.mjs:31-32, flag fan-out `BP` :38-47 + `UP` :48-53, `orderSubs` :71-82, `peopleCount` :83-88, `sh()` :57-61, `pause()` :62-66, dispatch :90-134 | `spawnSync` (:59) replaced by in-process job calls; `readFileSync(0)` stdin block (:65) → job gate awaiting UI approval event; `--yes` (:37,63) → `autoApprove` job option |

## C. Stays CLI — evidence per item

| File | Lines that stay | Reason |
|---|---|---|
| pipeline.mjs | argv/opt/has/fail :14-20, `--help`+exit :21-30, steps validation :31-33, FROM/OUT/YES :34-37, `stagingFile` :55, dispatch loop :90-134, `done` :135 | Thin orchestrator adapter; survives as `pipeline.mjs --from …` calling the same DAG the UI job calls |
| backup-page.mjs | shebang/usage :1-32, argv consts :33-48, `cdp/cdpAlive/warnIfHeadless/ensureChrome` :96-144, `client` :146-167, `EXPR` :169-225, `fetchBuf` :230-242, `cdpFetchImage` :243-262, `extOf` :263-272, CF consts/expr :278-284, `waitForEnter` :292-303, `filePickerBtn/pickLinksHTML/pickImagesHTML/masterPickHTML/reviewHTML` :497-748, dispatch `--regen-review/--finalize/--apply-master/probe/run/summary` :845-1009 incl. `ensureChrome()` :962 and target lifecycle :965-988 | Chrome launcher, wire protocol, DOM-extract string, human HTML review screens, process exit codes. Service reuses the wrapped core, not these |
| uploader/upload-people.mjs | usage :26-40, BACKEND/PORT/MAP/SAVE/TO/LIMIT parse :41-50, map file read + `_status==="locked"` check :56-70, host-gate call :74-77, backend autodiscover :79-84, people read/sort/slice :92-97, `fromDir/slug` :98-99, `connectOverCDP` :186-188, save-click block :433-444, report write :480-481, `browser.close`+exit :485-486 | CLI adapter incl. `--to` escape hatch (:48, :231-232, :259, :328-332): keep CLI-first; service exposes `--to` only after safety #15 decides |
| uploader/detect.mjs | whole file :1-95 (argv :20-36, `resolvePort` :37, sections-from-people :42-49, `discoverBackends` :55, `automap{write:false}` :67, stdout JSON :91, `--dump-map` gate+write :35-36, :82-90, exit :95) | Read-only diagnostic wrapper; shares `automap` core, writes only on explicit opt-in |
| uploader/map-check.mjs | whole file :1-57 (argv :8-21, connect :23-27, evaluate dump :30-54, `writeFileSync OUT` :55, exit :57) | Diagnostic dump; never submits; output feeds manual map authoring |
| data files | `sections.json`, `source-groups.json`, `uploader/maps/*`, `uploader/profiles/*`, `uploader/field-map.json`, `uploader/section-map.json` (compat artifact, unread per upload-people.mjs:88-90) | Data, not code; service injects loaders, CLI keeps file paths |

## Notes for map driver (don't re-decide here)

1. Ticket's "largely reusable `uploader/lib/`" confirmed with one refinement: `automap()`/`createDepartment()`/`discoverBackends()` are reusable but not verbatim-liftable — they need a live Playwright `page`/`context` injected by the job layer. Only the scoring/guard/identity/picker halves lift verbatim.
2. `match.mjs` + `automap.mjs` file reads (`keywords.json`, `profiles/`) are the only fs touches in otherwise-pure modules — service should inject the parsed JSON (trivially mockable for #17 characterization tests).
3. `verify-identity.mjs` is the per-row safety net the UI must keep calling inside `upload.executeRow` — URL id + photo-form-action id, never section names (:1-11). Depends on safety #15 + state #12 for retry/resume semantics.
4. HTML review screens (`pick-links/master-pick/pick-images/review/index.html`) stay files in this round; migration path is #13's call. Job layer should treat their JSON (`picked-links.json`, `master.json`, `picked-images.json`, `selection.json`) as the contract, HTML as renderers.
5. Characterization boundary (#17, blocked by this ticket) = Lift set + Wrap op signatures above; CLI stdout text is explicitly out of contract (see #19 event catalog for the replacement).

## Context pointer

Full question in #18 body; audit method: read ticket, then verified each claimed symbol against the files/lines cited above at `7e4f887`. No code changed on this branch — this file only.
