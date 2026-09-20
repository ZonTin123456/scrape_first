// stage-map.js — single display-only stage map (#40, locked #35).
// Derived ONLY from GET job {stage,blockers} + GET safety {gate1,gate2}.
// No transition logic, no gating decisions: server enforces on mutation.
"use strict";

// Normal-path next action per stage. Label + owning page only.
export const NEXT = {
  idle: ["Run Probe", "overview"],
  probing: ["Wait for probe to finish", "overview"],
  waiting_for_page_selection: ["Select pages", "pages"],
  scraping: ["Wait for scrape to finish", "pages"],
  waiting_for_people_review: ["Review people", "review"],
  finalizing: ["Wait for finalize", "review"],
  detecting_backend: ["Run Detect", "safety"],
  dry_running: ["Run dry-run", "safety"],
  dry_passed: ["Attest and arm", "safety"],
  armed: ["Real Upload", "safety"],
  uploading: ["Wait for upload to finish", "safety"],
  done: ["View proofs", "overview"],
  failed: ["Resume or retry", "overview"],
  cancelled: ["Terminal — no actions", "overview"],
};

const ORDER = [
  "idle",
  "probing",
  "waiting_for_page_selection",
  "scraping",
  "waiting_for_people_review",
  "finalizing",
  "detecting_backend",
  "dry_running",
  "dry_passed",
  "armed",
  "uploading",
  "done",
];

export const STEPS = [
  ["Create", "idle"],
  ["Probe", "probing"],
  ["Page Selection", "waiting_for_page_selection"],
  ["Scrape", "scraping"],
  ["People Review", "waiting_for_people_review"],
  ["Finalize", "finalizing"],
  ["Detect", "detecting_backend"],
  ["Dry-run", "dry_running"],
  ["Arm", "dry_passed"],
  ["Real Upload", "armed"],
];

// Full spine incl. terminals, for validation copy.
export const SPINE = [...ORDER, "failed", "cancelled"];

export function nextFor(stage) {
  return NEXT[stage] || ["Open overview", "overview"];
}

// Wrong-stage destination: the single mapping every gate card derives its
// link from. Depending only on stage (never on the current page) makes
// page-to-page loops impossible: the target always owns the stage.
export function pageFor(stage) {
  return nextFor(stage)[1];
}

export function stepIndex(stage) {
  return ORDER.indexOf(stage);
}
