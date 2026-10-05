// notes_move through the server: one step, logged, undone by moving back. Invented notes only.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { activityDir } from "../src/lib/activity.js";
import { readConfig } from "../src/lib/config.js";
import { setFakeFixtures } from "../src/lib/fake.js";
import { createServer } from "../src/server.js";

beforeEach(() => rmSync(activityDir(), { recursive: true, force: true }));
afterEach(() => setFakeFixtures(null));

const ACC = "x-coredata://TEST/ICAccount/p1", ACC2 = "x-coredata://TEST/ICAccount/p2";
const F = (n) => `x-coredata://TEST/ICFolder/p${n}`;
const N = (n) => `x-coredata://TEST/ICNote/p${n}`;
const FOLDERS = {
  accounts: [{ id: ACC, name: "iCloud", default_folder: F(2) }, { id: ACC2, name: "On My Mac", default_folder: F(8) }],
  folders: [
    { id: F(1), name: "Recently Deleted", shared: false, container: ACC, account: ACC, count: 0 },
    { id: F(2), name: "Notes", shared: false, container: ACC, account: ACC, count: 0 },
    { id: F(5), name: "Dictations", shared: false, container: ACC, account: ACC, count: 1 },
    { id: F(6), name: "Processed", shared: false, container: F(5), account: ACC, count: 0 },
    { id: F(7), name: "Team", shared: true, container: ACC, account: ACC, count: 0 },
    { id: F(8), name: "Notes", shared: false, container: ACC2, account: ACC2, count: 0 },
  ],
};
const note = (folder, extra = {}) => ({
  found: true, id: N(40), name: "Dictation 2030-01-02 08:15", folder, created: "2030-01-02T07:15:00.000Z", modified: "2030-01-02T07:15:30.000Z",
  locked: false, shared: false, attachments: [], ...extra,
});

function server() {
  const s = createServer({ config: readConfig({ KAIROS_APPS: "notes", KAIROS_WRITE: "notes" }) });
  return async (name, args) => {
    const res = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return res.result.isError ? { error: res.result.content[0].text } : res.result.structuredContent;
  };
}

test("a dictation moves to Processed in one step, is logged, and undo moves it back", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(40) }, once: true, output: note(F(5)) }, // checks
        { match: { id: N(40) }, once: true, output: note(F(5)) }, // settle
        { match: { id: N(40) }, output: note(F(6)) }, // after the move, and from then on
      ],
      "notes.move": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  const r = await call("notes_move", { id: N(40), folder: "iCloud/Dictations/Processed" });
  assert.equal(r.moved, true, r.error);
  assert.equal(r.from, "iCloud/Dictations");
  assert.equal(r.folder, "iCloud/Dictations/Processed");
  assert.match(r.activity_id, /^act-/);
  assert.equal(r.confirmation, undefined, "no preview step: a move loses nothing");
  assert.deepEqual(fx.calls.osascript.filter((c) => c.name === "notes.move").map((c) => c.input), [{ id: N(40), folder: F(6) }]);

  const log = await call("kairos_activity", { since: "2020-01-01" });
  assert.equal(log.changes[0].action, "move");
  assert.equal(log.changes[0].can_undo, true);

  const p = await call("kairos_undo", { id: r.activity_id });
  assert.match(p.preview, /back from iCloud\/Dictations\/Processed to iCloud\/Dictations/);
  const done = await call("kairos_undo", { id: r.activity_id, confirmation: p.confirmation });
  assert.equal(done.undone, r.activity_id);
  assert.deepEqual(fx.calls.osascript.filter((c) => c.name === "notes.move").at(-1).input, { id: N(40), folder: F(5) });
});

test("undo leaves a note alone that was moved again since", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(40) }, once: true, output: note(F(5)) },
        { match: { id: N(40) }, once: true, output: note(F(5)) },
        { match: { id: N(40) }, once: true, output: note(F(6)) },
        { match: { id: N(40) }, output: note(F(2)) }, // the user moved it on to Notes
      ],
      "notes.move": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  const r = await call("notes_move", { id: N(40), folder: F(6) });
  assert.match((await call("kairos_undo", { id: r.activity_id })).error, /moved again since/);
});

test("refused: Recently Deleted either way, other accounts, shared places without allow_shared; a no-op is not logged", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(41) }, output: note(F(1), { id: N(41) }) },
        { match: { id: N(40) }, output: note(F(5)) },
      ],
      "notes.move": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  assert.match((await call("notes_move", { id: N(41), folder: F(6) })).error, /Recently Deleted\. Restore it/);
  assert.match((await call("notes_move", { id: N(40), folder: F(1) })).error, /does not move notes to Recently Deleted/);
  assert.match((await call("notes_move", { id: N(40), folder: F(8) })).error, /only moves notes within one account/);
  assert.match((await call("notes_move", { id: N(40), folder: "Team" })).error, /shared with other people.*allow_shared: true/s);
  assert.match((await call("notes_move", { id: N(40), folder: "Nowhere" })).error, /No Notes folder "Nowhere"/);
  assert.equal(fx.calls.osascript.filter((c) => c.name === "notes.move").length, 0, "nothing moved");

  const same = await call("notes_move", { id: N(40), folder: "Dictations" });
  assert.equal(same.moved, false);
  assert.equal(same.activity_id, undefined, "moving to where the note already is changes nothing and is not logged");
  assert.equal((await call("kairos_activity", { since: "2020-01-01" })).total, 0);
});

test("a folder created moments ago is found: an unknown name reads the folder list again once", async () => {
  const before = { ...FOLDERS, folders: FOLDERS.folders.filter((f) => f.id !== F(6)) };
  const fx = { osascript: { "notes.folders": [{ once: true, output: before }, { output: FOLDERS }], "notes.scan": [{ output: [] }] } };
  setFakeFixtures(fx);
  const call = server();
  await call("notes_folders", {}); // the cache now holds the list from before the new folder
  assert.equal(fx.calls.osascript.filter((c) => c.name === "notes.folders").length, 1);
  const r = await call("notes_list", { folder: "Dictations/Processed" });
  assert.equal(r.total, 0, r.error);
  assert.equal(fx.calls.osascript.filter((c) => c.name === "notes.folders").length, 2, "read again once");
  assert.match((await call("notes_list", { folder: "Nowhere" })).error, /No Notes folder "Nowhere"/);
});

test("trash: one step to Recently Deleted, logged, and undo puts the note back in its folder", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(40) }, once: true, output: note(F(5)) }, // checks
        { match: { id: N(40) }, once: true, output: note(F(5)) }, // settle
        { match: { id: N(40) }, output: note(F(1)) }, // in Recently Deleted from then on
      ],
      "notes.trash": [{ output: { ok: true } }],
      "notes.move": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  const r = await call("notes_trash", { id: N(40) });
  assert.equal(r.trashed, true, r.error);
  assert.equal(r.recoverable_days, 30);
  assert.equal(r.from, "iCloud/Dictations");
  assert.equal(r.confirmation, undefined, "one step");
  assert.match(r.activity_id, /^act-/);
  const p = await call("kairos_undo", { id: r.activity_id });
  assert.match(p.preview, /Restore the note .* from Recently Deleted to iCloud\/Dictations/);
  await call("kairos_undo", { id: r.activity_id, confirmation: p.confirmation });
  assert.deepEqual(fx.calls.osascript.filter((c) => c.name === "notes.move").map((c) => c.input), [{ id: N(40), folder: F(5) }]);
});

test("trash: locked and shared notes are refused, a note already deleted is left alone and not logged", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(41) }, output: note(F(5), { id: N(41), locked: true }) },
        { match: { id: N(42) }, output: note(F(7), { id: N(42) }) },
        { match: { id: N(43) }, output: note(F(1), { id: N(43) }) },
      ],
      "notes.trash": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  assert.match((await call("notes_trash", { id: N(41) })).error, /locked/);
  assert.match((await call("notes_trash", { id: N(42) })).error, /shared with other people.*allow_shared: true/s);
  const again = await call("notes_trash", { id: N(43) });
  assert.equal(again.trashed, false);
  assert.equal(again.activity_id, undefined);
  assert.equal(fx.calls.osascript.filter((c) => c.name === "notes.trash").length, 0, "nothing deleted");
});

test("undo of a trash is refused once the note left Recently Deleted", async () => {
  const fx = {
    osascript: {
      "notes.folders": [{ output: FOLDERS }],
      "notes.get": [
        { match: { id: N(40) }, once: true, output: note(F(5)) },
        { match: { id: N(40) }, once: true, output: note(F(5)) },
        { match: { id: N(40) }, once: true, output: note(F(1)) },
        { match: { id: N(40) }, output: note(F(2)) }, // the user restored it to Notes
      ],
      "notes.trash": [{ output: { ok: true } }],
    },
  };
  setFakeFixtures(fx);
  const call = server();
  const r = await call("notes_trash", { id: N(40) });
  assert.match((await call("kairos_undo", { id: r.activity_id })).error, /no longer in Recently Deleted/);
});

test("folder names match without emoji and their invisible variation selectors, only when unique", async () => {
  const EMOJI = { ...FOLDERS, folders: [...FOLDERS.folders.map((f) => (f.id === F(5) ? { ...f, name: "🎙️ Dictations" } : f)), { id: F(9), name: "📚 Reading 📚", shared: false, container: ACC, account: ACC, count: 0 }, { id: F(10), name: "Reading", shared: false, container: ACC2, account: ACC2, count: 0 }] };
  setFakeFixtures({ osascript: { "notes.folders": [{ output: EMOJI }], "notes.scan": [{ output: [] }] } });
  const call = server();
  await call("notes_folders", {});
  for (const name of ["🎙️ Dictations", "🎙 Dictations", "Dictations", "dictations", "iCloud/Dictations/Processed", "Dictations/Processed"]) {
    assert.equal((await call("notes_list", { folder: name })).total, 0, name);
  }
  const exact = await call("notes_list", { folder: "Reading" });
  assert.equal(exact.error, undefined, "an exact name wins over a loose one");
  assert.match((await call("notes_list", { folder: "📚 Reading" })).error, /matches 2 folders/, "two folders that differ only by emoji are not guessed");
  assert.match((await call("notes_list", { folder: "Readings" })).error, /No Notes folder/);
});
