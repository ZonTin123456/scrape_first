// pages/safety.js — Safety / Dry / G1 / G2 / Real Upload (#43).
// Sections activate from finalizing onward; earlier stages show explain+link.
// One-click dry sends server defaults (server-authoritative; no dry logic in
// this file). Raw JSON lives only in the collapsed Advanced hatch.
// Red appears ONLY in the G2 Real Upload danger fence. Server enforces
// G1/G2/single-use arm fail-closed; buttons mirror validity as hints.
"use strict";

import { esc } from "../header.js";
import { nextFor } from "../stage-map.js";

const PRE = new Set([
  "idle",
  "probing",
  "waiting_for_page_selection",
  "scraping",
  "waiting_for_people_review",
]);

function linkTarget(route, page) {
  const id = encodeURIComponent(route.jobId);
  return page === "overview" ? `/jobs/${id}` : `/jobs/${id}/${page}`;
}

export async function render(el, api, route) {
  let timer = null;
  const say = (t) => {
    const m = el.querySelector("#sf-msg");
    if (m) m.textContent = t;
  };
  // Dry status lives next to the Dry button (not hidden in Detect).
  const drySay = (t) => {
    const m = el.querySelector("#sf-dry-msg");
    if (m) m.textContent = t;
  };

  async function paint() {
    let job = null;
    let safety = null;
    try {
      job = (await api.getJob(route.jobId))?.job || null;
    } catch {
      job = null;
    }
    if (!job) {
      el.innerHTML = `<h1>Safety / Dry / Real Upload</h1><div class="gate"><b>Job not found:</b> ${esc(route.jobId)}. <a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
      return null;
    }
    const stage = job.stage;
    if (PRE.has(stage)) {
      // Wrong-stage: destination derives from the single stage map (never a
      // hardcoded guess), so cards cannot point at each other in a loop.
      const [label, page] = nextFor(stage);
      el.innerHTML =
        `<h1>Safety / Dry / Real Upload</h1><div class="gate"><b>Safety is not available</b> while the job is at stage <b>${esc(stage)}</b>. ` +
        `Next step is “${esc(label)}” on the ${esc(page)} page. ` +
        `<a class="btn sec" data-nav href="${linkTarget(route, page)}">Go to the right page</a></div>`;
      return stage;
    }
    try {
      safety = await api.getSafety(job.jobId);
    } catch {
      safety = null;
    }
    if (!safety) {
      el.innerHTML = `<h1>Safety / Dry / Real Upload</h1><div class="card"><p class="muted">Safety model unavailable. Reload.</p></div>`;
      return stage;
    }

    const g1 = safety.gate1 || {};
    const g2 = safety.gate2 || {};
    const bundle = safety.bundle || null;
    const armed = g2.armed === true || safety.arm === "armed";
    const secs = ["source", "group", "destinationOrigin", "targetDepts", "wouldCreate", "identity", "unmapped", "counts", "rows", "proofs"];
    // Latest dry refusals, persisted server-side on the record: they survive
    // repaint and reload (the POST disposition alone does not). Amber explainer
    // card — never red (red is fenced to Real Upload only).
    const refusals = (job.ledger || [])
      .filter((e) => e && e.kind === "gate:failed" && /dry refused|G1 red/i.test(e.message || ""))
      .slice(-2)
      .reverse();

    el.innerHTML =
      `<h1>Safety / Dry / Real Upload</h1>` +
      `<div class="card"><h2>Detect backend</h2>` +
      (stage === "finalizing" || stage === "detecting_backend"
        ? `<button class="pri" id="sf-detect">Run Detect</button> <span class="small muted" id="sf-msg"></span>`
        : `<p class="small muted">Detect ${["dry_running", "dry_passed", "armed", "uploading", "done"].includes(stage) ? "completed." : "is not the current step."} <span id="sf-msg"></span></p>`) +
      `</div>` +
      `<div class="warn"><b>Dry-run — safe, never saves.</b><br><button class="pri" id="sf-dry" ${stage === "dry_running" ? "" : "disabled"}>Run dry-run</button> ` +
      `<span class="small" id="sf-dry-msg">${stage === "dry_running" ? "" : "Available at stage dry_running."}</span>` +
      `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">Advanced — raw JSON payload (power users)</summary>` +
      `<textarea id="sf-json" rows="4">{}</textarea><br><button id="sf-dry-json">Run with JSON</button></details></div>` +
      (refusals.length
        ? `<div class="warn"><b>Last dry attempt refused.</b><ul class="small">` +
          refusals.map((r) => `<li>${esc(r.message)}${r.at ? ` <span class="muted">${esc(r.at)}</span>` : ""}</li>`).join("") +
          `</ul></div>`
        : "") +
      (bundle
        ? `<div class="card"><h2>Visibility bundle</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">` +
          secs.map((s) => `<div style="border:1px solid var(--bd);border-radius:6px;padding:8px;font-size:12px;background:#fff"><b style="display:block;font-size:11px;color:var(--tx2);text-transform:uppercase">${esc(s)}</b>${esc(summarize(bundle[s]))}</div>`).join("") +
          `</div></div>`
        : `<div class="card"><h2>Visibility bundle</h2><p class="small muted">Pending — no dry yet. ${esc((safety.pending || []).join(", "))}</p></div>`) +
      (g1.ok
        ? `<div style="background:var(--gr-bg);border:1px solid var(--gr-bd);border-radius:8px;padding:12px 16px;margin:0 0 16px;color:var(--gr-t)"><b>G1 preflight: passed</b> — dry-run current for this snapshot. Real Upload stays disabled until G1 is green.</div>`
        : `<div class="warn"><b>G1 preflight: blocked.</b><ul class="small">${(g1.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`) +
      `<div class="card"><h2>G2 attestation</h2>` +
      `<p class="small">${esc(g2.attestation || "Attestation appears after a fresh dry-run.")}</p>` +
      `<p><label><input type="checkbox" id="sf-attest"> I attest</label> <label>type slug <input type="text" id="sf-typed" size="12" placeholder="${esc(safety.slug || "")}"></label> ` +
      `<button id="sf-arm" ${stage === "dry_passed" ? "" : "disabled"}>Arm</button></p></div>` +
      `<fieldset style="border:2px solid var(--rd);border-radius:8px;padding:12px 16px;margin:0 0 16px;background:var(--card)"><legend style="color:var(--rd-d);font-weight:700;padding:0 8px">Real upload — destructive</legend>` +
      `<p><b style="color:var(--rd-d)">This clicks save on the backend. Red appears nowhere else in this UI.</b></p>` +
      `<button id="sf-upload" style="background:var(--rd);border-color:var(--rd-d);color:#fff" ${stage === "armed" && armed ? "" : "disabled"}>Real Upload — clicks save</button></fieldset>` +
      (bundle?.proofs?.length
        ? `<div class="card"><h2>Proofs</h2><ul class="small">${bundle.proofs.map((p) => `<li>${esc(p.kind || "")} — ${esc(p.relPath || p.url || "")}</li>`).join("")}</ul></div>`
        : "");

    const detect = el.querySelector("#sf-detect");
    if (detect) detect.addEventListener("click", async () => {
      say("Detecting…");
      const r = await api.postCommand(job.jobId, "detect", {});
      say(r.data?.accepted ? "Detect started." : `Refused: ${r.data?.reason || r.status}`);
      await paint();
    });
    el.querySelector("#sf-dry").addEventListener("click", async () => {
      drySay("Dry running with server defaults…");
      const r = await api.postCommand(job.jobId, "dry", {});
      if (r.data?.accepted) {
        drySay("Dry recorded — G1 evaluated.");
      } else {
        drySay("Dry refused — details below.");
      }
      await paint();
    });
    el.querySelector("#sf-dry-json").addEventListener("click", async () => {
      let payload = {};
      try {
        payload = JSON.parse(el.querySelector("#sf-json").value || "{}");
      } catch {
        drySay("Advanced JSON invalid — nothing sent.");
        return;
      }
      drySay("Dry running with JSON payload…");
      const r = await api.postCommand(job.jobId, "dry", payload);
      if (r.data?.accepted) {
        drySay("Dry recorded — G1 evaluated.");
      } else {
        drySay(`Dry refused: ${r.data?.reason || r.status}`);
      }
      await paint();
    });
    el.querySelector("#sf-arm").addEventListener("click", async () => {
      const checked = el.querySelector("#sf-attest")?.checked === true;
      const typed = el.querySelector("#sf-typed")?.value || "";
      say("Arming…");
      const r = await api.postCommand(job.jobId, "arm", {
        attestedText: checked ? g2.attestation : null,
        typed,
        clicked: true,
      });
      say(r.data?.accepted ? "Armed (single-use)." : `Refused: ${r.data?.reason || r.status}`);
      await paint();
    });
    el.querySelector("#sf-upload").addEventListener("click", async () => {
      say("Uploading…");
      const r = await api.postCommand(job.jobId, "begin-upload", {});
      say(r.data?.accepted ? "Upload started." : `Refused: ${r.data?.reason || r.status}`);
      await paint();
    });
    return stage;
  }

  function summarize(v) {
    if (v == null) return "—";
    if (Array.isArray(v)) return v.length === 0 ? "none" : `${v.length} item(s)`;
    if (typeof v === "object") return Object.keys(v).length === 0 ? "none" : `${Object.keys(v).length} key(s)`;
    return String(v);
  }

  let last = await paint();
  timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const cur = (await api.getJob(route.jobId))?.job?.stage || null;
      if (cur !== last) last = await paint();
    } catch {
      // poll heals
    }
  }, 1000);
  return () => clearInterval(timer);
}
