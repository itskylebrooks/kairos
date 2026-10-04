// Reminders tools, through the EventKit helper (`event`).
// Setting the flag needs a third party shortcut the helper asks for, so Kairos only reads it.
// A reminder set for a day without a time comes through as local midnight: treat it as the
// whole day. Overdue is computed here (the helper's own filter returns nothing).
import { WEEKDAYS, addDays, ekStamp, isBareDay, localDay, localStamp, parseArgDate, parseEkDate, startOfDay } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { registerUndo } from "../lib/activity.js";
import { eventkit } from "../lib/eventkit.js";
import { clampInt } from "../lib/paging.js";
import { ADD, DELETE, READ, UPDATE, defineTool } from "../lib/tools.js";

const norm = (s) => String(s ?? "").toLowerCase();
const PRIORITY_OUT = { 0: "none", 1: "high", 5: "medium", 9: "low" };
const PRIORITY_IN = { none: 0, high: 1, medium: 5, low: 9 };

/** Helper reminder JSON to a Kairos reminder (plus private sort fields). */
export function mapReminder(r, now = new Date()) {
  const p = parseEkDate(r.dueDate);
  const wholeDay = !!p && (p.dateOnly || (p.date.getHours() === 0 && p.date.getMinutes() === 0 && p.date.getSeconds() === 0));
  const dueEnd = p ? (wholeDay ? addDays(startOfDay(p.date), 1) : p.date) : null;
  const done = !!(r.isCompleted || r.completed);
  const overdue = !done && !!dueEnd && dueEnd <= now;
  const c = parseEkDate(r.completionDate);
  return {
    id: r.id,
    title: r.title || "(no title)",
    list: r.list || r.listName || null,
    due: p ? `${WEEKDAYS[p.date.getDay()]} ${wholeDay ? localDay(p.date) : localStamp(p.date)}` : null,
    all_day: p ? wholeDay : null,
    overdue,
    days_overdue: overdue ? Math.max(0, Math.round((startOfDay(now).getTime() - startOfDay(p.date).getTime()) / 86400e3)) : null,
    completed: done,
    completed_at: c ? localStamp(c.date) : null,
    priority: PRIORITY_OUT[r.priority] || (r.priority ? String(r.priority) : "none"),
    flagged: !!r.isFlagged,
    notes: r.notes || null,
    url: r.url || null,
    recurring: !!(r.recurrenceRules && r.recurrenceRules.length),
    _s: p ? p.date : null,
  };
}

const strip = ({ _s, ...rest }) => rest;

/** @param {{ list?: string, completed?: boolean }} o */
async function allReminders({ list, completed }) {
  const args = ["reminders", "list"];
  if (list) args.push(`--list=${list}`);
  if (completed) args.push("--completed");
  args.push("--json");
  return eventkit(args);
}

async function lists() {
  const raw = await eventkit(["reminders", "lists", "list", "--json"]);
  // Reminders always has at least one list; none usually means access was not granted yet.
  if (!raw.length) throw new UserError("Reminders returned no lists. macOS has probably not allowed the EventKit helper to access Reminders yet: allow it in the prompt, or in System Settings > Privacy & Security > Reminders, then try again.");
  return raw;
}

async function findReminder(id) {
  if (!id || typeof id !== "string") throw new UserError("id is required.");
  const raw = await allReminders({ completed: true });
  const hit = raw.find((r) => r.id === id || r.externalId === id);
  if (!hit) throw new UserError(`No reminder with id ${id}.`);
  return hit;
}

/* ================= handlers ================= */

async function remindersLists() {
  const raw = await lists();
  return { count: raw.length, lists: raw.map((l) => ({ id: l.id, name: l.title, color: l.color || null, ...(l.isImmutable ? { read_only: true } : {}) })) };
}

async function remindersRead({ due, since, until, list, search, completed, id, limit } = /** @type {any} */ ({})) {
  const now = new Date(), today = startOfDay(now), tomorrow = addDays(today, 1);
  if (id) return { count: 1, reminders: [strip(mapReminder(await findReminder(id), now))] };
  const raw = await allReminders({ list, completed: !!completed });
  const from = parseArgDate(since, "since");
  let to = parseArgDate(until, "until");
  if (to && isBareDay(until)) to = addDays(to, 1);
  let items = raw.map((r) => mapReminder(r, now));
  if (completed === "only") items = items.filter((r) => r.completed);
  else if (!completed) items = items.filter((r) => !r.completed);
  const dueIn = (a, b) => (r) => r._s && r._s >= a && r._s < b;
  switch (due ?? "any") {
    case "any": break;
    case "overdue": items = items.filter((r) => r.overdue); break;
    case "today": items = items.filter(dueIn(today, tomorrow)); break;
    case "tomorrow": items = items.filter(dueIn(tomorrow, addDays(today, 2))); break;
    case "next7": items = items.filter(dueIn(today, addDays(today, 7))); break;
    case "no-date": items = items.filter((r) => !r._s); break;
    case "dated": items = items.filter((r) => r._s); break;
    default: throw new UserError(`Unknown due filter "${due}". Use overdue, today, tomorrow, next7, no-date, dated or any.`);
  }
  if (from) items = items.filter((r) => r._s && r._s >= from);
  if (to) items = items.filter((r) => r._s && r._s < to);
  const needle = norm(search);
  if (needle) items = items.filter((r) => norm(`${r.title} ${r.notes}`).includes(needle));
  // Overdue first (oldest first), then by due date, undated last.
  items.sort((a, b) => (b.overdue - a.overdue) || ((a._s ?? Infinity) - (b._s ?? Infinity)));
  const l = clampInt(limit, 1, 1000, 200);
  return { count: items.length, ...(items.length > l ? { truncated: true } : {}), reminders: items.slice(0, l).map(strip) };
}

/** Due argument to the helper's form: a bare date means that day (local midnight). */
export function dueArg(due) {
  const d = parseArgDate(due, "due");
  return isBareDay(due) ? `${localDay(d)} 00:00:00` : ekStamp(d);
}

function priorityArg(p) {
  if (p === undefined) return undefined;
  if (!(p in PRIORITY_IN)) throw new UserError("priority must be none, low, medium or high.");
  return PRIORITY_IN[p];
}

async function checkList(name) {
  const all = await lists();
  const hits = all.filter((l) => l.title === name);
  if (!hits.length) throw new UserError(`No reminders list named "${name}". Use reminders_lists to see them.`);
  if (hits.length > 1) throw new UserError(`${hits.length} lists are named "${name}". The EventKit helper picks lists by name, so Kairos only writes to lists with a unique name.`);
  if (hits[0].isImmutable) throw new UserError(`The list "${name}" is read only.`);
}

// The helper rejects empty values, so it cannot clear a text field: say so instead of failing late.
const opt = (args, flag, v) => {
  if (v === undefined || v === null) return;
  if (String(v) === "") throw new UserError(`${flag} cannot be cleared through the EventKit helper yet. Clear it in the app, or pass new text.`);
  args.push(`--${flag}=${v}`);
};

/* ---------- activity log: machine readable state, journals, undo ---------- */

/** A reminder as the log stores it: due in the form the tools accept. */
export function reminderState(raw) {
  const r = mapReminder(raw);
  const due = r._s ? (r.all_day ? localDay(r._s) : localStamp(r._s)) : null;
  return { id: r.id, title: r.title, list: r.list, due, completed: r.completed, notes: r.notes, url: r.url, priority: r.priority, recurring: r.recurring };
}

const SAME = ["title", "list", "due", "completed", "notes", "url", "priority"];
const sameReminder = (a, b) => SAME.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));

async function unchangedSince(entry) {
  let raw;
  try { raw = await findReminder(entry.after.id); } catch { throw new UserError(`The reminder "${entry.after.title}" no longer exists.`); }
  if (!sameReminder(reminderState(raw), entry.after)) throw new UserError(`The reminder "${entry.after.title}" was changed after Kairos' change, so undoing would overwrite those later edits. Change it in Reminders instead.`);
}

registerUndo("reminders", "create", {
  async preview(e) { await unchangedSince(e); return { summary: `Delete the reminder "${e.after.title}" (list "${e.after.list}") that Kairos created.` }; },
  async run(e) {
    await unchangedSince(e);
    const r = await remindersDelete({ id: e.after.id });
    return { result: r, journal: { action: "delete", target: { kind: "reminder", id: e.after.id, title: e.after.title }, summary: `Deleted "${e.after.title}" (undo of its creation).`, before: e.after, after: null } };
  },
});

registerUndo("reminders", "update", {
  async preview(e) {
    await unchangedSince(e);
    return { summary: `Change "${e.after.title}" back: ${SAME.filter((k) => (e.before[k] ?? null) !== (e.after[k] ?? null)).map((k) => `${k} from ${JSON.stringify(e.after[k])} to ${JSON.stringify(e.before[k])}`).join("; ")}.` };
  },
  async run(e) {
    await unchangedSince(e);
    const b = e.before, a = e.after, args = { id: a.id };
    if (b.title !== a.title) args.title = b.title;
    if (b.due !== a.due) args.due = b.due; // null clears the due date
    if (b.notes !== a.notes) args.notes = b.notes;
    if (b.url !== a.url) args.url = b.url;
    if (b.priority !== a.priority) args.priority = b.priority;
    const r = await remindersUpdate(args);
    return { result: r, journal: { action: "update", target: { kind: "reminder", id: a.id, title: b.title }, summary: `Changed "${a.title}" back to how it was.`, before: a, after: reminderState(r._raw) } };
  },
});

registerUndo("reminders", "complete", {
  async preview(e) { await unchangedSince(e); return { summary: `${e.before.completed ? "Mark as done again" : "Reopen"}: "${e.after.title}" (list "${e.after.list}").` }; },
  async run(e) {
    await unchangedSince(e);
    const r = await remindersComplete({ id: e.after.id, completed: e.before.completed });
    return { result: r, journal: { action: "complete", target: { kind: "reminder", id: e.after.id, title: e.after.title }, summary: `${e.before.completed ? "Marked as done again" : "Reopened"} "${e.after.title}".`, before: e.after, after: reminderState(r._raw) } };
  },
});

registerUndo("reminders", "delete", {
  async preview(e) {
    await checkList(e.before.list);
    return { summary: `Recreate the reminder "${e.before.title}" in list "${e.before.list}"${e.before.due ? `, due ${e.before.due}` : ""}. It comes back with a new id.` };
  },
  async run(e) {
    const b = e.before;
    const r = await remindersCreate({ title: b.title, list: b.list, due: b.due ?? undefined, notes: b.notes ?? undefined, url: b.url ?? undefined, priority: b.priority });
    return { result: r, journal: { action: "create", target: { kind: "reminder", id: r.created.id, title: b.title }, summary: `Recreated "${b.title}" (undo of its deletion).`, before: null, after: reminderState(r._raw) } };
  },
});

async function remindersCreate({ title, list, due, notes, url, priority } = /** @type {any} */ ({})) {
  const t = String(title ?? "").trim();
  if (!t) throw new UserError("title is required.");
  if (list) await checkList(list);
  const args = ["reminders", "create", `--title=${t}`];
  opt(args, "list", list);
  if (due) args.push(`--due=${dueArg(due)}`);
  opt(args, "notes", notes);
  opt(args, "url", url);
  opt(args, "priority", priorityArg(priority));
  args.push("--no-shortcuts", "--json");
  const raw = await eventkit(args);
  const after = reminderState(raw);
  return {
    created: strip(mapReminder(raw)), _raw: raw,
    _journal: { action: "create", target: { kind: "reminder", id: after.id, title: after.title }, summary: `Created the reminder "${after.title}" (list "${after.list}"${after.due ? `, due ${after.due}` : ""}).`, before: null, after, undo: { possible: true } },
  };
}

/** "Title" (list "Errands", due Tue 2030-01-15) */
const describe = (r) => `"${r.title}" (list "${r.list}"${r.due ? `, due ${r.due}` : ""})`;

/** Everything reminders_update will do, checked, without writing. */
async function planUpdate({ id, title, due, notes, url, priority } = /** @type {any} */ ({})) {
  const raw = await findReminder(id);
  const before = strip(mapReminder(raw));
  const args = ["reminders", "update", `--id=${raw.id}`];
  const rawBefore = raw;
  const changes = [];
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw new UserError("title must not be empty.");
    args.push(`--title=${t}`);
    changes.push({ field: "title", from: before.title, to: t });
  }
  if (due === null || due === "") { args.push("--clear-due"); changes.push({ field: "due", from: before.due, to: null }); }
  else if (due !== undefined) { args.push(`--due=${dueArg(due)}`); changes.push({ field: "due", from: before.due, to: due }); }
  opt(args, "notes", notes);
  if (notes !== undefined) changes.push({ field: "notes", from: before.notes, to: notes });
  opt(args, "url", url);
  if (url !== undefined) changes.push({ field: "url", from: before.url, to: url });
  opt(args, "priority", priorityArg(priority));
  if (priority !== undefined) changes.push({ field: "priority", from: before.priority, to: priority });
  if (!changes.length) throw new UserError("Nothing to change: pass at least one of title, due, notes, url, priority.");
  args.push("--no-shortcuts", "--json");
  return { before, args, changes, raw: rawBefore };
}

async function remindersUpdate(a = /** @type {any} */ ({})) {
  const p = await planUpdate(a);
  const raw = await eventkit(p.args);
  const before = reminderState(p.raw), after = reminderState(raw);
  const stuck = ["notes", "url"].filter((k) => !before[k] && after[k]);
  return {
    updated: strip(mapReminder(raw)), before: p.before, _raw: raw,
    _journal: {
      action: "update", target: { kind: "reminder", id: after.id, title: after.title },
      summary: `Changed "${before.title}": ${p.changes.map((c) => `${c.field} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join("; ")}.`,
      before, after,
      undo: stuck.length ? { possible: false, reason: `The ${stuck.join(" and ")} was empty before, and the EventKit helper cannot clear it again.` } : { possible: true },
    },
  };
}

async function previewUpdate(a = /** @type {any} */ ({})) {
  const p = await planUpdate(a);
  return { summary: `Change ${describe(p.before)}: ${p.changes.map((c) => `${c.field} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join("; ")}.`, changes: p.changes, reminder: p.before };
}

async function remindersComplete({ id, completed = true } = /** @type {any} */ ({})) {
  const before = await findReminder(id);
  const raw = await eventkit(["reminders", "update", `--id=${before.id}`, `--completed=${completed ? "true" : "false"}`, "--no-shortcuts", "--json"]);
  const repeats = !!before.recurrenceRules?.length;
  const b = reminderState(before), a = reminderState(raw);
  return {
    reminder: strip(mapReminder(raw)), _raw: raw,
    ...(repeats && completed ? { note: "This reminder repeats: completing it moves it to its next date." } : {}),
    _journal: {
      action: "complete", target: { kind: "reminder", id: a.id, title: a.title },
      summary: `${completed ? "Marked as done" : "Reopened"} "${a.title}" (list "${a.list}").`, before: b, after: a,
      undo: repeats && completed ? { possible: false, reason: "It repeats: completing it already moved it to its next date." } : { possible: true },
    },
  };
}

async function previewComplete({ id, completed = true } = /** @type {any} */ ({})) {
  const raw = await findReminder(id);
  const r = strip(mapReminder(raw));
  const repeats = raw.recurrenceRules?.length && completed ? " It repeats, so it moves to its next date." : "";
  return { summary: `${completed ? "Mark as done" : "Reopen"}: ${describe(r)}.${repeats}`, reminder: r };
}

async function remindersDelete({ id } = /** @type {any} */ ({})) {
  const raw = await findReminder(id);
  await eventkit(["reminders", "delete", `--id=${raw.id}`], { json: false });
  const before = reminderState(raw);
  return {
    deleted: strip(mapReminder(raw)),
    _journal: {
      action: "delete", target: { kind: "reminder", id: raw.id, title: before.title }, summary: `Deleted the reminder "${before.title}" (list "${before.list}").`, before, after: null,
      undo: before.recurring ? { possible: false, reason: "It repeated, and the repeat rule cannot be restored." } : { possible: true },
    },
  };
}

async function previewDelete({ id } = /** @type {any} */ ({})) {
  const r = strip(mapReminder(await findReminder(id)));
  return { summary: `Delete ${describe(r)}.`, reminder: r };
}

/* ================= tool definitions ================= */

const DATE = { type: "string", description: "Date (2030-01-31) or local date-time (2030-01-31 18:00)." };
const REM_ID = { type: "string", description: "Reminder id from reminders_read." };
const PRIORITY = { type: "string", enum: ["none", "low", "medium", "high"] };

export const tools = [
  defineTool({
    name: "reminders_lists", app: "reminders", title: "List reminder lists", annotations: READ, handler: remindersLists,
    description: "All Reminders lists with id and name.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  }),
  defineTool({
    name: "reminders_read", app: "reminders", title: "Read reminders", annotations: READ, handler: remindersRead,
    description: "Reminders, overdue first. due: overdue | today | tomorrow | next7 | no-date | dated | any (default). Optional since/until on the due date, list name, text search, completed (true includes them, \"only\" for only completed), or one reminder by id. Reminders without a time are all day (all_day: true).",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        due: { type: "string", enum: ["overdue", "today", "tomorrow", "next7", "no-date", "dated", "any"] },
        since: DATE, until: DATE, list: { type: "string" }, search: { type: "string" },
        completed: { type: ["boolean", "string"], enum: [true, false, "only"], description: "true to include completed, \"only\" for only completed." },
        id: REM_ID, limit: { type: "integer", description: "Max reminders (default 200)." },
      },
    },
  }),
  defineTool({
    name: "reminders_create", app: "reminders", title: "Create a reminder", annotations: ADD, handler: remindersCreate,
    description: "Create a reminder. due as a date (2030-01-31) means that day without a time; as a date-time it means at that time. Default list: the user's default list.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["title"],
      properties: { title: { type: "string" }, list: { type: "string", description: "List name; must be unique." }, due: DATE, notes: { type: "string" }, url: { type: "string" }, priority: PRIORITY },
    },
  }),
  defineTool({
    name: "reminders_update", app: "reminders", title: "Change a reminder", annotations: UPDATE, handler: remindersUpdate, preview: previewUpdate,
    description: "Change fields of one reminder by id; only the fields passed change. due: null removes the date. Two steps: the first call only returns a preview and a confirmation; show the preview, wait for the user's yes, then call again with the same arguments plus confirmation.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: { id: REM_ID, title: { type: "string" }, due: { type: ["string", "null"], description: "Date, date-time, or null to remove." }, notes: { type: "string", description: "New notes (cannot be cleared yet)." }, url: { type: "string", description: "New URL (cannot be cleared yet)." }, priority: PRIORITY },
    },
  }),
  defineTool({
    name: "reminders_complete", app: "reminders", title: "Complete a reminder", annotations: { ...UPDATE, destructiveHint: false }, handler: remindersComplete, preview: previewComplete,
    description: "Mark one reminder as done by id (completed: false reopens it). Two steps: the first call only returns a preview and a confirmation; show the preview, wait for the user's yes, then call again with the same arguments plus confirmation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: REM_ID, completed: { type: "boolean", description: "Default true." } } },
  }),
  defineTool({
    name: "reminders_delete", app: "reminders", title: "Delete a reminder", annotations: DELETE, handler: remindersDelete, preview: previewDelete,
    description: "Delete one reminder by id. Two steps: the first call only returns a preview and a confirmation; show the preview, wait for the user's yes, then call again with the same arguments plus confirmation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: REM_ID } },
  }),
];
