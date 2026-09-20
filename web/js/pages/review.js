// pages/review.js — People Review (#42).
// Full at waiting_for_people_review; progress while finalizing; explain+link
// elsewhere (no auto-redirect). Save is POST-only with editedFrom revision:
// 409 stale-conflict reloads, never last-wins. Preview writes nothing.
// Thumbnails are HTTP pointers only. Primary: Save, then Finalize.
"use strict";

import { esc } from "../header.js";

function linkTarget(route, page) {
  const id = encodeURIComponent(route.jobId);
  return page === "overview" ? `/jobs/${id}` : `/jobs/${id}/${page}`;
}

function thumbFor(model, seq) {
  const t = (model.thumbs || []).find((x) => Number(x.seq) === Number(seq));
  return t?.url || null;
}

export async function render(el, api, route) {
  let timer = null;

  const collect = () =>
    [...el.querySelectorAll("[data-card]")].map((card) => ({
      seq: Number(card.getAttribute("data-seq")),
      file: card.getAttribute("data-file") || "",
      keep: card.querySelector("[data-keep]")?.checked ?? true,
      order: Number(card.querySelector("[data-order]")?.value) || 0,
    }));

  const say = (t) => {
    const m = el.querySelector("#rev-msg");
    if (m) m.textContent = t;
  };

  async function paint() {
    let job = null;
    let model = null;
    try {
      job = (await api.getJob(route.jobId))?.job || null;
    } catch {
      job = null;
    }
    if (!job) {
      el.innerHTML = `<h1>People Review</h1><div class="gate"><b>Job not found:</b> ${esc(route.jobId)}. <a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
      return null;
    }
    const stage = job.stage;
    if (stage !== "waiting_for_people_review" && stage !== "finalizing") {
      el.innerHTML =
        `<h1>People Review</h1><div class="gate"><b>People Review is not available</b> while the job is at stage <b>${esc(stage)}</b>. ` +
        `Scrape has not produced a review yet. <a class="btn sec" data-nav href="${linkTarget(route, "pages")}">Go to pages</a></div>`;
      return stage;
    }
    try {
      model = await api.getReview(job.jobId);
    } catch {
      model = null;
    }
    if (!model || !Array.isArray(model.selection)) {
      el.innerHTML = `<h1>People Review</h1><div class="card"><p class="muted">Review model unavailable. Reload or check the overview.</p></div>`;
      return stage;
    }
    if (stage === "finalizing") {
      el.innerHTML =
        `<h1>People Review</h1><div class="next"><b>Next: Wait for finalize</b> <span class="small">on the review page</span></div>` +
        `<div class="card"><p>Finalizing… revision ${esc(String(model.revision ?? ""))}.</p></div>`;
      return stage;
    }

    const rows = model.selection;
    el.innerHTML =
      `<h1>People Review</h1><div class="next"><b>Next: Save, then finalize</b> <span class="small">on this page</span></div>` +
      `<div class="card"><h2>Revision <span class="pill">rev ${esc(String(model.revision ?? "?"))} · ${model.stale ? "stale — reload" : "fresh"}</span></h2>` +
      `<p class="small muted">If someone else saves first you get a stale-conflict: reload, never last-wins.</p></div>` +
      `<div class="card"><h2>People</h2>` +
      rows
        .map((r) => {
          const thumb = thumbFor(model, r.seq);
          return (
            `<div data-card data-seq="${r.seq}" data-file="${esc(r.file || "")}" style="display:grid;grid-template-columns:64px 1fr;gap:10px;border:1px solid var(--bd);border-radius:8px;padding:10px;margin:0 0 10px;background:#fff">` +
            (thumb
              ? `<img src="${esc(thumb)}" alt="" loading="lazy" style="width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--bd)">`
              : `<div style="width:64px;height:64px;border-radius:4px;background:var(--nt-bg);border:1px solid var(--nt-bd)"></div>`) +
            `<div><b>seq ${r.seq}</b> <span class="small muted">${esc(r.file || "")}</span><br>` +
            `<label><input type="checkbox" data-keep ${r.keep !== false ? "checked" : ""}> keep</label> ` +
            `<label>order <input type="number" data-order value="${esc(String(r.order ?? 0))}" style="width:4em"></label></div></div>`
          );
        })
        .join("") +
      `<p><label>Bulk order <input type="text" id="bulk-ord" size="6"></label> <button id="bulk-set">Apply to checked</button></p></div>` +
      `<div class="warn" id="rev-warn" ${model.warnings?.length || (model.duplicates?.length ?? 0) ? "" : 'style="display:none"'}><b>Warnings:</b> <span id="rev-warn-text">${esc((model.warnings || []).join("; ") || `${model.duplicates?.length || 0} duplicate(s)`)}</span></div>` +
      `<div class="card"><h2>Save &amp; finalize</h2><button id="rev-preview">Warning preview</button> <button class="pri" id="rev-save">Save (POST only)</button> <button id="rev-finalize">Finalize</button> <span class="small muted" id="rev-msg"></span></div>`;

    el.querySelector("#bulk-set").addEventListener("click", () => {
      const v = Number(el.querySelector("#bulk-ord").value) || 0;
      el.querySelectorAll("[data-card]").forEach((card) => {
        if (card.querySelector("[data-keep]")?.checked) card.querySelector("[data-order]").value = v;
      });
    });
    el.querySelector("#rev-preview").addEventListener("click", async () => {
      say("Previewing…");
      const r = await api.postPreview(job.jobId, { selection: collect() });
      const w = el.querySelector("#rev-warn");
      if (r.status === 200) {
        const warns = r.data?.warnings || [];
        const dups = r.data?.duplicates || [];
        el.querySelector("#rev-warn-text").textContent =
          warns.join("; ") || (dups.length ? `${dups.length} duplicate(s)` : "no warnings");
        w.style.display = "";
        say("Preview ready — writes nothing.");
      } else {
        say(`Preview refused: ${r.status}`);
      }
    });
    el.querySelector("#rev-save").addEventListener("click", async () => {
      say("Saving…");
      const r = await api.postReview(job.jobId, { selection: collect(), editedFrom: model.revision });
      if (r.status === 200) {
        say(`Saved rev ${r.data?.revision}.`);
        await paint();
      } else if (r.status === 409) {
        say("Stale conflict — someone saved first. Reloaded latest.");
        await paint();
      } else {
        say(`Save refused: ${r.data?.reason || r.data?.detail || r.status}`);
      }
    });
    el.querySelector("#rev-finalize").addEventListener("click", async () => {
      say("Finalizing…");
      const r = await api.postCommand(job.jobId, "finalize", {});
      say(r.data?.accepted ? "Finalize accepted." : `Refused: ${r.data?.reason || r.status}`);
      await paint();
    });
    return stage;
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
