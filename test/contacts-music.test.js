// Contacts and live Music tools, with invented data in fake mode.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { contactMatches, toContacts, upcomingBirthdays } from "../src/apps/contacts.js";
import { tools as musicTools } from "../src/apps/music.js";
import { UserError } from "../src/lib/errors.js";
import { setFakeFixtures } from "../src/lib/fake.js";

afterEach(() => setFakeFixtures(null));

// The bulk arrays Contacts scripting returns, one entry per person.
const RAW = {
  id: ["P1:ABPerson", "P2:ABPerson", "P3:ABPerson", "P4:ABPerson"],
  name: ["Ada Example", "René Muster", "", "Leap Example"],
  first: ["Ada", "René", null, "Leap"], middle: [null, null, null, null], last: ["Example", "Muster", null, "Example"],
  nickname: [null, null, null, null], org: [null, "Example GmbH", "Only A Company", null], job: [null, null, null, null], dept: [null, null, null, null],
  note: ["Met at the café", null, null, null],
  bday: [[1990, 3, 10], [1604, 12, 24], null, [2000, 2, 29]],
  phoneV: [["+49 170 1234567"], [], [], []], phoneL: [["_$!<Mobile>!$_"], [], [], []],
  emailV: [["ada@example.com"], ["rene@example.com"], [], []], emailL: [["home"], ["work"], [], []],
  relV: [["Bob Example"], [], [], []], relL: [["_$!<Brother>!$_"], [], [], []],
  urlV: [[], [], [], []], addrV: [[], [], [], []], addrL: [[], [], [], []],
};

test("cards: names, cleaned labels, unknown birth year, company only contacts", () => {
  const cs = toContacts(RAW);
  assert.deepEqual(cs.map((c) => c.name), ["Ada Example", "Leap Example", "Only A Company", "René Muster"]);
  const ada = cs.find((c) => c.name === "Ada Example");
  assert.deepEqual(ada.phones, [{ label: "mobile", number: "+49 170 1234567" }]);
  assert.deepEqual(ada.related_names, [{ label: "brother", name: "Bob Example" }]);
  assert.equal(ada.id, "P1:ABPerson");
  assert.deepEqual(cs.find((c) => c.name === "René Muster").birthday, { month: 12, day: 24, year: null });
});

test("search: every word, accents ignored, relations and phone endings", () => {
  const cs = toContacts(RAW);
  const find = (q) => cs.filter((c) => contactMatches(c, q)).map((c) => c.name);
  assert.deepEqual(find("rene"), ["René Muster"]);
  assert.deepEqual(find("cafe ada"), ["Ada Example"]);
  assert.deepEqual(find("brother"), ["Ada Example"]);
  assert.deepEqual(find("0170 1234567"), ["Ada Example"]);
  assert.equal(find("").length, 4);
});

test("birthdays: window, age, unknown year, 29 February in a non leap year", () => {
  const cs = toContacts(RAW);
  const now = new Date(2031, 1, 20); // 2031 is not a leap year
  const b = upcomingBirthdays(cs, 30, now);
  assert.deepEqual(b.map((x) => [x.name, x.date, x.days_until, x.turning]), [["Leap Example", "02-28", 8, 31], ["Ada Example", "03-10", 18, 41]]);
  assert.match(b[0].note, /29 February/);
  const dec = upcomingBirthdays(cs, 366, new Date(2031, 11, 24));
  assert.deepEqual(dec[0], { name: "René Muster", id: "P2:ABPerson", date: "12-24", days_until: 0, turning: null });
});

const music = (name, args) => musicTools.find((t) => t.name === name).handler(args);

test("music: closed Music is reported, never opened unless asked", async () => {
  const fx = { osascript: { music: [{ match: { open_if_closed: false }, output: { running: false } }, { output: { running: true, state: "paused", track: null } }] } };
  setFakeFixtures(fx);
  assert.deepEqual(await music("music_now", {}), { running: false, message: "Music is not running. Pass open_if_closed: true to open it." });
  assert.equal((await music("music_now", { open_if_closed: true })).state, "paused");
  assert.deepEqual(fx.calls.osascript.map((c) => c.input.open_if_closed), [false, true]);
});

test("music: dates go in as local times, limits are clamped, unknown playlists explained", async () => {
  const fx = { osascript: { music: [{ match: { mode: "playlist" }, output: { running: true, error: "no_playlist" } }, { output: { running: true, total: 0, tracks: [] } }] } };
  setFakeFixtures(fx);
  await music("music_played", { since: "2030-01-31", limit: 999999 });
  const input = fx.calls.osascript[0].input;
  assert.equal(input.since, new Date(2030, 0, 31).getTime());
  assert.equal(input.limit, 2000);
  await assert.rejects(music("music_playlists", { name: "Nope" }), (e) => e instanceof UserError && /No playlist named "Nope"/.test(e.message));
  await assert.rejects(music("music_search", { query: "  " }), /must not be empty/);
});
