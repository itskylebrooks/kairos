// Reminders tools in fake mode: the EventKit helper answers from invented fixtures.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dueArg, mapReminder, tools } from "../src/apps/reminders.js";
import { addDays, ekStamp, localDay, startOfDay } from "../src/lib/dates.js";
import { UserError } from "../src/lib/errors.js";
import { setFakeFixtures } from "../src/lib/fake.js";

const call = (name, args) => tools.find((t) => t.name === name).handler(args);
const rejectsUser = (p, re) => assert.rejects(p, (e) => e instanceof UserError && re.test(e.message));
afterEach(() => setFakeFixtures(null));

// Due dates relative to today, so the overdue and today filters are testable.
const today = startOfDay(new Date());
const day = (n) => addDays(today, n);
const R = {
  old: { id: "R1", title: "Return library books", list: "Kairos Test", dueDate: ekStamp(day(-3)), isCompleted: false, priority: 1 },
  todayAllDay: { id: "R2", title: "Water plants", list: "Kairos Test", dueDate: `${localDay(day(0))}T00:00:00`, isCompleted: false, priority: 0 },
  later: { id: "R3", title: "Call Ada", list: "Errands", dueDate: ekStamp(new Date(day(2).getTime() + 18 * 3600e3)), isCompleted: false, priority: 5, notes: "about the trip" },
  undated: { id: "R4", title: "Someday idea", list: "Kairos Test", isCompleted: false, priority: 9 },
  done: { id: "R5", title: "Done thing", list: "Kairos Test", dueDate: ekStamp(day(-1)), isCompleted: true, completionDate: ekStamp(day(-1)), priority: 0 },
};
const LISTS = [{ id: "L1", title: "Kairos Test", color: "#000000", isImmutable: false }, { id: "L2", title: "Errands", isImmutable: false }, { id: "L3", title: "Errands", isImmutable: false }, { id: "L4", title: "Shared", isImmutable: true }];

const fixtures = (over = []) => ({
  eventkit: [
    ...over,
    { prefix: ["reminders", "lists", "list"], output: LISTS },
    { args: ["reminders", "list", "--completed", "--json"], output: Object.values(R) },
    { prefix: ["reminders", "list"], output: Object.values(R).filter((r) => !r.isCompleted) },
  ],
});

test("midnight means the whole day; overdue is computed, also for whole days", () => {
  const now = new Date(today.getTime() + 10 * 3600e3);
  const a = mapReminder(R.todayAllDay, now);
  assert.equal(a.all_day, true);
  assert.equal(a.overdue, false); // due today, the day is not over
  const b = mapReminder(R.old, now);
  assert.equal(b.overdue, true);
  assert.equal(b.days_overdue, 3);
  assert.equal(mapReminder(R.undated, now).due, null);
});

test("due arguments: a date becomes local midnight, a date-time keeps its time", () => {
  assert.equal(dueArg("2030-01-20"), "2030-01-20 00:00:00");
  assert.equal(dueArg("2030-01-20 18:30"), "2030-01-20 18:30:00");
  assert.throws(() => dueArg("soon"), /Could not read due/);
});

test("read: open ones only by default, overdue first, then by date, undated last", async () => {
  setFakeFixtures(fixtures());
  const r = await call("reminders_read", {});
  assert.deepEqual(r.reminders.map((x) => x.title), ["Return library books", "Water plants", "Call Ada", "Someday idea"]);
  assert.equal(r.reminders[2].priority, "medium");
});

test("read: due filters", async () => {
  setFakeFixtures(fixtures());
  const titles = async (args) => (await call("reminders_read", args)).reminders.map((x) => x.title);
  assert.deepEqual(await titles({ due: "overdue" }), ["Return library books"]);
  assert.deepEqual(await titles({ due: "today" }), ["Water plants"]);
  assert.deepEqual(await titles({ due: "next7" }), ["Water plants", "Call Ada"]);
  assert.deepEqual(await titles({ due: "no-date" }), ["Someday idea"]);
  assert.deepEqual(await titles({ search: "TRIP" }), ["Call Ada"]);
  assert.deepEqual(await titles({ completed: "only" }), ["Done thing"]);
  await rejectsUser(call("reminders_read", { due: "soonish" }), /Unknown due filter/);
});

test("lists: an empty answer is reported as a likely permission problem", async () => {
  setFakeFixtures({ eventkit: [{ prefix: ["reminders", "lists", "list"], output: [] }] });
  await rejectsUser(call("reminders_lists", {}), /Privacy & Security > Reminders/);
});

test("create: arguments as --name=value, priority mapped, no shortcuts", async () => {
  const fx = fixtures([{ prefix: ["reminders", "create"], output: { id: "R9", title: "-2 kg flour", list: "Kairos Test", dueDate: "2030-01-20 12:00:00 AM", priority: 1 } }]);
  setFakeFixtures(fx);
  const r = await call("reminders_create", { title: "-2 kg flour", list: "Kairos Test", due: "2030-01-20", priority: "high" });
  assert.equal(r.created.all_day, true);
  assert.deepEqual(fx.calls.eventkit.at(-1), ["reminders", "create", "--title=-2 kg flour", "--list=Kairos Test", "--due=2030-01-20 00:00:00", "--priority=1", "--no-shortcuts", "--json"]);
});

test("create: refuses unknown, duplicate and read only lists, and bad priorities", async () => {
  setFakeFixtures(fixtures());
  await rejectsUser(call("reminders_create", { title: "x", list: "Nope" }), /No reminders list/);
  await rejectsUser(call("reminders_create", { title: "x", list: "Errands" }), /2 lists are named/);
  await rejectsUser(call("reminders_create", { title: "x", list: "Shared" }), /read only/);
  await rejectsUser(call("reminders_create", { title: "x", priority: "urgent" }), /priority must be/);
});

test("update: due null clears the date; empty text cannot clear; nothing to change is refused", async () => {
  const fx = fixtures([{ prefix: ["reminders", "update"], output: { ...R.later, dueDate: undefined } }]);
  setFakeFixtures(fx);
  const r = await call("reminders_update", { id: "R3", due: null });
  assert.equal(r.before.title, "Call Ada");
  assert.deepEqual(fx.calls.eventkit.at(-1), ["reminders", "update", "--id=R3", "--clear-due", "--no-shortcuts", "--json"]);
  await rejectsUser(call("reminders_update", { id: "R3", notes: "" }), /cannot be cleared/);
  await rejectsUser(call("reminders_update", { id: "R3" }), /Nothing to change/);
  await rejectsUser(call("reminders_update", { id: "NOPE", title: "x" }), /No reminder with id/);
});

test("complete and reopen, delete with plain text output", async () => {
  const fx = fixtures([
    { prefix: ["reminders", "update"], output: { ...R.later, isCompleted: true } },
    { prefix: ["reminders", "delete"], output: "Reminder deleted successfully" },
  ]);
  setFakeFixtures(fx);
  assert.equal((await call("reminders_complete", { id: "R3" })).reminder.completed, true);
  assert.deepEqual(fx.calls.eventkit.at(-1), ["reminders", "update", "--id=R3", "--completed=true", "--no-shortcuts", "--json"]);
  await call("reminders_complete", { id: "R3", completed: false });
  assert.deepEqual(fx.calls.eventkit.at(-1), ["reminders", "update", "--id=R3", "--completed=false", "--no-shortcuts", "--json"]);
  assert.equal((await call("reminders_delete", { id: "R3" })).deleted.title, "Call Ada");
  assert.deepEqual(fx.calls.eventkit.at(-1), ["reminders", "delete", "--id=R3"]);
});
