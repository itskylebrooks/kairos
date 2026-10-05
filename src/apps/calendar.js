// Calendar tools. Events go through the EventKit helper (`event`); the calendar list comes
// from Calendar's scripting, because the helper has no command for it.
//
// Repeating events: the helper can only address an event by id, and EventKit then takes the
// FIRST occurrence. There is no way to say "only next Tuesday's", so Kairos refuses to
// update or delete repeating events rather than change the wrong occurrence.
import { WEEKDAYS, addDays, ekStamp, isBareDay, localDay, localStamp, parseArgDate, parseEkDate, startOfDay } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { registerUndo } from "../lib/activity.js";
import { eventkit } from "../lib/eventkit.js";
import { defineScript, jxa } from "../lib/osascript.js";
import { clampInt } from "../lib/paging.js";
import { ADD, DELETE, READ, UPDATE, defineTool } from "../lib/tools.js";

const norm = (s) => String(s ?? "").toLowerCase();

/* ================= calendars (Calendar scripting) ================= */

// Reads names and flags in one round trip per property; quits Calendar again if this
// call had to start it.
// Bulk calendarIdentifier() fails ("Can't get object") when any calendar lacks one, so ids
// are read one by one.
const JXA_CALENDARS = defineScript("calendar.calendars", `
function run(argv) {
  const C = Application("Calendar");
  const wasRunning = C.running();
  try {
    const cs = C.calendars;
    const names = cs.name(), writable = cs.writable();
    const ids = names.map((_, i) => { try { return cs[i].calendarIdentifier(); } catch (e) { return null; } });
    return JSON.stringify({ names: names, ids: ids, writable: writable });
  } finally {
    if (!wasRunning) { try { C.quit(); } catch (e) {} }
  }
}`);

let calCache = null, calAt = 0;

/** @returns {Promise<{ id?: string, name: string, writable: boolean }[]>} */
async function calendars({ fresh = false } = /** @type {any} */ ({})) {
  if (!fresh && calCache && Date.now() - calAt < 5 * 60e3) return calCache;
  const r = await jxa(JXA_CALENDARS, {}, { app: "Calendar", timeoutMs: 60000 });
  calCache = r.names.map((name, i) => ({ name, writable: !!r.writable[i], ...(r.ids[i] ? { id: r.ids[i] } : {}) }));
  calAt = Date.now();
  return calCache;
}

/** Read only calendar names (subscriptions, holidays), or null when unknown. */
async function readOnlyNames() {
  try { return new Set((await calendars()).filter((c) => !c.writable).map((c) => c.name)); } catch { return null; }
}

/** A calendar name the helper can target: it must exist once, and be writable. */
async function writableCalendar(name) {
  const all = await calendars({ fresh: true });
  const hits = all.filter((c) => c.name === name);
  if (!hits.length) throw new UserError(`No calendar named "${name}". Use calendar_calendars to see them.`);
  if (hits.length > 1) throw new UserError(`${hits.length} calendars are named "${name}". The EventKit helper picks calendars by name, so Kairos only writes to calendars with a unique name.`);
  if (!hits[0].writable) throw new UserError(`The calendar "${name}" is read only (a subscription or someone else's calendar).`);
  return hits[0];
}

/* ================= events ================= */

const fmtDay = (d) => `${WEEKDAYS[d.getDay()]} ${localDay(d)}`;

/** Helper event JSON to a Kairos event. */
function mapEvent(e, readOnly) {
  const st = parseEkDate(e.startDate), en = parseEkDate(e.endDate);
  const allDay = !!e.isAllDay;
  const out = {
    id: e.id,
    title: e.title || "(no title)",
    calendar: e.calendar || null,
    all_day: allDay,
    start: st ? (allDay ? fmtDay(st.date) : `${fmtDay(st.date)} ${localStamp(st.date).slice(11)}`) : null,
    end: en ? (allDay ? fmtDay(en.date) : `${fmtDay(en.date)} ${localStamp(en.date).slice(11)}`) : null,
    location: e.location || null,
    notes: e.notes || null,
    url: e.url || null,
    recurring: !!(e.recurrenceRules && e.recurrenceRules.length),
    ...(readOnly && e.calendar && readOnly.has(e.calendar) ? { from_others: true } : {}),
  };
  // For all day events EventKit ends at the last day itself (inclusive); keep end only if longer.
  if (allDay && out.end === out.start) out.end = null;
  return Object.assign(out, { _s: st && st.date, _e: en && en.date });
}

const strip = ({ _s, _e, ...rest }) => rest;

async function listEvents(from, to, calendar) {
  // `--end` is exclusive and whole days: fetch one extra day, then filter exactly.
  const args = ["calendar", "list", `--start=${localDay(startOfDay(from))}`, `--end=${localDay(addDays(startOfDay(to), 1))}`];
  if (calendar) args.push(`--calendar=${calendar}`);
  args.push("--json");
  return eventkit(args);
}

/**
 * One event by id. The helper cannot fetch by id and EventKit searches at most 4 years at a
 * time, so search 4 year windows: around today, then later, then earlier.
 */
async function findEvent(id) {
  if (!id || typeof id !== "string") throw new UserError("id is required.");
  const today = startOfDay(new Date());
  const Y = 365;
  for (const [a, b] of [[-2 * Y, 2 * Y], [2 * Y, 6 * Y], [-6 * Y, -2 * Y]]) {
    const raw = await listEvents(addDays(today, a), addDays(today, b - 1));
    const hits = raw.filter((e) => e.id === id);
    if (hits.length) return { raw: hits[0], occurrences: hits.length };
  }
  throw new UserError(`No event with id ${id} within six years of today.`);
}

async function calendarCalendars() {
  const all = await calendars({ fresh: true });
  return { count: all.length, calendars: all.map((c) => ({ ...c, ...(c.writable ? {} : { from_others: true }) })) };
}

async function calendarRead({ date, since, until, calendar, search, id, limit } = /** @type {any} */ ({})) {
  const readOnly = await readOnlyNames();
  if (id) {
    const { raw } = await findEvent(id);
    const ev = strip(mapEvent(raw, readOnly));
    return { count: 1, events: [ev] };
  }
  const today = startOfDay(new Date());
  let from, to;
  if (date) { from = startOfDay(parseArgDate(date, "date")); to = addDays(from, 1); }
  else {
    from = parseArgDate(since, "since") || today;
    to = parseArgDate(until, "until") || addDays(startOfDay(from), 8);
    if (until && isBareDay(until)) to = addDays(to, 1); // a bare end date means through that day
  }
  if (to <= from) throw new UserError("until must be after since.");
  const raw = await listEvents(from, to, calendar);
  const needle = norm(search);
  let events = raw.map((e) => mapEvent(e, readOnly)).filter((e) => {
    if (!e._s) return false;
    // An all day event's end is its last day, inclusive: it lasts until that day is over.
    const end = e.all_day ? addDays(startOfDay(e._e && e._e > e._s ? e._e : e._s), 1) : e._e && e._e > e._s ? e._e : new Date(e._s.getTime() + 1);
    return e._s < to && end > from;
  });
  if (needle) events = events.filter((e) => norm(`${e.title} ${e.location} ${e.notes}`).includes(needle));
  events.sort((a, b) => (a._s || 0) - (b._s || 0));
  const l = clampInt(limit, 1, 1000, 300);
  const out = events.slice(0, l).map(strip);
  return {
    range: { from: localStamp(from), to: localStamp(to) },
    count: events.length,
    ...(events.length > l ? { truncated: true } : {}),
    events: out,
  };
}

/**
 * Start and end arguments to helper strings. A bare date means an all day event (end is
 * the last day, inclusive); a date-time means a timed event (default length 1 hour).
 * The helper is inconsistent for all day ends (verified with 1.5.0 on macOS 27): `calendar
 * create` wants the day AFTER the last day, `calendar update` wants the last day itself.
 * @param {"create" | "update"} command
 */
export function eventTimes(start, end, command) {
  if (start == null || start === "") throw new UserError("start is required.");
  const allDay = isBareDay(start);
  if (end != null && end !== "" && isBareDay(end) !== allDay) throw new UserError("start and end must both be dates (all day) or both be date-times.");
  const s = parseArgDate(start, "start");
  if (allDay) {
    const e = end ? parseArgDate(end, "end") : s;
    if (e < s) throw new UserError("end must not be before start.");
    return { allDay, start: localDay(s), end: localDay(command === "create" ? addDays(e, 1) : e) };
  }
  const e = end ? parseArgDate(end, "end") : new Date(s.getTime() + 3600e3);
  if (e <= s) throw new UserError("end must be after start.");
  return { allDay, start: ekStamp(s), end: ekStamp(e) };
}

// The helper rejects empty values, so it cannot clear a text field: say so instead of failing late.
const opt = (args, flag, v) => {
  if (v === undefined || v === null) return;
  if (String(v) === "") throw new UserError(`${flag} cannot be cleared through the EventKit helper yet. Clear it in the app, or pass new text.`);
  args.push(`--${flag}=${v}`);
};

/* ---------- activity log: machine readable state, journals, undo ---------- */

/** An event as the log stores it: times in the form the tools accept (all day end inclusive). */
export function eventState(raw) {
  const e = mapEvent(raw, null);
  const day = e.all_day;
  const fmt = (d) => (d ? (day ? localDay(d) : localStamp(d)) : null);
  return { id: e.id, title: e.title, calendar: e.calendar, all_day: day, start: fmt(e._s), end: fmt(e._e ?? e._s), location: e.location, notes: e.notes, recurring: e.recurring };
}

const SAME = ["title", "calendar", "all_day", "start", "end", "location", "notes"];
const sameEvent = (a, b) => SAME.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
const when = (st) => `${st.start}${st.end && st.end !== st.start ? ` to ${st.end}` : ""}`;

/** Fields the helper cannot clear: undoing a change that filled them in is impossible. */
function cannotRestore(before, after) {
  return ["location", "notes"].filter((k) => !before[k] && after[k]);
}

async function current(id) {
  try { return eventState((await findEvent(id)).raw); } catch { return null; }
}

/** Refuses when the event is gone or was changed since Kairos left it. */
async function unchangedSince(entry) {
  const now = await current(entry.after.id);
  if (!now) throw new UserError(`The event "${entry.after.title}" no longer exists.`);
  if (!sameEvent(now, entry.after)) throw new UserError(`The event "${entry.after.title}" was changed after Kairos' change, so undoing would overwrite those later edits. Change it in Calendar instead.`);
  return now;
}

registerUndo("calendar", "create", {
  async preview(e) { await unchangedSince(e); return { summary: `Delete the event "${e.after.title}" (${when(e.after)}, calendar "${e.after.calendar}") that Kairos created.` }; },
  async run(e) {
    await unchangedSince(e);
    const r = await calendarDelete({ id: e.after.id });
    return { result: r, journal: { action: "delete", target: { kind: "event", id: e.after.id, title: e.after.title }, summary: `Deleted "${e.after.title}" (undo of its creation).`, before: e.after, after: null } };
  },
});

registerUndo("calendar", "update", {
  async preview(e) {
    await unchangedSince(e);
    return { summary: `Change "${e.after.title}" back: ${SAME.filter((k) => (e.before[k] ?? null) !== (e.after[k] ?? null)).map((k) => `${k} from ${JSON.stringify(e.after[k])} to ${JSON.stringify(e.before[k])}`).join("; ")}.` };
  },
  async run(e) {
    await unchangedSince(e);
    const b = e.before, a = e.after;
    const args = { id: a.id };
    if (b.title !== a.title) args.title = b.title;
    if (b.start !== a.start || b.end !== a.end) Object.assign(args, { start: b.start, end: b.end });
    if (b.location !== a.location) args.location = b.location;
    if (b.notes !== a.notes) args.notes = b.notes;
    const r = await calendarUpdate(args);
    return { result: r, journal: { action: "update", target: { kind: "event", id: a.id, title: b.title }, summary: `Changed "${a.title}" back to how it was.`, before: a, after: eventState(r._raw) } };
  },
});

registerUndo("calendar", "delete", {
  async preview(e) {
    await writableCalendar(e.before.calendar);
    return { summary: `Recreate "${e.before.title}" (${when(e.before)}) in calendar "${e.before.calendar}". It comes back as a new event with a new id; alerts are not restored.` };
  },
  async run(e) {
    const b = e.before;
    const r = await calendarCreate({ title: b.title, start: b.start, end: b.end, calendar: b.calendar, location: b.location ?? undefined, notes: b.notes ?? undefined });
    return { result: r, journal: { action: "create", target: { kind: "event", id: r.created.id, title: b.title }, summary: `Recreated "${b.title}" (undo of its deletion).`, before: null, after: eventState(r._raw) } };
  },
});

async function calendarCreate({ title, start, end, calendar, location, notes } = /** @type {any} */ ({})) {
  const t = String(title ?? "").trim();
  if (!t) throw new UserError("title is required.");
  const times = eventTimes(start, end, "create");
  if (calendar) await writableCalendar(calendar);
  const args = ["calendar", "create", `--title=${t}`, `--start=${times.start}`, `--end=${times.end}`];
  opt(args, "calendar", calendar);
  opt(args, "location", location);
  opt(args, "notes", notes);
  args.push("--json");
  const created = await eventkit(args);
  const after = eventState(created);
  return {
    created: strip(mapEvent(created, null)),
    _raw: created,
    _journal: { action: "create", target: { kind: "event", id: after.id, title: after.title }, summary: `Created "${after.title}" (${when(after)}, calendar "${after.calendar}").`, before: null, after, undo: { possible: true } },
  };
}

function refuseRecurring(raw, what, occurrences = 1) {
  // Several events under one id are occurrences of a series, whatever the rules field says.
  if ((raw.recurrenceRules && raw.recurrenceRules.length) || occurrences > 1) {
    throw new UserError(`This is a repeating event. Kairos cannot ${what} a single occurrence safely (the EventKit helper would change the first one), so please ${what} it in the Calendar app.`);
  }
}

/** "Title" (Tue 2030-01-15 10:00 to Tue 2030-01-15 11:00, calendar "Work") */
const describe = (e) => `"${e.title}" (${e.start}${e.end ? ` to ${e.end}` : ""}, calendar "${e.calendar}")`;

/** How helper time strings read to a person. */
function showTimes(times) {
  const s = parseEkDate(times.start), e = parseEkDate(times.end);
  const f = (p) => (times.allDay ? fmtDay(p.date) : `${fmtDay(p.date)} ${localStamp(p.date).slice(11)}`);
  return { start: f(s), end: f(e) };
}

/** Everything calendar_update will do, checked, without writing. */
async function planUpdate({ id, title, start, end, location, notes } = /** @type {any} */ ({})) {
  const { raw, occurrences } = await findEvent(id);
  refuseRecurring(raw, "change", occurrences);
  const readOnly = await readOnlyNames();
  if (readOnly && readOnly.has(raw.calendar)) throw new UserError(`"${raw.title}" is in the read only calendar "${raw.calendar}".`);
  const before = strip(mapEvent(raw, readOnly));
  const args = ["calendar", "update", `--id=${id}`];
  const rawBefore = raw;
  const changes = [];
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw new UserError("title must not be empty.");
    args.push(`--title=${t}`);
    changes.push({ field: "title", from: before.title, to: t });
  }
  if (start !== undefined || end !== undefined) {
    const cur = mapEvent(raw, null);
    const s = start ?? (cur.all_day ? localDay(cur._s) : ekStamp(cur._s));
    let e = end;
    if (e === undefined && cur._s && cur._e) {
      // Moving the start keeps the duration.
      const ns = parseArgDate(s, "start");
      // All day: count calendar days, not hours (a day has 23 or 25 hours when the clocks change).
      const days = Math.round((startOfDay(cur._e).getTime() - startOfDay(cur._s).getTime()) / 86400e3);
      e = cur.all_day ? localDay(addDays(ns, days)) : ekStamp(new Date(ns.getTime() + (cur._e.getTime() - cur._s.getTime())));
      if (isBareDay(s) !== cur.all_day) e = undefined;
    }
    const times = eventTimes(s, e, "update");
    args.push(`--start=${times.start}`, `--end=${times.end}`);
    const shown = showTimes(times);
    changes.push({ field: "time", from: `${before.start}${before.end ? ` to ${before.end}` : ""}`, to: `${shown.start}${shown.end !== shown.start ? ` to ${shown.end}` : ""}` });
  }
  opt(args, "location", location);
  if (location !== undefined) changes.push({ field: "location", from: before.location, to: location });
  opt(args, "notes", notes);
  if (notes !== undefined) changes.push({ field: "notes", from: before.notes, to: notes });
  if (!changes.length) throw new UserError("Nothing to change: pass at least one of title, start, end, location, notes.");
  args.push("--json");
  return { before, readOnly, args, changes, raw: rawBefore };
}

async function calendarUpdate(a = /** @type {any} */ ({})) {
  const p = await planUpdate(a);
  const raw = await eventkit(p.args);
  const before = eventState(p.raw), after = eventState(raw);
  const stuck = cannotRestore(before, after);
  return {
    updated: strip(mapEvent(raw, p.readOnly)), before: p.before,
    _raw: raw,
    _journal: {
      action: "update", target: { kind: "event", id: after.id, title: after.title },
      summary: `Changed "${before.title}": ${p.changes.map((c) => `${c.field} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join("; ")}.`,
      before, after,
      undo: stuck.length ? { possible: false, reason: `The ${stuck.join(" and ")} was empty before, and the EventKit helper cannot clear it again.` } : { possible: true },
    },
  };
}

async function previewUpdate(a = /** @type {any} */ ({})) {
  const p = await planUpdate(a);
  return { summary: `Change ${describe(p.before)}: ${p.changes.map((c) => `${c.field} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join("; ")}.`, changes: p.changes, event: p.before };
}

async function planDelete({ id } = /** @type {any} */ ({})) {
  const { raw, occurrences } = await findEvent(id);
  refuseRecurring(raw, "delete", occurrences);
  const readOnly = await readOnlyNames();
  if (readOnly && readOnly.has(raw.calendar)) throw new UserError(`"${raw.title}" is in the read only calendar "${raw.calendar}".`);
  return { before: strip(mapEvent(raw, readOnly)), raw };
}

async function calendarDelete({ id } = /** @type {any} */ ({})) {
  const p = await planDelete({ id });
  await eventkit(["calendar", "delete", `--id=${id}`], { json: false });
  const before = eventState(p.raw);
  return {
    deleted: p.before,
    _journal: { action: "delete", target: { kind: "event", id, title: before.title }, summary: `Deleted "${before.title}" (${when(before)}, calendar "${before.calendar}").`, before, after: null, undo: { possible: true } },
  };
}

async function previewDelete({ id } = /** @type {any} */ ({})) {
  const p = await planDelete({ id });
  return { summary: `Delete ${describe(p.before)}.`, event: p.before };
}

/* ================= tool definitions ================= */

const DATE = { type: "string", description: "Date (2030-01-31) or local date-time (2030-01-31 18:00 or 2030-01-31T18:00)." };
const EVENT_ID = { type: "string", description: "Event id from calendar_read." };

export const tools = [
  defineTool({
    name: "calendar_calendars", app: "calendar", title: "List calendars", annotations: READ, handler: calendarCalendars,
    description: "All calendars with name and whether they are writable. Read only ones (subscriptions, holidays, other people's calendars) are marked from_others.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  }),
  defineTool({
    name: "calendar_read", app: "calendar", title: "Read calendar events", annotations: READ, handler: calendarRead,
    description: "Events for one day (date) or a range (since/until; a bare until date includes that whole day; default today plus 7 days), optionally one calendar or a text search over title, location and notes, or one event by id. Times are local. All day events have end null unless they span several days (end is then the last day).",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        date: DATE, since: DATE, until: DATE,
        calendar: { type: "string", description: "Calendar name." },
        search: { type: "string" }, id: EVENT_ID,
        limit: { type: "integer", description: "Max events (default 300)." },
      },
    },
  }),
  defineTool({
    name: "calendar_create", app: "calendar", title: "Create an event", annotations: ADD, handler: calendarCreate,
    description: "Create an event. start and end as dates (2030-01-31) make an all day event, end being the last day (default: one day); as date-times they make a timed event (default length 1 hour). Default calendar: the user's default calendar. Write titles and notes in English.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["title", "start"],
      properties: {
        title: { type: "string" }, start: DATE, end: DATE,
        calendar: { type: "string", description: "Calendar name; must be unique and writable." },
        location: { type: "string" }, notes: { type: "string" },
      },
    },
  }),
  defineTool({
    name: "calendar_update", app: "calendar", title: "Change an event", annotations: UPDATE, handler: calendarUpdate, preview: previewUpdate,
    description: "Change fields of one event by id; only the fields passed change (moving start keeps the length). Repeating events are refused: change those in the Calendar app.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: { id: EVENT_ID, title: { type: "string" }, start: DATE, end: DATE, location: { type: "string", description: "New location (cannot be cleared yet)." }, notes: { type: "string", description: "New notes (cannot be cleared yet)." } },
    },
  }),
  defineTool({
    name: "calendar_delete", app: "calendar", title: "Delete an event", annotations: DELETE, handler: calendarDelete, preview: previewDelete,
    description: "Delete one event by id. Repeating events are refused: delete those in the Calendar app.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: EVENT_ID } },
  }),
];
