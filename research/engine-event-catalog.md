# Research: engine observability inventory + structured event catalog sketch

Ticket: Inventory engine observability into structured event protocol basis (research) — #19, part of #10.
Branch: `research/engine-event-catalog`. Verified against code 2026-09-18 (backup-page.mjs v1.3.0).

## 1. What engine emits today (inventory)

All human-readable terminal text or batch JSON files. No event bus, no jobId, no per-URL progress stream.

### 1.1 Terminal (parse-only signals)

**pipeline.mjs**
- `$ node <args>` echo per step — `sh()` pipeline.mjs:58. Only step-boundary marker.
- Human pauses (stdin block): pick-links / master / pick-images Thai prompts + `--yes` skip line — `pause()` pipeline.mjs:62-66.
- `upload: warn: --order token "x" matches nothing` — pipeline.mjs:78.
- `finalize: skip <dir> (no review/selection.json ...)` — pipeline.mjs:116.
- `upload queue:` + `  N. <slug> (<n> rows) <<url>>` per row — pipeline.mjs:126-127. Only per-slug upload progress signal.
- `upload: skip <dir> (no people.json)` — pipeline.mjs:130.
- `pipeline: done.` — pipeline.mjs:135.
- `pipeline: <msg>` on stderr + exit 1 — `fail()` pipeline.mjs:20.

**backup-page.mjs**
- `CDP: using 127.0.0.1:<port>` — backup-page.mjs:122.
- `backup-page: warning: connected Chrome looks headless ...` stderr — backup-page.mjs:111.
- `backup-page: Cloudflare challenge still up for <url>` + `solve Turnstile ... press Enter` stderr + stdin wait — backup-page.mjs:324-327 (`waitForChallengeClear`, `waitForEnter`).
- `backup-page: image via=cdp (flag|cloudflare wall seen)` stderr — backup-page.mjs:381 (`downloadQueue`).
- `group-integrity: <url> seq=<n> previous=<p> demoted-division=<d> kept=<s> (<reason>)` stderr per demoted image — backup-page.mjs:430 (`scrapeOne`).
- `apply-master: ...` lines: `0 decisions`, `skip <slug> (no/unreadable picked-images.json)`, `<slug>: <up> updated, <keep>/<n> kept`, `done — <up> updated, <keep> kept` — backup-page.mjs:644-672.
- `finalize: compacted orders ...`, `finalize: warn: duplicate orders: ...`, `finalized <dir>: kept <i> images, removed <r>` — backup-page.mjs:807-826 (`finalize`).
- `regen-review <d>: <n> candidates` — backup-page.mjs:864.
- `page sections: <n> rules from <file>` — backup-page.mjs:903.
- Single-URL hint: `<dir>` + `review: <n> candidates in review/ — ...` — backup-page.mjs:979-980.
- `probe done: open <master-pick.html> — ...` — backup-page.mjs:1006.
- Per-URL end-of-batch only: `OK <url> -> <dir>` / `FAIL <url> :: <error>` + `summary: <path>` — `writeSummary()` backup-page.mjs:829-842. Exit code 1 if any `r.error` — backup-page.mjs:1009.

**uploader/upload-people.mjs** (default `--dry`, screenshots but never save)
- `backend auto-discovered: <host>`, `using detected map <path> - REVIEW it before --save`, `no --map: auto-detecting <host> ...`, `auto-detect: <profile|full-classify> (<n> sections)`, `empty backend (0 departments discovered): deferring field check ...` — upload-people.mjs:63-213.
- Stale-finalize gate: `warn: no review/selection.json — check skipped`, or `upload-people: REFUSING stale finalize output:` + up to 15 `  - <issue>` stderr, or `warn: ignoring <n> ... (--ignore-selection-check)` — upload-people.mjs:106-139.
- `target resolution skipped (--to ...)` — upload-people.mjs:232.
- Dry plan block: `dry-run plan: <n> group(s) would be CREATED ...` + `  - WOULD-CREATE department "<g>"`, `upload plan (dry, no writes):` + `  - group "<g>" -> <target|WOULD-CREATE>`, `  rows: <n> total (see report for per-row status)` — upload-people.mjs:244-254.
- Save path: `creating department "<g>" ...`, `created department "<g>" -> <url> (backend id <id>)`, `re-discovering backend after creation ...`, `re-discovery ok (<n> departments), all rows resolved` — upload-people.mjs:266-306.
- End-of-run only: `mode=<dry|save> total=<n> {status:count}`, `report: <path>` — upload-people.mjs:482-483. Exit 1 if any row `failed` — upload-people.mjs:484-486.

### 1.2 Batch JSON files (post-hoc, no streaming)

- `out/summary.json` (run) / `out/_staging/summary.json` (probe) — `writeSummary()` backup-page.mjs:829-835: `{generated_at, extractor_version, total, ok, failed, results[]}`. Run row: `{url, slug, dir, title, counts, candidates, people}` or `{url, error}`. Probe row: `{url, slug, dir, title, counts, images}` or `{url, error}`. Written once at end (multi-URL only: `fromFile || urlList.length > 1`, backup-page.mjs:1008).
- `out/<slug>/content.json` manifest: `{source_url, source_title, captured_at, extractor_version, counts{text,image,placeholder,iframe-sameorigin,cut,imgErrors,people}, rules[], picked?, reviewed?, reviewed_at?, order_overrides?, order_compacted?}` — `scrapeOne` backup-page.mjs:446-451 + `finalize` backup-page.mjs:774-823.
- `out/<slug>/people.json` rows: `{seq, order, photo, name, position, phone, note, section, section_from, group_warn, section_evidence, likely_header, vacant, width, height, alt, source_url, source_group}` — `buildPeople` sectioning.mjs:278-294.
- `out/_staging/<slug>/probe.json`: `{source_url, source_title, captured_at, extractor_version, slug, counts, images[{seq,src,width,height,top,alt,caption,phone,note,section,likely_header,vacant}], people_preview[0..5], texts_preview[0..8]}` — `probeOne` backup-page.mjs:475-479. Plus `picked-links.json`, `picked-images.json`, `master.json {generated_at, extractor_version, pages, decisions[{src,keep}]}`, `review/selection.json [{seq,file,keep,order}]`.
- `uploader/report-<slug>.json`: `{generated_at, mode: dry|save, backend, from, slug, total, by_status, plan[{group, action: upload|would-create|created, target, via}], results[{seq, order, name, status, detail, group, form}]}` — upload-people.mjs:472-481. Code statuses: `failed | skip-would-create | dry | dry-partial | created | created-partial` (upload-people.mjs:319-444). On disk (33 reports): only `created: 296, failed: 2`.
- `uploader/shots/<slug>/<order:03d>-seq<seq>.png` per processed row (dry and save); path embedded only as `shot: <abs path>` inside report `results[].detail` — upload-people.mjs:426-429. No manifest; directory listing is the index.

### 1.3 Per-URL progress signals (asked: queued/loading/challenge/downloading/completed/failed)

They do not exist as structured data. Today:
- queued/loading: implicit loop order in `for (const url of urlList)` backup-page.mjs:964 — no emission.
- challenge: ephemeral `c._cfChallenge` flag (backup-page.mjs:343, 380) + stderr lines above; never persisted.
- downloading: silent per-image loop in `downloadQueue` backup-page.mjs:383-419; only aggregate `imgErrors` in manifest counts.
- completed/failed: terminal `OK/FAIL` + `summary.json results[]` + process exit code. Nothing per-image or per-row until the final file write.

## 2. Proposed minimal event catalog (sketch)

Envelope (new; no jobId exists today — propose `jobId = <ISO-timestamp>-<pid>` created by pipeline, passed as `--job` to children): `{v: 1, jobId, step: probe|run|finalize|upload, url?, slug?, seq?, current?, total?, at, message?}`. Transport undecided (see #16); smallest viable is NDJSON lines on stdout alongside existing text, files unchanged.

| Event | Payload (beyond envelope) | Emitter site |
|---|---|---|
| `pipeline:step-started` / `pipeline:step-finished` | `step, ok, error?` | `sh()` pipeline.mjs:57-61 (wrap existing `$ node` echo) |
| `pipeline:pause-waiting` / `pipeline:pause-skipped` | `gate: pick-links\|master\|pick-images` | `pause()` pipeline.mjs:62-66 |
| `pipeline:upload-queue` | `queue: [{slug, url, rows}]` (replaces parsing `upload queue:` block) | pipeline.mjs:126-127 |
| `scrape:url-started` | `url, slug, index, total` | per-URL loop head backup-page.mjs:964-970 |
| `scrape:challenge-seen` / `scrape:challenge-cleared` / `scrape:challenge-blocked` | `url, waited_s` | `waitForChallengeClear` backup-page.mjs:312-336 |
| `scrape:url-finished` | `url, slug, dir, title, counts` | `results.push` after `probeOne`/`scrapeOne` backup-page.mjs:971-977 |
| `scrape:url-failed` | `url, error` (replaces parsing `FAIL`) | catch backup-page.mjs:983-985 + `writeSummary` backup-page.mjs:836-839 |
| `scrape:image-downloaded` | `url, slug, seq, current, total, file, bytes, via: fetch\|cdp` | success branch `downloadQueue` backup-page.mjs:411-417 |
| `scrape:image-failed` | `url, slug, seq, error, via` | error branch backup-page.mjs:411 |
| `scrape:group-demoted` | `url, slug, seq, previous, demoted, kept, reason` (replaces stderr parse) | `group-integrity` line backup-page.mjs:430 |
| `review:selection-written` | `slug, dir, candidates` | `writeReview` backup-page.mjs:691-699 |
| `review:finalized` | `slug, dir, kept, removed, order_compacted?, duplicate_orders?` | `finalize` backup-page.mjs:750-827 |
| `upload:plan` | `slug, plan[{group, action, target}]` (replaces dry-plan text parse) | plan block upload-people.mjs:221-256 |
| `upload:row-finished` | `slug, seq, order, name, status: dry\|dry-partial\|skip-would-create\|created\|created-partial\|failed, form?, shot?` | per-row push upload-people.mjs:309-450 |
| `upload:report-written` | `slug, mode, total, by_status, reportPath` | report write upload-people.mjs:480-483 |
| `artifact:written` | `kind: summary\|content\|people\|probe\|report\|shot\|selection, path` | `writeSummary` backup-page.mjs:835, `scrapeOne` writes backup-page.mjs:453-455, `probeOne` writes backup-page.mjs:479-484, report write upload-people.mjs:481, screenshot upload-people.mjs:427 |

Explicit non-events: human tick HTML pages (`pick-links.html`, `pick-images.html`, `master-pick.html`, `review/index.html`) stay file-based; emit only the applied result (`apply-master` totals backup-page.mjs:670-672 already covered by `artifact:written`). Per-row `duplicate`/`unmapped`/`partial` notes stay inside `upload:row-finished.detail`, not separate events.

## 3. Suggested next step for map driver

Keep terminal + file outputs as-is; add NDJSON emitter behind a flag (e.g. `--emit-events ndjson`) starting with `scrape:url-started/finished/failed` + `upload:row-finished` + `artifact:written` — the three that unblock a UI progress view without touching scrape logic. Full `scrape:image-*` per-image stream follows only if UI needs live download bars (#16 transport decision first).
