// router.js — pathname router for the light shell (#39 shell, #40 header).
// Parses location.pathname, mounts shared header, lazy-loads the owning page
// module into #view, mounts Activity for job routes. Legacy ?jobId= on /
// renders the job view. No stage logic here: pages decide what to show from
// GET job/safety only. Wrong-stage renders explain+link, never auto-redirect.
"use strict";

import * as api from "./api.js";

const view = () => document.getElementById("view");

let cleanups = [];

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

const PAGE_MODULE = {
  dashboard: "./pages/dashboard.js",
  overview: "./pages/overview.js",
  pages: "./pages/pages.js",
  review: "./pages/review.js",
  safety: "./pages/safety.js",
};

function teardown() {
  for (const c of cleanups) {
    try {
      c();
    } catch {
      // ignore
    }
  }
  cleanups = [];
  document.getElementById("activity-mount").innerHTML = "";
}

export async function render() {
  teardown();
  const route = parseRoute();
  const { mount } = await import("./header.js");
  cleanups.push(await mount(route));

  if (route.name === "not-found") {
    document.getElementById("pill").textContent = "Job Workspace";
    view().innerHTML =
      `<div class="gate"><b>Unknown page.</b> No such workspace page. ` +
      `<a class="btn sec" data-nav href="/">Back to Dashboard</a></div>`;
    return;
  }
  const modPath = PAGE_MODULE[route.name];
  if (!modPath) {
    // pages/review/safety land in #41–#43; interim card keeps deep links honest.
    view().innerHTML =
      `<div class="card"><h2>${route.name[0].toUpperCase()}${route.name.slice(1)} — next ticket</h2>` +
      `<p class="small muted">This page ships in its ticket with full stage gating. Shell, header, and Activity already live.</p>` +
      `<p><a class="btn sec" data-nav href="/jobs/${encodeURIComponent(route.jobId || "")}">Back to overview</a></p></div>`;
    const { mount: mountActivity } = await import("./activity.js");
    if (route.jobId) cleanups.push(mountActivity(route.jobId));
    return;
  }
  const mod = await import(modPath);
  const done = await mod.render(view(), api, route);
  if (typeof done === "function") cleanups.push(done);
  if (route.jobId) {
    const { mount: mountActivity } = await import("./activity.js");
    cleanups.push(mountActivity(route.jobId));
  }
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
