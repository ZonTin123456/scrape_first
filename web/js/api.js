// api.js — dumb fetch wrappers over absolute job paths (#39).
// Display-only: no stage transitions, no gating, no business rules here.
// Server re-validates every mutation fail-closed.
"use strict";

async function req(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, ok: r.ok, data };
}

// Same shape as the retired single-page client: unique per click, server
// dedups by commands.json replay. Uniqueness only, no semantics.
export function newCommandId() {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const listJobs = () => req("GET", "/jobs").then((r) => r.data);
export const createJob = ({ source, group = "", slug = undefined }) =>
  req("POST", "/jobs", { source, group, ...(slug ? { slug } : {}) });
export const getJob = (jobId) => req("GET", `/jobs/${encodeURIComponent(jobId)}`).then((r) => r.data);
export const getPages = (jobId) =>
  req("GET", `/jobs/${encodeURIComponent(jobId)}/pages`).then((r) => r.data);
export const postPages = (jobId, payload) =>
  req("POST", `/jobs/${encodeURIComponent(jobId)}/pages`, payload);
export const getReview = (jobId) =>
  req("GET", `/jobs/${encodeURIComponent(jobId)}/review`).then((r) => r.data);
export const postReview = (jobId, payload) =>
  req("POST", `/jobs/${encodeURIComponent(jobId)}/review`, payload);
export const postPreview = (jobId, payload) =>
  req("POST", `/jobs/${encodeURIComponent(jobId)}/review/preview`, payload);
export const getSafety = (jobId) =>
  req("GET", `/jobs/${encodeURIComponent(jobId)}/safety`).then((r) => r.data);
export const postCommand = (jobId, type, payload = {}) =>
  req("POST", `/jobs/${encodeURIComponent(jobId)}/commands`, {
    commandId: newCommandId(),
    type,
    payload,
  });
export const eventsUrl = (jobId, once = false) =>
  `/jobs/${encodeURIComponent(jobId)}/events${once ? "?once=1" : ""}`;
