// Characterization: sectioning.mjs (Lift-verbatim per #18).
// Pins source identity, sectioning heuristics, kept/queue filter rules,
// and personnel-row contract BEFORE any UI-service refactor.
// Run: node --test tests/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDivisionText,
  inferSection,
  slugBaseOf,
  newSourceContext,
  resolveTargetGroup,
  attachCaptions,
  IMG_DENY,
  TEXT_DENY_EXACT,
  MIN_PX,
  providerOf,
  imgSlotKey,
  buildKept,
  buildPeople,
} from "../sectioning.mjs";

describe("slugBaseOf: deterministic source key (1 URL = 1 group)", () => {
  it("same URL always yields same key; different URLs differ", () => {
    const a = "https://khiansago.go.th/officer1.php";
    assert.equal(slugBaseOf(a), slugBaseOf(a));
    assert.notEqual(slugBaseOf(a), slugBaseOf("https://khanthuligo.go.th/officer1.php"));
  });
  it("invalid URL falls back to page-index", () => {
    assert.equal(slugBaseOf("not a url"), "page-index");
    assert.equal(slugBaseOf(""), "page-index");
  });
  it("lowercases and strips www", () => {
    const k = slugBaseOf("https://WWW.Example.GO.TH/AbC.php");
    assert.equal(k, k.toLowerCase());
    assert.ok(!k.startsWith("www"), "www stripped");
  });
});

describe("newSourceContext: fresh isolated identity per URL", () => {
  it("copies url, derives key, fresh object per call", () => {
    const u = "https://khiansago.go.th/officer1.php";
    const a = newSourceContext(u);
    const b = newSourceContext(u);
    assert.equal(a.source_url, u);
    assert.equal(a.source_key, slugBaseOf(u));
    assert.notEqual(a, b);
  });
});

describe("resolveTargetGroup: registry alias wins, else own identity", () => {
  it("explicit substring alias merges intentionally", () => {
    const g = resolveTargetGroup("https://a.go.th/x", "aaa-x", { map: { "a.go.th": "merged-group" } });
    assert.equal(g, "merged-group");
  });
  it("underscore-prefixed registry keys are comments, ignored", () => {
    const g = resolveTargetGroup("https://a.go.th/x", "aaa-x", { map: { _note: "merged-group" } });
    assert.equal(g, "aaa-x");
  });
  it("falls back to row source_group without registry", () => {
    assert.equal(resolveTargetGroup("https://a.go.th/x", "aaa-x", null), "aaa-x");
    assert.equal(resolveTargetGroup("https://a.go.th/x", "aaa-x", {}), "aaa-x");
  });
});

describe("isDivisionText / inferSection: structural Thai vocab only", () => {
  it("accepts division headers, rejects names and oversize", () => {
    assert.equal(isDivisionText("กองคลัง"), true);
    assert.equal(isDivisionText("สำนักปลัด"), true);
    assert.equal(isDivisionText("ฝ่ายปกครอง"), true);
    assert.equal(isDivisionText("นายสมชาย ใจดี"), false);
    assert.equal(isDivisionText(""), false);
    assert.equal(isDivisionText("สำนักปลัดเทศบาลนครหาดใหญ่พิเศษมากเกินสามสิบตัวอักษรแน่"), false);
  });
  it("position inference: council > executive > staff, else null", () => {
    assert.equal(inferSection("สมาชิกสภา", "นาย ก"), "สภาท้องถิ่น");
    assert.equal(inferSection("นายกเทศมนตรี", "นาย ข"), "คณะผู้บริหาร");
    assert.equal(inferSection("หัวหน้าฝ่ายปกครอง", "นาง ค"), "พนักงานส่วนท้องถิ่น");
    assert.equal(inferSection("คนสวน", "นาย ง"), null);
  });
});

describe("filter constants + providerOf + imgSlotKey", () => {
  it("denylist / size floor pinned", () => {
    assert.ok(IMG_DENY.test("https://x/icon-spacer.gif"));
    assert.ok(IMG_DENY.test("cleardot.png"));
    assert.ok(TEXT_DENY_EXACT.has("เลือกภาษา"));
    assert.equal(MIN_PX, 12);
  });
  it("iframe provider classifier pinned", () => {
    assert.deepEqual(providerOf("https://www.google.com/maps/embed?x=1")[0], "maps");
    assert.deepEqual(providerOf("https://ws.sharethis.com/x")[0], "sharethis");
    assert.deepEqual(providerOf("https://cjworld.example/hotmenu/y")[0], "hotmenu");
    assert.deepEqual(providerOf("https://example.com/embed")[0], "other");
  });
  it("person-slot dedupe key: coords beat src-only", () => {
    assert.equal(imgSlotKey("u", null, null), "src:u");
    assert.equal(imgSlotKey("u", 10, 20), "src:u@10x20");
    assert.notEqual(imgSlotKey("u", 10, 20), imgSlotKey("u", 10, 21));
  });
});

describe("buildKept: raw-nodes to kept/queue/stats", () => {
  it("cuts denylist, undersize, chrome, data-uri; keeps content", () => {
    const raw = [
      { t: "text", text: "นาย ก", chrome: false },
      { t: "text", text: "เลือกภาษา", chrome: false },
      { t: "img", src: "https://x/spacer.gif", w: 100, h: 100, chrome: false },
      { t: "img", src: "https://x/tiny.jpg", w: 5, h: 5, chrome: false },
      { t: "img", src: "https://x/nav.jpg", w: 100, h: 100, chrome: true },
      { t: "img", src: "data:image/gif;base64,xx", w: 100, h: 100, chrome: false },
      { t: "img", src: "https://x/p1.jpg", w: 200, h: 200, chrome: false, left: 0, top: 0 },
    ];
    const { kept, queue, stats } = buildKept(raw, "https://x");
    assert.equal(queue.length, 1);
    assert.equal(queue[0].src, "https://x/p1.jpg");
    assert.ok(stats.cut >= 5);
    assert.equal(stats.image, 1);
    assert.ok(kept.some((n) => n.type === "text" && n.text === "นาย ก"));
  });
  it("dedupes same slot, keeps same src at new position (shared placeholders)", () => {
    const raw = [
      { t: "img", src: "https://x/vacant.gif", w: 100, h: 100, chrome: false, left: 1, top: 1 },
      { t: "img", src: "https://x/vacant.gif", w: 100, h: 100, chrome: false, left: 1, top: 1 },
      { t: "img", src: "https://x/vacant.gif", w: 100, h: 100, chrome: false, left: 2, top: 2 },
    ];
    const { queue, stats } = buildKept(raw, "https://x");
    assert.equal(queue.length, 2);
    assert.equal(stats.cut, 1);
  });
  it("fullres_candidate only for image extensions", () => {
    const raw = [
      { t: "img", src: "https://x/a.jpg", w: 50, h: 50, chrome: false, full: "https://x/a-big.jpg" },
      { t: "img", src: "https://x/b.jpg", w: 50, h: 50, chrome: false, full: "https://x/page.html" },
    ];
    const { queue } = buildKept(raw, "https://x");
    assert.equal(queue[0].fullres_candidate, "https://x/a-big.jpg");
    assert.ok(!("fullres_candidate" in queue[1]));
  });
  it("cross-origin iframe becomes placeholder; same-origin stays entry", () => {
    const raw = [
      { t: "iframe", src: "https://www.google.com/maps/embed", abs: "https://www.google.com/maps/embed", title: "", chrome: false },
      { t: "iframe", src: "/inner", abs: "https://x/inner", title: "", chrome: false },
      { t: "iframe", src: "", abs: "about:blank", title: "", chrome: false },
    ];
    const { kept, stats } = buildKept(raw, "https://x");
    assert.equal(stats.placeholder, 1);
    assert.equal(stats["iframe-sameorigin"], 1);
    assert.equal(stats.cut, 1);
    assert.ok(kept.some((n) => n.type === "placeholder" && n.provider === "maps"));
  });
});

describe("attachCaptions: caption/phone/note + section priority", () => {
  const txt = (seq, text, extra = {}) => ({ seq, type: "text", chrome: false, text, ...extra });

  it("caption = next 2 texts, phone first match, extras join note", () => {
    const kept = [
      { seq: 0, type: "image", chrome: false },
      txt(1, "นายสมชาย ใจดี"),
      txt(2, "หัวหน้าฝ่ายปกครอง"),
      txt(3, "081-234-5678"),
      txt(4, "รับผิดชอบงานทะเบียน"),
    ];
    attachCaptions(kept);
    assert.deepEqual(kept[0].caption_next, ["นายสมชาย ใจดี", "หัวหน้าฝ่ายปกครอง"]);
    assert.equal(kept[0].phone, "081-234-5678");
    assert.equal(kept[0].note, "รับผิดชอบงานทะเบียน");
  });
  it("heading beats division; position inference is fallback", () => {
    const kept = [
      txt(0, "คณะผู้บริหาร", { h: "H2" }),
      { seq: 1, type: "image", chrome: false },
      txt(2, "นาย ก"),
      txt(3, "นายกเทศมนตรี"),
    ];
    attachCaptions(kept);
    assert.equal(kept[1].section, "คณะผู้บริหาร");
    assert.equal(kept[1].section_from, "heading");
  });
  it("tainted division (previous person note tail) loses to own position evidence", () => {
    const kept = [
      { seq: 0, type: "image", chrome: false },
      txt(1, "นาง ก"),
      txt(2, "เจ้าพนักงานธุรการ"),
      txt(3, "กองคลัง"),
      { seq: 4, type: "image", chrome: false },
      txt(5, "นาย ข"),
      txt(6, "หัวหน้าฝ่ายปกครอง"),
    ];
    attachCaptions(kept);
    const second = kept[4];
    assert.equal(second.section, "พนักงานส่วนท้องถิ่น");
    assert.equal(second.section_from, "position");
    assert.ok(second.group_warn, "demotion recorded");
  });
  it("page fallback covers images with no evidence", () => {
    const kept = [
      { seq: 0, type: "image", chrome: false },
      txt(1, "นาย ก"),
      txt(2, "นายกเทศมนตรี"),
      { seq: 3, type: "image", chrome: false },
      txt(4, "ใครสักคน"),
    ];
    attachCaptions(kept);
    assert.ok(kept[0].section, "first image sectioned by position");
    assert.equal(kept[3].section, kept[0].section);
    assert.equal(kept[3].section_from, "page");
  });
});

describe("buildPeople: uploader row contract", () => {
  it("every row carries source identity; order is 0-based DOM sequence", () => {
    const url = "https://khiansago.go.th/officer1.php";
    const kept = [
      { seq: 0, type: "image", chrome: false, src: "https://x/a.jpg", caption_next: ["นาย ก", "นายกเทศมนตรี"], phone: null, note: null, section: "คณะผู้บริหาร", section_from: "position" },
      { seq: 5, type: "image", chrome: false, src: "https://x/b.jpg", caption_next: ["นาง ข", "หัวหน้าฝ่าย"], phone: "081-234-5678", note: "งานทะเบียน", section: "พนักงานส่วนท้องถิ่น", section_from: "position" },
    ];
    const rows = buildPeople(kept, url, "src");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.order), [0, 1]);
    for (const r of rows) {
      assert.equal(r.source_url, url);
      assert.equal(r.source_group, slugBaseOf(url));
    }
    assert.equal(rows[1].phone, "081-234-5678");
    assert.equal(rows[0].photo, "https://x/a.jpg");
  });
});
