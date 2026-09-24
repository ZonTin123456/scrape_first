/* app.js — dashboard logic for the backup -> upload pipeline.
   Talks to ui/server.mjs. Renders every pipeline step, streams job output over
   SSE, supports drag & drop (urls.txt, people.json batch -> upload queue,
   reorder photos and reorder queue rows) and whole-card ticking. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let S = null;
let current = null; // running job
let es = null;
let reports = {};                 // slug -> upload report
const probeCache = new Map();     // slug -> {probe, picked}
const reviewCache = new Map();    // slug -> {candidates, ...}
let plans = {};                   // slug -> what the last dry-run said about the backend department

const form = {
  urls: null,
  port: "auto", via: "auto", cfWait: "60",
  backend: "", limit: "", map: "", to: "", strict: false,
  compact: true,
  iVerified: false, confirmSlug: null, confirmText: "",
  imageSlug: null, reviewSlug: null,
  queue: [],                                          // [{slug, rows}] drop order — memory only, by design
  queueConfirm: false, queueText: "", queueVerified: false,
  groupNames: {},                                     // url -> edited backend name (unsaved typing)
};

const QUEUE_PHRASE = "ยิงจริง"; // must match QUEUE_CONFIRM in ui/server.mjs

// ---------- api ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

// ---------- toast ----------
let toastT;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3400);
}

// ---------- console ----------
function logLine(text, cls) {
  const l = $("#log");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  l.appendChild(span);
  l.scrollTop = l.scrollHeight;
}
function setJobStatus(text, kind = "") {
  const p = $("#job-status");
  p.textContent = text;
  p.className = "pill small " + kind;
}
function showKill(on) {
  $("#btn-kill").hidden = !on;
}

// ---------- job runner ----------
async function runJob(step, opts, label, payload = null) {
  if (current && !current.done) { toast("มีงานกำลังรันอยู่ รอให้เสร็จก่อน", "err"); return; }
  let info;
  try { info = await post("/api/job", payload || { step, opts }); }
  catch (e) { toast(e.message, "err"); logLine("✖ " + e.message + "\n", "err"); $("#console").classList.remove("collapsed"); return; }
  current = { id: info.id, step, label, done: false, planSlug: step === "upload" ? opts?.slug || null : null, planBuf: "" };
  setJobStatus("กำลังรัน: " + (label || step), "warn");
  showKill(true);
  logLine(`\n$ ${info.line}\n`, "sys");
  $("#console").classList.remove("collapsed");
  if (es) es.close();
  es = new EventSource(`/api/job/${info.id}`);
  es.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === "out") {
      logLine(d.text);
      if (current?.planSlug) { current.planBuf += d.text; parsePlan(current.planSlug, current.planBuf); }
    } else if (d.type === "err") logLine(d.text, "err");
    else if (d.type === "step") {
      current.planSlug = d.slug; current.planBuf = "";
      setJobStatus(`รายการ ${d.index}/${d.total}: ${d.slug}`, "warn");
      logLine(`\n===== [${d.index}/${d.total}] ${d.slug} — ${d.save ? "ยิงจริง" : "dry-run"} =====\n`, "sys");
    } else if (d.type === "exit") {
      current.done = true;
      setJobStatus(d.code === 0 ? "เสร็จแล้ว" : `ผิดพลาด (exit ${d.code})`, d.code === 0 ? "ok" : "err");
      logLine(`\n— จบการทำงาน (exit ${d.code}) —\n`, d.code === 0 ? "sys" : "err");
      showKill(false);
      if (es) { es.close(); es = null; }
      afterJob(step, opts, payload);
    }
  };
  es.onerror = () => { if (current && current.done && es) { es.close(); es = null; } };
}

// The uploader's dry-run plan is the only honest evidence about the backend:
//   - group "X" -> <url> (existing)   = แผนกนี้มีอยู่แล้วบน backend
//   - WOULD-CREATE department "X"      = ยังไม่มี ตอน --save จะสร้างใหม่
// We only surface what the script actually printed — never guess.
function parsePlan(slug, buf) {
  if (!slug) return;
  const create = /WOULD-CREATE department "([^"]+)"/.exec(buf);
  if (create) { plans[slug] = { action: "create", name: create[1] }; return; }
  const exist = /- group "([^"]+)" -> (\S+) \(existing\)/.exec(buf);
  if (exist) plans[slug] = { action: "existing", name: exist[1], target: exist[2] };
}

async function afterJob(step, opts, payload) {
  // refresh the report of every slug the job touched (single run or whole queue)
  const slugs = payload?.steps ? payload.steps.map((s) => s?.opts?.slug).filter(Boolean) : (opts?.slug ? [opts.slug] : []);
  for (const s of slugs) {
    try { reports[s] = (await api("/api/report/" + s)).report; } catch { /* no report */ }
  }
  probeCache.clear();
  reviewCache.clear();
  await load();
}

const contentPages = () => (S?.pages || []).filter((p) => p.hasContent);
// The name shown for a page IS the backend target group name (source-groups.json
// alias when set, otherwise the page's own stable slug identity).
const groupName = (o) => (o?.group && String(o.group).trim()) || o?.slug || "";
const nameVal = (o) => form.groupNames[o?.url] ?? o?.alias ?? "";

// ---------- state ----------
async function load() {
  try { S = await api("/api/state"); }
  catch (e) { toast("โหลดสถานะไม่ได้: " + e.message, "err"); return; }
  if (form.urls === null) form.urls = S.urls || "";
  if (!form.imageSlug && S.probes.length) form.imageSlug = S.probes[0].slug;
  if (form.reviewSlug && !contentPages().some((p) => p.slug === form.reviewSlug)) form.reviewSlug = null;
  if (!form.reviewSlug && contentPages().length) form.reviewSlug = contentPages()[0].slug;
  render();
}

// ---------- option helpers ----------
function netOpts() {
  return { port: form.port || undefined, via: form.via || undefined, cfWait: form.cfWait || undefined };
}
function uploadOpts(slug, save) {
  return {
    slug, save,
    port: form.port || undefined,
    backend: form.backend.trim() || undefined,
    limit: form.limit.trim() || undefined,
    map: form.map.trim() || undefined,
    to: form.to.trim() || undefined,
    strictSections: !!form.strict,
    iVerified: !!form.iVerified,
  };
}
const field = (key, label, extra = "") =>
  `<label class="field"><span>${label}</span><input data-form="${key}" value="${esc(form[key] ?? "")}" ${extra}></label>`;
const selectField = (key, label, options) =>
  `<label class="field"><span>${label}</span><select data-form="${key}">${options.map(([v, t]) => `<option value="${esc(v)}" ${form[key] === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;

// ---------- per-card renderers ----------
// ชื่อหน่วยงานปลายทาง — 1 URL = 1 หน่วยงานบน backend (ไฟล์ source-groups.json)
function groupNameTable() {
  const rows = S.urlRows || [];
  if (!rows.length) return `<div class="section-title">ชื่อหน่วยงานปลายทางบน backend</div><div class="empty">ยังไม่มี URL — ใส่รายการด้านบนก่อน</div>`;
  return `<div class="section-title">ชื่อหน่วยงานปลายทางบน backend (${rows.length})</div>
    <p class="hint">การยิงจริงจะใช้/สร้างแผนกตามชื่อนี้ · เว้นว่าง = ใช้ชื่อเดิมจาก slug · เก็บใน <code>source-groups.json</code></p>
    <table><thead><tr><th>URL (หน้านี้)</th><th style="width:36%">ชื่อหน่วยงานปลายทาง</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><b>${esc(r.slug)}</b><div class="u">${esc(r.url)}</div></td>
      <td><input data-group-url="${esc(r.url)}" value="${esc(nameVal(r))}" placeholder="${esc(r.slug)}" maxlength="80">
        <div class="u">${r.alias ? `ตั้งไว้: ${esc(r.group)}` : "ยังไม่ได้ตั้ง — ใช้ชื่อจาก slug"}</div></td>
    </tr>`).join("")}
    </tbody></table>
    <div class="row" style="margin-top:12px"><button data-action="save-groups">บันทึกชื่อหน่วยงาน</button>
      <span class="muted">มีผลกับทุกการอัปโหลดที่มาจาก URL เหล่านี้ (รวมรายการที่ลากเข้าคิวในการ์ด 9)</span></div>`;
}

function cardUrls() {
  const n = (form.urls || "").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  return `<div class="card">
    <div class="card-head"><span class="num">1</span>
      <div><h2>วางรายการ URL</h2><p>ลากไฟล์ <code>urls.txt</code> มาวาง หรือพิมพ์/วาง URL ทีละบรรทัด</p></div>
      <span class="spacer"></span><span class="badge ${n ? "ok" : ""}">${n} URL</span></div>
    <div class="card-body">
      <div class="dropzone" id="drop-urls"><strong>ลากไฟล์ urls.txt มาวางที่นี่</strong>หรือคลิกเพื่อเลือกไฟล์ (.txt)</div>
      <input type="file" id="file-urls" accept=".txt,text/plain" hidden>
      <textarea id="urls" data-form="urls" rows="6" placeholder="https://www.example.go.th/page.php" style="margin-top:12px">${esc(form.urls ?? "")}</textarea>
      <div class="row" style="margin-top:12px">
        <button data-action="save-urls">บันทึก urls.txt</button>
        <span class="muted">มี ${(S.urlList || []).length} URL ในไฟล์ ${S.urlList.length ? "" : "(ยังว่าง)"}</span>
      </div>
      ${groupNameTable()}
    </div>
  </div>`;
}

function cardProbe() {
  const failed = (S.failed || []).length;
  return `<div class="card">
    <div class="card-head"><span class="num">2</span>
      <div><h2>Probe — สแกนหาลิงก์</h2><p>ดึงเฉพาะ metadata (ลิงก์/นับรูป) ยังไม่โหลดรูปลงเครื่อง</p></div>
      <span class="spacer"></span>${(S.links.length ? `<span class="badge ok">${S.links.length} หน้า</span>` : "")}</div>
    <div class="card-body">
      <div class="grid cols-3">
        ${field("port", "พอร์ต Chrome CDP", 'placeholder="auto"')}
        ${selectField("via", "วิธีดึงรูป", [["auto", "auto (แนะนำ)"], ["fetch", "fetch"], ["cdp", "cdp"]])}
        ${field("cfWait", "รอ Cloudflare (วินาที)", 'type="number" min="0"')}
      </div>
      <p class="hint">ค่าเชื่อมต่อนี้ใช้ร่วมกับขั้นตอน “Run” ด้านล่าง · ต้องเปิด Chrome ด้วย <code>--remote-debugging-port=9333</code> ก่อน</p>
      <div class="row" style="margin-top:12px">
        <button data-action="run-probe">รัน probe</button>
        <span class="muted">อ่าน URL จาก urls.txt</span>
      </div>
      ${failed ? `<div class="callout danger" style="margin-top:14px"><b>${failed} หน้าโหลดไม่สำเร็จ</b><br>${S.failed.map((f) => `<span class="u">${esc(f.url)} — ${esc(f.error)}</span>`).join("<br>")}</div>` : ""}
    </div>
  </div>`;
}

function cardLinks() {
  if (!S.links.length) return `<div class="card">
    <div class="card-head"><span class="num">3</span><div><h2>เลือกหน้าจะโหลด</h2><p>ติ๊กลิงก์ที่ต้องการ</p></div></div>
    <div class="card-body"><div class="empty">ยังไม่มีข้อมูล probe — รัน probe ก่อน</div></div></div>`;
  const rows = S.links.map((l) => `<tr>
    <td><input type="checkbox" data-link="${esc(l.slug)}" ${l.keep ? "checked" : ""}></td>
    <td><b>${esc(l.title || "(ไม่มีชื่อ)")}</b><div class="u">${esc(l.url)}</div></td>
    <td><span class="badge">ข้อความ ${l.counts.text ?? "?"}</span> <span class="badge">รูป ${l.images}</span></td>
  </tr>`).join("");
  const kept = S.links.filter((l) => l.keep).length;
  return `<div class="card">
    <div class="card-head"><span class="num">3</span>
      <div><h2>เลือกหน้าจะโหลด</h2><p>ติ๊กลิงก์ที่ต้องการ แล้วบันทึก (ใช้กับขั้นตอน Run)</p></div>
      <span class="spacer"></span><span class="badge ${kept ? "ok" : "warn"}">เลือก ${kept}/${S.links.length}</span></div>
    <div class="card-body">
      <div class="row" style="margin-bottom:10px">
        <button class="ghost small" data-action="links-all">เลือกทั้งหมด</button>
        <button class="ghost small" data-action="links-none">ไม่เลือกเลย</button>
      </div>
      <table><thead><tr><th style="width:44px">เอา</th><th>เว็บ</th><th>ปริมาณ</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="row" style="margin-top:12px"><button data-action="save-links">บันทึก picked-links.json</button></div>
    </div>
  </div>`;
}

function cardMaster() {
  const m = S.master;
  return `<div class="card">
    <div class="card-head"><span class="num">4</span>
      <div><h2>ติ๊กรวมรูปซ้ำทุกหน้า <span class="badge">ทางเลือก</span></h2><p>ติ๊กครั้งเดียวใช้กับทุกหน้า (รูปไอคอน/แบนเนอร์ที่ซ้ำกัน)</p></div></div>
    <div class="card-body">
      ${!m || !m.groups.length ? `<div class="empty">ยังไม่มีรูปไม่ซ้ำ — รัน probe ก่อน</div>` : `
        <div class="row"><span class="muted">พบ ${m.groups.length} รูปไม่ซ้ำใน ${m.pages.length} หน้า</span>
          <span class="spacer"></span>
          <button class="ghost small" data-action="master-all">เลือกทั้งหมด</button>
          <button class="ghost small" data-action="master-none">ไม่เลือกเลย</button></div>
        <details style="margin-top:10px"><summary>แสดงรายการรูป (${m.groups.length})</summary>
        <div class="imgs" style="margin-top:12px">${m.groups.map((g) => `<figure class="pic">
          <img src="${esc(g.src)}" loading="lazy" onerror="this.style.visibility='hidden'">
          <figcaption><b>${esc(g.names.slice(0, 2).join(" | ") || "(ไม่มีชื่อ)")}</b>
            ${g.width}x${g.height}<br>${g.pages.length} หน้า</figcaption>
          <label class="check"><input type="checkbox" data-master="${esc(g.src)}" ${g.keep ? "checked" : ""}> โหลดรูปนี้</label>
        </figure>`).join("")}</div></details>
        <div class="row" style="margin-top:14px">
          <button data-action="save-master">บันทึก master.json</button>
          <button class="ghost" data-action="run-apply-master">ใช้กับการเลือกทีละหน้า (apply-master)</button>
        </div>`}
    </div>
  </div>`;
}

function cardPickImages() {
  if (!S.probes.length) return `<div class="card">
    <div class="card-head"><span class="num">5</span><div><h2>เลือกรูปที่จะโหลด (รายหน้า)</h2><p>ตัดไอคอน/ป้ายที่ไม่ต้องการก่อนดึงจริง</p></div></div>
    <div class="card-body"><div class="empty">ยังไม่มีข้อมูล — รัน probe ก่อน</div></div></div>`;
  const opts = S.probes.map((p) => `<option value="${esc(p.slug)}" ${form.imageSlug === p.slug ? "selected" : ""}>${esc(p.slug)} — เก็บ ${p.keeps} รูป</option>`).join("");
  return `<div class="card">
    <div class="card-head"><span class="num">5</span>
      <div><h2>เลือกรูปที่จะโหลด (รายหน้า) <span class="badge">ทางเลือก</span></h2><p>ถ้าไม่ติ๊ก ขั้นตอน Run จะโหลดรูปรอไว้ทั้งหมดตาม master</p></div>
      <span class="spacer"></span><span class="badge">${S.probes.length} หน้า</span></div>
    <div class="card-body">
      <label class="field"><span>เลือกหน้า</span><select id="pick-slug">${opts}</select></label>
      <div id="pick-grid"><div class="empty">กำลังโหลด…</div></div>
      <div class="row" style="margin-top:12px">
        <button data-action="save-images">บันทึกรูปที่เลือก (picked-images.json)</button>
        <span class="muted" id="pick-count"></span>
      </div>
    </div>
  </div>`;
}

function cardRun() {
  return `<div class="card">
    <div class="card-head"><span class="num">6</span>
      <div><h2>Run — ดึงหน้าจริง + รูป</h2><p>สร้าง <code>out/&lt;slug&gt;/content.json</code>, <code>people.json</code> และหน้าติ๊กคน</p></div>
      <span class="spacer"></span>${contentPages().length ? `<span class="badge ok">${contentPages().length} หน้าเสร็จ</span>` : ""}</div>
    <div class="card-body">
      <p class="hint">ใช้ค่าเชื่อมต่อจากขั้นตอน Probe · ใช้เฉพาะหน้าที่ติ๊กไว้ในขั้นตอน 3</p>
      <div class="row" style="margin-top:12px"><button data-action="run-run">รัน run (ดึงทุกหน้าที่ติ๊ก)</button></div>
      ${contentPages().length ? `<div class="section-title">ผลลัพธ์</div>
        <table><thead><tr><th>หน้า</th><th>รูป</th><th>คน (แถว)</th><th>ติ๊กคนแล้ว</th></tr></thead><tbody>
        ${contentPages().map((p) => `<tr><td><b>${esc(groupName(p))}</b><div class="u">${esc(p.slug)} · ${esc(p.title)}</div></td>
          <td>${p.counts.image ?? "?"}</td><td>${p.people ?? "?"}</td>
          <td>${p.hasSelection ? '<span class="badge ok">มี</span>' : '<span class="badge warn">ยังไม่มี</span>'}</td></tr>`).join("")}
        </tbody></table>` : ""}
    </div>
  </div>`;
}

function cardReview() {
  if (!contentPages().length) return `<div class="card">
    <div class="card-head"><span class="num">7</span><div><h2>ติ๊กรูปคน + จัดลำดับ</h2><p>เลือกรูปที่จะอัปโหลด</p></div></div>
    <div class="card-body"><div class="empty">ยังไม่มีหน้า — รัน run ก่อน</div></div></div>`;
  const opts = contentPages().map((p) => `<option value="${esc(p.slug)}" ${form.reviewSlug === p.slug ? "selected" : ""}>${esc(groupName(p))}${p.group && p.group !== p.slug ? ` (${esc(p.slug)})` : ""} — ${p.people ?? "?"} แถว</option>`).join("");
  return `<div class="card">
    <div class="card-head"><span class="num">7</span>
      <div><h2>ติ๊กรูปคน + จัดลำดับ</h2><p>ติ๊กเฉพาะรูปคนชัด · ลากการ์ดเพื่อจัดลำดับ (เลขตำแหน่งภาพอัปเดตตาม)</p></div></div>
    <div class="card-body">
      <label class="field"><span>เลือกหน้า</span><select id="review-slug">${opts}</select></label>
      <div class="row" style="margin-bottom:10px">
        <button class="ghost small" data-action="review-all">เลือกทั้งหมด</button>
        <button class="ghost small" data-action="review-none">ไม่เลือกเลย</button>
        <span class="spacer"></span>
        <span class="muted">ตั้งเลขให้ใบที่ติ๊ก:</span>
        <input id="bulk-ord" type="number" min="0" value="0" style="width:70px">
        <button class="ghost small" data-action="bulk-order">ตั้งเลข</button>
      </div>
      <div id="review-grid"><div class="empty">กำลังโหลด…</div></div>
      <div class="row" style="margin-top:12px">
        <button data-action="save-review">บันทึก selection.json</button>
        <span class="muted" id="review-count"></span>
      </div>
      <div class="callout warn">ติ๊กไม่ครบแล้วกด Finalize จะลบรูปนั้นถาวร — ตรวจให้ครบก่อน</div>
    </div>
  </div>`;
}

function cardFinalize() {
  return `<div class="card">
    <div class="card-head"><span class="num">8</span>
      <div><h2>Finalize — ตัดรูปที่ไม่เลือก + จัดลำดับ</h2><p>ลบรูปที่ไม่ติ๊กในทุกหน้า แล้วสร้าง people.json สุดท้าย</p></div></div>
    <div class="card-body">
      <label class="check"><input type="checkbox" data-form="compact" ${form.compact ? "checked" : ""}> บีบเลขตำแหน่งภาพให้เรียงติดกัน 0,1,2,… (compact-orders)</label>
      <div class="row" style="margin-top:12px">
        <button data-action="run-finalize">รัน finalize ทั้งหมด</button>
        <button class="ghost" data-action="run-regen-review">สร้างหน้าติ๊กใหม่ (regen-review)</button>
      </div>
      <p class="hint">ย้อนกลับไม่ได้ — ถ้าติ๊กผิดให้รัน run ใหม่</p>
    </div>
  </div>`;
}

function reportBlock(slug) {
  const r = reports[slug];
  if (!r) return "";
  const by = r.by_status || {};
  const badges = Object.entries(by).map(([k, v]) => `<span class="badge ${k === "failed" ? "err" : k.startsWith("created") ? "ok" : ""}">${esc(k)} ${v}</span>`).join(" ");
  const failedRows = (r.results || []).filter((x) => x.status === "failed" || String(x.status || "").includes("partial"));
  return `<div class="callout ${by.failed ? "danger" : ""}" style="margin-top:10px">
    <b>Report:</b> โหมด ${esc(r.mode)} · ทั้งหมด ${r.total} · ${badges}
    ${failedRows.length ? `<div style="margin-top:6px">${failedRows.map((x) => `<div class="u">${esc(x.name || "?")} (#${x.order ?? "?"}) — ${esc(x.status)}: ${esc(String(x.detail || "").slice(0, 120))}</div>`).join("")}</div>` : ""}
  </div>`;
}

// ---------- upload queue (memory only: a refresh clears it, by design) ----------
function queueRows() {
  const by = new Map(S.pages.map((p) => [p.slug, p]));
  return form.queue.map((q) => {
    const p = by.get(q.slug);
    return {
      slug: q.slug, rows: p?.people ?? q.rows ?? null, hasSelection: !!p?.hasSelection, known: !!p,
      url: p?.url || "", group: p?.group || q.slug, alias: p?.alias ?? null,
    };
  });
}

// what the last dry-run reported for this slug: a plan is the only real evidence
// about whether the backend already has that department name.
function planBadge(slug) {
  const p = plans[slug];
  if (!p) return "";
  return p.action === "create"
    ? `<span class="badge warn">จะสร้างแผนกใหม่: ${esc(p.name)}</span>`
    : `<span class="badge ok">เข้าแผนกที่มีอยู่: ${esc(p.name)}</span>`;
}
function planLine(slug) {
  const p = plans[slug];
  if (!p) return "";
  return p.action === "create"
    ? `จะสร้างแผนกใหม่ชื่อ “${p.name}” (ถ้าไม่จริง ไปแก้ชื่อที่การ์ด 1)`
    : `เข้าแผนกที่มีอยู่ “${p.name}”`;
}
const queueSteps = (save) => form.queue.map((q) => ({ step: "upload", opts: uploadOpts(q.slug, save) }));

function queueBadge(slug) {
  const r = reports[slug];
  if (!r) return "";
  const failed = r.by_status?.failed || 0;
  return `<span class="badge ${failed ? "err" : "ok"}">${r.mode === "save" ? "ยิงจริง" : "dry"} · ${failed ? `ล้ม ${failed}` : "ผ่าน"} · ${r.total} แถว</span>`;
}

function queueListHtml(q) {
  if (!q.length) return `<div class="empty">ยังไม่มีรายการในคิว — ลาก people.json มาวาง หรือกด “เพิ่มทุกหน้าจากตาราง”</div>`;
  return `<ol id="queue-list" class="queue">${q.map((x, i) => `<li data-qslug="${esc(x.slug)}" draggable="true" title="ลากเพื่อสลับลำดับ">
    <span class="grip" aria-hidden="true">⠿</span>
    <span class="q-idx">${i + 1}</span>
    <span class="q-name"><b>${esc(x.group)}</b><div class="u">${esc(x.slug)} · ${x.rows ?? "?"} แถว · ${x.hasSelection ? "ติ๊กคนแล้ว" : "ยังไม่ติ๊กคน"}${x.known ? "" : " · ไม่พบ people.json"}</div>
      ${x.url
        ? `<input class="q-rename" data-group-url="${esc(x.url)}" value="${esc(nameVal(x))}" placeholder="${esc(x.slug)}" maxlength="80" title="ชื่อหน่วยงานปลายทางบน backend">`
        : `<div class="u">ไม่มี source_url ใน people.json — เปลี่ยนชื่อไม่ได้</div>`}
    </span>
    ${planBadge(x.slug)} ${queueBadge(x.slug)}
    <button class="ghost small" data-action="queue-remove" data-slug="${esc(x.slug)}" title="เอาออกจากคิว">✕</button>
  </li>`).join("")}</ol>`;
}

function cardUpload() {
  const pages = S.pages.filter((p) => p.people != null);
  const inQueue = (slug) => form.queue.some((x) => x.slug === slug);
  const rows = pages.map((p) => `<tr>
    <td><b>${esc(groupName(p))}</b><div class="u">${esc(p.slug)} · ${esc(p.title)}</div>
      ${p.url && !inQueue(p.slug)
        ? `<input class="q-rename" data-group-url="${esc(p.url)}" value="${esc(nameVal(p))}" placeholder="${esc(p.slug)}" maxlength="80" title="ชื่อหน่วยงานปลายทางบน backend">`
        : ""}</td>
    <td>${p.people} แถว</td>
    <td>${p.hasSelection ? '<span class="badge ok">ติ๊กแล้ว</span>' : '<span class="badge warn">ยังไม่ติ๊ก</span>'} ${planBadge(p.slug)}</td>
    <td><button class="ghost small" data-action="upload-dry" data-slug="${esc(p.slug)}">ตรวจ (dry-run)</button></td>
    <td><button class="ghost danger small" data-action="upload-real" data-slug="${esc(p.slug)}">ยิงจริง…</button></td>
  </tr>`).join("");

  const q = queueRows();
  const qBad = q.filter((x) => !x.hasSelection);
  const qTotal = q.reduce((n, x) => n + (x.rows || 0), 0);

  const confirm = form.confirmSlug ? (() => {
    const pg = pages.find((p) => p.slug === form.confirmSlug);
    return `<div class="callout danger" style="margin-top:14px">
      <b>ยืนยันการยิงจริง: ${esc(form.confirmSlug)}</b> (${pg ? pg.people + " แถว" : "?"})
      <label class="check" style="margin-top:8px;display:flex"><input type="checkbox" data-form="iVerified" ${form.iVerified ? "checked" : ""}> ข้าพเจ้าตรวจ report dry-run แล้ว และยืนยันให้บันทึกจริงลง backend</label>
      <label class="field" style="margin-top:8px"><span>พิมพ์ slug เพื่อยืนยัน: <code>${esc(form.confirmSlug)}</code></span>
        <input data-form="confirmText" value="${esc(form.confirmText)}" placeholder="พิมพ์ให้ตรงเป๊ะ"></label>
      <div class="row"><button class="danger" data-action="confirm-upload" data-slug="${esc(form.confirmSlug)}">ยิงจริงเลย</button>
        <button class="ghost" data-action="cancel-upload">ยกเลิก</button></div>
    </div>`;
  })() : "";

  const qConfirm = form.queueConfirm ? `<div class="callout danger" style="margin-top:14px">
      <b>ยืนยันยิงจริงทั้งคิว — ${q.length} รายการ · ${qTotal} แถว</b>
      <div style="margin:6px 0">${q.map((x, i) => `<div class="u">${i + 1}. ${esc(x.group)} — ${x.rows ?? "?"} แถว · slug ${esc(x.slug)}${x.hasSelection ? "" : " (ยังไม่ติ๊กคน)"}${planLine(x.slug) ? ` · ${esc(planLine(x.slug))}` : ""}</div>`).join("")}</div>
      ${qBad.length ? `<div class="u" style="color:var(--danger)">⚠ ${qBad.length} รายการยังไม่ได้ติ๊กคน (selection.json) — รายการนั้นจะล้ม และคิวจะหยุดทันที</div>` : ""}
      ${q.some((x) => !plans[x.slug]) ? `<div class="u">⚠ บางรายการยังไม่มีผล dry-run — ถ้า backend ยังไม่มีชื่อหน่วยงานที่ตั้งไว้ ระบบจะ <b>สร้างแผนกใหม่</b> ตามชื่อนั้น (กด “ตรวจทั้งหมดตามลำดับ” ก่อนเพื่อดูให้ชัด)</div>` : ""}
      <label class="check" style="margin-top:8px;display:flex"><input type="checkbox" data-form="queueVerified" ${form.queueVerified ? "checked" : ""}> ข้าพเจ้าตรวจ report dry-run ครบทุกหน้าแล้ว และยืนยันให้บันทึกจริงลง backend</label>
      <label class="field" style="margin-top:8px"><span>พิมพ์คำยืนยันให้ตรงเป๊ะ: <code>${QUEUE_PHRASE}</code></span>
        <input data-form="queueText" value="${esc(form.queueText)}" placeholder="พิมพ์คำยืนยัน"></label>
      <div class="row"><button class="danger" data-action="queue-go">ยิงจริงทั้งคิว</button>
        <button class="ghost" data-action="queue-cancel">ยกเลิก</button></div>
    </div>` : "";

  return `<div class="card">
    <div class="card-head"><span class="num">9</span>
      <div><h2>Upload — ยิงขึ้น backend</h2><p>เริ่มด้วย dry-run ตรวจก่อนเสมอ แล้วค่อยยิงจริง</p></div></div>
    <div class="card-body">
      <div class="dropzone small" id="drop-people"><strong>ลาก people.json มาวางที่นี่</strong>วางได้หลายไฟล์พร้อมกัน — จะต่อท้ายคิวตามลำดับที่วาง</div>
      <input type="file" id="file-people" accept=".json,application/json" multiple hidden>
      <div class="grid cols-3" style="margin-top:14px">
        ${field("backend", "Backend (ไม่ใส่ = หาจากแท็บเอง)", 'placeholder="https://host"')}
        ${field("limit", "จำกัดจำนวนแถว (limit)", 'type="number" min="0" placeholder="ทั้งหมด"')}
        ${field("map", "Map file (ไม่ใส่ = auto-detect)", 'placeholder="uploader/maps/<host>.json"')}
      </div>
      <div class="grid cols-3" style="margin-top:12px">
        ${field("to", "บังคับฟอร์มเดียว --to (ไม่บังคับ)", 'placeholder="…/personal/person/123"')}
        ${field("port", "พอร์ต CDP", 'placeholder="auto"')}
        <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" data-form="strict" ${form.strict ? "checked" : ""}> strict-sections (ปฏิเสธถ้าแผนกไม่ตรง)</label>
      </div>
      <div class="section-title">คิวอัปโหลด ${q.length ? `<span class="badge ${qBad.length ? "warn" : "ok"}">${q.length} รายการ · ${qTotal} แถว</span>` : ""}</div>
      <p class="hint">วางไฟล์ = ต่อท้ายคิวตามลำดับที่วาง · ลากแถวเพื่อสลับลำดับ · “ยิงจริงทั้งหมด” จะรันทีละรายการตามคิว และหยุดทันทีถ้ารายการใดล้ม</p>
      ${queueListHtml(q)}
      <div class="row" style="margin-top:12px">
        <button class="ghost small" data-action="queue-seed">เพิ่มทุกหน้าจากตาราง</button>
        <button class="ghost small" data-action="queue-clear" ${q.length ? "" : "disabled"}>ล้างคิว</button>
        <button class="ghost small" data-action="save-groups" ${q.some((x) => x.url) ? "" : "disabled"}>บันทึกชื่อหน่วยงาน</button>
        <span class="spacer"></span>
        <button class="ghost" data-action="queue-dry" ${q.length ? "" : "disabled"}>ตรวจทั้งหมดตามลำดับ (dry-run)</button>
        <button class="danger" data-action="queue-real" ${q.length ? "" : "disabled"}>ยิงจริงทั้งหมด…</button>
      </div>
      ${qConfirm}
      ${pages.length ? `<div class="section-title">หน้าที่พร้อมอัปโหลด (${pages.length})</div>
        <table><thead><tr><th>หน้า</th><th>จำนวน</th><th>ติ๊กคน</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">ยังไม่มี people.json — รัน run + finalize ก่อน หรือลากไฟล์มาวาง</div>`}
      ${confirm}
      ${Object.keys(reports).map(reportBlock).join("")}
    </div>
  </div>`;
}

// ---------- page render ----------
function renderCrumbs() {
  const items = [
    ["URL", (S.urlList || []).length > 0],
    ["Probe", S.links.length > 0],
    ["เลือกหน้า", (S.links || []).some((l) => l.keep) && S.links.length > 0],
    ["Run", contentPages().length > 0],
    ["ติ๊กคน", contentPages().length > 0 && contentPages().every((p) => p.hasSelection)],
    ["Finalize", contentPages().some((p) => p.reviewed)],
    ["Upload", false],
  ];
  $("#crumbs").innerHTML = items.map(([t, done]) => `<span class="crumb ${done ? "done" : ""}"><span class="dot"></span>${t}</span>`).join("");
}

function renderCdp() {
  const p = $("#cdp-pill");
  if (!S.cdp) { p.textContent = "CDP: ไม่พบ Chrome"; p.className = "pill warn"; return; }
  p.textContent = `CDP: พอร์ต ${S.cdp.port}${S.cdp.headless ? " (headless!)" : ""}`;
  p.className = "pill " + (S.cdp.headless ? "warn" : "ok");
}

function render() {
  renderCdp();
  renderCrumbs();
  $("#app").innerHTML = [cardUrls(), cardProbe(), cardLinks(), cardMaster(), cardPickImages(), cardRun(), cardReview(), cardFinalize(), cardUpload()].join("");
  // async grids
  if (form.imageSlug && S.probes.length) loadPickImages(form.imageSlug);
  if (form.reviewSlug) loadReview(form.reviewSlug);
  wireDrops();
}

// ---------- pick-images grid ----------
let pickReq = 0;
async function loadPickImages(slug) {
  const box = $("#pick-grid");
  if (!box) return;
  const req = ++pickReq;
  box.innerHTML = `<div class="empty">กำลังโหลด…</div>`;
  let data;
  try { data = await api("/api/probe/" + slug); }
  catch (e) { box.innerHTML = `<div class="empty">โหลดไม่ได้: ${esc(e.message)}</div>`; return; }
  if (req !== pickReq || !$("#pick-grid")) return;
  probeCache.set(slug, data);
  const keepBySrc = new Map((data.picked || []).map((e) => [e.src, e.keep]));
  const imgs = data.probe.images || [];
  if (!imgs.length) { box.innerHTML = `<div class="empty">หน้านี้ไม่มีรูป</div>`; updatePickCount(); return; }
  box.className = "imgs";
  box.innerHTML = imgs.map((im) => {
    const keep = keepBySrc.has(im.src) ? keepBySrc.get(im.src) : !!(im.name && !im.likely_header);
    const who = [im.name, im.position].filter(Boolean).join(" | ") || im.alt || "(ไม่มีชื่อ)";
    const flags = [im.likely_header ? "ป้ายแผนก" : "", im.vacant ? "เก้าอี้ว่าง" : ""].filter(Boolean).join(" · ");
    return `<figure class="pic ${keep ? "kept" : ""}">
      <img src="${esc(im.src)}" loading="lazy" draggable="false" onerror="this.style.visibility='hidden'">
      <figcaption><b>${esc(who)}</b>${esc(im.width)}x${esc(im.height)}${flags ? `<br><i>${esc(flags)}</i>` : ""}</figcaption>
      <label class="check"><input type="checkbox" data-pick="${esc(im.src)}" data-seq="${im.seq}" ${keep ? "checked" : ""}> โหลดรูปนี้</label>
    </figure>`;
  }).join("");
  updatePickCount();
}
function updatePickCount() {
  const n = $$("#pick-grid input[data-pick]:checked").length;
  const c = $("#pick-count");
  if (c) c.textContent = n ? `ติ๊กไว้ ${n} รูป` : "";
}

// ---------- review grid ----------
let reviewReq = 0;
async function loadReview(slug) {
  const box = $("#review-grid");
  if (!box) return;
  const req = ++reviewReq;
  box.innerHTML = `<div class="empty">กำลังโหลด…</div>`;
  let data;
  try { data = await api("/api/review/" + slug); }
  catch (e) { box.innerHTML = `<div class="empty">โหลดไม่ได้: ${esc(e.message)}</div>`; return; }
  if (req !== reviewReq || !$("#review-grid")) return;
  reviewCache.set(slug, data);
  const cands = data.candidates || [];
  if (!cands.length) { box.innerHTML = `<div class="empty">หน้านี้ไม่มีรูปให้เลือก</div>`; updateReviewCount(); return; }
  box.className = "imgs";
  box.innerHTML = cands.map((c) => `<figure class="pic ${c.keep ? "kept" : ""}" draggable="true" data-rseq="${c.seq}">
    <img src="${esc(c.src)}" loading="lazy" draggable="false" onerror="this.style.visibility='hidden'">
    <figcaption><b>${esc(c.caption || c.alt || "(ไม่มีชื่อ)")}</b>
      ${c.phone ? `<br>โทร: ${esc(c.phone)}` : ""}${c.note ? `<br><small>${esc(String(c.note).replace(/<br>/g, " "))}</small>` : ""}</figcaption>
    <label class="check"><input type="checkbox" data-rkeep="${c.seq}" ${c.keep ? "checked" : ""}> เก็บรูปนี้</label>
    <label class="ord">ตำแหน่งภาพ <input type="number" min="0" data-rorder="${c.seq}" value="${c.order}"></label>
  </figure>`).join("");
  updateReviewCount();
}
function updateReviewCount() {
  const n = $$("#review-grid input[data-rkeep]:checked").length;
  const total = $$("#review-grid figure[data-rseq]").length;
  const c = $("#review-count");
  if (c) c.textContent = total ? `ติ๊กไว้ ${n}/${total} รูป` : "";
}

// ---------- actions ----------
async function act(name, el) {
  const slug = el?.dataset?.slug;
  switch (name) {
    case "save-urls": {
      try { const r = await post("/api/urls", { text: form.urls }); toast(`บันทึก urls.txt แล้ว (${r.count} URL)`, "ok"); await load(); }
      catch (e) { toast(e.message, "err"); }
      break;
    }
    case "run-probe": return runJob("probe", netOpts(), "probe");
    case "run-run": return runJob("run", netOpts(), "run");
    case "run-finalize": return runJob("finalize", { compactOrders: form.compact }, "finalize");
    case "run-regen-review": return runJob("regen-review", {}, "regen-review");
    case "run-apply-master": return runJob("apply-master", {}, "apply-master");
    case "links-all": $$("input[data-link]").forEach((c) => (c.checked = true)); break;
    case "links-none": $$("input[data-link]").forEach((c) => (c.checked = false)); break;
    case "master-all": $$("input[data-master]").forEach((c) => (c.checked = true)); break;
    case "master-none": $$("input[data-master]").forEach((c) => (c.checked = false)); break;
    case "save-links": {
      const links = $$("input[data-link]").map((c) => {
        const l = S.links.find((x) => x.slug === c.dataset.link);
        return { url: l.url, slug: l.slug, keep: c.checked };
      });
      try { const r = await post("/api/staging/picked-links", { links }); toast(`บันทึกแล้ว (เลือก ${r.kept})`, "ok"); await load(); }
      catch (e) { toast(e.message, "err"); }
      break;
    }
    case "save-master": {
      const decisions = $$("input[data-master]").map((c) => ({ src: c.dataset.master, keep: c.checked }));
      try { await post("/api/staging/master", { pages: S.master.pages, decisions }); toast("บันทึก master.json แล้ว", "ok"); }
      catch (e) { toast(e.message, "err"); }
      break;
    }
    case "save-images": {
      if (!form.imageSlug) return;
      const decisions = $$("#pick-grid input[data-pick]").map((c) => ({ seq: +c.dataset.seq, src: c.dataset.pick, keep: c.checked }));
      try { const r = await post("/api/staging/picked-images", { slug: form.imageSlug, decisions }); toast(`บันทึกแล้ว (ติ๊ก ${r.kept})`, "ok"); }
      catch (e) { toast(e.message, "err"); }
      break;
    }
    case "review-all": $$("#review-grid input[data-rkeep]").forEach((c) => (c.checked = true)); $$("#review-grid figure.pic").forEach(syncKept); updateReviewCount(); break;
    case "review-none": $$("#review-grid input[data-rkeep]").forEach((c) => (c.checked = false)); $$("#review-grid figure.pic").forEach(syncKept); updateReviewCount(); break;
    case "bulk-order": {
      const v = parseInt($("#bulk-ord")?.value, 10);
      if (!Number.isFinite(v) || v < 0) return toast("เลขไม่ถูกต้อง", "err");
      $$("#review-grid input[data-rkeep]:checked").forEach((c) => {
        const o = $(`#review-grid input[data-rorder="${c.dataset.rkeep}"]`);
        if (o) o.value = v;
      });
      break;
    }
    case "save-review": {
      if (!form.reviewSlug) return;
      const selection = $$("#review-grid figure[data-rseq]").map((f) => {
        const seq = +f.dataset.rseq;
        const keep = $("input[data-rkeep]", f)?.checked ?? false;
        const order = parseInt($("input[data-rorder]", f)?.value, 10);
        return { seq, file: reviewCache.get(form.reviewSlug)?.candidates.find((c) => c.seq === seq)?.file || "", keep, order: Number.isFinite(order) && order >= 0 ? order : 0 };
      });
      try { const r = await post("/api/review/" + form.reviewSlug, { selection }); toast(`บันทึก selection.json แล้ว (เก็บ ${r.kept})`, "ok"); await load(); }
      catch (e) { toast(e.message, "err"); }
      break;
    }
    case "save-groups": {
      // one input per URL on the page (the queue row when queued, otherwise the
      // table row) — so a URL can never be saved with a half-stale value
      const byUrl = new Map();
      $$("input[data-group-url]").forEach((i) => byUrl.set(i.dataset.groupUrl, i.value));
      if (!byUrl.size) return toast("ไม่มี URL ให้ตั้งชื่อ", "err");
      try {
        const r = await post("/api/source-groups", { entries: [...byUrl].map(([url, name]) => ({ url, name })) });
        form.groupNames = {};
        plans = {}; // dry-run plans were computed under the old names
        toast(`บันทึกชื่อหน่วยงานแล้ว — ตั้งไว้ ${Object.keys(r.map).length} รายการ`, "ok");
        await load();
      } catch (e) { toast(e.message, "err"); }
      break;
    }
    case "queue-seed": {
      const have = new Set(form.queue.map((x) => x.slug));
      const add = S.pages.filter((p) => p.people != null && !have.has(p.slug));
      for (const p of add) form.queue.push({ slug: p.slug, rows: p.people });
      form.queueConfirm = false;
      render();
      toast(add.length ? `เพิ่มเข้าคิว ${add.length} รายการ (รวม ${form.queue.length})` : "มีครบทุกหน้าในคิวแล้ว", add.length ? "ok" : "");
      break;
    }
    case "queue-remove":
      form.queue = form.queue.filter((x) => x.slug !== slug);
      form.queueConfirm = false;
      render();
      break;
    case "queue-clear":
      form.queue = []; form.queueConfirm = false;
      render();
      break;
    case "queue-dry":
      if (!form.queue.length) return toast("คิวว่าง", "err");
      return runJob("upload-queue", null, `ตรวจคิว ${form.queue.length} รายการ (dry-run)`, { steps: queueSteps(false) });
    case "queue-real":
      if (!form.queue.length) return toast("คิวว่าง", "err");
      form.queueConfirm = true; form.queueText = ""; form.queueVerified = false;
      render();
      break;
    case "queue-cancel": form.queueConfirm = false; render(); break;
    case "queue-go": {
      if (!form.queueVerified) return toast("ต้องติ๊กยืนยันก่อน", "err");
      if (form.queueText.trim() !== QUEUE_PHRASE) return toast(`พิมพ์ยืนยันไม่ตรง — ต้องเป็น "${QUEUE_PHRASE}"`, "err");
      const steps = queueSteps(true);
      form.queueConfirm = false;
      render();
      return runJob("upload-queue", null, `ยิงจริงทั้งคิว ${steps.length} รายการ`, { steps, confirm: QUEUE_PHRASE });
    }
    case "upload-dry": return runJob("upload", uploadOpts(slug, false), `upload dry-run ${slug}`);
    case "upload-real": form.confirmSlug = slug; form.confirmText = ""; form.iVerified = false; render(); break;
    case "cancel-upload": form.confirmSlug = null; render(); break;
    case "confirm-upload": {
      if (!form.iVerified) return toast("ต้องติ๊กยืนยันก่อน", "err");
      if (form.confirmText.trim() !== slug) return toast("พิมพ์ slug ไม่ตรง", "err");
      const opts = uploadOpts(slug, true);
      form.confirmSlug = null;
      render();
      return runJob("upload", opts, `upload จริง ${slug}`);
    }
  }
}

// ---------- events ----------
$("#app").addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (t) act(t.dataset.action, t);
});
$("#app").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.form) { form[t.dataset.form] = t.type === "checkbox" ? t.checked : t.value; return; }
  if (t.dataset.groupUrl) {
    // the same URL can be edited from card 1 and from card 9 — keep every editor
    // in sync so a save can never fire a stale value from the other one
    const url = t.dataset.groupUrl;
    form.groupNames[url] = t.value;
    $$("input[data-group-url]").forEach((i) => { if (i !== t && i.dataset.groupUrl === url) i.value = t.value; });
    return;
  }
  if (t.dataset.pick || t.dataset.rkeep) {
    syncKept(t.closest("figure.pic"));
    if (t.dataset.rkeep) updateReviewCount(); else updatePickCount();
  }
});
$("#app").addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "pick-slug") { form.imageSlug = t.value; loadPickImages(t.value); }
  else if (t.id === "review-slug") { form.reviewSlug = t.value; loadReview(t.value); }
  else if (t.dataset.form) { form[t.dataset.form] = t.type === "checkbox" ? t.checked : t.value; }
});

// ---------- picking/keeping: bigger targets, the whole card toggles ----------
function keptBox(fig) { return fig ? $("input[data-rkeep], input[data-pick]", fig) : null; }
function syncKept(fig) {
  const box = keptBox(fig);
  if (fig && box) fig.classList.toggle("kept", box.checked);
}
// clicking anywhere on a card toggles it; controls inside keep their own behaviour
$("#app").addEventListener("click", (e) => {
  if (justDragged) return;
  if (e.target.closest("input, label, button, select, textarea, a")) return;
  const fig = e.target.closest("figure.pic");
  const box = keptBox(fig);
  if (!box) return;
  box.checked = !box.checked;
  box.dispatchEvent(new Event("input", { bubbles: true })); // counts + card frame follow
});

// ---------- drag & drop reorder (review photos and the upload queue) ----------
const REORDER_SEL = "#review-grid figure[data-rseq], #queue-list li[data-qslug]";
const reorderItem = (node) => node?.closest?.(REORDER_SEL) || null;
let dragEl = null;
let justDragged = false;

// the queue order IS the DOM order: keep the two in sync after a drop
function applyQueueOrder() {
  const items = $$("#queue-list li[data-qslug]");
  if (!items.length) return;
  const by = new Map(form.queue.map((x) => [x.slug, x]));
  form.queue = items.map((el) => by.get(el.dataset.qslug)).filter(Boolean);
  items.forEach((el, i) => { const n = $(".q-idx", el); if (n) n.textContent = String(i + 1); });
}
function renumberOrders() {
  $$("#review-grid figure[data-rseq]").forEach((fig, i) => {
    const o = $("input[data-rorder]", fig);
    if (o) o.value = i;
  });
  updateReviewCount();
}

$("#app").addEventListener("dragstart", (e) => {
  const f = reorderItem(e.target);
  if (!f) return;
  dragEl = f; justDragged = true;
  f.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
});
$("#app").addEventListener("dragover", (e) => {
  const f = reorderItem(e.target);
  if (!f || !dragEl || f === dragEl || f.parentElement !== dragEl.parentElement) return;
  e.preventDefault();
  f.classList.add("drop-target");
});
$("#app").addEventListener("dragleave", (e) => {
  const f = reorderItem(e.target);
  if (f) f.classList.remove("drop-target");
});
$("#app").addEventListener("drop", (e) => {
  const f = reorderItem(e.target);
  if (!f || !dragEl || f === dragEl || f.parentElement !== dragEl.parentElement) return;
  e.preventDefault();
  const box = f.parentElement;
  const items = [...box.children];
  if (items.indexOf(dragEl) < items.indexOf(f)) f.after(dragEl); else f.before(dragEl);
  if (dragEl.matches("li[data-qslug]")) applyQueueOrder(); else renumberOrders();
});
$("#app").addEventListener("dragend", () => {
  $$("#app .dragging").forEach((x) => x.classList.remove("dragging"));
  $$("#app .drop-target").forEach((x) => x.classList.remove("drop-target"));
  dragEl = null;
  setTimeout(() => (justDragged = false), 200); // swallow the click a drag can leave behind
});

// ---------- dropzones ----------
function wireDropzone(zoneSel, inputSel, onFiles) {
  const zone = $(zoneSel), input = $(inputSel);
  if (!zone || !input) return;
  zone.onclick = () => input.click();
  input.onchange = () => { const files = [...input.files]; if (files.length) onFiles(files); input.value = ""; };
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("drag");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}
const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });

function wireDrops() {
  wireDropzone("#drop-urls", "#file-urls", async (files) => {
    const text = await readText(files[0]);
    form.urls = text;
    const ta = $("#urls"); if (ta) ta.value = text;
    try { const r = await post("/api/urls", { text }); toast(`โหลด urls.txt แล้ว (${r.count} URL)`, "ok"); await load(); }
    catch (e) { toast(e.message, "err"); }
  });
  wireDropzone("#drop-people", "#file-people", async (files) => {
    // every dropped file lands in out/<slug>/people.json, then joins the queue in drop order
    const payload = [];
    for (const f of files) payload.push({ name: f.name, content: await readText(f) });
    try {
      const r = await post("/api/drop-people", { files: payload });
      const dup = [];
      let overwritten = 0;
      for (const f of r.files) {
        if (f.existed) overwritten++;
        if (form.queue.some((x) => x.slug === f.slug)) { dup.push(f.slug); continue; }
        form.queue.push({ slug: f.slug, rows: f.rows });
      }
      form.queueConfirm = false;
      const added = r.files.length - dup.length;
      toast(`ต่อท้ายคิว ${added} รายการ${overwritten ? ` · เขียนทับ people.json เดิม ${overwritten} ไฟล์` : ""}${dup.length ? ` · ข้ามซ้ำ ${dup.join(", ")}` : ""}`, "ok");
      await load();
    } catch (e) { toast("อ่านไฟล์ไม่ได้: " + e.message, "err"); }
  });
}

// ---------- chrome ----------
$("#btn-refresh").onclick = () => load();
$("#btn-clear").onclick = () => ($("#log").textContent = "");
$("#btn-toggle-console").onclick = () => $("#console").classList.toggle("collapsed");
$("#btn-kill").onclick = async () => { if (current) { await post("/api/job/" + current.id + "/kill", {}); toast("ส่งสัญญาณหยุดแล้ว"); } };

// ---------- boot ----------
(async () => {
  logLine("ยินดีต้อนรับ — เริ่มจากวาง urls.txt แล้วกดรัน probe\n", "sys");
  await load();
})();
