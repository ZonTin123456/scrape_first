#!/usr/bin/env node
// detect: auto-detect backend personnel module (profile-first, then full classify).
// READ-ONLY w.r.t. backend data: only navigates + submits the department FILTER form
// (display only). Writes maps/<host>.json then STOPS for review.
// Usage:
//   node detect.mjs [--port auto] [--match personal] [--from out/<slug>/people.json | --sections "a,b"]
//   node detect.mjs --backend https://tenant.host [--from ...]   (single host, no tab scan)
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePort, discoverBackends } from "./lib/cdp-port.mjs";
import { automap } from "./lib/automap.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const fail = (m) => { console.error("detect: " + m); process.exit(1); };
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node detect.mjs [--port auto] [--match personal] [--from out/<slug>/people.json | --sections \"a,b\"] [--backend https://host]");
  console.log("  --port auto scans 9333 -> 9444 -> 9222; writes uploader/maps/<host>.json then STOPS");
  process.exit(2);
}
const PORT = await resolvePort(opt("--port", "auto")).catch((e) => fail(e.message));
const MATCH = opt("--match", "personal");
const FROM = opt("--from", null);
const BACKEND_ARG = (opt("--backend", null) || "").replace(/\/$/, "");
let sections = [];
if (FROM) {
  if (!/people\.json$/.test(FROM)) fail("--from must be out/<slug>/people.json");
  const people = JSON.parse(readFileSync(FROM, "utf8"));
  sections = [...new Set(people.map((p) => p.section).filter(Boolean))];
} else if (opt("--sections", null)) {
  sections = opt("--sections", "").split(",").map((s) => s.trim()).filter(Boolean);
}
if (!sections.length) fail("no sections: give --from people.json (uses its sections) or --sections \"a,b\"");

const uploaderDir = dirname(fileURLToPath(import.meta.url));
const mapsDir = join(uploaderDir, "maps");

let hosts = [];
if (BACKEND_ARG) {
  hosts = [BACKEND_ARG];
} else {
  hosts = await discoverBackends(PORT, MATCH).catch(() => fail(`CDP port ${PORT} unreachable`));
  if (!hosts.length) fail(`no open tab matches "${MATCH}" on port ${PORT}`);
  console.log(`found backends (port ${PORT}): ${hosts.join(", ")}`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((e) => fail(`connect: ${e.message}`));
const context = browser.contexts()[0];
if (!context) fail("no browser context");

const results = [];
for (const host of hosts) {
  results.push(await automap(context, host, sections, { mapsDir, write: true }));
}

for (const r of results) {
  if (!r.ok) { console.log(`FAIL ${r.host} :: ${r.error}`); continue; }
  const c = r.content;
  const fields = Object.entries(c.map.fields).map(([k, v]) => `${k}=${v.confidence}${v.selector || v.strategy ? "" : " (MISSING)"}`).join(" ");
  console.log(`OK ${r.host} -> ${r.mapPath} [${c.profile ? "profile:" + c.profile : "full-classify"}]\n   ${fields}`);
  if (c.map.ambiguous.length) console.log(`   ambiguous needs human: ${c.map.ambiguous.join("; ")}`);
}
console.log("done - review maps/*.json, then run upload-people.mjs --map <file> --from <people.json> (dry first)");
const failed = results.some((r) => !r.ok);
await browser.close().catch(() => null);
process.exit(failed ? 1 : 0);
