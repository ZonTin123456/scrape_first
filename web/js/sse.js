// sse.js — per-page EventSource lifecycle (#40, locked #36).
// Mount: caller GETs authoritative state first, then connect().
// Unmount/nav: call the returned disconnect. Reload: same order.
// job:resynced (stream epoch change) triggers onResync for full GET resync.
// onerror stays silent: the 1s GET poll heals. Events are narrative only.
"use strict";

import { eventsUrl } from "./api.js";

// Explicit catalog (locked transport): unknown types ignorable, never state.
const TYPES = [
  "job:advanced",
  "job:resynced",
  "job:retry",
  "blocker:raised",
  "blocker:cleared",
  "challenge:seen",
  "challenge:cleared",
  "challenge:blocked",
  "gate:failed",
  "upload:plan",
  "upload:row-finished",
  "upload:report-written",
  "scrape:url-started",
  "scrape:url-finished",
  "scrape:url-failed",
  "scrape:image-downloaded",
  "scrape:image-failed",
  "scrape:group-demoted",
  "review:selection-written",
  "review:finalized",
  "artifact:written",
  "arm:granted",
  "arm:consumed",
];

export function connect(jobId, { onEvent, onResync }) {
  const es = new EventSource(eventsUrl(jobId));
  const handle = (e) => {
    let env = null;
    try {
      env = JSON.parse(e.data);
    } catch {
      return;
    }
    if (env?.type === "job:resynced") {
      try {
        onResync?.(env);
      } catch {
        // ignore
      }
      return;
    }
    try {
      onEvent?.(env);
    } catch {
      // ignore
    }
  };
  for (const t of TYPES) es.addEventListener(t, handle);
  es.onerror = () => {};
  return () => {
    try {
      es.close();
    } catch {
      // ignore
    }
  };
}
