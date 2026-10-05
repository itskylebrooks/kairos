// Music play log: pure logic plus the file store, on invented tracks in a temp directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { coverage, decide, loadLog, makeEntry, placeEvent, readEntries, readState, replay, runSnapshot, timeline, topPlays, trackMatches, updateCatalog } from "../src/lib/playlog.js";

const at = (d, h = 12, m = 0) => new Date(2030, 0, d, h, m); // local times in January 2030
const H = 3600e3;

test("decide: the first check of each day snapshots, later ones every hour, never with Music closed", () => {
  const last = at(10, 9).toISOString();
  assert.deepEqual(decide({ now: at(10, 9, 45), last, musicRunning: null }), { take: false, reason: "recent" });
  assert.deepEqual(decide({ now: at(10, 10), last, musicRunning: null }), { take: null, reason: "check_music" });
  assert.deepEqual(decide({ now: at(10, 10), last, musicRunning: true }), { take: true, reason: "interval" });
  // The hourly check runs on the hour: a snapshot a moment after the last one is still taken.
  const justAfter = new Date(at(10, 9).getTime() + 400).toISOString();
  assert.deepEqual(decide({ now: new Date(at(10, 10).getTime() + 200), last: justAfter, musicRunning: true }), { take: true, reason: "interval" });
  assert.deepEqual(decide({ now: at(11, 0, 30), last: at(10, 23).toISOString(), musicRunning: true }), { take: true, reason: "daily" });
  assert.deepEqual(decide({ now: at(11, 8), last, musicRunning: false }), { take: false, reason: "music_closed" });
  assert.deepEqual(decide({ now: at(10, 9, 5), last, musicRunning: true, force: true }), { take: true, reason: "manual" });
  assert.deepEqual(decide({ now: at(10, 9), last: null, musicRunning: true }), { take: true, reason: "first" });
});

const NAMES = { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta" };
const tracks = (counts, last = {}) => Object.entries(counts).map(([id, count]) => ({ id, count, last: last[id] ?? null, name: NAMES[id], artist: "Ada Example", album: "Example Album" }));

test("entries: a baseline first and each month, then only changed counts; removals recorded", () => {
  const a = makeEntry({ prev: null, tracks: tracks({ A: 1, B: 0 }), now: at(10), reason: "first" });
  assert.equal(a.entry.kind, "baseline");
  assert.deepEqual(a.entry.counts, { A: 1, B: 0 });
  const b = makeEntry({ prev: a.state, tracks: tracks({ A: 3, C: 1 }, { A: at(10, 15).toISOString() }), now: at(10, 18), reason: "interval" });
  assert.equal(b.entry.kind, "delta");
  assert.deepEqual(b.entry.counts, { A: 3, C: 1 });
  assert.deepEqual(b.entry.removed, ["B"]);
  assert.deepEqual(Object.keys(b.entry.last), ["A"]);
  assert.equal(b.changed, 2);
  const c = makeEntry({ prev: b.state, tracks: tracks({ A: 3, C: 1 }), now: new Date(2030, 1, 1, 9), reason: "daily" });
  assert.equal(c.entry.kind, "baseline");
  assert.deepEqual(c.entry.counts, { A: 3, C: 1 });
});

const E = (t, counts, last = {}, extra = {}) => ({ t: t.toISOString(), counts, last: Object.fromEntries(Object.entries(last).map(([k, v]) => [k, v.toISOString()])), ...extra });

test("replay: increases become plays, decreases are resets, new tracks count only fresh plays", () => {
  const r = replay([
    E(at(10, 9), { A: 5, B: 2 }),
    E(at(10, 15), { A: 7 }, { A: at(10, 14) }),
    E(at(11, 9), { B: 1 }),                                  // count went down: reset
    E(at(11, 15), { B: 3, C: 2, D: 4 }, { B: at(11, 14), C: at(11, 12), D: at(9, 20) }), // D: old track added again
  ]);
  assert.deepEqual(r.events.map((e) => [e.id, e.n]), [["A", 2], ["B", 2], ["C", 2]]);
  assert.deepEqual(r.anomalies.map((a) => [a.id, a.from, a.to]), [["B", 2, 1]]);
});

test("placing plays: exact day, uncertain days across a gap, late sync, no date", () => {
  const ev = (from, to, n, last) => ({ from: from.getTime(), to: to.getTime(), n, last: last ? last.getTime() : null });
  assert.deepEqual(placeEvent(ev(at(10, 9), at(10, 15), 3, at(10, 14))), { at: at(10, 14).getTime(), n: 3, uncertain: 0, late: false });
  assert.deepEqual(placeEvent(ev(at(8, 9), at(10, 15), 3, at(10, 14))), { at: at(10, 14).getTime(), n: 3, uncertain: 2, late: false });
  assert.deepEqual(placeEvent(ev(at(10, 9), at(10, 15), 2, at(9, 20))), { at: at(9, 20).getTime(), n: 2, uncertain: 1, late: true });
  assert.deepEqual(placeEvent(ev(at(9, 9), at(10, 15), 2, null)), { at: at(10, 15).getTime(), n: 2, uncertain: 2, late: false });
});

test("catalog: new tracks, renames kept as aliases (and searchable), removals and returns", () => {
  const cat = { tracks: {} };
  updateCatalog(cat, [{ id: "A", name: "Old Title", artist: "Ada Example", album: "X", duration: 200 }], at(10));
  updateCatalog(cat, [{ id: "A", name: "New Title", artist: "Ada Example", album: "X" }], at(11));
  assert.equal(cat.tracks.A.name, "New Title");
  assert.deepEqual(cat.tracks.A.aliases, [{ name: "Old Title", artist: "Ada Example", album: "X" }]);
  assert.ok(trackMatches(cat.tracks.A, "old title"));
  updateCatalog(cat, [], at(12));
  assert.ok(cat.tracks.A.removed_at);
  updateCatalog(cat, [{ id: "A", name: "New Title", artist: "Ada Example", album: "X" }], at(13));
  assert.equal(cat.tracks.A.removed_at, undefined);
});

test("coverage reports gaps longer than 30 hours", () => {
  const times = [at(10, 9), at(10, 15), at(13, 9), at(13, 12)].map((d) => d.getTime());
  const c = coverage(times, at(1).getTime(), at(31).getTime());
  assert.equal(c.gaps.length, 1);
  assert.match(c.gaps[0].from, /^2030-01-10T15:00/);
});

/* ---------- store and queries, in a temp data dir ---------- */

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "kairos-playlog-")); process.env.KAIROS_DATA_DIR = dir; });
after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.KAIROS_DATA_DIR; });
beforeEach(() => rmSync(join(dir, "music"), { recursive: true, force: true }));

const lib = (counts, last = {}, extra = []) => async () => ({ running: true, tracks: [...tracks(counts, Object.fromEntries(Object.entries(last).map(([k, v]) => [k, v.toISOString()]))), ...extra] });

test("snapshot runs: first, recent skip, Music closed, interval, next day; files private", async () => {
  assert.deepEqual(await runSnapshot({ now: at(10, 9), readLibrary: lib({ A: 5, B: 2 }) }), { action: "snapshot", reason: "first", kind: "baseline", tracks: 2, changed: 0 });
  let called = false;
  assert.deepEqual(await runSnapshot({ now: at(10, 9, 40), readLibrary: async () => { called = true; return { running: true, tracks: [] }; } }), { action: "skip", reason: "recent" });
  assert.equal(called, false, "a recent snapshot skips without touching Music");
  assert.deepEqual(await runSnapshot({ now: at(10, 13), readLibrary: async () => ({ running: false }) }), { action: "skip", reason: "music_closed" });
  assert.equal((await runSnapshot({ now: at(10, 15), readLibrary: lib({ A: 7, B: 2 }, { A: at(10, 14) }) })).reason, "interval");
  assert.equal((await runSnapshot({ now: at(11, 8), readLibrary: lib({ A: 7, B: 4 }, { B: at(10, 23) }) })).reason, "daily");

  const music = join(dir, "music");
  assert.deepEqual(readdirSync(music).sort(), ["catalog.json", "snapshots-2030.jsonl", "state.json"]);
  assert.equal(statSync(music).mode & 0o777, 0o700);
  for (const f of readdirSync(music)) assert.equal(statSync(join(music, f)).mode & 0o777, 0o600, f);
  assert.equal(readEntries().entries.length, 3);
  assert.equal(readState().last_check.reason, "daily");
});

test("history: top tracks and artists, timeline with unlogged days, state rebuilt when lost", async () => {
  await runSnapshot({ now: at(10, 9), readLibrary: lib({ A: 5, B: 2 }) });
  await runSnapshot({ now: at(10, 15), readLibrary: lib({ A: 8, B: 2 }, { A: at(10, 14) }) });
  await runSnapshot({ now: at(11, 9), readLibrary: lib({ A: 8, B: 3 }, { B: at(10, 22) }) });
  rmSync(join(dir, "music", "state.json"));
  assert.deepEqual(readState().counts, { A: 8, B: 3 });

  const log = loadLog();
  const top = topPlays(log, { since: at(1).getTime(), until: at(31).getTime() });
  assert.equal(top.total_plays, 4);
  assert.deepEqual(top.items.map((x) => [x.name, x.plays]), [["Alpha", 3], ["Bravo", 1]]);
  const artists = topPlays(log, { since: at(1).getTime(), until: at(31).getTime(), group_by: "artist" });
  assert.deepEqual(artists.items.map((x) => [x.artist, x.plays, x.tracks]), [["Ada Example", 4, 2]]);

  const days = timeline(log, { since: at(9, 0).getTime(), until: at(12, 0).getTime(), bucket: "day" });
  assert.deepEqual(days.map((d) => [d.period, d.plays]), [["2030-01-09", null], ["2030-01-10", 4], ["2030-01-11", 0]]);
  const onlyB = timeline(log, { since: at(10, 0).getTime(), until: at(11, 0).getTime(), query: "bravo" });
  assert.deepEqual(onlyB.map((d) => d.plays), [1]);
});

test("a damaged line is skipped, not fatal", async () => {
  await runSnapshot({ now: at(10, 9), readLibrary: lib({ A: 1 }) });
  const f = join(dir, "music", "snapshots-2030.jsonl");
  writeFileSync(f, `${readFileSync(f, "utf8")}{"t": "2030-01-10T`, { mode: 0o600 });
  const r = readEntries();
  assert.equal(r.entries.length, 1);
  assert.equal(r.damaged, 1);
});

test("the background job runs every full hour and catches up after sleep (not StartInterval, which skips runs during sleep)", async () => {
  const { agentPlist } = await import("../src/cli/music-log.js");
  const p = agentPlist("/x/runtime/node-kairos", "/x/src/cli/music-log.js");
  assert.match(p, /<key>StartCalendarInterval<\/key><dict><key>Minute<\/key><integer>0<\/integer><\/dict>/);
  assert.doesNotMatch(p, /<key>StartInterval<\/key>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
});
