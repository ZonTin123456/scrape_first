#!/usr/bin/env node
// pipeline: one command for the whole chain, steps in any order you choose.
//   node pipeline.mjs --from urls.txt [--steps probe,pick-links,master,apply-master,run,finalize,upload]
// Human steps pause for you to tick pages opened straight from disk
// (File Picker buttons save over the real files, no server needed).
// --yes accepts all defaults and skips every pause.
// Needs: Node 18+, Chrome on CDP (see backup-page.mjs --help).
import { spawnSync } from "node:child_process";
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
  console.log("Usage: node pipeline.mjs --from urls.txt [--steps probe,pick-links,master,apply-master,run,finalize,upload] [--out ./out]");
  console.log("  backup-page flags passed through: --port --timeout --via --cf-wait --no-cf-manual");
  console.log("  upload flags passed through: --backend --map --limit --save --i-verified --dry-proof --strict-sections");
  console.log("  finalize flag passed through: --compact-orders (squeeze kept orders dense 0..N)");
  console.log("  --order a,b,c: fire matching slugs first (upload step; rest keep summary order)");
  console.log("  --yes: accept defaults, skip all human pauses");
  console.log("  (pick-images step still available for per-page ticking instead of master)");
  process.exit(2);
}
const ALL = ["probe", "pick-links", "master", "apply-master", "run", "pick-images", "finalize", "upload"];
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
// section overrides must reach the --run step too: backup-page.mjs only
// auto-loads sections.json next to --from (skipped for picked-*.json),
// so pass the repo one explicitly unless the user gave their own.
if (!has("--page-sections") && existsSync(join(HERE, "sections.json"))) {
  BP.push("--page-sections", join(HERE, "sections.json"));
}
const UP = [ // flags passed to upload-people.mjs
  ...["--backend", "--map", "--limit", "--dry-proof"].flatMap((f) => argv.includes(f) ? [f, opt(f, "")] : []),
  ...(has("--save") ? ["--save"] : []),
  ...(has("--i-verified") ? ["--i-verified"] : []),
  ...(has("--yes") ? ["--yes"] : []),
  ...(has("--strict-sections") ? ["--strict-sections"] : []),
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

// --order a,b,c: substring match against slug (then url), first-match wins.
// Subs nobody matched keep original order appended after. Unknown tokens warn.
function orderSubs(subs, orderRaw) {
  const tokens = String(orderRaw || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return subs;
  const rest = [...subs], out = [];
  for (const t of tokens) {
    const i = rest.findIndex((r) =>
      String(r.slug || "").toLowerCase().includes(t) || String(r.url || "").toLowerCase().includes(t));
    if (i < 0) { console.log(`upload: warn: --order token "${t}" matches nothing`); continue; }
    out.push(rest.splice(i, 1)[0]);
  }
  return [...out, ...rest];
}
function peopleCount(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, "people.json"), "utf8"));
    return Array.isArray(p) ? p.length : "?";
  } catch { return "?"; }
}

for (const s of steps) {
    if (s === "probe") {
      sh(["backup-page.mjs", "--probe", "--from", FROM, "--out", OUT, ...BP]);
    } else if (s === "pick-links") {
      pause(`ชั้น 1 — เปิด ${stagingFile("pick-links.html")} ติ๊กลิงก์ กด "บันทึกทับไฟล์เดิม" แล้วกลับมากด Enter`);
    } else if (s === "master") {
      pause(`ติ๊กรวม — เปิด ${stagingFile("master-pick.html")} ติ๊กครั้งเดียว กด "บันทึกทับไฟล์เดิม" (master.json) แล้วกลับมากด Enter`);
    } else if (s === "apply-master") {
      const master = stagingFile("master.json");
      if (!existsSync(master)) fail(`missing ${master} (probe writes a default one — run probe + master first)`);
      sh(["backup-page.mjs", "--apply-master", master, "--out", OUT]);
    } else if (s === "run") {
      const picked = stagingFile("picked-links.json");
      if (!existsSync(picked)) fail(`missing ${picked} (run probe + pick-links first, or re-add those steps)`);
      sh(["backup-page.mjs", "--run", "--from", picked, "--out", OUT, ...BP]);
    } else if (s === "pick-images") {
      pause(`ชั้น 2 — เปิดแต่ละ pick-images.html ใน ${stagingFile()} ติ๊ก กด "บันทึกทับไฟล์เดิม" แล้วกลับมากด Enter`);
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
        sh(["backup-page.mjs", "--finalize", d, ...(has("--compact-orders") ? ["--compact-orders"] : [])]);
      }
    } else if (s === "upload") {
      const summary = join(HERE, OUT, "summary.json");
      if (!existsSync(summary)) fail(`missing ${summary} (nothing to upload)`);
      const subs = readJson(summary).results.filter((r) => !r.error && r.dir);
      if (!subs.length) fail("no successful scrapes to upload");
      const queue = orderSubs(subs, opt("--order", ""));
      console.log("upload queue:");
      queue.forEach((r, i) => console.log(`  ${i + 1}. ${r.slug || r.dir} (${peopleCount(resolve(HERE, r.dir))} rows)${r.url ? " <" + r.url + ">" : ""}`));
      for (const r of queue) {
        const people = resolve(HERE, r.dir, "people.json");
        if (!existsSync(people)) { console.log(`upload: skip ${r.dir} (no people.json)`); continue; }
        sh([join(HERE, "uploader", "upload-people.mjs"), "--from", people, ...UP]);
      }
    }
}
console.log("\npipeline: done.");
