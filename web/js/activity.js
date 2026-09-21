// activity.js — collapsed per-page Activity section (#40, locked #36).
// Debug narrative only: newest at bottom, default last 50, expandable to the
// server buffer (200). Blocker/error cards live in pages, never here.
"use strict";

import { connect } from "./sse.js";
import { esc } from "./header.js";

export function mount(jobId) {
  const host = document.getElementById("activity-mount");
  if (!jobId || !host) return () => {};
  const seen = [];
  host.innerHTML =
    `<details class="act"><summary>Activity — recent events (collapsed by default, debug only)</summary>` +
    `<div class="log" id="act-log" style="border-top:1px solid var(--bd);padding:8px 16px;font-family:ui-monospace,monospace;font-size:12px;color:var(--tx2);max-height:180px;overflow:auto"></div></details>`;
  const log = host.querySelector("#act-log");
  function paint() {
    const rows = seen.slice(-50);
    log.innerHTML =
      rows.map((e) => `${esc(e.at || "")} ${esc(e.type || "")}`).join("<br>") +
      (seen.length > 50
        ? `<br><span class="muted">showing 50 of ${seen.length} (buffer holds 200 server-side)</span>`
        : rows.length === 0
          ? `<span class="muted">no events yet — state above comes from GETs, never from this list</span>`
          : `<br><span class="muted">state above comes from GETs, never from this list</span>`);
    log.scrollTop = log.scrollHeight;
  }
  paint();
  const disconnect = connect(jobId, {
    onEvent: (env) => {
      seen.push(env);
      if (seen.length > 200) seen.shift();
      paint();
    },
    onResync: () => {
      // Epoch change: pages re-GET via their own resync path; note it here.
      seen.push({ at: new Date().toISOString(), type: "job:resynced (local note: page reloaded state)" });
      paint();
    },
  });
  return () => {
    disconnect();
    host.innerHTML = "";
  };
}
