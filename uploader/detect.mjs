#!/usr/bin/env node
// detect: READ-ONLY diagnostic wrapper around the shared automap discovery core
// (profile-first, then full classify). Default performs ZERO local writes and
// ZERO backend mutations: only GET navigations + DOM reads (the department
// filter form is probed, never submitted; no POST anywhere).
// Results print as JSON on stdout. A file is written only via explicit
// --dump-map <path> (the single host's discovery content, maps/<host>.json
// shape, exact snapshot with no merge).
// maps/ is a compatibility artifact, never a source of truth.
// Usage:
//   node detect.mjs [--port auto] [--match personal] [--from out/<slug>/people.json | --sections "a,b"]
//   node detect.mjs --backend https://tenant.host [--from ...]   (single host, no tab scan)
//   node detect.mjs ... --dump-map <path>   (explicit opt-in file write)
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolvePort, discoverBackends } from "./lib/cdp-port.mjs";
import { automap } from "./lib/automap.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const fail = (m) => { console.error("detect: " + m); process.exit(1); };
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node detect.mjs [--port auto] [--match personal] [--from out/<slug>/people.json | --sections \"a,b\"] [--backend https://host] [--dump-map <path>]");
  console.log("  default is read-only: no files created or modified; JSON discovery result on stdout (human notes on stderr)");
  console.log("  --dump-map <path>: explicit opt-in only - writes the exact discovery snapshot to <path> (no merge, no maps/ auto-filename)");
  console.log("  --port auto scans 9333 -> 9444 -> 9222");
  process.exit(2);
}
// --dump-map without a path fails fast (before any browser contact): there is
// no default filename by design, so maps/ can never be rewritten implicitly.
const DUMP = argv.includes("--dump-map") ? opt("--dump-map", null) : null;
if (argv.includes("--dump-map") && !DUMP) fail("--dump-map needs an explicit <path> (no implicit maps/<host>.json filename)");
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

let hosts = [];
if (BACKEND_ARG) {
  hosts = [BACKEND_ARG];
} else {
  hosts = await discoverBackends(PORT, MATCH).catch(() => fail(`CDP port ${PORT} unreachable`));
  if (!hosts.length) fail(`no open tab matches "${MATCH}" on port ${PORT}`);
  console.error(`found backends (port ${PORT}): ${hosts.join(", ")}`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((e) => fail(`connect: ${e.message}`));
const context = browser.contexts()[0];
if (!context) fail("no browser context");

const results = [];
for (const host of hosts) {
  // diagnostic default: ephemeral discovery, zero local writes.
  results.push(await automap(context, host, sections, { write: false }));
}

for (const r of results) {
  if (!r.ok) { console.error(`FAIL ${r.host} :: ${r.error}`); continue; }
  const c = r.content;
  const fields = Object.entries(c.map.fields).map(([k, v]) => `${k}=${v.confidence}${v.selector || v.strategy ? "" : " (MISSING)"}`).join(" ");
  console.error(`OK ${r.host} [${c.profile ? "profile:" + c.profile : "full-classify"}]\n   ${fields}`);
  if (c.map.ambiguous.length) console.error(`   ambiguous needs human: ${c.map.ambiguous.join("; ")}`);
}
// Explicit opt-in file output only: the single successful host's discovery
// content (same shape as the legacy maps/<host>.json files, so --map accepts
// it). Exact snapshot of this run — no merge with previous files (the old
// automap write:true merge lived in maps/ and is gone from this path).
// Never called from the normal upload flow.
if (DUMP) {
  const good = results.filter((r) => r.ok);
  if (results.length !== 1 || !good.length) fail(`--dump-map needs exactly one successful host (got ${results.length} host(s), ${good.length} ok)`);
  try {
    mkdirSync(dirname(resolve(DUMP)), { recursive: true });
    writeFileSync(DUMP, JSON.stringify(good[0].content, null, 1), "utf8");
  } catch (e) { fail(`cannot write --dump-map ${DUMP}: ${e.message}`); }
  console.error(`wrote discovery snapshot: ${DUMP} (exact, no merge)`);
}
console.log(JSON.stringify(results, null, 1));
console.error("done - default wrote zero files; pass the snapshot via --map only as an explicit manual escape hatch for upload-people.mjs");
const failed = results.some((r) => !r.ok);
await browser.close().catch(() => null);
process.exit(failed ? 1 : 0);
