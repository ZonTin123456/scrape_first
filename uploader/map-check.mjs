#!/usr/bin/env node
// map-check: READ-ONLY dump of the currently open backend form tab via CDP.
// Usage: node map-check.mjs [--port 9444] [--match personal] [--out field-dump.json]
// Never submits anything. Open the create/edit form tab first, then run.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
if (argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node map-check.mjs [--port auto] [--match personal] [--out field-dump.json]");
  process.exit(2);
}
import { resolvePort } from "./lib/cdp-port.mjs";
const PORT = await resolvePort(opt("--port", "auto")).catch((e) => fail(e.message));
const MATCH = opt("--match", "personal");
const OUT = opt("--out", "field-dump.json");
const fail = (m) => { console.error("map-check: " + m); process.exit(1); };

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((e) => fail(`connect port ${PORT}: ${e.message}`));
const contexts = browser.contexts();
const pages = contexts.flatMap((c) => c.pages());
if (!pages.length) fail("no open tabs found");
let page = pages.find((p) => p.url().includes(MATCH)) || pages[0];
console.log(`dumping tab: ${page.url()}`);

const dump = await page.evaluate(() => {
  const q = (sel) => [...document.querySelectorAll(sel)];
  return {
    url: location.href,
    title: document.title,
    forms: [...document.forms].map((f) => ({
      action: f.action, method: f.method,
      elements: [...f.elements].map((e) => ({
        tag: e.tagName, type: e.type || null, name: e.name || null, id: e.id || null,
        accept: e.accept || null, placeholder: (e.placeholder || "").slice(0, 60),
        required: !!e.required,
      })),
    })),
    selects: q("select").map((s) => ({
      name: s.name || null, id: s.id || null,
      options: [...s.options].map((o) => o.text.trim()).filter(Boolean),
    })),
    fileInputs: q('input[type="file"]').map((e) => ({ name: e.name || null, id: e.id || null, accept: e.accept || null })),
    buttons: q("button, input[type=submit]").slice(0, 15).map((e) => ({
      tag: e.tagName, type: e.type || null, text: (e.innerText || e.value || "").trim().slice(0, 60),
    })),
    labels: q("label").slice(0, 40).map((e) => e.innerText.trim().slice(0, 80)).filter(Boolean),
    images: document.images.length,
  };
});
writeFileSync(OUT, JSON.stringify(dump, null, 1), "utf8");
console.log(`wrote ${OUT} — paste the selectors into field-map.json and set _status to "locked"`);
process.exit(0);
