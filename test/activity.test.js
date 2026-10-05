// Activity log and undo, end to end through the server, with an invented calendar.
import assert from "node:assert/strict";
import { readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { activityDir, readAll, record } from "../src/lib/activity.js";
import { readConfig } from "../src/lib/config.js";
import { setFakeFixtures } from "../src/lib/fake.js";
import { createServer } from "../src/server.js";

beforeEach(() => rmSync(activityDir(), { recursive: true, force: true }));
afterEach(() => setFakeFixtures(null));

test("entries are private, ordered, and month files older than 90 days are removed", () => {
  const old = new Date(Date.now() - 200 * 86400e3);
  record({ tool: "x_old", app: "calendar", action: "create", target: { kind: "event", id: "E0" }, summary: "old", undo: { possible: true } }, old);
  const e = record({ tool: "calendar_create", app: "calendar", action: "create", target: { kind: "event", id: "E1" }, summary: "Created", undo: { possible: true } });
  assert.match(e.id, /^act-/);
  assert.deepEqual(readAll().map((x) => x.summary), ["Created"], "the 200 day old month file is gone");
  assert.equal(statSync(activityDir()).mode & 0o777, 0o700);
  for (const f of readdirSync(activityDir())) assert.equal(statSync(join(activityDir(), f)).mode & 0o777, 0o600);
});

const EVENT = { id: "CAL1:EV9", title: "Dentist", calendar: "Kairos Test", startDate: "2030-01-15 10:00:00 AM", endDate: "2030-01-15 11:00:00 AM", isAllDay: false, recurrenceRules: [] };
const CALS = { names: ["Kairos Test"], ids: [null], writable: [true] };

function server(write = "calendar") {
  const s = createServer({ config: readConfig({ KAIROS_APPS: "calendar", KAIROS_WRITE: write }) });
  return async (name, args) => {
    const res = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (res.error) return { error: res.error.message }; // e.g. a tool that is not offered
    return res.result.isError ? { error: res.result.content[0].text } : res.result.structuredContent;
  };
}

test("create, list, undo through preview and confirm; a second undo is refused", async () => {
  const fx = {
    osascript: { "calendar.calendars": [{ output: CALS }] },
    eventkit: [
      { prefix: ["calendar", "create"], output: EVENT },
      { prefix: ["calendar", "delete"], output: "Event deleted successfully" },
      { prefix: ["calendar", "list"], output: [EVENT] },
    ],
  };
  setFakeFixtures(fx);
  const call = server();
  const created = await call("calendar_create", { title: "Dentist", start: "2030-01-15 10:00", calendar: "Kairos Test" });
  assert.match(created.activity_id, /^act-/);
  assert.equal(created._journal, undefined, "internal fields never reach Claude");
  assert.equal(created._raw, undefined);

  const log = await call("kairos_activity", { since: "2020-01-01" });
  assert.equal(log.total, 1);
  assert.deepEqual(log.changes[0], { id: created.activity_id, time: log.changes[0].time, app: "calendar", action: "create", summary: 'Created "Dentist" (2030-01-15 10:00 to 2030-01-15 11:00, calendar "Kairos Test").', can_undo: true });

  const p = await call("kairos_undo", { id: created.activity_id });
  assert.equal(p.changed, false);
  assert.match(p.preview, /Delete the event "Dentist" .* that Kairos created/);
  assert.ok(!fx.calls.eventkit.some((a) => a[1] === "delete"), "the preview deletes nothing");

  const done = await call("kairos_undo", { id: created.activity_id, confirmation: p.confirmation });
  assert.equal(done.undone, created.activity_id);
  assert.match(done.activity_id, /^act-/);
  assert.equal(done.result._journal, undefined);
  assert.deepEqual(fx.calls.eventkit.filter((a) => a[1] === "delete"), [["calendar", "delete", "--id=CAL1:EV9"]]);

  const after = await call("kairos_activity", { since: "2020-01-01" });
  assert.equal(after.total, 2, "the preview was not logged, only the create and the undo");
  assert.equal(after.changes[0].undo_of, created.activity_id);
  assert.equal(after.changes[0].can_undo, false);
  assert.equal(after.changes[1].undone_by, after.changes[0].id);
  assert.match((await call("kairos_undo", { id: created.activity_id })).error, /Already undone/);
});

test("undo is refused when the item was changed since, and without write permission", async () => {
  const base = { osascript: { "calendar.calendars": [{ output: CALS }] } };
  setFakeFixtures({ ...base, eventkit: [{ prefix: ["calendar", "create"], output: EVENT }] });
  const call = server();
  const created = await call("calendar_create", { title: "Dentist", start: "2030-01-15 10:00", calendar: "Kairos Test" });
  // Later the user edits the event in Calendar.
  const fx = { ...base, eventkit: [{ prefix: ["calendar", "list"], output: [{ ...EVENT, title: "Dentist (moved by me)" }] }] };
  setFakeFixtures(fx);
  assert.match((await call("kairos_undo", { id: created.activity_id })).error, /changed after Kairos' change/);
  assert.ok(!fx.calls.eventkit.some((a) => a[1] === "delete"));
  assert.match((await server("")("kairos_undo", { id: created.activity_id })).error, /Unknown tool|may not write/, "without write permission undo is not even offered");
});

test("changes that cannot be undone say why", async () => {
  record({ tool: "mail_create_draft", app: "mail", action: "draft", target: { kind: "draft", id: null, title: "Hi" }, summary: "Saved a draft", undo: { possible: false, reason: "Delete the draft in Mail if you do not want it." } });
  const call = server("calendar,mail");
  const log = await call("kairos_activity", {});
  assert.equal(log.changes[0].can_undo, false);
  assert.match(log.changes[0].why_not, /Delete the draft in Mail/);
  assert.match((await call("kairos_undo", { id: log.changes[0].id })).error, /Delete the draft in Mail/);
});

test("an older change waits until later changes to the same item are undone", async () => {
  const mk = (action, id = "E5") => record({ tool: `calendar_${action}`, app: "calendar", action, target: { kind: "event", id }, summary: action, undo: { possible: true } });
  const created = mk("create");
  const moved = mk("update");
  mk("create", "E6"); // another item does not matter
  const call = server();
  const log = await call("kairos_activity", {});
  const byId = Object.fromEntries(log.changes.map((c) => [c.id, c]));
  assert.equal(byId[created.id].can_undo, false);
  assert.match(byId[created.id].why_not, new RegExp(`later change to the same item \\(${moved.id}\\)`));
  assert.equal(byId[moved.id].can_undo, true);
  // Once the later change is undone, the earlier one can be undone again.
  record({ tool: "kairos_undo", app: "calendar", action: "update", target: { kind: "event", id: "E5" }, summary: "back", undo_of: moved.id, undo: { possible: false } });
  const again = Object.fromEntries((await call("kairos_activity", {})).changes.map((c) => [c.id, c]));
  assert.equal(again[created.id].can_undo, true);
});

test("with previews off, undo runs in one step too", async () => {
  const fx = {
    osascript: { "calendar.calendars": [{ output: CALS }] },
    eventkit: [
      { prefix: ["calendar", "create"], output: EVENT },
      { prefix: ["calendar", "delete"], output: "Event deleted successfully" },
      { prefix: ["calendar", "list"], output: [EVENT] },
    ],
  };
  setFakeFixtures(fx);
  const s = createServer({ config: readConfig({ KAIROS_APPS: "calendar", KAIROS_WRITE: "calendar", KAIROS_CONFIRM: "off" }) });
  const call = async (name, args) => (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result.structuredContent;
  const created = await call("calendar_create", { title: "Dentist", start: "2030-01-15 10:00", calendar: "Kairos Test" });
  const undone = await call("kairos_undo", { id: created.activity_id });
  assert.equal(undone.undone, created.activity_id);
  assert.ok(fx.calls.eventkit.some((a) => a[1] === "delete"), "deleted at once, no preview");
});

test("removal limit: at most KAIROS_MAX_REMOVALS items per hour, counted from the log, enforced by the server", async () => {
  const { DELETE, defineTool } = await import("../src/lib/tools.js");
  const removed = [];
  const drop = defineTool({
    name: "notes_drop", app: "notes", title: "Drop", description: "Invented.", annotations: DELETE, removes: true,
    inputSchema: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, ids: { type: ["array", "string"] } } },
    preview: async () => ({ summary: "Drop." }),
    handler: async ({ id, ids }) => { const list = ids ?? [id]; removed.push(...list); return { dropped: list.length, _journal: { action: "trash", target: { kind: "note", id: id ?? null }, summary: "Dropped.", before: ids ? list.map((x) => ({ id: x })) : { id }, undo: { possible: false, reason: "test" } } }; },
  });
  const make = (env = {}) => {
    const s = createServer({ tools: [drop], config: readConfig({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes", KAIROS_CONFIRM: "off", ...env }) });
    return async (args) => { const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_drop", arguments: args } })).result; return r.isError ? { error: r.content[0].text } : r.structuredContent; };
  };
  const call = make({ KAIROS_MAX_REMOVALS: "3" });
  for (const id of ["N1", "N2", "N3"]) assert.equal((await call({ id })).dropped, 1);
  const refused = await call({ id: "N4" });
  assert.match(refused.error, /Removal limit reached: Kairos removed 3 items in the last hour and allows 3 per hour .* Nothing was removed/);
  assert.deepEqual(removed, ["N1", "N2", "N3"], "the fourth never ran");
  assert.match((await make({ KAIROS_MAX_REMOVALS: "3" })({ id: "N5" })).error, /limit reached/, "a new server (restart, new chat) does not reset the count");

  // Older than an hour no longer counts; a batch counts each item and must fit as a whole.
  rmSync(activityDir(), { recursive: true, force: true });
  const old = new Date(Date.now() - 3601e3);
  for (const id of ["O1", "O2", "O3"]) record({ tool: "notes_drop", app: "notes", action: "trash", target: { kind: "note", id }, summary: "old", undo: { possible: false } }, old);
  assert.equal((await call({ id: "N6" })).dropped, 1);
  assert.match((await call({ ids: ["A", "B", "C"] })).error, /removed 1 item in the last hour/, "1 + 3 would be over 3");
  assert.equal((await call({ ids: ["A", "B"] })).dropped, 2);

  const r = readConfig({ KAIROS_MAX_REMOVALS: "lots" });
  assert.equal(r.maxRemovals, 20);
  assert.match(r.warnings.join(), /KAIROS_MAX_REMOVALS/);
  assert.equal(readConfig({}).maxRemovals, 20, "default 20");
});

test("only removals count: creating, moving and marking are never limited", async () => {
  const { MOVE, defineTool } = await import("../src/lib/tools.js");
  const move = defineTool({
    name: "notes_shift", app: "notes", title: "Shift", description: "Invented.", annotations: MOVE,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    handler: async ({ id }) => ({ shifted: id, _journal: { action: "move", target: { kind: "note", id }, summary: "Moved.", undo: { possible: false, reason: "test" } } }),
  });
  const s = createServer({ tools: [move], config: readConfig({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes", KAIROS_MAX_REMOVALS: "1" }) });
  for (let i = 0; i < 5; i++) {
    const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_shift", arguments: { id: `N${i}` } } })).result;
    assert.equal(r.isError, undefined);
  }
});
