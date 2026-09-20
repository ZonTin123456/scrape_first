// router.js — pathname router for the light shell (#39).
// Parses location.pathname, lazy-loads the owning page module, renders into
// #view. Legacy ?jobId= on / renders the job view. No stage logic here:
// pages decide what to show from GET job/safety only. No auto-redirect.
"use strict";

import * as api from "./api.js";

const view = () => document.getElementById("view");
const nav = () => document.getElementById("nav");
const pill = () => document.getElementById("pill");

let cleanup = null;

export function parseRoute(pathname = location.pathname, search = location.search) {
  const q = new URLSearchParams(search);
  let m;
  if ((m = pathname.match(/^\/jobs\/([^/]+)\/(pages|review|safety)\/?$/))) {
    return { name: m[2], jobId: decodeURIComponent(m[1]) };
  }
  if ((m = pathname.match(/^\/jobs\/([^/]+)\/?$/))) {
    return { name: "overview", jobId: decodeURIComponent(m[1]) };
  }
  if (pathname === "/" || pathname === "/shell.html") {
    const alias = q.get("jobId");
    if (alias) return { name: "overview", jobId: alias };
    return { name: "dashboard", jobId: null };
  }
  return { name: "not-found", jobId: null };
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
  nav().innerHTML = links
    .map((l) => `<a data-nav href="${l.href}" class="${l.on ? "on" : ""}">${l.label}</a>`)
    .join("");
}

// Interim job view (#39): proves deep-link shell + GET-first. Replaced by the
// real Overview + shared header in #40. Not a placeholder for behavior.
async function renderJobInterim(route) {
  pill().textContent = `JOB ${route.jobId}`;
  paintNav(route);
  const el = view();
  el.innerHTML = `<div class="card"><h2>Job <span class="small muted">${escapeHtml(route.jobId)}</span></h2><p class="muted">Loading…</p></div>`;
  let data = null;
  try {
    data = await api.getJob(route.jobId);
  } catch {
    data = null;
  }
  const stage = data?.job?.stage ?? "unknown";
  el.innerHTML =
    `<div class="card"><h2>Job <span class="small muted">${escapeHtml(route.jobId)}</span></h2>` +
    `<p>Stage: <b>${escapeHtml(String(stage))}</b></p>` +
    `<p class="small muted">Full ${escapeHtml(route.name)} view ships in the next ticket. Job record loads correctly.</p>` +
    `<p><a class="btn sec" data-nav href="/">Back to Dashboard</a></p></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function render() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // ignore
    }
    cleanup = null;
  }
  const route = parseRoute();
  if (route.name === "dashboard") {
    const mod = await import("./pages/dashboard.js");
    pill().textContent = "Job Workspace";
    paintNav(route);
    cleanup = (await mod.render(view(), api)) || null;
    return;
  }
  if (route.name === "not-found") {
    pill().textContent = "Job Workspace";
    paintNav(route);
    view().innerHTML =
      `<div class="gate"><b>Unknown page.</b> No such workspace page. ` +
      `<a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
    return;
  }
  await renderJobInterim(route);
}

export function navigate(path) {
  history.pushState(null, "", path);
  render();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-nav]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", render);
render();
