# Research #32 — Single-page UI bindings to backend contracts

Source: primary code only — `web/index.html` (825 lines, inline `<script>` ~ll.191-822),
`server.mjs` (821 lines, `handleWith`), `jobs/commands.mjs`, `jobs/events.mjs`,
`jobs/store.mjs` (SPINE), `jobs/pipeline.mjs` (`UI_STEP_STAGES`, `startUiStep`/`runUiStepSync`),
`jobs/review.mjs`, `jobs/pages.mjs`, `jobs/safety.mjs`.
No IA proposal here — fact base for later IA/migration tickets (map #31).

## Contract summary (server authority)

- SPINE (`jobs/store.mjs:8-21`, mirrored in client `SPINE` const `index.html:193`):
  `idle → probing → waiting_for_page_selection → scraping → waiting_for_people_review → finalizing → detecting_backend → dry_running → dry_passed → armed → uploading → done` + terminals `failed, cancelled`.
- `UI_STEP_STAGES` (`jobs/pipeline.mjs:625-631`): `probe→probing`, `approve-page→scraping`, `scrape→scraping`, `finalize→finalizing`, `detect→detecting_backend`.
- Commands (`jobs/commands.mjs:14 SUPPORTED`): `cancel advance retry resume artifact dry arm begin-upload finish-row probe approve-page scrape finalize detect run-step`.
  Client uses subset: `probe approve-page scrape finalize detect retry resume cancel dry arm begin-upload`.
  `ENGINE_OPS` single-flight (`commands.mjs:22`): `dry arm begin-upload probe scrape finalize detect run-step` refused transiently (`single-flight`, never cached) while engine op held; `cancel/finish-row/review/approve-page` never gated.
- Idempotency: client `newCommandId()` (`index.html:416-418`, `cmd_<time36>_<rand36>`) → `POST /jobs/:id/commands {commandId,type,payload}` → persisted `commands.json` (cap 500, `commands.mjs:38-69`), replay returns original disposition.
- Review (`jobs/review.mjs`, `server.mjs:239-416`): `GET review` model `{revision,fingerprint,stale,staleReason,selection,effectiveOrder,warnings,duplicates,thumbs}`, `POST review {selection,editedFrom}` POST-only writer (409 `stale-conflict` + reload, never last-wins), `POST review/preview` non-persisting (same `buildWarningPreview`), `GET review/warnings` (client does NOT call it), `GET review/thumbs/:seq` HTTP-pointer only (never `file://`/`data:`).
- Pages (`jobs/pages.mjs`, `server.mjs:450-505`): `GET pages → {pending,links,master}` (`pending:true` = no probe yet), `POST pages {links:[{url,keep}],images:{slug:[{seq,keep}]}}` merges by key, ledger `pages:saved`, emits `job:advanced` + `artifact:written(kind=picked-links)`.
- Safety (`jobs/safety.mjs`, `server.mjs:422-444` + commands): `GET safety → safetyModel {bundle(10 undroppable sections),gate1{ok,reasons,warnings,verifyReasons},gate2{attestation,armed},stage}` read-only; mutations only via commands `dry→dry_passed` (`artifact:written dry-report`), `arm→armed` (`arm:granted`/`gate:failed`), `begin-upload→uploading` (consumes single-use arm, `arm:consumed` + `save-report`).
- Events (`jobs/events.mjs`, `server.mjs:544-627`): `GET /jobs/:id/events` SSE envelope `v:1 {v,streamId,seq,jobId,type,at,payload}`, `id: <streamId>:<seq>`, `event: <type>`, buffer 200, replay via `Last-Event-ID`/`?since=`, `job:resynced` on reset/epoch-change, `?once=1`/`?live=0` finite. Known types incl. `job:advanced job:resynced gate:failed arm:granted arm:consumed review:selection-written review:finalized artifact:written`.
- Jobs CRUD (`server.mjs:629-717`): `GET /jobs` (list via `listJobs`, corrupt skipped), `POST /jobs {source,group?,slug?,jobId?}` (slug defaults via `slugFromSource`, idempotent by explicit `jobId`, 409 on conflict), `GET /jobs/:id → {job}` (job carries `stage blockers ledger`).
- Static: `GET /` → `web/index.html` via `serveStatic`.

## Full inventory: UI element → route/command/event → stage relevance

| # | UI element (`web/index.html`) | Backend contract (route / command / event) | Job-stage relevance |
|---|---|---|---|
| 1 | `#job-id` input + `#load-btn` "Load review" (l.374,300) | `GET /jobs/:id` (status) + `GET /jobs/:id/review` (model) + `connectLog()` SSE + `tickStatus()`; `?jobId=` deep-link auto-load (l.387) | Any; review meaningful at `waiting_for_people_review`/`finalizing` |
| 2 | `#safety-btn` "Load safety" (l.375) | `GET /jobs/:id` + `GET /jobs/:id/safety` → `renderSafety` + `gateButtons` | `detecting_backend`→`done`; bundle pending before first dry |
| 3 | `#rev-label` (l.77,264) | `review` model `revision/stale` display only | `waiting_for_people_review` (stale-conflict UX) |
| 4 | `#src-url #src-slug #src-group` + `#create-btn` (l.443) | `POST /jobs {source,slug?,group}` → 201 `{job,jobId}` + `job:advanced(created)` | Creates `idle` job |
| 5 | `#jobs-btn` "List jobs" (l.469) | `GET /jobs` → `{jobs:[pointer]}`; logs `jobId@stage` | Any (workspace navigation) |
| 6 | `#probe-btn` "Probe" (l.624) | `POST …/commands {type:probe}` → `startUiStep` bg (`accepted:started`) → `pollBgDone` ledger `pipeline:finished/failed/superseded` + `GET /jobs/:id` + SSE `job:advanced` | `idle`→`probing`→`waiting_for_page_selection` |
| 7 | `#approve-btn` "Approve pages" (l.625) | `POST …/commands {type:approve-page}` → `runUiStepSync` sync (`page-approved`/`already-past`) | Human gate `waiting_for_page_selection`→`scraping` |
| 8 | `#scrape-btn` "Scrape" (l.626) | `POST …/commands {type:scrape}` → bg `started` → ledger poll | `scraping`→`waiting_for_people_review` |
| 9 | `#finalize-btn` "Finalize" (l.627) | `POST …/commands {type:finalize}` → sync (`finalized`) via review validation | `waiting_for_people_review`→`finalizing` |
| 10 | `#detect-btn` "Detect" (l.628) | `POST …/commands {type:detect}` → bg `started` → ledger poll | `finalizing`→`detecting_backend`→`dry_running` |
| 11 | `#retry-to` select (SPINE options, l.432) + `#retry-btn` (l.630) | `POST …/commands {type:retry,{to,reason:"ui retry"}}` → `store.retry` | Any non-terminal; backward moves (terminals never reopen) |
| 12 | `#resume-btn` (l.634) | `POST …/commands {type:resume,{reason}}` → `store.resume` | Blocked/failed resume |
| 13 | `#cancel-btn` (l.635) | `POST …/commands {type:cancel,{prompted:true,reason}}` → `requestCancel` → `cancelled`/`stop_requested` + `job:advanced` | Any; stop path |
| 14 | `#mode-bar .mode[data-mode]` discover/dry/real (l.637) | **Client-only** `state.safetyMode`; no route. Feeds `gateButtons()` + `status-pill` | discover: all (inspect); dry: `dry_running`; real: `dry_passed`/`armed` |
| 15 | `#pages-load-btn` / `#pages-reload-btn` (l.620) | `GET /jobs/:id/pages` → `renderPages`; 404 = job not found | `waiting_for_page_selection` (`pending` = probe first) |
| 16 | `#pages-save-btn` "Save pages (POST only)" (l.622) | `POST /jobs/:id/pages {links,images}` → `{links,imageUpdates}` + `pages:saved` ledger + `job:advanced` + `artifact:written(picked-links)`; then `loadPages+tickStatus` | `waiting_for_page_selection`, before Approve |
| 17 | `#pages-table` keep checkboxes `data-plink` + `#pages-images` `data-pslug/data-pseq` (l.538-588) | Shaped into POST #16 payload only; counts from `probe.json` via `pages.mjs:probeInfo` | Same as #16 |
| 18 | `#cards` keep `data-seq` + order `data-ord` + `collect()`/`ordOf()` (l.252-286) | Shaped into review POST/preview payloads; thumbs `model.thumbs[].url` → `<img src>` | `waiting_for_people_review` |
| 19 | `#preview-btn` "Warning preview" (l.314) | `POST /jobs/:id/review/preview {selection}` → `{duplicates,effectiveOrder,warnings}`; writes nothing | `waiting_for_people_review`/`finalizing` |
| 20 | `#save-btn` "Save (POST only)" (l.329) | `POST /jobs/:id/review {selection,editedFrom}` → `{revision,fingerprint,…}` or 409 `stale-conflict` → auto `loadReview()` (never last-wins) + `review:selection-written` + `artifact:written(selection)` | `waiting_for_people_review` |
| 21 | `#reload-btn` (l.376) | `GET /jobs/:id/review` | Same as #20 (conflict recovery) |
| 22 | `#bulk-ord` + `#bulk-set` (l.379) | **Client-only** DOM write to checked rows' order inputs | `waiting_for_people_review` convenience |
| 23 | `#dup-warn #sort-preview` (l.289) | Render `duplicates/effectiveOrder/warnings` from GET model or preview response | Same as #20 |
| 24 | Thumb `<img>` per card (l.273-277) | `GET /jobs/:id/review/thumbs/:seq` (server `resolveThumbFile` candidates; 404 if missing/unreadable); pointer-only, `loading=lazy` | `waiting_for_people_review` |
| 25 | `#bundle-grid` 10 sections (l.719-737) | `GET safety` → `bundle{source,group,destinationOrigin,targetDepts,wouldCreate,identity,unmapped,counts,rows,proofs}`; missing bundle = loud `pending — no dry yet` | `dry_running` onward |
| 26 | `#row-table #row-body` (l.738) | Same bundle `rows[{seq,name,group,target,status,detail}]` | Same as #25 |
| 27 | `#g1-list` (l.749) | `gate1{ok,reasons,warnings,verifyReasons}` (server `evaluateRowPolicy` + guard + snapshot) | Gate to `dry_passed`; red blocks Real |
| 28 | `#dry-input` + `#dry-btn` (l.787) | `POST …/commands {type:dry, payload:JSON.parse(dry-input)}` → `recordDryPass` → `dry_passed` + `dry-report` artifact; disabled unless mode=dry (`gateButtons`) | `dry_running`→`dry_passed` |
| 29 | `#g2-text #g2-check #g2-slug #arm-btn` (l.803) | `POST …/commands {type:arm,{attestedText(iff checked),typed,clicked:true}}` → `grantArmFromSafety` → `armed` (`arm:granted`) or `gate:failed(G1/G2)`; disabled unless mode=real **and** live G1 ok | `dry_passed`→`armed` (single-use) |
| 30 | `#upload-btn` (l.815) | `POST …/commands {type:begin-upload,{}}` → `beginUploadWithProof` (consumes arm even on failure) → `uploading` + `arm:consumed` + `save-report`; same real+G1 gate | `armed`→`uploading`→`done` |
| 31 | `#proof-list` (l.778) | `bundle.proofs[{kind,relPath/url,sha256,byteLength}]` immutable dry/save reports | `dry_passed` onward (restart re-verified) |
| 32 | `tickStatus()` 1s poll (l.229) | `GET /jobs/:id` → `status-pill "MODE x · STAGE y · BLOCKER z"`, `setStage`, `updatePin`, `gateButtons`, `ctx-source` | All stages (authoritative resync under SSE) |
| 33 | `connectLog()` EventSource (l.352) | `GET /jobs/:id/events` SSE; `onmessage` + `artifact:written` + `review:selection-written` → `#log-strip`; `onerror` ignored (GET resync heals) | All stages |
| 34 | `driveStep()` + `pollBgDone(cmd,240s,2s)` (l.477-520) | Ledger filter `state.job.ledger[]` by `commandId` for `pipeline:finished/failed/superseded`; then `tickStatus` | bg `probe/scrape/detect` completion UX |
| 35 | `#stepper #workflow-list body[data-stage] #step-title` (l.203-227) | Render `job.stage` (SPINE + terminals); wide layout at `waiting_for_people_review` | All stages |
| 36 | `#ctx-toggle` + `updatePin()` (l.648-669) | **Client policy** on `job.stage`: auto-pin `dry_passed`/`armed`, drawer allowed only before `dry_running`; `body[data-pinned]`, `ctx-pin-note` | `dry_running`→`armed` context lock |
| 37 | `#ctx-source #ctx-safety #ctx-evidence #pane-context` + `#log-strip` (200-line cap, l.365) | `job{source,group,slug}` display + SSE/log lines; safety/evidence filled from safety/review models | All stages |

## Dumb-client audit (engine logic in client?)

**Verdict: no engine-authority violation found. Server re-validates every mutation fail-closed.**
Cosmetic duplications to carry into redesign (drift risks, not authority bugs):

- `ordOf()` (`index.html:197`) coerces invalid order → 0. Mirrors server `coerceOrder` (`jobs/review.mjs:15`) but header-commented "Cosmetic/local only: invalid coerces to 0. Server reruns authoritative." Keep pattern: client may pre-format, server decides.
- `gateButtons()` (`index.html:672`) disables dry/arm/upload by mode+G1. Comment states "Client-side mode gating (server re-enforces G1/G2 regardless)". Defense-in-depth only; redesign must keep `recordDryPass`/`grantArmFromSafety`/`beginUploadWithProof` as sole gate.
- `updatePin()` stage-order array (`index.html:652`) duplicates SPINE to enforce drawer-before-`dry_running`. UI policy only; suggest deriving from server stage enum in multi-page IA.
- `pollBgDone()` filters ledger — read-only wait on server-written `pipeline:*` entries; no transition decided client-side.
- `DRY_TEMPLATE` (`index.html:392`, `backend.invalid` demo) is a dev fill-in; server validates snapshot/rows/guard fail-closed. Do not treat as contract.
- Client `SPINE` const + `initRetryTargets` + `updatePin` order = 3 copies of stage list; `retry-to` offers even illegal targets and relies on server `retry` fail-closed. Redesign: single stage source or server-driven options.
- Unused-by-UI (do NOT drop server-side): `GET review/warnings`, commands `advance artifact finish-row run-step`, events `blocker:* challenge:* scrape:* upload:* job:retry`.
