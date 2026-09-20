// header.js — shared header: nav, status pill, recovery (Retry/Resume/Cancel).
// (#40) Buttons are display hints; server allows or refuses fail-closed.
// After a mutation the current route re-renders from fresh GETs.
"use strict";

import * as api from "./api.js";
import { SPINE } from "./stage-map.js";
import { render } from "./router.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function paintNav(route) {
  const links = [{ href: "/", label: "Dashboard", on: route.name === "dashboard" }];
  if (route.jobId) {
    const id = encodeURIComponent(route.jobId);
    links.push(
      { href: `/jobs/${id}`, label: "Job", on: route.name === "overview" },
      { href: `/jobs/${id}/pages`, label: "Pages", on: route.name === "pages" },
      { href: `/jobs/${id}/review`, label: "Review", on: route.name === "review" },
      { href: `/jobs/${id}/safety`, label: "Safety", on: route.name === "safety" },
    );
  }
  document.getElementById("nav").innerHTML = links
    .map((l) => `<a data-nav href="${l.href}" class="${l.on ? "on" : ""}">${l.label}</a>`)
    .join("");
}

function setPill(text) {
  document.getElementById("pill").textContent = text;
}

function paintRecovery(route, stage) {
  const box = document.getElementById("recov");
  if (!route.jobId) {
    box.innerHTML = "";
    return;
  }
  const terminal = stage === "done" || stage === "cancelled";
  const failed = stage === "failed";
  box.innerHTML =
    (failed
      ? `<select id="retry-to" title="retry target">${SPINE.map((s) => `<option>${s}</option>`).join("")}</select>` +
        `<button data-act="retry">Retry</button><button data-act="resume">Resume</button>`
      : "") +
    (terminal ? "" : `<button data-act="cancel">Cancel</button>`) +
    `<span class="small muted" id="recov-msg"></span>`;
  box.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const act = b.getAttribute("data-act");
      const msg = box.querySelector("#recov-msg");
      msg.textContent = "Sending…";
      const payload =
        act === "cancel"
          ? { prompted: true, reason: "shell header" }
          : act === "resume"
            ? { reason: "shell header" }
            : { to: box.querySelector("#retry-to")?.value, reason: "shell header" };
      const r = await api.postCommand(route.jobId, act, payload);
      msg.textContent = r.data?.accepted ? "Accepted." : `Refused: ${r.data?.reason || r.status}`;
      await render();
    }),
  );
}

// Mounts nav + pill + recovery for a job route; polls pill while visible.
// Returns cleanup (stops poll). Page modules handle their own refresh.
export async function mount(route) {
  paintNav(route);
  setPill(route.jobId ? `JOB ${route.jobId}` : "Job Workspace");
  if (!route.jobId) {
    document.getElementById("recov").innerHTML = "";
    return () => {};
  }
  async function refresh() {
    if (document.hidden) return;
    let job = null;
    try {
      job = (await api.getJob(route.jobId))?.job || null;
    } catch {
      return;
    }
    // Pill text is cheap (no focus impact); recovery buttons repaint only on
    // stage change so the retry select and focus survive polling.
    if (!job) {
      setPill(`JOB ${route.jobId} — not found`);
      if (lastKey !== "missing") {
        lastKey = "missing";
        paintRecovery(route, "cancelled");
      }
      return;
    }
    const n = job.blockers?.length || 0;
    setPill(`STAGE ${job.stage} · ${n} blocker${n === 1 ? "" : "s"}`);
    if (job.stage !== lastKey) {
      lastKey = job.stage;
      paintRecovery(route, job.stage);
    }
  }
  let lastKey = null;
  await refresh();
  const timer = setInterval(refresh, 1000);
  return () => clearInterval(timer);
}
