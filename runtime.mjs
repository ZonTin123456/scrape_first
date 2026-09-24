#!/usr/bin/env node
// runtime: shared environment helpers for every entry script.
import { join } from "node:path";
export const MIN_NODE_MAJOR = 22;

// backup-page.mjs drives Chrome over the global WebSocket, which Node only has
// from v22. On Node 18/20 a run would die mid-way ("WebSocket is not defined")
// after it already opened tabs — so fail before any work, with the fix.
export function assertNode(script) {
  const major = Number(String(process.versions.node).split(".")[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return;
  console.error(`${script}: Node ${MIN_NODE_MAJOR}+ is required (running v${process.versions.node})`);
  console.error(`  why: Chrome is driven over the built-in WebSocket, available since Node ${MIN_NODE_MAJOR}; on Node 18/20 the run breaks partway through.`);
  console.error("  fix: install Node 22+ (https://nodejs.org) or `nvm install 22 && nvm use 22`, then run the same command again.");
  process.exit(1);
}

// Chrome installs in different places per OS and may not be on PATH under the
// name we guess: return the usual locations first, then every PATH entry, so
// callers can existsSync-probe the list in order.
function pathCandidates(names) {
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  return String(process.env.PATH || "").split(sep).filter(Boolean)
    .flatMap((d) => exts.flatMap((e) => names.map((n) => join(d, n + e))));
}
export function chromeCandidates() {
  const envPath = (v, rel) => (v ? join(v, rel) : null);
  const fixed = process.platform === "win32"
    ? [envPath(process.env.PROGRAMFILES, "Google\\Chrome\\Application\\chrome.exe"),
       envPath(process.env["PROGRAMFILES(X86)"], "Google\\Chrome\\Application\\chrome.exe"),
       envPath(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
         "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
         "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  const names = process.platform === "win32"
    ? ["chrome"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  return [...fixed.filter(Boolean), ...pathCandidates(names)];
}
