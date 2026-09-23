Plan from locked map. No reopen. Contradiction only escape hatch.

## Destination

Local Job Workspace UI over current engine. Same CLI works. 72 tests green after every step.

## Fixed locks consumed

- [Runtime grilling](https://github.com/ZonTin123456/scrape_first/issues/11): local web + single Node process. Serves UI + runs jobs in-process. Dumb localhost client. External headed Chrome via CDP 9333→9444→9222. Node-only. `startServer({outDir,port})` seam. Packaging deferred.
- [Safety grilling](https://github.com/ZonTin123456/scrape_first/issues/15): discover/dry/real trinity. G1 green preflight + fresh dry. G2 attest + typed slug + click. Snapshot/dry/save ids. Immutable proof. Single-use arm.
- [Reuse research](https://github.com/ZonTin123456/scrape_first/issues/18): Lift-verbatim vs Wrap vs stays-CLI. Evidence `research/ui-service-boundary`. Rule: UI imports Lift + Wrap cores only. Never CLI entries.
- [Observability research](https://github.com/ZonTin123456/scrape_first/issues/19): today terminal + batch JSON + shots only. ~16-event NDJSON sketch. Start trio `url-started/finished/failed` + `row-finished` + `artifact:written`. Evidence `research/engine-event-catalog`.
- [State grilling](https://github.com/ZonTin123456/scrape_first/issues/12): URL-scoped Job. Spine `idle→probing→waiting_for_page_selection→scraping→waiting_for_people_review→finalizing→detecting_backend→dry_running→dry_passed→armed→uploading→done`, terminals `failed/cancelled`. CF/CDP orthogonal blockers. Job-ID record. Single-use arm. Single-flight v1.
- [Transport grilling](https://github.com/ZonTin123456/scrape_first/issues/16): SSE-per-Job + POST commands. `job.json` truth. `(jobId,streamId,seq)` cursor. Pointer-only artifacts. No fs/log-parse.
- [Migration grilling](https://github.com/ZonTin123456/scrape_first/issues/13): review-first split, no iframe. Schema+semantics freeze. Engine owns semantics. POST-only save + revision conflict. HTTP-pointer previews. Server-computed warning preview. Retire-builders-at-parity.
- [Characterization task](https://github.com/ZonTin123456/scrape_first/issues/17): 72 `node:test` pins green at `ca7eed1`. Command: `node --test tests/sectioning.test.mjs tests/match.test.mjs tests/guards.test.mjs tests/verify-identity.test.mjs tests/automap-pure.test.mjs tests/dryrun-contract.test.mjs`. Live-browser checklist human-only.
- [Prototype](https://github.com/ZonTin123456/scrape_first/issues/14): KEEP 3-pane + bottom log. Asset `prototype/job-workspace-layout:prototype/job-workspace-prototype.html`. Adjustments: context auto-pins at `dry_passed/armed`; keep bottom log strip; review pane goes wide.

## Architecture target

```
Core Logic (Lift + Wrap cores)
  ^                ^
  CLI adapter      UI adapter (job layer + server + dumb client)
```

- Single process. No `spawnSync` on UI path. No browser fs/Playwright/CDP/engine imports.
- Client: static assets served by same server. Vanilla first per soft lock. No framework until #14/#13 force it.
- Server module importable: `server.mjs:startServer({outDir,port})`. Zero Electron/Tauri APIs.

## Reuse boundary (do not drift)

Lift verbatim:
- `sectioning.mjs` all: `slugBaseOf,newSourceContext,resolveTargetGroup,attachCaptions,buildKept,buildPeople,isDivisionText,inferSection,providerOf,imgSlotKey,IMG_DENY,TEXT_DENY_EXACT,MIN_PX`
- `uploader/lib/match.mjs` scoring: `norm,scorePair,normalizePhone,extractPhones,phoneOverlap,normalizeName,isVacantName,memberScore,matchSection,failBlock`. `keywords()` inject dict.
- `group-guard.mjs`: `sourceUniformityFailure,sourceIdentityFailure,fieldsSatisfy`. `host-gate.mjs`: `mapHostMismatch`. `verify-identity.mjs`: `extractPersonId,verifyPageIdentity` (pass Playwright page through).
- `automap.mjs` pure subset: `loadProfiles,matchProfile,pickDeptRows,buildInventory,classify,fieldMatchesSel,actionFor`. Inject profiles loader. `dumpForm` lifts as evaluate string, executes in page.

Wrap behind job ops:
- `env.preflight`: `resolvePort` + `discoverBackends`.
- `scrape.probeUrl/runUrl`: `navigateAndExtract,downloadQueue,scrapeOne,probeOne` + CF helpers. stdin `waitForEnter` becomes `challenge-blocked` event.
- `review.*`: `buildMasterGroups,applyMaster,suggestOrders,writeReview,finalize,writeSummary`. `--compact-orders` becomes op option.
- `discover.backend`: `automap()` forced ephemeral `write:false`.
- `backend.ensureDepartment`: `createDepartment()`. Fix stale NOT-wired header `target-creation.mjs:1-4` on touch.
- `upload.plan/preflight/executeRow`: `targetGroupOf,deptIndex,resolveGroup,plan,checkFields`, stale-finalize check, creation bootstrap, per-row loop. `console.log` plan becomes `upload:plan` payload. `fail()/process.exit` becomes typed failures.
- `pipeline.dag`: step list `pipeline.mjs:31-32`, flag fan-out, `orderSubs`. `sh()` becomes in-process calls. `pause()` becomes job gate awaiting UI approval. `--yes` becomes `autoApprove` option.

Stays CLI: argv/dispatch/exit/Chrome-launch/HTML builders in `pipeline.mjs,backup-page.mjs,upload-people.mjs,detect.mjs,map-check.mjs`. Data files stay data.

## State record contract

Canonical: `out/<slug>/jobs/<jobId>/job.json` immutable per Job. `out/<slug>/job.json` pointer/projection only. Restart: load record → validate artifacts/fingerprints → reconstruct live projection. Never infer stage from stray files.

Fields: `jobId,source,group,slug,stage,blockers[{type:cloudflare|cdp,at,ctx}],attempts,snapshot_id,dry_run_id,arm:{state: none|armed, attested, typed},ledger[],artifacts[{kind,url,relPath,sha256,byteLength}],fingerprints,created_at,updated_at`.

Rules:
- Retry explicit, `attempts++` + audit, re-enter last safe checkpoint same inputs.
- Resume explicit only. Upload never direct-resume: consumes arm → minimum fresh `dry_running→dry_passed→re-arm`; structural-mutation risk routes `detecting_backend→dry_running→dry_passed→re-arm`.
- Cancel whole-Job idempotent, retains proofs. Non-upload prompt. Upload `stop_requested` → finish current row truthfully → `cancelled`. Consumes arm.
- Fingerprint mutation, guard regression, proof loss invalidates `dry_passed`, disarms to `dry_running`. Any real-upload attempt consumes arm. `failed/cancelled` consume arm. CF/CDP alone preserve arm if snapshot+proof validate.
- `done` never reopens. Same source rerun = new Job.
- Stage policy: scraping image-error allowed; probing/finalizing/detect stage-error blocking; dry guard-red/row-failed blocking, dry-partial amber allowed w/ ledger; upload row-failed/guard-regression blocking, written rows kept truthfully; unclassified blocking by default.
- Single-flight v1: one active engine op globally. Many Jobs may sit in waits.

## Safety contract (UI + CLI both enforce)

Modes: Discover neutral/gray inspect-only. Dry honey/amber fill+screenshot never save/create, writes local report+shots only. Real red fenced danger zone only mode clicking save/creating depts. Names in headings, never color alone.

- `snapshot_id` = deterministic hash `people.json content + selection keep/order + source URL+group + backend origin + dept mapping/plan + mapping/profile versions`. `dry_run_id` = one dry execution against snapshot, excluded from hash. `save_run_id` separate.
- G1: all-green + fresh dry for SAME snapshot else Real disabled. Any material change → re-dry.
- G2: checkbox `I reviewed dry report <dry_run_id> and all <N> screenshots for snapshot <short>` + type exact slug + click. Both mandatory.
- Visibility bundle undroppable: source/group, destination origin, target depts + WOULD-CREATE, identity, unmapped/TBD, partial/skipped/failed counts, per-row table, report+screenshot links. All visible before G2.
- Row policy: any failed = G1 red. Pinned-map WOULD-CREATE/unresolved = blocked. dry-partial amber allowed w/ row warnings. Zero-map WOULD-CREATE = listed path only; real may create then must rediscover + re-gate + verify identity before row writes.
- Proof immutable: `dry_run_id→report+shots` and `save_run_id→report+shots` never overwrite. Save references prerequisite dry. G2 requires dry proof present.
- CLI: interactive prints safety summary + types exact slug. `--yes` = non-interactive confirm only. Never bypasses snapshot freshness, dry prerequisite, group/host/field/identity guards, failed-row policy. Missing/invalid dry proof fails closed even with `--yes`.

## Transport contract (code against this)

- Engine→UI: SSE primary `GET /jobs/:jobId/events`, native EventSource, ephemeral only. GET resync fallback. Missed SSE never correctness failure.
- UI→engine: `POST /jobs/:jobId/commands` returns `{accepted,reason,jobId,commandId}` immediately. Completion via state/event + GET. Client-generated `commandId` idempotency on all mutating commands. Replay returns original disposition, never executes twice. Cancel records intent/audit before ack; transient `stop_requested`; repeated cancel idempotent.
- Envelope: `{v:1,streamId,seq,jobId,type,at,payload}`. SSE `id:<streamId>:<seq>`, `event:<type>`. Dedup `(jobId,streamId,seq)`. Payload notifications/references only, never authoritative state. Unknown type ignorable iff `v` supported. Unknown `v` → resync/compat failure, never silent ignore.
- Cursor `(jobId,streamId,seq)` per-Job scoped to current `streamId`. Bounded in-memory replay ~200/Job v1 starting point, not guarantee. New epoch → new `streamId`. Same `streamId` + buffered → `Last-Event-ID` replay. Unknown/old/purged/restart → `GET /jobs/:id`, reset cursor, reconnect. No fake continuity. `?since=` optional.
- Artifacts pointer-only `{kind,url,relPath?,sha256?,byteLength?}`. `byteLength` = file length, never inline bytes. `sha256` required for safety/audit proofs (dry/save reports+shots); optional for legacy non-proof during migration. HTTP path prefix impl detail.
- One SSE stream per selected Job. No global bus v1. List activity via lightweight GET polling later.
- Ban: no `fs.watch` as transport, no fs polling primary, no terminal-text parse into state. Logs display-only. Emit structured events at authoritative Wrap mutation points.

First event types: `job:advanced,blocker:raised/blocker:cleared,gate:failed,upload:plan,upload:row-finished,upload:report-written,scrape:url-started/url-finished/url-failed,scrape:image-downloaded/image-failed (defer full stream if unneeded),scrape:group-demoted,review:selection-written,review:finalized,artifact:written,arm:granted/arm:consumed,job:resynced`. Payload `kind` catalog grows later.

## Review migration contract

Order: `review/index.html` first → native component for `waiting_for_people_review`. `pick-links,master-pick,pick-images` stay legacy files, migrate after parity proven. No iframe. End-state all four components, never all-at-once.

- Compat schema+semantics, not bytes. Same required fields, key semantics `url/src/seq`, keep/order meaning, master `{generated_at,pages,decisions}`, selection `{seq,file,keep,order}`. Whitespace/key-order/timestamps free unless consumer proves dependence. No parallel format, no schema evolution here.
- Engine/service owns semantics (`src-grouping,keep defaults,anyNamed,suggestOrders,dup-warn/sort/compact,stale-finalize validation`, future normalization). Components render model + submit `keep/order`. Cosmetic/local validation only.
- Save: component→server POST only writer for active workspace Job. Server validates + atomic-writes, emits `artifact:written`, returns revision/fingerprint. Save carries edited-from revision; stale → conflict/reload, never last-wins. Picker/Blob = export/download-copy only. CLI/legacy Jobs keep old flow. Fingerprint validation detects out-of-band disk edits → marks draft stale/disarmed.
- Previews: localhost HTTP artifact pointers only. Never `file://`, never inline bytes. Legacy files keep relative/file behavior until retired.
- Warnings: server-computed non-persisting preview. Submit draft → server runs same shared logic as finalize validation → advisory warnings/derived preview (dup orders, effective sort, stale/mismatch). Preview writes nothing. Submit/finalize reruns authoritative.
- Parity = keep/unkeep, per-image order edit, checked-only bulk assign, engine dup-warn visible, schema-compatible `selection.json`, stale/fingerprint protection, finalize/CLI consumes output unchanged behavior. Behavior+contract, not pixels. Then remove `pickLinksHTML,masterPickHTML,pickImagesHTML,reviewHTML/writeReview` from new-generation paths. Never delete already-generated legacy files.

Preserved behaviors: picker-once-overwrite + Blob fallback; pick-links url-keyed, pick-images seq-keyed; master src-grouping + `--apply-master` fan-out; review keep+order, checked-only bulk, invalid-order→0, dup-allowed+warned + `(order,seq)` sort; stale-finalize check.

## Screen contract (prototype A + adjustments)

Base A: top stepper full spine incl waits + `armed`; left workflow steps; center current step; right source/target/safety/evidence; bottom log strip; 1-sec status pill `MODE+STAGE+BLOCKER` as text.

Adjustments mandatory:
1. Context auto-pins at `dry_passed/armed`. Drawer allowed only before `dry_running`.
2. Keep dedicated bottom log strip. C job-tree idea survives for later multi-Job waits list.
3. Current-step pane goes WIDE at `waiting_for_people_review` (B full-width canvas). 4-up contact sheet cramped at 1/3 width.

Tokens: `#0E0D0B/#15130F/#1C1913`, honey `#F2B84B/#D99A2B/#FFCC66` active/primary/focus/progress only, text `#F4F1E8/#AAA398/#706A61`, muted semantics. Reducer logic in prototype liftable shape; page shell throwaway.

## Implementation phases (each ends green)

Gate every phase: `node --test tests/...` 72 pass 0 fail. Plus CLI smoke: existing `probe/run/finalize/upload --dry` flags unchanged. Live-browser checklist before trusting beyond pure boundary.

P0 scaffold seam:
- Add `server.mjs` `startServer({outDir,port})` serving static + stub `GET /jobs/:id`, `POST /jobs/:jobId/commands`, `GET /jobs/:jobId/events`. No engine import yet. CLI untouched. Tests green.

P1 Lift services (no behavior change):
- Create `services/` pure imports: `sectioning` re-export, `match-core`, `guards`, `identity`, `automap-pure`. Inject `keywords.json` + `profiles/` loaders (follow-on from reuse + characterization notes). CLI files import from services where they already duplicated logic, else leave call sites. `dryrun-contract.test.mjs` static pins must move, not drop. Tests green.

P2 Job record + state machine:
- Implement `jobs/store.mjs`: canonical `out/<slug>/jobs/<jobId>/job.json` read/validate/write, pointer projection, fingerprint `snapshot_id`, `dry_run_id/save_run_id` gen, arm single-use, blockers set, attempts/ledger, stage policy table. Unit-test machine transitions (spine, CF/CDP preserve, disarm rules, cancel/upload semantics) without browser. CLI untouched. Tests green.

P3 Transport:
- Wire SSE per Job + POST commands + `commandId` idempotency + `(streamId,seq)` cursor + ~200 buffer + GET resync. Envelope `v:1`. Pointer-only artifacts with `sha256` for proofs. No fs.watch. No log parse. Tests green.

P4 Engine events at Wrap points:
- Emit start trio + `row-finished` + `artifact:written` behind flag first, terminal/files unchanged. Then `upload:plan,challenge-seen/cleared/blocked,image-downloaded/failed,group-demoted,selection-written,finalized,report-written`. Map emitter sites from observability inventory (`backup-page.mjs:964,312-336,971-985,383-419,430,691-699,750-827,829-842`; `upload-people.mjs:221-256,309-450,480-483`; `pipeline.mjs:57-66,126-127`). Tests green.

P5 Review-first component:
- Build `waiting_for_people_review` wide component per migration contract: keep by `seq`, order input invalid→0, checked-only bulk, dup allowed+warned, `(order,seq)` sort preview, POST-only save rev bump, stale→conflict, HTTP-pointer thumbs, server warning preview. Legacy builders stay until parity proven. Tests green + finalize/CLI consumes component output unchanged.

P6 Safety UI + upload:
- Discover/dry/real trinity screens, visibility bundle, G1/G2 flow, attestation exact copy, typed slug, fenced red danger zone, separate dry/save proof links. Wire `detecting_backend→dry_running→dry_passed→armed→uploading→done|failed`. Enforce snapshot/dry/arm ids, disarm rules, row policy. CLI `--save/--i-verified/--yes` prerequisites unchanged. Tests green.

P7 Pipeline DAG as job ops:
- Replace `spawnSync/pause` with in-process job calls + approval events. Preserve `pipeline.mjs --from --steps --order --yes` CLI adapter over same DAG. Preserve `backup-page` + `upload-people` CLIs. Staging files (`picked-links.json,master.json,<slug>/picked-images.json,content.json,review/selection.json,people.json,summary.json,report-<slug>.json,shots/`) remain contract. Tests green.

P8 Hardening/acceptance:
- Single-flight enforcement, restart load+validate, two-tab conflict, stream restart epoch, guard regression disarm, arm single-use attempt, dry-partial amber ledger, upload stop_requested path. Thai error copy + per-step retry UX (fog graduate, impl detail). Packaging still deferred.

## Acceptance to declare done

- All 72 pins green on final branch. No pin deleted, only moved with logic.
- CLI parity: `pipeline --from --steps probe,pick-links,master,apply-master,run,pick-images,finalize,upload`, `backup-page --probe/--run/--finalize`, `upload-people --dry/--save` behave as before for file-based flows.
- Job Workspace happy path + 5 prototype walkthroughs pass: happy, CF-preserves-arm, dry-partial amber, guard-red blocks, arm single-use.
- Review parity checklist met. Builders retired only at parity.
- Safety G1/G2 enforced in UI + CLI. Proofs immutable + linked. `sha256` on dry/save reports+shots.
- Transport: kill SSE mid-upload → GET resync heals, no state inferred from logs. Restart server → new `streamId`, client resyncs, no fake continuity. Replay `commandId` → no double arm/upload.
- Out-of-scope respected: no cloud/multi-user/auth/remote farm/analytics/billing/mobile; no mirror-offline/non-CDP/batch-semantics change; no pixel spec from human-pick map.

## True-contradiction rule

Implement as above. Stop only if code proves lock impossible (e.g. Wrap core cannot shed argv without behavior loss, `sha256` proof breaks legacy artifact, Job-ID record collides with existing `out/<slug>` consumers). Then surface file:line evidence + failing pin, do not silently override.