// pages/pages.js — Page Selection (#41).
// Full at waiting_for_page_selection; progress view while scraping;
// explain+link elsewhere (no auto-redirect). Primary morphs
// Save -> Approve -> Scrape, driven by server stage. Server merges by key
// and enforces approve/scrape fail-closed.
"use strict";

import { esc } from "../header.js";

function linkTarget(route, page) {
  const id = encodeURIComponent(route.jobId);
  return page === "overview" ? `/jobs/${id}` : `/jobs/${id}/${page}`;
}

export async function render(el, api, route) {
  let timer = null;

  async function paint() {
    let job = null;
    let model = null;
    try {
      job = (await api.getJob(route.jobId))?.job || null;
    } catch {
      job = null;
    }
    if (!job) {
      el.innerHTML = `<h1>Page Selection</h1><div class="gate"><b>Job not found:</b> ${esc(route.jobId)}. <a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
      return null;
    }
    try {
      model = await api.getPages(job.jobId);
    } catch {
      model = null;
    }
    const stage = job.stage;

    if (stage !== "waiting_for_page_selection" && stage !== "scraping") {
      const hint =
        stage === "idle" || stage === "probing"
          ? "Run Probe first."
          : "Pages are already approved for this job.";
      const go = stage === "idle" || stage === "probing" ? "overview" : "review";
      el.innerHTML =
        `<h1>Page Selection</h1><div class="gate"><b>Page Selection is not available</b> while the job is at stage <b>${esc(stage)}</b>. ${esc(hint)} ` +
        `<a class="btn sec" data-nav href="${linkTarget(route, go)}">Go to the right page</a></div>`;
      return stage;
    }

    if (stage === "scraping") {
      el.innerHTML =
        `<h1>Page Selection</h1><div class="next"><b>Next: Wait for scrape to finish</b> <span class="small">on the pages page</span></div>` +
        `<div class="card"><p>Scraping in progress… stage updates via poll + event resync.</p></div>`;
      return stage;
    }

    if (!model || model.pending) {
      el.innerHTML =
        `<h1>Page Selection</h1><div class="next"><b>Next: Run Probe</b> <span class="small">on the overview page</span> ` +
        `<a class="btn" data-nav href="${linkTarget(route, "overview")}">Go to overview</a></div>` +
        `<div class="card"><p class="muted">No probe data yet. Probe first, then select pages here.</p></div>`;
      return stage;
    }

    const links = model.links || [];
    el.innerHTML =
      `<h1>Page Selection</h1><div class="next"><b>Next: Save, approve, then scrape</b> <span class="small">on this page</span></div>` +
      `<div class="card"><h2>Links <span class="small muted">(from probe data)</span></h2>` +
      `<table class="q"><tr><th>Keep</th><th>URL</th><th>Title</th></tr>` +
      links
        .map(
          (l) =>
            `<tr><td><input type="checkbox" data-plink ${l.keep !== false ? "checked" : ""} data-url="${esc(l.url)}"></td>` +
            `<td>${esc(l.url)}</td><td>${esc(l.title || "")}</td></tr>`,
        )
        .join("") +
      `</table></div>` +
      links
        .map(
          (l, i) =>
            `<div class="card"><h2>Images — ${esc(l.slug || `link ${i + 1}`)}</h2>` +
            `<table class="q"><tr><th>Keep</th><th>Seq</th><th>Detail</th></tr>` +
            (l.images || [])
              .map(
                (im) =>
                  `<tr><td><input type="checkbox" data-pimg ${im.keep !== false ? "checked" : ""} data-pslug="${esc(l.slug || "")}" data-pseq="${im.seq}"></td>` +
                  `<td>${im.seq}</td><td class="small muted">${esc(im.file || im.src || "")}</td></tr>`,
              )
              .join("") +
            `</table></div>`,
        )
        .join("") +
      `<div class="card"><h2>Approve &amp; scrape</h2>` +
      `<button class="pri" id="pg-save">Save pages</button> <button id="pg-approve">Approve pages</button> <button id="pg-scrape">Scrape</button> ` +
      `<span class="small muted" id="pg-msg"></span></div>`;

    const collect = () => ({
      links: [...el.querySelectorAll("[data-plink]")].map((c) => ({
        url: c.getAttribute("data-url"),
        keep: c.checked,
      })),
      images: Object.fromEntries(
        [...new Set([...el.querySelectorAll("[data-pimg]")].map((c) => c.getAttribute("data-pslug")))].map(
          (slug) => [
            slug,
            [...el.querySelectorAll(`[data-pimg][data-pslug="${CSS.escape(slug)}"]`)].map((c) => ({
              seq: Number(c.getAttribute("data-pseq")),
              keep: c.checked,
            })),
          ],
        ),
      ),
    });
    const say = (t) => {
      const m = el.querySelector("#pg-msg");
      if (m) m.textContent = t;
    };
    el.querySelector("#pg-save").addEventListener("click", async () => {
      say("Saving…");
      const r = await api.postPages(job.jobId, collect());
      say(r.data?.ok ? `Saved: ${r.data.links ?? 0} links.` : `Save refused: ${r.data?.reason || r.data?.detail || r.status}`);
      await paint();
    });
    el.querySelector("#pg-approve").addEventListener("click", async () => {
      say("Approving…");
      const r = await api.postCommand(job.jobId, "approve-page", {});
      say(r.data?.accepted ? "Approved." : `Refused: ${r.data?.reason || r.status}`);
      await paint();
    });
    el.querySelector("#pg-scrape").addEventListener("click", async () => {
      say("Starting scrape…");
      const r = await api.postCommand(job.jobId, "scrape", {});
      say(r.data?.accepted ? "Scrape started." : `Refused: ${r.data?.reason || r.status}`);
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
