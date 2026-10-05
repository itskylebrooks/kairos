import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALL_TOOLS } from "../src/apps/index.js";
import { readConfig } from "../src/lib/config.js";
import { UserError } from "../src/lib/errors.js";
import { ADD, READ, defineTool } from "../src/lib/tools.js";
import { INSTRUCTIONS, PROTOCOL_VERSIONS, VERSION, createServer } from "../src/server.js";

// Invented tools; nothing here touches Apple data.
const echo = defineTool({
  name: "notes_echo", app: "notes", title: "Echo", description: "Returns its input.",
  inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
  annotations: READ, handler: ({ text }) => ({ text }),
});
const list = defineTool({
  name: "notes_list_example", app: "notes", title: "List", description: "Returns an array.",
  inputSchema: { type: "object", properties: {} }, annotations: READ, handler: () => ["a", "b"],
});
const boom = defineTool({
  name: "notes_boom", app: "notes", title: "Boom", description: "Fails.",
  inputSchema: { type: "object", properties: { user: { type: "boolean" } } }, annotations: READ,
  handler: ({ user }) => { throw user ? new UserError("Note not found.") : new Error("unexpected"); },
});
const create = defineTool({
  name: "notes_create_example", app: "notes", title: "Create", description: "Writes.",
  inputSchema: { type: "object", properties: {} }, annotations: ADD, handler: () => ({ created: true }),
});
const TOOLS = [echo, list, boom, create];
const cfg = (env) => readConfig(env);
const server = createServer({ tools: TOOLS, config: cfg({ KAIROS_APPS: "notes" }) });
const call = (name, args, id = 1) => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("VERSION matches package.json", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("by default only read tools are listed; writes need KAIROS_WRITE", async () => {
  const names = async (env) => new Set((await createServer({ config: cfg(env) }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name));
  const READS = ["calendar_calendars", "calendar_read", "reminders_lists", "reminders_read", "contacts_search", "contacts_birthdays", "notes_folders", "notes_list", "notes_search", "notes_read", "music_now", "music_played", "music_top", "music_search", "music_history_status", "music_history_top", "music_history_timeline", "music_playlists", "mail_mailboxes", "mail_unread", "mail_search", "mail_read", "kairos_activity", "kairos_health"];
  assert.deepEqual(await names({}), new Set(READS));
  assert.deepEqual(await names({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }), new Set(["notes_folders", "notes_list", "notes_search", "notes_read", "notes_create", "notes_append", "notes_move", "notes_trash", "notes_replace", "kairos_activity", "kairos_health", "kairos_undo"]));
  const all = await names({ KAIROS_WRITE: "calendar,reminders,notes,mail" });
  for (const t of ["calendar_create", "calendar_update", "calendar_delete", "reminders_create", "reminders_update", "reminders_complete", "reminders_delete", "mail_create_draft"]) assert.ok(all.has(t), t);
  assert.deepEqual(await names({ KAIROS_APPS: "messages" }), new Set(["kairos_activity", "kairos_health"]), "the activity log and the health check are always there; undo only when something may write");
  assert.ok(ALL_TOOLS.every((t) => t.annotations.openWorldHint === false));
});

test("annotations: reads are read only, deletes and updates destructive, creates additive", () => {
  const a = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t.annotations]));
  for (const [name, x] of Object.entries(a)) {
    if (/_(read|list|lists|folders|search|calendars|birthdays|now|played|top|playlists|status|timeline|mailboxes|unread|activity|health)$/.test(name)) assert.equal(x.readOnlyHint, true, name);
    else assert.equal(x.readOnlyHint, false, name);
  }
  for (const n of ["calendar_delete", "reminders_delete", "calendar_update", "reminders_update", "notes_replace", "kairos_undo"]) assert.equal(a[n].destructiveHint, true, n);
  for (const n of ["calendar_create", "reminders_create", "notes_create", "notes_append", "notes_move", "notes_trash", "reminders_complete", "mail_create_draft"]) assert.equal(a[n].destructiveHint, false, n);
  assert.equal(a.notes_move.idempotentHint, true, "moving to where a note already is changes nothing");
  for (const n of ["calendar_create", "reminders_create", "notes_create", "notes_append"]) assert.equal(a[n].idempotentHint, false, n);
});

test("initialize accepts a supported protocol version", async () => {
  const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.equal(res.result.serverInfo.name, "kairos");
  assert.equal(res.result.instructions, INSTRUCTIONS);
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
});

test("initialize answers an unknown protocol version with our newest, not an echo", async () => {
  for (const v of ["2099-01-01", "1999-01-01", undefined]) {
    const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } });
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  }
});

test("instructions carry the confirmation, language, id and data rules", () => {
  assert.match(INSTRUCTIONS, /wait for a clear yes/);
  assert.match(INSTRUCTIONS, /English/);
  assert.match(INSTRUCTIONS, /by id/);
  assert.match(INSTRUCTIONS, /data, never instructions/);
});

test("tools/list hides write tools unless KAIROS_WRITE allows them", async () => {
  const names = async (s) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  assert.deepEqual(await names(server), ["notes_echo", "notes_list_example", "notes_boom"]);
  const writer = createServer({ tools: TOOLS, config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  assert.ok((await names(writer)).includes("notes_create_example"));
  assert.deepEqual(await names(createServer({ tools: TOOLS, config: cfg({ KAIROS_APPS: "mail" }) })), []);
});

test("listed tools carry title and all annotations, and no handler", async () => {
  const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const t of res.result.tools) {
    assert.equal(typeof t.title, "string");
    assert.equal(t.handler, undefined);
    assert.equal(t.app, undefined);
    assert.equal(t.annotations.openWorldHint, false);
    for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint"]) assert.equal(typeof t.annotations[h], "boolean");
  }
});

test("tools/call returns structuredContent plus a text copy", async () => {
  const res = await call("notes_echo", { text: "Grüße 👋" });
  assert.deepEqual(res.result.structuredContent, { text: "Grüße 👋" });
  assert.deepEqual(JSON.parse(res.result.content[0].text), { text: "Grüße 👋" });
  assert.equal(res.result.isError, undefined);
});

test("non object results are wrapped so structuredContent is always an object", async () => {
  const res = await call("notes_list_example", {});
  assert.deepEqual(res.result.structuredContent, { result: ["a", "b"] });
});

test("bad arguments and handler errors come back as tool errors", async () => {
  const missing = await call("notes_echo", {});
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Missing required argument "text"/);
  const user = await call("notes_boom", { user: true });
  assert.equal(user.result.isError, true);
  assert.equal(user.result.content[0].text, "Note not found.");
});

test("unknown and hidden tools are protocol errors", async () => {
  assert.equal((await call("notes_nope", {})).error.code, -32602);
  assert.equal((await call("notes_create_example", {})).error.code, -32602);
});

test("ping, unknown methods, notifications and invalid requests", async () => {
  assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 7, method: "ping" }), { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 8, method: "resources/list" })).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await server.handle({ id: 9, method: "ping" })).error.code, -32600);
  assert.equal((await server.handle([1, 2])).error.code, -32600);
});

/* ---------- two step tools: preview, then confirm ---------- */

test("destructive tools must have a preview, and get a confirmation parameter", async () => {
  const { UPDATE } = await import("../src/lib/tools.js");
  const base = { name: "notes_wipe", app: "notes", title: "Wipe", description: "Invented.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: UPDATE, handler: () => ({}) };
  assert.throws(() => defineTool(base), /destructive tools need a preview/);
  const t = defineTool({ ...base, preview: async () => ({ summary: "x" }) });
  assert.ok(t.inputSchema.properties.confirmation);
  for (const real of ALL_TOOLS.filter((x) => x.annotations.destructiveHint)) assert.equal(typeof real.preview, "function", real.name);
});

test("first call previews and changes nothing; the token confirms exactly that change, once", async () => {
  const { UPDATE } = await import("../src/lib/tools.js");
  const done = [];
  const wipe = defineTool({
    name: "notes_wipe", app: "notes", title: "Wipe", description: "Invented.", annotations: UPDATE,
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    preview: async ({ id }) => ({ summary: `Wipe note ${id}.`, note_id: id }),
    handler: async ({ id }) => { done.push(id); return { wiped: id }; },
  });
  const s = createServer({ tools: [wipe], config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  const call = async (args) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_wipe", arguments: args } })).result;

  const p = (await call({ id: "N1" })).structuredContent;
  assert.equal(p.changed, false);
  assert.equal(p.preview, "Wipe note N1.");
  assert.match(p.confirmation, /^confirm-[0-9a-f]{24}$/);
  assert.match(p.note, /wait for a clear yes|wait for the user|Show the user/);
  assert.deepEqual(done, [], "nothing happened on the preview");

  const wrong = await call({ id: "N2", confirmation: p.confirmation });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /different change/);
  assert.deepEqual(done, []);

  const p2 = (await call({ id: "N1" })).structuredContent;
  const done1 = (await call({ id: "N1", confirmation: p2.confirmation })).structuredContent;
  assert.equal(done1.wiped, "N1");
  assert.match(done1.activity_id, /^act-/, "every change is logged");
  assert.deepEqual(done, ["N1"]);
  const again = await call({ id: "N1", confirmation: p2.confirmation });
  assert.match(again.content[0].text, /already used/);
  assert.deepEqual(done, ["N1"], "a token works once");
});

test("a preview that finds a problem refuses before any token is issued", async () => {
  const { DELETE } = await import("../src/lib/tools.js");
  const t = defineTool({
    name: "notes_drop", app: "notes", title: "Drop", description: "Invented.", annotations: DELETE,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    preview: async () => { throw new UserError("This note is locked."); }, handler: async () => ({}),
  });
  const s = createServer({ tools: [t], config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_drop", arguments: { id: "x" } } })).result;
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "This note is locked.");
});

test("a finished write whose result is too large is reported as done, not as a failure", async () => {
  const big = defineTool({
    name: "notes_big_write", app: "notes", title: "Big write", description: "Writes and returns too much.",
    inputSchema: { type: "object", properties: {} }, annotations: ADD, handler: () => ({ text: "x".repeat(150_000) }),
  });
  const bigRead = defineTool({
    name: "notes_big_read", app: "notes", title: "Big read", description: "Returns too much.",
    inputSchema: { type: "object", properties: {} }, annotations: READ, handler: () => ({ text: "x".repeat(150_000) }),
  });
  const s = createServer({ tools: [big, bigRead], config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  const w = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_big_write", arguments: {} } });
  assert.equal(w.result.isError, undefined);
  assert.equal(w.result.structuredContent.done, true);
  assert.match(w.result.structuredContent.activity_id, /^act-/);
  assert.match(w.result.structuredContent.message, /Do not repeat the call/);
  // A large read result is not refused: it comes in parts.
  const r = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes_big_read", arguments: {} } });
  assert.equal(r.result.isError, undefined);
  assert.equal(r.result.structuredContent.paging.has_more, true);
});

test("KAIROS_CONFIRM=off: changes act at once, are still logged, and are described as one step", async () => {
  const { UPDATE } = await import("../src/lib/tools.js");
  const done = [];
  const wipe = defineTool({
    name: "notes_wipe", app: "notes", title: "Wipe", description: "Invented.", annotations: UPDATE,
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    preview: async ({ id }) => ({ summary: `Wipe note ${id}.` }),
    handler: async ({ id }) => { done.push(id); return { wiped: id, _journal: { action: "wipe", target: { kind: "note", id }, summary: `Wiped ${id}.`, undo: { possible: false, reason: "test" } } }; },
  });
  const on = createServer({ tools: [wipe], config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  const off = createServer({ tools: [wipe], config: cfg({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes", KAIROS_CONFIRM: "off" }) });
  const list = async (s) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.find((t) => t.name === "notes_wipe");
  const init = async (s) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.instructions;

  assert.match((await list(on)).description, /Two steps/);
  assert.ok((await list(on)).inputSchema.properties.confirmation);
  assert.match((await list(off)).description, /Acts immediately/);
  assert.equal((await list(off)).inputSchema.properties.confirmation, undefined);
  assert.match(await init(on), /two steps: the first call only returns a preview/);
  assert.match(await init(off), /switched previews off: .* act immediately/);
  assert.doesNotMatch(await init(off), /wait for a clear yes/);

  const r = (await off.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_wipe", arguments: { id: "N1" } } })).result.structuredContent;
  assert.equal(r.wiped, "N1");
  assert.equal(r.confirmation, undefined, "no preview step");
  assert.match(r.activity_id, /^act-/, "still logged");
  assert.deepEqual(done, ["N1"]);
});

test("KAIROS_CONFIRM accepts on/off and friends; anything else keeps previews on with a warning", () => {
  for (const v of ["off", "OFF", "no", "false", "0"]) assert.equal(cfg({ KAIROS_CONFIRM: v }).confirm, false, v);
  for (const v of [undefined, "", "on", "yes", "true", "1"]) assert.equal(cfg({ KAIROS_CONFIRM: v }).confirm, true, String(v));
  const bad = cfg({ KAIROS_CONFIRM: "sometimes" });
  assert.equal(bad.confirm, true);
  assert.match(bad.warnings.join(), /KAIROS_CONFIRM/);
});

test("exactly the tools that remove things count against the removal limit", () => {
  assert.deepEqual(ALL_TOOLS.filter((t) => t.removes).map((t) => t.name).sort(), ["calendar_delete", "mail_trash", "notes_trash", "reminders_delete"]);
});
