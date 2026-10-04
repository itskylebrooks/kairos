import assert from "node:assert/strict";
import { test } from "node:test";
import { ADD, DELETE, READ, UPDATE, defineTool, describeTool, selectTools, validateArgs } from "../src/lib/tools.js";
import { UserError } from "../src/lib/errors.js";

const base = {
  name: "notes_example", app: "notes", title: "Example", description: "An invented tool.",
  inputSchema: { type: "object", properties: {} }, annotations: READ, handler: () => ({}),
};

test("annotation presets are complete and closed world", () => {
  for (const a of [READ, ADD, UPDATE, DELETE]) {
    assert.equal(a.openWorldHint, false);
    for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint"]) assert.equal(typeof a[h], "boolean");
  }
  assert.equal(READ.readOnlyHint, true);
  assert.equal(ADD.destructiveHint, false);
  assert.equal(DELETE.destructiveHint, true);
});

test("defineTool rejects incomplete definitions", () => {
  assert.doesNotThrow(() => defineTool(base));
  assert.throws(() => defineTool({ ...base, title: "" }), /title/);
  assert.throws(() => defineTool({ ...base, name: "example" }), /snake_case/);
  assert.throws(() => defineTool({ ...base, name: "mail_example" }), /must start with "notes_"/);
  assert.throws(() => defineTool({ ...base, app: "messages", name: "messages_x" }), /unknown app/);
  assert.throws(() => defineTool({ ...base, annotations: { readOnlyHint: true } }), /annotation/);
  assert.throws(() => defineTool({ ...base, annotations: { ...READ, openWorldHint: true } }), /openWorldHint/);
});

test("selectTools hides disabled apps and unpermitted writes", () => {
  const read = defineTool(base);
  const write = defineTool({ ...base, name: "notes_create", annotations: ADD });
  const mail = defineTool({ ...base, app: "mail", name: "mail_search" });
  const cfg = (apps, write) => ({ apps: new Set(apps), write: new Set(write), warnings: [] });
  assert.deepEqual(selectTools([read, write, mail], cfg(["notes"], [])).map((t) => t.name), ["notes_example"]);
  assert.deepEqual(selectTools([read, write, mail], cfg(["notes", "mail"], ["notes"])).map((t) => t.name), ["notes_example", "notes_create", "mail_search"]);
});

test("describeTool omits the handler and app", () => {
  const d = describeTool(defineTool(base));
  assert.deepEqual(Object.keys(d).sort(), ["annotations", "description", "inputSchema", "name", "title"]);
});

test("validateArgs", () => {
  const schema = {
    type: "object", additionalProperties: false, required: ["id"],
    properties: { id: { type: "string" }, limit: { type: "integer" }, n: { type: "number" }, mode: { type: "string", enum: ["a", "b"] } },
  };
  assert.deepEqual(validateArgs(schema, { id: "x", limit: 3, n: 1.5, mode: "a" }), { id: "x", limit: 3, n: 1.5, mode: "a" });
  const bad = (args, re) => assert.throws(() => validateArgs(schema, args), (e) => e instanceof UserError && re.test(e.message));
  bad({}, /Missing required argument "id"/);
  bad({ id: 1 }, /"id" must be string/);
  bad({ id: "x", limit: 1.5 }, /"limit" must be integer/);
  bad({ id: "x", mode: "c" }, /one of: a, b/);
  bad({ id: "x", other: true }, /Unknown argument "other"/);
  bad([], /must be an object/);
  assert.deepEqual(validateArgs({ type: "object", properties: {} }, undefined), {});
});

test("validateArgs: names inherited from Object.prototype are not known arguments", () => {
  const schema = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } };
  const bad = (args, re) => assert.throws(() => validateArgs(schema, args), (e) => e instanceof UserError && re.test(e.message));
  bad({ id: "x", constructor: "y" }, /Unknown argument "constructor"/);
  bad({ id: "x", toString: "y" }, /Unknown argument "toString"/);
  bad(JSON.parse('{"id":"x","__proto__":{"a":1}}'), /Unknown argument "__proto__"/);
  bad(Object.create({ id: "inherited" }), /Missing required argument "id"/);
});
