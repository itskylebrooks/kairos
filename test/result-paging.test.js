// Read results larger than the size cap come in parts: whole items, or one long text by
// characters. Invented data only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESULT_CHARS, readConfig } from "../src/lib/config.js";
import { UserError } from "../src/lib/errors.js";
import { fitResult, textCut } from "../src/lib/paging.js";
import { ADD, READ, defineTool } from "../src/lib/tools.js";
import { createServer } from "../src/server.js";

const size = (v) => JSON.stringify(v).length;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Fetches every part the way Claude would, checking each against the cap. */
function allParts(result, maxChars, tool = "notes_list", args = { folder: "Kairos Test" }) {
  const parts = [];
  let cursor;
  for (let i = 0; i < 1000; i++) {
    const p = fitResult(result, { maxChars, cursor, tool, args });
    assert.ok(size(p) <= maxChars, `part ${i} has ${size(p)} characters, cap ${maxChars}`);
    parts.push(p);
    if (!p.paging?.has_more) return parts;
    cursor = p.paging.cursor;
  }
  throw new Error("paging did not end");
}

const notes = (n, body = "Ada Example's note text. ") =>
  Array.from({ length: n }, (_, i) => ({ id: `x-coredata://test/ICNote/p${i}`, title: `Kairos Test ${i}`, preview: body.repeat(8) }));

test("a result exactly at the cap comes back unchanged, one character more is paged", () => {
  const cap = 5_000;
  const at = { text: "x".repeat(cap - size({ text: "" })) };
  assert.equal(size(at), cap);
  assert.deepEqual(fitResult(at, { maxChars: cap, tool: "notes_read", args: {} }), at);

  const over = { text: at.text + "x" };
  const p = fitResult(over, { maxChars: cap, tool: "notes_read", args: {} });
  assert.ok(size(p) <= cap);
  assert.equal(p.paging.unit, "characters");
  assert.equal(p.paging.has_more, true);
  const parts = allParts(over, cap, "notes_read", {});
  assert.equal(parts.map((x) => x.text).join(""), over.text);
});

test("lists are paged by whole items, in order, each part within the cap", () => {
  const cap = 5_000;
  const result = { total: 60, notes: notes(60) };
  const parts = allParts(result, cap);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.flatMap((p) => p.notes), result.notes, "every item exactly once, never cut");
  assert.equal(parts[0].paging.unit, "items");
  assert.equal(parts[0].paging.field, "notes");
  assert.equal(parts[0].paging.total, 60);
  assert.equal(parts[0].total, 60, "the tool's own fields stay");
  assert.equal(parts.at(-1).paging.has_more, false);
  assert.equal(parts.at(-1).paging.cursor, undefined);
  let offset = 0;
  for (const p of parts) { assert.equal(p.paging.offset, offset); offset += p.paging.returned; }
});

test("Cyrillic text counts one per character, not per byte, and pages back together exactly", () => {
  const cap = 5_000;
  // 4,900 Cyrillic characters are about 9,800 bytes in UTF-8, yet fit a 5,000 character cap.
  const fits = { markdown: "Ёлка ".repeat(980) };
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) > cap);
  assert.deepEqual(fitResult(fits, { maxChars: cap, tool: "notes_read", args: { id: "n" } }), fits);

  const exact = { markdown: "ж".repeat(cap - size({ markdown: "" })) };
  assert.equal(size(exact), cap);
  assert.equal(fitResult(exact, { maxChars: cap, tool: "notes_read", args: {} }).paging, undefined);
  const parts = allParts({ markdown: exact.markdown + "я" }, cap, "notes_read", {});
  assert.equal(parts.length, 2);
  assert.equal(parts.map((p) => p.markdown).join(""), exact.markdown + "я");

  const long = { title: "Заметка", markdown: "Привет, мир! Это тестовая заметка.\n".repeat(600) };
  const all = allParts(long, cap, "notes_read", { id: "n" });
  assert.equal(all.map((p) => p.markdown).join(""), long.markdown);
  for (const p of all.slice(0, -1)) assert.ok(p.markdown.endsWith("\n"), "cuts at a line break when one is near");
});

test("text is never cut inside an emoji, and escapes are counted", () => {
  const cap = 5_000;
  const emoji = { body: "👋🏽".repeat(4_000) };
  const parts = allParts(emoji, cap, "mail_read", {});
  for (const p of parts) assert.doesNotMatch(p.body, LONE_SURROGATE);
  assert.equal(parts.map((p) => p.body).join(""), emoji.body);

  const escapes = { body: 'a "quoted" line\\ \n'.repeat(1_000) + "\u0001".repeat(500) };
  assert.equal(allParts(escapes, cap, "mail_read", {}).map((p) => p.body).join(""), escapes.body);
  assert.equal(textCut("abc", 0, 10), 3);
});

test("one item too large for a part has its text paged, then the list continues", () => {
  const cap = 5_000;
  const result = { messages: [{ id: "m0", subject: "Short" }, { id: "m1", subject: "Long", body: "word ".repeat(3_000) }, { id: "m2", subject: "After" }] };
  const parts = allParts(result, cap, "mail_search", {});
  const first = parts[0];
  assert.deepEqual(first.messages.map((m) => m.id), ["m0"]);
  const text = parts.filter((p) => p.paging.unit === "characters");
  assert.ok(text.length > 1);
  assert.equal(text[0].paging.field, "messages[1].body");
  assert.equal(text[0].paging.text_continues, true);
  assert.equal(text.map((p) => p.messages[0].body).join(""), result.messages[1].body);
  assert.deepEqual(parts.at(-1).messages.map((m) => m.id), ["m2"]);
});

test("a cursor works only for the same tool and arguments; a broken one is refused", () => {
  const cap = 5_000;
  const result = { notes: notes(60) };
  const p = fitResult(result, { maxChars: cap, tool: "notes_list", args: { folder: "A" } });
  assert.throws(() => fitResult(result, { maxChars: cap, cursor: p.paging.cursor, tool: "notes_list", args: { folder: "B" } }), (e) => e instanceof UserError && /different call/.test(e.message));
  assert.throws(() => fitResult(result, { maxChars: cap, cursor: p.paging.cursor, tool: "notes_search", args: { folder: "A" } }), /different call/);
  assert.throws(() => fitResult(result, { maxChars: cap, cursor: "nonsense", tool: "notes_list", args: { folder: "A" } }), /Invalid cursor/);
  // The list changed between parts: still served, and flagged.
  const next = fitResult({ notes: notes(59) }, { maxChars: cap, cursor: p.paging.cursor, tool: "notes_list", args: { folder: "A" } });
  assert.equal(next.paging.changed, true);
});

test("a result that cannot be split is refused with advice", () => {
  assert.throws(() => fitResult({ a: 1, b: { deep: "x".repeat(6_000) } }, { maxChars: 5_000, tool: "notes_read", args: {} }), /cannot be split.*Narrow/s);
});

test("KAIROS_MAX_RESULT_CHARS: default 20,000, clamped to a sane range, nonsense ignored", () => {
  assert.equal(readConfig({}).maxResultChars, 20_000);
  assert.equal(readConfig({ KAIROS_MAX_RESULT_CHARS: "50000" }).maxResultChars, 50_000);
  const high = readConfig({ KAIROS_MAX_RESULT_CHARS: "5000000" });
  assert.equal(high.maxResultChars, RESULT_CHARS.max);
  assert.match(high.warnings.join(), /outside/);
  assert.equal(readConfig({ KAIROS_MAX_RESULT_CHARS: "10" }).maxResultChars, RESULT_CHARS.min);
  const bad = readConfig({ KAIROS_MAX_RESULT_CHARS: "lots" });
  assert.equal(bad.maxResultChars, 20_000);
  assert.match(bad.warnings.join(), /not a whole number/);
});

test("through the server: read tools get a cursor, write tools do not, and parts chain", async () => {
  const list = defineTool({
    name: "notes_many", app: "notes", title: "Many", description: "Lists many notes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { folder: { type: "string" } } },
    annotations: READ, handler: ({ folder }) => ({ folder, notes: notes(400) }),
  });
  const write = defineTool({
    name: "notes_add", app: "notes", title: "Add", description: "Adds.",
    inputSchema: { type: "object", properties: {} }, annotations: ADD, handler: () => ({ ok: true }),
  });
  assert.ok(list.inputSchema.properties.cursor);
  assert.match(list.description, /come in parts/);
  assert.equal(write.inputSchema.properties.cursor, undefined);

  const s = createServer({ tools: [list, write], config: readConfig({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  const call = async (args) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_many", arguments: args } })).result;
  const seen = [];
  let args = { folder: "Kairos Test" };
  for (;;) {
    const r = await call(args);
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.ok(r.content[0].text.length <= 20_000);
    seen.push(...r.structuredContent.notes);
    if (!r.structuredContent.paging.has_more) break;
    args = { folder: "Kairos Test", cursor: r.structuredContent.paging.cursor };
  }
  assert.equal(seen.length, 400);
  assert.deepEqual(seen.map((n) => n.id), notes(400).map((n) => n.id));
});
