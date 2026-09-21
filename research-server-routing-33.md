# Research #33 — Server static + job routes for multi-page deep links

Source: primary code only — `server.mjs` (821 lines, `serveStatic` ll.45-84, `handleWith` ll.198-724, `CLIENT_DIR` l.24), `web/index.html` (825 lines, single shell), `tests/server-seam.test.mjs`. Live-probe verified 2026-09-20 against `startServer({port:0})` (empty outDir + one `POST /jobs` job). Part of map #31. No engine/safety semantics reopened.

## `serveStatic` today (`server.mjs:45-84`)

- `CLIENT_DIR = join(dirname(server.mjs), "web")` (l.24). Only file present: `web/index.html`.
- `pathname === "/"` → `/index.html`; else `decodeURIComponent(pathname)` (400 `bad path` on bad encoding).
- `normalize(join(CLIENT_DIR, rel))` + traversal guard: `relative(CLIENT_DIR, file)` starts with `..` or is absolute → 403 `forbidden` (ll.54-60).
- Directory → `index.html` inside it; missing → 404 `text/plain "not found"` (ll.62-73). No SPA fallback, no `Accept` check.
- Serves bytes with `MIME[ext]` (html/js/css/json/txt/svg/png, else octet-stream), supports `HEAD` (ll.74-79).

## Route order today (`handleWith`, `server.mjs:198-724`)

Order matters — first regex match wins:

| # | Pattern (`server.mjs`) | Methods | Response |
|---|---|---|---|
| 1 | `^/jobs/([^/]+)/review/thumbs/([^/]+)$` (l.205) | GET only, else 405 | PNG/file bytes 200, or JSON 404 (`job not found` / `thumb not found`) |
| 2 | `^/jobs/([^/]+)/review/preview$` (l.240) | POST only, else 405 | JSON `{persisted:false, warnings, duplicates, effectiveOrder}`; writes nothing |
| 3 | `^/jobs/([^/]+)/review/warnings$` (l.275) | GET only, else 405 | JSON `{revision, fingerprint, stale, warnings, duplicates, effectiveOrder}` |
| 4 | `^/jobs/([^/]+)/review$` (l.306) | GET → model; POST → save; else 405 | GET JSON `{revision, fingerprint, stale, selection, thumbs[]}`; POST `{selection, editedFrom}` → 200/400/409 `stale-conflict` |
| 5 | `^/jobs/([^/]+)/safety$` (l.422) | GET only, else 405 | JSON `safetyModel()` (read-only; mutations via commands) |
| 6 | `^/jobs/([^/]+)/pages$` (l.451) | GET → model; POST → save; else 405 | GET `{pending, links, master}`; POST `{links, images}` merge-by-key |
| 7 | `^/jobs/([^/]+)/commands$` (l.507) | POST only, else 405 `{accepted:false}` | `commands.execute()` disposition `{accepted, reason, commandId}` |
| 8 | `^/jobs/([^/]+)/events$` (l.544) | GET only, else 405 | SSE `text/event-stream`; `?once=1`/`?live=0` or unknown job → finite; else live stream + replay via `Last-Event-ID`/`?since=` |
| 9 | `path === "/jobs"` GET\|HEAD (l.629) | list | JSON `{jobs: listJobs(outDir)}` |
| 10 | `path === "/jobs"` POST (l.638) | create | JSON `{job, jobId, created}` 201 (or 200 idempotent replay); 400/409 on bad input |
| 11 | `^/jobs/([^/]+)$` (l.695) | GET only, else 405 | JSON `{job}` or 404 `{job:null, jobId, error:not-found}` |
| 12 | GET\|HEAD → `serveStatic(path)` (l.719) | static fallback | `web/*` file or 404 text/plain |
| 13 | else (l.723) | non-GET/HEAD unknown | JSON 404 `{error: not-found, unknown route}` |

Notes: routing uses `new URL(req.url).pathname` — query strings ignored for match. Thumbs intentionally first (generic `/review` must not swallow `/review/thumbs/:seq`). SSE (8) emits `job:resynced(reason=stream-open)` even for unknown jobs, then closes (finite) — verified live.

## Deep-link resolution today (live-probe verified)

Only UI route that works today is `/` (+ `?jobId=` query the client already reads, `index.html:387-388`).

| Deep link | Unknown job (`/jobs/abc/...`) | Real job (created via `POST /jobs`) | Verdict |
|---|---|---|---|
| `/` | 200 `text/html` index.html | same | OK — only working entry |
| `/jobs/:id` | 404 JSON `{job:null, error:not-found}` (route 11) | 200 JSON `{job}` (route 11), even with `Accept: text/html` | BROKEN for UI — browser nav gets JSON, never HTML |
| `/jobs/:id/pages` | 404 JSON `{error:not-found}` (route 6) | 200 JSON pages model (route 6), `?x=1` same | BROKEN — API collision, no HTML |
| `/jobs/:id/review` | 404 JSON (route 4) | 200 JSON review model (route 4) | BROKEN — same collision |
| `/jobs/:id/safety` | 404 JSON (route 5) | 200 JSON safety model (route 5) | BROKEN — same collision |
| `/jobs/:id/review/` (trailing slash) | 404 `text/plain "not found"` (falls to 12, no file) | same 404 text/plain | BROKEN differently — static 404, not API |
| `/jobs/:id/events` | 200 SSE finite `job:resynced` | 200 SSE (live or `?once=1` finite) | OK — must NOT be swallowed by SPA fallback |
| `/nope` | 404 `text/plain "not found"` (route 12) | — | static 404 baseline |

So: 4 of 5 wanted UI links collide with JSON API (exact-segment match wins before static); trailing-slash variants miss the regex and die as static 404. `Accept: text/html` currently ignored (probe: same JSON). No per-route HTML files exist and jobIds are dynamic, so disk files can't cover them.

## Recommended minimal delta (single HTML + client router, Accept-gated)

**Decision: keep one `web/index.html`, add client router on pathname, add one Accept-gated SPA intercept on the server. Reject per-route HTML and per-page HTML files** (dynamic jobIds, duplication, stale-drift; `?jobId=` query already proves single-shell works).

Server delta (~10 lines, no new deps, static-linkage safe):

1. Insert SPA intercept at top of `handleWith`, BEFORE thumbs route (l.204):
   - Condition: `(req.method === "GET" || req.method === "HEAD")` AND `String(req.headers.accept || "").includes("text/html")` AND `pathname` matches `^/jobs/[^/]+(/(pages|review|safety))?/?$` (allow optional trailing slash).
   - Action: `serveStatic(req, res, "/index.html"); return;`
   - Everything else falls through untouched.
2. Client: parse `location.pathname` (`/jobs/:id`, `/jobs/:id/{pages,review,safety}`) on load + `popstate`, reuse existing `loadReview/loadPages/loadSafety/tickStatus/connectLog`; keep `?jobId=` as legacy alias; all fetches stay absolute (`/jobs/...`) so deep paths don't break asset/API resolution. No `<base>` change needed (no relative assets today — inline CSS/JS only).
3. Tests to add with the change: browser-nav (`Accept: text/html`) on all 5 links → 200 html; API (`Accept: */*` / no header, as `fetch`/`curl` send) → JSON unchanged; `POST /jobs/:id/review` etc. unaffected; `GET /events` (`Accept: text/event-stream`) stays SSE; thumbs (`Accept: image/*`) stay bytes; traversal guard + `HEAD` preserved.

Why this shape:

- `GET /jobs/:id` JSON stays unambiguous: `fetch` (client `tickStatus`, tests) sends `Accept: */*` → JSON; only browser navigation (`Accept: text/html,...`) → HTML. Verified today both send JSON; after change only the HTML-preferring branch diverts. `curl` default (`*/*`) unaffected → CLI safe.
- `/pages|review|safety` JSON stays default for API clients for the same reason; no method/path change, only an `Accept`-gated pre-branch. `POST` never diverted (GET/HEAD only).
- Thumbs/base-URL: thumbs path not in SPA set + `Accept: image/*` → never diverted; absolute `thumbsFor` URLs (`server.mjs:109-116`) unaffected.
- SSE: `/events` not in SPA set and `Accept: text/event-stream` lacks `text/html` → never diverted; `?once=1`/`?live=0`/unknown-job finite path untouched.
- Trailing slash: regex `/?$` covers `/review/` so it serves HTML instead of today's static 404; API keeps exact-match (no slash) so `POST .../review/` still 404 as today — no silent widening.
- Static linkage: no new imports; `serveStatic` reuse keeps traversal/MIME/HEAD semantics.

Rejected: unconditional SPA fallback (no `Accept` gate) would hijack `curl`/API `GET /jobs/:id` → HTML and break `server-seam.test.mjs:79-86` + CLI; per-route/per-page HTML files can't cover dynamic jobIds and fork the shell.

## Files to touch when implemented (not in this research commit)

- `server.mjs` — SPA intercept (~10 lines before l.205).
- `web/index.html` — pathname router (~30 lines; derive from existing `?jobId=` block l.387).
- `tests/server-seam.test.mjs` (or new `tests/server-routing.test.mjs`) — Accept-matrix tests above.
