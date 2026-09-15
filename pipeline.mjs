#!/usr/bin/env node
// pipeline: one command for the whole chain, steps in any order you choose.
//   node pipeline.mjs --from urls.txt [--steps probe,pick-links,run,pick-images,finalize,upload]
// Human steps (pick-links / pick-images / review-before-finalize) pause for you
// to tick in the browser; --serve is started automatically so "บันทึกเลย" writes
// straight to disk. --yes accepts all defaults and skips every pause.
// Needs: Node 18+, Chrome on CDP (see backup-page.mjs --help).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const fail = (m) => { console.error("pipeline: " + m); process.exit(1); };
if (!argv.length || has("-h") || has("--help")) {
  console.log("Usage: node pipeline.mjs --from urls.txt [--steps probe,pick-links,run,pick-images,finalize,upload] [--out ./out]");
  console.log("  backup-page flags passed through: --port --timeout --via --cf-wait --no-cf-manual");
  console.log("  upload flags passed through: --backend --map --limit --save --i-verified");
  console.log("  --serve-port 9334 (auto-started for ticking; --no-serve to disable)");
  console.log("  --yes: accept defaults, skip all human pauses");
  process.exit(2);
}
const ALL = ["probe", "pick-links", "run", "pick-images", "finalize", "upload"];
const steps = String(opt("--steps", ALL.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
for (const s of steps) if (!ALL.includes(s)) fail(`unknown step ${s} (want ${ALL.join("|")})`);
const FROM = opt("--from", null);
if (!FROM) fail("missing --from urls.txt");
const OUT = opt("--out", "./out");
const YES = has("--yes");
const BP = [ // flags passed to backup-page.mjs
  ...["--port", "--timeout", "--via", "--cf-wait"].flatMap((f) => argv.includes(f) ? [f, opt(f, "")] : []),
  ...(has("--no-cf-manual") ? ["--no-cf-manual"] : []),
];
const UP = [ // flags passed to upload-people.mjs
  ...["--backend", "--map", "--limit"].flatMap((f) => argv.includes(f) ? [f, opt(f, "")] : []),
  ...(has("--save") ? ["--save"] : []),
  ...(has("--i-verified") ? ["--i-verified"] : []),
];
const STAGING = "_staging";
const stagingFile = (...p) => join(HERE, OUT, STAGING, ...p);

function sh(nodeArgs, cwd = HERE) {
  console.log(`\n$ node ${nodeArgs.join(" ")}`);
  const r = spawnSync("node", nodeArgs, { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(`step failed (exit ${r.status}): node ${nodeArgs.slice(0, 3).join(" ")}`);
}
function pause(msg) {
  if (YES) { console.log(`( --yes: skip pause: ${msg} )`); return; }
  process.stdout.write(`\n${msg} [Enter] `);
  readFileSync(0); // block until Enter (stdin raw bytes, no readline needed)
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

let serveChild = null;
function serveStart() {
  if (has("--no-serve") || serveChild) return;
  const port = opt("--serve-port", "9334");
  serveChild = spawn("node", ["backup-page.mjs", "--serve", "--serve-port", port, "--out", OUT],
    { cwd: HERE, stdio: "ignore", detached: false });
  console.log(`serve: tick pages at http://127.0.0.1:${port}/ ("บันทึกเลย" writes straight to disk)`);
}
function serveStop() { try { serveChild?.kill(); } catch { /* noop */ } serveChild = null; }
process.on("SIGINT", () => { serveStop(); process.exit(130); });

try {
  for (const s of steps) {
    if (s === "probe") {
      sh(["backup-page.mjs", "--probe", "--from", FROM, "--out", OUT, ...BP]);
    } else if (s === "pick-links") {
      serveStart();
      pause(`ชั้น 1 — ติ๊กลิงก์ใน pick-links.html แล้วกด "บันทึกเลย" เสร็จแล้วกลับมากด Enter`);
    } else if (s === "run") {
      const picked = stagingFile("picked-links.json");
      if (!existsSync(picked)) fail(`missing ${picked} (run probe + pick-links first, or re-add those steps)`);
      sh(["backup-page.mjs", "--run", "--from", picked, "--out", OUT, ...BP]);
    } else if (s === "pick-images") {
      serveStart();
      pause(`ชั้น 2 — ติ๊กรูปในแต่ละ pick-images.html แล้วกด "บันทึกเลย" เสร็จแล้วกลับมากด Enter`);
    } else if (s === "finalize") {
      const summary = join(HERE, OUT, "summary.json");
      let dirs = [];
      if (existsSync(summary)) {
        dirs = readJson(summary).results.filter((r) => !r.error && r.dir).map((r) => resolve(HERE, r.dir));
      }
      if (!dirs.length) fail(`nothing to finalize (missing ${summary} — run the run step first)`);
      for (const d of dirs) {
        if (!existsSync(join(d, "review", "selection.json"))) {
          console.log(`finalize: skip ${d} (no review/selection.json — keep-all default already written by run)`);
        }
        sh(["backup-page.mjs", "--finalize", d]);
      }
    } else if (s === "upload") {
      const summary = join(HERE, OUT, "summary.json");
      if (!existsSync(summary)) fail(`missing ${summary} (nothing to upload)`);
      const subs = readJson(summary).results.filter((r) => !r.error && r.dir);
      if (!subs.length) fail("no successful scrapes to upload");
      for (const r of subs) {
        const people = resolve(HERE, r.dir, "people.json");
        if (!existsSync(people)) { console.log(`upload: skip ${r.dir} (no people.json)`); continue; }
        sh(["uploader/upload-people.mjs", "--from", people, ...UP], join(HERE, "uploader"));
      }
    }
  }
} finally {
  serveStop();
}
console.log("\npipeline: done.");
