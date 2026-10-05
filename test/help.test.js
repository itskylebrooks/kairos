// kairos_help: the overview of what Kairos can do, filtered to this setup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TOOLS } from "../src/apps/index.js";
import { readConfig } from "../src/lib/config.js";
import { APP_HELP, KAIROS_HELP, kairosHelp } from "../src/lib/help.js";
import { createServer } from "../src/server.js";

test("every Kairos tool appears in the overview, and nothing that is not a tool", () => {
  const listed = [...Object.values(APP_HELP).flatMap((h) => [...h.readTools, ...(h.writeTools ?? [])]), ...KAIROS_HELP.readTools, ...KAIROS_HELP.writeTools];
  assert.deepEqual([...listed].sort(), ALL_TOOLS.map((t) => t.name).sort());
  for (const [app, h] of Object.entries(APP_HELP)) {
    for (const n of h.readTools) assert.equal(ALL_TOOLS.find((t) => t.name === n).annotations.readOnlyHint, true, `${app}: ${n} is a read tool`);
    for (const n of h.writeTools ?? []) assert.equal(ALL_TOOLS.find((t) => t.name === n).annotations.readOnlyHint, false, `${app}: ${n} is a write tool`);
  }
});

test("the overview matches the setup: enabled apps only, writes only where allowed, previews named", () => {
  const ro = kairosHelp(readConfig({ KAIROS_APPS: "notes,music" }));
  assert.deepEqual(ro.apps.map((a) => a.app), ["notes", "music"]);
  const notes = ro.apps.find((a) => a.app === "notes");
  assert.deepEqual(notes.can_write, []);
  assert.match(notes.writing, /switched off/);
  assert.ok(!notes.tools.includes("notes_create"));
  assert.ok(!notes.examples.some((e) => /Create/.test(e)), "no write examples without write permission");
  assert.match(ro.changes, /Read only/);
  assert.deepEqual(ro.kairos.tools, ["kairos_activity", "kairos_health", "kairos_help"]);

  const rw = kairosHelp(readConfig({ KAIROS_APPS: "notes,mail", KAIROS_WRITE: "notes,mail", KAIROS_CONFIRM: "off" }));
  assert.ok(rw.apps.find((a) => a.app === "mail").tools.includes("mail_archive"));
  assert.match(rw.changes, /act at once/);
  assert.ok(rw.kairos.tools.includes("kairos_undo"));
  assert.match(rw.good_to_know.join(" "), /never sends anything over the network/);
  assert.match(kairosHelp(readConfig({ KAIROS_WRITE: "notes" })).changes, /preview first/);
});

test("kairos_help is listed in every setup, and Claude's instructions point to it", async () => {
  const s = createServer({ config: readConfig({ KAIROS_APPS: "contacts" }) });
  const tools = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  assert.ok(tools.includes("kairos_help"));
  const init = (await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.instructions;
  assert.match(init, /call kairos_help/);
  const r = (await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kairos_help", arguments: {} } })).result.structuredContent;
  assert.deepEqual(r.apps.map((a) => a.app), ["contacts"]);
});
