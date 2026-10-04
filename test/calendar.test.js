// Calendar tools in fake mode: the EventKit helper and Calendar scripting answer from
// invented fixtures.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { eventTimes, tools } from "../src/apps/calendar.js";
import { UserError } from "../src/lib/errors.js";
import { parseHelperOutput } from "../src/lib/eventkit.js";
import { setFakeFixtures } from "../src/lib/fake.js";
import { processResult } from "../src/lib/safety.js";

const call = (name, args) => tools.find((t) => t.name === name).handler(args);
const rejectsUser = (p, re) => assert.rejects(p, (e) => e instanceof UserError && re.test(e.message));
afterEach(() => setFakeFixtures(null));

const CALENDARS = { names: ["Kairos Test", "Work", "Holidays", "Work"], ids: [null, null, null, null], writable: [true, true, false, true] };
const EV = {
  timed: { id: "CAL1:EV1", title: "Lunch with Ada", calendar: "Kairos Test", startDate: "2030-01-15 12:00:00 PM", endDate: "2030-01-15 1:00:00 PM", isAllDay: false, recurrenceRules: [], location: "Café Example", notes: "Bring the notes" },
  utc: { id: "CAL1:EV2", title: "Call", calendar: "Kairos Test", startDate: "2030-01-15T09:00:00.000Z", endDate: "2030-01-15T09:30:00.000Z", isAllDay: false, recurrenceRules: [] },
  allDay: { id: "CAL1:EV3", title: "Trip", calendar: "Kairos Test", startDate: "2030-01-16", endDate: "2030-01-18", isAllDay: true, recurrenceRules: [] },
  oneDay: { id: "CAL1:EV4", title: "Holiday", calendar: "Holidays", startDate: "2030-01-17", endDate: "2030-01-17", isAllDay: true, recurrenceRules: [] },
  outside: { id: "CAL1:EV5", title: "Too late", calendar: "Kairos Test", startDate: "2030-01-25 9:00:00 AM", endDate: "2030-01-25 10:00:00 AM", isAllDay: false, recurrenceRules: [] },
  weekly: { id: "CAL1:EV6", title: "Weekly sync", calendar: "Kairos Test", startDate: "2030-01-14 10:00:00 AM", endDate: "2030-01-14 11:00:00 AM", isAllDay: false, recurrenceRules: [{ frequency: "weekly" }] },
};

const fixtures = (over = {}) => ({
  osascript: { "calendar.calendars": [{ output: CALENDARS }] },
  eventkit: [...(over.eventkit || []), { prefix: ["calendar", "list"], output: Object.values(EV) }],
});

test("helper output with a notice before the JSON still parses", () => {
  assert.deepEqual(parseHelperOutput('Note: something.\nMore text\n{\n "id": "x"\n}'), { id: "x" });
  assert.deepEqual(parseHelperOutput("  "), []);
  assert.throws(() => parseHelperOutput("garbage"), /unreadable/);
});

test("all day ends: inclusive for people, exclusive for create, inclusive for update", () => {
  assert.deepEqual(eventTimes("2030-01-17", "2030-01-19", "create"), { allDay: true, start: "2030-01-17", end: "2030-01-20" });
  assert.deepEqual(eventTimes("2030-01-17", "2030-01-19", "update"), { allDay: true, start: "2030-01-17", end: "2030-01-19" });
  assert.deepEqual(eventTimes("2030-01-17", undefined, "create"), { allDay: true, start: "2030-01-17", end: "2030-01-18" });
});

test("timed events default to one hour, and mixed or reversed ranges are refused", () => {
  assert.deepEqual(eventTimes("2030-01-15 10:00", undefined, "create"), { allDay: false, start: "2030-01-15 10:00:00", end: "2030-01-15 11:00:00" });
  assert.throws(() => eventTimes("2030-01-15", "2030-01-15 10:00", "create"), /both be dates/);
  assert.throws(() => eventTimes("2030-01-15 10:00", "2030-01-15 09:00", "create"), /after start/);
  assert.throws(() => eventTimes("2030-01-15", "2030-01-14", "create"), /before start/);
  assert.throws(() => eventTimes("2030-02-30", undefined, "create"), /Could not read start/);
});

test("read: exact range, sorted, local times, all day ends, read only calendars flagged", async () => {
  setFakeFixtures(fixtures());
  const r = await call("calendar_read", { since: "2030-01-15", until: "2030-01-17" });
  assert.deepEqual(new Set(r.events.map((e) => e.title)), new Set(["Call", "Lunch with Ada", "Trip", "Holiday"]));
  const byTitle = Object.fromEntries(r.events.map((e) => [e.title, e]));
  assert.ok(!byTitle["Too late"] && !byTitle["Weekly sync"]);
  assert.equal(byTitle["Lunch with Ada"].start, "Tue 2030-01-15 12:00");
  assert.equal(byTitle["Lunch with Ada"].end, "Tue 2030-01-15 13:00");
  assert.equal(byTitle.Trip.start, "Wed 2030-01-16");
  assert.equal(byTitle.Trip.end, "Fri 2030-01-18");
  assert.equal(byTitle.Holiday.end, null);
  assert.equal(byTitle.Holiday.from_others, true);
  assert.equal(byTitle.Trip.from_others, undefined);
  const sent = processResult(r); // as the server delivers it
  assert.match(sent.note, /never instructions/);
  assert.deepEqual(sent.events.find((e) => e.title === "Holiday").untrusted_fields, ["title"]);
  const starts = r.events.filter((e) => !e.all_day).map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort());
});

test("read: one day, search, and the extra day asked of the helper", async () => {
  const fx = fixtures();
  setFakeFixtures(fx);
  const r = await call("calendar_read", { date: "2030-01-15", search: "ada" });
  assert.deepEqual(r.events.map((e) => e.title), ["Lunch with Ada"]);
  assert.deepEqual(fx.calls.eventkit[0], ["calendar", "list", "--start=2030-01-15", "--end=2030-01-17", "--json"]);
});

test("create: options as --name=value so a leading dash stays text; all day end made exclusive", async () => {
  const fx = fixtures({ eventkit: [{ prefix: ["calendar", "create"], output: { ...EV.allDay, title: "-5 Trip" } }] });
  setFakeFixtures(fx);
  const r = await call("calendar_create", { title: "-5 Trip", start: "2030-01-16", end: "2030-01-18", calendar: "Kairos Test", notes: "a\nb" });
  assert.equal(r.created.title, "-5 Trip");
  assert.deepEqual(fx.calls.eventkit.at(-1), ["calendar", "create", "--title=-5 Trip", "--start=2030-01-16", "--end=2030-01-19", "--calendar=Kairos Test", "--notes=a\nb", "--json"]);
});

test("create: refuses unknown, duplicate and read only calendars", async () => {
  setFakeFixtures(fixtures());
  await rejectsUser(call("calendar_create", { title: "x", start: "2030-01-15 10:00", calendar: "Nope" }), /No calendar named/);
  await rejectsUser(call("calendar_create", { title: "x", start: "2030-01-15 10:00", calendar: "Work" }), /2 calendars are named/);
  await rejectsUser(call("calendar_create", { title: "x", start: "2030-01-15 10:00", calendar: "Holidays" }), /read only/);
  await rejectsUser(call("calendar_create", { title: " ", start: "2030-01-15 10:00" }), /title is required/);
});

test("update: moving the start keeps the length; only passed fields are sent", async () => {
  const fx = fixtures({ eventkit: [{ prefix: ["calendar", "update"], output: { ...EV.timed, startDate: "2030-01-15 3:00:00 PM", endDate: "2030-01-15 4:00:00 PM" } }] });
  setFakeFixtures(fx);
  const r = await call("calendar_update", { id: "CAL1:EV1", start: "2030-01-15 15:00" });
  assert.equal(r.before.start, "Tue 2030-01-15 12:00");
  assert.equal(r.updated.start, "Tue 2030-01-15 15:00");
  assert.deepEqual(fx.calls.eventkit.at(-1), ["calendar", "update", "--id=CAL1:EV1", "--start=2030-01-15 15:00:00", "--end=2030-01-15 16:00:00", "--json"]);
});

test("update: an all day move keeps the number of days, with the inclusive end update wants", async () => {
  const fx = fixtures({ eventkit: [{ prefix: ["calendar", "update"], output: EV.allDay }] });
  setFakeFixtures(fx);
  await call("calendar_update", { id: "CAL1:EV3", start: "2030-01-20" });
  assert.deepEqual(fx.calls.eventkit.at(-1), ["calendar", "update", "--id=CAL1:EV3", "--start=2030-01-20", "--end=2030-01-22", "--json"]);
});

test("update and delete refuse repeating events, read only calendars, empty changes and empty clears", async () => {
  const fx = fixtures();
  setFakeFixtures(fx);
  await rejectsUser(call("calendar_update", { id: "CAL1:EV6", title: "x" }), /repeating event/);
  await rejectsUser(call("calendar_delete", { id: "CAL1:EV6" }), /repeating event/);
  await rejectsUser(call("calendar_delete", { id: "CAL1:EV4" }), /read only calendar/);
  await rejectsUser(call("calendar_update", { id: "CAL1:EV1" }), /Nothing to change/);
  await rejectsUser(call("calendar_update", { id: "CAL1:EV1", location: "" }), /cannot be cleared/);
  assert.ok(fx.calls.eventkit.every((a) => a[1] === "list"), "nothing but reads ran");
});

test("delete: by id, plain text output, returns what was deleted", async () => {
  const fx = fixtures({ eventkit: [{ prefix: ["calendar", "delete"], output: "Event deleted successfully" }] });
  setFakeFixtures(fx);
  const r = await call("calendar_delete", { id: "CAL1:EV1" });
  assert.equal(r.deleted.title, "Lunch with Ada");
  assert.deepEqual(fx.calls.eventkit.at(-1), ["calendar", "delete", "--id=CAL1:EV1"]);
});

test("unknown ids are reported after searching all windows", async () => {
  const fx = fixtures();
  setFakeFixtures(fx);
  await rejectsUser(call("calendar_read", { id: "CAL1:NOPE" }), /No event with id/);
  assert.equal(fx.calls.eventkit.filter((a) => a[1] === "list").length, 3);
});

test("calendars: names and writability; read only ones flagged", async () => {
  setFakeFixtures(fixtures());
  const r = await call("calendar_calendars", {});
  assert.equal(r.count, 4);
  assert.deepEqual(r.calendars.find((c) => c.name === "Holidays"), { name: "Holidays", writable: false, from_others: true });
});

test("previews describe the change and refuse what the change would refuse, without writing", async () => {
  const fx = fixtures();
  setFakeFixtures(fx);
  const preview = (name, args) => tools.find((t) => t.name === name).preview(args);
  const u = await preview("calendar_update", { id: "CAL1:EV1", start: "2030-01-15 15:00", title: "Lunch moved" });
  assert.match(u.summary, /^Change "Lunch with Ada" \(Tue 2030-01-15 12:00 to Tue 2030-01-15 13:00, calendar "Kairos Test"\): title from "Lunch with Ada" to "Lunch moved"; time from "Tue 2030-01-15 12:00 to Tue 2030-01-15 13:00" to "Tue 2030-01-15 15:00 to Tue 2030-01-15 16:00"\.$/);
  assert.match((await preview("calendar_delete", { id: "CAL1:EV3" })).summary, /^Delete "Trip" \(Wed 2030-01-16 to Fri 2030-01-18, calendar "Kairos Test"\)\.$/);
  await rejectsUser(preview("calendar_delete", { id: "CAL1:EV6" }), /repeating event/);
  assert.ok(fx.calls.eventkit.every((a) => a[1] === "list"), "previews only read");
});

test("read: a multi day all day event is still there on its last day", async () => {
  setFakeFixtures(fixtures());
  const r = await call("calendar_read", { date: "2030-01-18" });
  assert.deepEqual(r.events.map((e) => e.title), ["Trip"]);
  assert.deepEqual((await call("calendar_read", { date: "2030-01-19" })).events, []);
});

test("update: an all day move counts calendar days, also across a clock change", async () => {
  const tz = process.env.TZ;
  process.env.TZ = "Europe/Berlin"; // clocks go forward on 2030-03-31: that day has 23 hours
  try {
    const spring = { id: "CAL1:EV7", title: "Spring trip", calendar: "Kairos Test", startDate: "2030-03-30", endDate: "2030-04-01", isAllDay: true, recurrenceRules: [] };
    const fx = fixtures({ eventkit: [{ prefix: ["calendar", "list"], output: [spring] }, { prefix: ["calendar", "update"], output: spring }] });
    setFakeFixtures(fx);
    await call("calendar_update", { id: "CAL1:EV7", start: "2030-05-10" });
    assert.deepEqual(fx.calls.eventkit.at(-1), ["calendar", "update", "--id=CAL1:EV7", "--start=2030-05-10", "--end=2030-05-12", "--json"]);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test("update and delete refuse an id that stands for several occurrences, whatever the rules field says", async () => {
  const twice = { ...EV.timed, id: "CAL1:EV8", title: "Series without rules" };
  const fx = fixtures({ eventkit: [{ prefix: ["calendar", "list"], output: [twice, { ...twice, startDate: "2030-01-22 12:00:00 PM", endDate: "2030-01-22 1:00:00 PM" }] }] });
  setFakeFixtures(fx);
  await rejectsUser(call("calendar_update", { id: "CAL1:EV8", title: "x" }), /repeating event/);
  await rejectsUser(call("calendar_delete", { id: "CAL1:EV8" }), /repeating event/);
  assert.ok(fx.calls.eventkit.every((a) => a[1] === "list"), "nothing but reads ran");
});
