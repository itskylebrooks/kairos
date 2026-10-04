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

test("the real tool list is empty for now", async () => {
  assert.equal(ALL_TOOLS.length, 0);
  const res = await createServer({ config: cfg({}) }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(res, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
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
