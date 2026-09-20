// pages/dashboard.js — Dashboard: create job + job list (#39).
// Primary action: Create Job. List polls GET /jobs every 5s while visible,
// pauses when the tab hides. No SSE on dashboard (locked #36).
"use strict";

export async function render(el, api) {
  el.innerHTML =
    `<h1>Dashboard</h1>` +
    `<div class="card"><h2>Create job</h2>` +
    `<form id="create-form"><label>Source URL <input type="text" id="f-source" size="40" placeholder="https://…"></label> ` +
    `<label>Group <input type="text" id="f-group" size="12" placeholder="optional"></label> ` +
    `<label>Slug <input type="text" id="f-slug" size="14" placeholder="optional"></label> ` +
    `<button class="pri" type="submit">Create job</button></form>` +
    `<p class="small muted" id="create-msg"></p></div>` +
    `<div class="card"><h2>Jobs</h2><div id="jobs-list"><p class="muted">Loading…</p></div></div>`;

  const msg = el.querySelector("#create-msg");
  el.querySelector("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = el.querySelector("#f-source").value.trim();
    const group = el.querySelector("#f-group").value.trim();
    const slug = el.querySelector("#f-slug").value.trim();
    if (!source) {
      msg.textContent = "Validation: source URL is required.";
      return;
    }
    msg.textContent = "Creating…";
    const r = await api.createJob({ source, group, slug: slug || undefined });
    if (r.status === 201 || (r.status === 200 && r.data?.jobId)) {
      const id = r.data.jobId;
      const { navigate } = await import("../router.js");
      navigate(`/jobs/${encodeURIComponent(id)}`);
      return;
    }
    msg.textContent = `Create failed: ${r.data?.error?.message || r.data?.error?.code || r.status}`;
  });

  async function refresh() {
    if (document.hidden) return;
    let jobs = [];
    try {
      const data = await api.listJobs();
      jobs = data?.jobs || [];
    } catch {
      jobs = null;
    }
    const box = el.querySelector("#jobs-list");
    if (!box) return;
    if (jobs === null) {
      box.innerHTML = `<p class="muted">Could not load job list.</p>`;
      return;
    }
    if (jobs.length === 0) {
      box.innerHTML = `<p class="muted">No jobs yet. Create one above to start the normal workflow.</p>`;
      return;
    }
    box.innerHTML =
      `<table class="q"><tr><th>Job</th><th>Slug</th><th>Stage</th><th></th></tr>` +
      jobs
        .map(
          (j) =>
            `<tr><td>${esc(String(j.jobId || ""))}</td><td>${esc(String(j.slug || ""))}</td>` +
            `<td>${esc(String(j.stage || ""))}</td>` +
            `<td><a class="btn sec" data-nav href="/jobs/${encodeURIComponent(String(j.jobId || ""))}">Open</a></td></tr>`,
        )
        .join("") +
      `</table>`;
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  await refresh();
  const timer = setInterval(refresh, 5000);
  return () => clearInterval(timer);
}
