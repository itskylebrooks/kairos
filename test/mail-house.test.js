// Mail housekeeping through the server: Trash, Archive and read state, with undo. Invented
// accounts and messages; the Mail script answers from fixtures.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MAIL_SCRIPTS } from "../src/apps/mail.js";
import { activityDir } from "../src/lib/activity.js";
import { readConfig } from "../src/lib/config.js";
import { setFakeFixtures } from "../src/lib/fake.js";
import { createServer } from "../src/server.js";

beforeEach(() => rmSync(activityDir(), { recursive: true, force: true }));
afterEach(() => setFakeFixtures(null));

const ME = "me@example.org";
const ACCOUNTS = [{ id: "ACC1", name: "Example", addresses: [ME], enabled: true, mailboxes: [{ name: "INBOX", count: 2, unread: 1 }, { name: "Trash", count: 0, unread: 0 }, { name: "Archive", count: 0, unread: 0 }] }];
const meta = (n, extra = {}) => ({ subject: `Newsletter ${n}`, from: "News <news@example.com>", date: "2030-01-02T08:00:00.000Z", read: false, message_id: `m${n}@example.com`, ...extra });
const id = (n, box = "INBOX") => `mail:ACC1/${encodeURIComponent(box)}#${n}`;

function server(confirm = "off") {
  const s = createServer({ config: readConfig({ KAIROS_APPS: "mail", KAIROS_WRITE: "mail", KAIROS_CONFIRM: confirm }) });
  return async (name, args) => {
    const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
    return r.isError ? { error: r.content[0].text } : r.structuredContent;
  };
}

/** Makes every logged change an hour older (a fresh mail move cannot be undone yet). */
function ageLog() {
  for (const f of readdirSync(activityDir())) {
    const p = join(activityDir(), f);
    writeFileSync(p, readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { const e = JSON.parse(l); e.t = new Date(Date.parse(e.t) - 3600e3).toISOString(); return JSON.stringify(e); }).join("\n") + "\n");
  }
}

const house = (cases) => ({ osascript: { "mail.mailboxes": [{ output: { running: true, accounts: ACCOUNTS } }], "mail.house": cases } });

test("no Mail script deletes a message: housekeeping only moves", () => {
  for (const [name, { source }] of Object.entries(MAIL_SCRIPTS)) {
    assert.doesNotMatch(source, /\.delete\s*\(|\bM\.delete\b|deleteMessage|eraseDeleted/i, `${name} must never delete`);
  }
});

test("trash: messages go to the account's Trash in one step (previews off), are logged, and undo moves them back", async () => {
  const fx = house([
    { match: { action: "trash", mode: "plan" }, output: { running: true, items: [{ meta: meta(1), dest: "Trash" }, { meta: meta(2), dest: "Trash" }] } },
    { match: { action: "trash", mode: "do" }, output: { running: true, items: [{ meta: meta(1), dest: "Trash", new_id: 91 }, { meta: meta(2), dest: "Trash", new_id: 92 }] } },
    { match: { action: "restore", mode: "plan" }, output: { running: true, items: [{ meta: meta(1), dest: "INBOX" }, { meta: meta(2), dest: "INBOX" }] } },
    { match: { action: "restore", mode: "do" }, output: { running: true, items: [{ meta: meta(1), dest: "INBOX", new_id: 93 }, { meta: meta(2), dest: "INBOX", new_id: 94 }] } },
  ]);
  setFakeFixtures(fx);
  const call = server("off");
  const r = await call("mail_trash", { ids: [id(1), id(2)] });
  assert.equal(r.moved, 2, r.error);
  assert.deepEqual(r.messages.map((m) => m.id), [id(91, "Trash"), id(92, "Trash")], "the new ids are returned");
  assert.equal(r.messages[0].from_others, true);
  assert.match(r.activity_id, /^act-/);
  const runs = fx.calls.osascript.filter((c) => c.name === "mail.house");
  assert.deepEqual(runs.find((c) => c.input.mode === "do").input.items, [{ account: "ACC1", path: "INBOX", id: 1 }, { account: "ACC1", path: "INBOX", id: 2 }]);

  assert.match((await call("kairos_undo", { id: r.activity_id })).error, /still syncing this move/, "a move younger than a minute is not undone yet");
  ageLog();
  const u = await call("kairos_undo", { id: r.activity_id });
  assert.equal(u.result.moved_back, 2);
  const restore = fx.calls.osascript.find((c) => c.name === "mail.house" && c.input.action === "restore" && c.input.mode === "do");
  assert.deepEqual(restore.input.items, [
    { account: "ACC1", path: "Trash", message_id: "m1@example.com", to: "INBOX" },
    { account: "ACC1", path: "Trash", message_id: "m2@example.com", to: "INBOX" },
  ], "found again by Message-ID where Kairos put them, moved back to where they were");
});

test("with previews on, trash and archive show a preview first and move nothing", async () => {
  const fx = house([{ match: { action: "archive", mode: "plan" }, output: { running: true, items: [{ meta: meta(1), dest: "Archive" }] } }]);
  setFakeFixtures(fx);
  const p = await server("on")("mail_archive", { ids: [id(1)] });
  assert.equal(p.changed, false);
  assert.match(p.preview, /Move 1 message to Archive: "Newsletter 1" from News/);
  assert.match(p.confirmation, /^confirm-/);
  assert.ok(!fx.calls.osascript.some((c) => c.name === "mail.house" && c.input.mode === "do"), "nothing moved on the preview");
});

test("limits: 1 to 10 ids, no duplicates, valid ids only; Mail must be running", async () => {
  setFakeFixtures(house([]));
  const call = server("off");
  assert.match((await call("mail_trash", { ids: [] })).error, /1 to 10 message ids/);
  assert.match((await call("mail_trash", { ids: Array.from({ length: 11 }, (_, i) => id(i + 1)) })).error, /At most 10/);
  assert.match((await call("mail_trash", { ids: [id(1), id(1)] })).error, /only once/);
  assert.match((await call("mail_trash", { ids: ["Newsletter 1"] })).error, /not a Kairos mail id/);
  setFakeFixtures({ osascript: { "mail.house": [{ output: { running: false } }] } });
  assert.match((await call("mail_trash", { ids: [id(1)] })).error, /Mail is not running/);
});

test("archive: an account without one archive mailbox is refused, a message already there is left out, partial results are named", async () => {
  setFakeFixtures(house([
    { match: { action: "archive", mode: "plan" }, output: { running: true, items: [{ meta: meta(1), error: "several archive mailboxes" }] } },
  ]));
  assert.match((await server("off")("mail_archive", { ids: [id(1)] })).error, /more than one archive mailbox, so Kairos does not guess/);

  setFakeFixtures(house([
    { match: { action: "archive", mode: "plan" }, output: { running: true, items: [{ meta: meta(1), dest: "Archive" }, { meta: meta(2), dest: "Archive", already: true }, { error: "message not found" }] } },
    { match: { action: "archive", mode: "do" }, output: { running: true, items: [{ meta: meta(1), dest: "Archive", new_id: 70 }, { meta: meta(2), dest: "Archive", already: true }, { error: "message not found" }] } },
  ]));
  const r = await server("off")("mail_archive", { ids: [id(1), id(2), id(3)] });
  assert.equal(r.moved, 1);
  assert.deepEqual(r.not_moved.map((x) => x.reason), ["already in Archive", "not found (moved or deleted since it was listed; search again)"]);
});

test("mark: only messages not already in that state change; undo flips back only what is still as Kairos left it", async () => {
  const fx = house([
    { match: { action: "mark", mode: "plan" }, once: true, output: { running: true, items: [{ meta: meta(1) }, { meta: meta(2, { read: true }) }] } }, // preview check
    { match: { action: "mark", mode: "plan" }, once: true, output: { running: true, items: [{ meta: meta(1) }, { meta: meta(2, { read: true }) }] } }, // before state
    { match: { action: "mark", mode: "do" }, once: true, output: { running: true, items: [{ meta: meta(1, { read: true }), read: true }] } },
    { match: { action: "mark", mode: "plan" }, output: { running: true, items: [{ meta: meta(1, { read: true }) }] } }, // undo: still read
    { match: { action: "mark", mode: "do" }, output: { running: true, items: [{ meta: meta(1), read: false }] } },
  ]);
  setFakeFixtures(fx);
  const call = server("off");
  const r = await call("mail_mark", { ids: [id(1), id(2)], read: true });
  assert.equal(r.changed, 1, r.error);
  const doRun = fx.calls.osascript.find((c) => c.name === "mail.house" && c.input.mode === "do");
  assert.deepEqual(doRun.input.items, [{ account: "ACC1", path: "INBOX", id: 1 }], "the message already read is not touched");
  assert.equal(doRun.input.read, true);
  const u = await call("kairos_undo", { id: r.activity_id });
  assert.equal(u.result.changed, 1);
  assert.equal(fx.calls.osascript.filter((c) => c.name === "mail.house" && c.input.mode === "do").at(-1).input.read, false);
  assert.match((await call("mail_mark", { ids: [id(1)] })).error, /"read"/);
});

test("mail housekeeping tools exist only when Mail may write", async () => {
  const names = async (write) => (await createServer({ config: readConfig({ KAIROS_APPS: "mail", KAIROS_WRITE: write }) }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  assert.ok(!(await names("")).some((n) => /mail_(trash|archive|mark)/.test(n)));
  for (const n of ["mail_trash", "mail_archive", "mail_mark"]) assert.ok((await names("mail")).includes(n), n);
});
