// pages/overview.js — Job Overview (#40).
// Valid at all stages. Primary is contextual: Probe at idle, link-button to
// the owning page otherwise, proofs summary at done. Re-renders on stage
// change via 1s GET poll (paused when hidden); SSE feeds Activity only.
"use strict";

import { NEXT, STEPS, stepIndex } from "../stage-map.js";
import { esc } from "../header.js";

function progressHtml(stage) {
  const idx = stepIndex(stage);
  const doneAll = stage === "done";
  return (
    `<div class="stepper" style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">` +
    STEPS.map(([label, s]) => {
      const si = stepIndex(s);
      const cls = doneAll || si < idx ? "done" : si === idx ? "cur" : "";
      const style =
        cls === "done"
          ? "border-color:var(--gr-bd);color:var(--gr-t);background:var(--gr-bg)"
          : cls === "cur"
            ? "border-color:var(--ac);color:var(--ac-s);background:var(--ac-t);font-weight:700"
            : "color:var(--mut);background:var(--card)";
      return `<span style="padding:2px 8px;border:1px solid var(--bd);border-radius:999px;font-size:12px;${style}">${esc(label)}</span>`;
    }).join("") +
    `</div>`
  );
}

export async function render(el, api, route) {
  let timer = null;

  async function paint() {
    let data = null;
    try {
      data = await api.getJob(route.jobId);
    } catch {
      data = null;
    }
    const job = data?.job || null;
    if (!job) {
      el.innerHTML =
        `<h1>Job overview</h1><div class="gate"><b>Job not found:</b> ${esc(route.jobId)}. ` +
        `<a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
      return null;
    }
    const [label, page] = NEXT[job.stage] || ["Open overview", "overview"];
    const id = encodeURIComponent(job.jobId);
    const target = page === "overview" ? `/jobs/${id}` : `/jobs/${id}/${page}`;
    const blockers = job.blockers || [];
    const artifacts = job.artifacts || [];

    el.innerHTML =
      `<h1>Job overview <span class="small muted">${esc(job.jobId)}</span></h1>` +
      `<div class="next"><b>Next: ${esc(label)}</b> <span class="small">on the ${esc(page)} page</span> ` +
      (job.stage === "idle"
        ? `<button class="pri" id="ov-probe">Run Probe</button> <span class="small muted" id="ov-msg"></span>`
        : `<a class="btn" data-nav href="${target}">${esc(label)}</a>`) +
      `</div>` +
      `<div class="card"><h2>Identity</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">` +
      `<div><b class="small muted">SOURCE</b><br>${esc(job.source || "")}</div>` +
      `<div><b class="small muted">GROUP</b><br>${esc(job.group || "")}</div>` +
      `<div><b class="small muted">SLUG</b><br>${esc(job.slug || "")}</div>` +
      `<div><b class="small muted">STAGE</b><br>${esc(job.stage)}</div></div></div>` +
      `<div class="card"><h2>Workflow progress</h2>${progressHtml(job.stage)}</div>` +
      (blockers.length
        ? `<div class="warn"><b>Blocked: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}.</b> ` +
          `${blockers.map((b) => esc(b.type || b.code || "blocker")).join(", ")}. ` +
          `Fix or remap, then Retry/Resume from the header. State, not logs.</div>`
        : "") +
      (job.stage === "done" && artifacts.length
        ? `<div class="card"><h2>Proofs</h2><ul class="small">` +
          artifacts.map((a) => `<li>${esc(a.kind || "artifact")} — ${esc(a.relPath || a.url || "")}</li>`).join("") +
          `</ul></div>`
        : "");

    const probe = el.querySelector("#ov-probe");
    if (probe) {
      probe.addEventListener("click", async () => {
        const m = el.querySelector("#ov-msg");
        m.textContent = "Sending…";
        const r = await api.postCommand(job.jobId, "probe", {});
        m.textContent = r.data?.accepted ? "Probe accepted." : `Refused: ${r.data?.reason || r.status}`;
        await paint();
      });
    }
    return job.stage;
  }

  let last = await paint();
  // Repaint only on stage change: full paint rebuilds DOM (kills focus).
  // Probe and other clicks repaint directly after their mutation.
  timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const cur = (await api.getJob(route.jobId))?.job?.stage ?? null;
      if (cur !== last) last = await paint();
    } catch {
      // poll heals
    }
  }, 1000);
  return () => clearInterval(timer);
}
