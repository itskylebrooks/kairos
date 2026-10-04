// Kairos' own tools: the activity log of every change Kairos made, and undo.
// The log is written centrally by the server (see lib/activity.js); apps register how to
// undo their changes. Undo is itself a change: it goes through preview and confirmation,
// is refused when the item was changed since, and is logged too.
import { findEntry, undoerFor, withUndoState } from "../lib/activity.js";
import { addDays, isBareDay, isoLocal, parseArgDate, startOfDay } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { clampInt } from "../lib/paging.js";
import { CORE_APP, DELETE, READ, defineTool } from "../lib/tools.js";

const undoable = (e) => !e.undo_of && !e.undone_by && !e.superseded_by && e.undo?.possible === true && !!undoerFor(e);

function whyNot(e) {
  if (e.undo_of) return "This entry is itself an undo; to go back, make the change again.";
  if (e.undone_by) return `Already undone (${e.undone_by}).`;
  if (e.superseded_by) return `A later change to the same item (${e.superseded_by}) has to be undone first.`;
  if (e.undo?.possible !== true) return e.undo?.reason ?? "This change cannot be undone.";
  if (!undoerFor(e)) return "Kairos does not know how to undo this kind of change.";
  return null;
}

async function kairosActivity({ since, until, app, limit } = /** @type {any} */ ({})) {
  const today = startOfDay(new Date());
  const to = until ? (isBareDay(until) ? addDays(parseArgDate(until, "until"), 1) : parseArgDate(until, "until")) : addDays(today, 1);
  const from = since ? parseArgDate(since, "since") : addDays(today, -6);
  if (to <= from) throw new UserError("until must be after since.");
  const all = withUndoState().filter((e) => {
    const t = Date.parse(e.t);
    return t >= from.getTime() && t < to.getTime() && (!app || e.app === app);
  }).reverse();
  const l = clampInt(limit, 1, 200, 30);
  return {
    range: { from: isoLocal(from), to: isoLocal(to) },
    total: all.length,
    ...(all.length > l ? { has_more: true } : {}),
    changes: all.slice(0, l).map((e) => ({
      id: e.id,
      time: isoLocal(new Date(e.t)),
      app: e.app,
      action: e.action,
      summary: e.summary,
      ...(e.undo_of ? { undo_of: e.undo_of } : {}),
      ...(e.undone_by ? { undone_by: e.undone_by } : {}),
      can_undo: undoable(e),
      ...(undoable(e) ? {} : { why_not: whyNot(e) }),
    })),
    note: "Only changes made through Kairos are listed, never edits made directly in the apps. Kept 90 days.",
  };
}

/** The entry, checked: it exists, can be undone, and its app may write. */
function undoTarget(id, ctx) {
  if (!id) throw new UserError("id is required: take it from kairos_activity.");
  const e = findEntry(id);
  if (!e) throw new UserError(`No change ${id} in the activity log (it keeps 90 days).`);
  const reason = whyNot(e);
  if (reason) throw new UserError(reason);
  if (!ctx?.config?.write?.has(e.app)) throw new UserError(`Kairos may not write to ${e.app} (KAIROS_WRITE), so it cannot undo this change.`);
  return e;
}

/** Nested internal fields (raw helper output, journals) never leave Kairos. */
const publicOnly = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, publicOnly(x)])) : v);

async function previewUndo({ id } = /** @type {any} */ ({}), ctx) {
  const e = undoTarget(id, ctx);
  const p = await undoerFor(e).preview(e);
  return { summary: `Undo "${e.summary}" (${isoLocal(new Date(e.t)).slice(0, 16).replace("T", " ")}): ${p.summary}`, change: { id: e.id, app: e.app, action: e.action } };
}

async function kairosUndo({ id } = /** @type {any} */ ({}), ctx) {
  const e = undoTarget(id, ctx);
  const { result, journal } = await undoerFor(e).run(e);
  return {
    undone: e.id,
    result: publicOnly(result),
    _journal: { ...journal, app: e.app, undo_of: e.id, undo: { possible: false, reason: "An undo cannot be undone; make the change again instead." } },
  };
}

export const tools = [
  defineTool({
    name: "kairos_activity", app: CORE_APP, title: "What Kairos changed", annotations: READ, handler: kairosActivity,
    description: "The log of changes Kairos made through Claude (created, changed, completed, deleted or replaced items and drafts), newest first, by default the last 7 days, optionally one app (calendar, reminders, notes, mail). Each change has an id, a summary and whether it can be undone (can_undo, else why_not). Changes made directly in the apps are not in it.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        since: { type: "string", description: "Date or date-time (default: 6 days ago, so the last 7 days)." },
        until: { type: "string", description: "Date or date-time; a bare date includes that day." },
        app: { type: "string", enum: ["calendar", "reminders", "notes", "mail"] },
        limit: { type: "integer", description: "Max changes (default 30)." },
      },
    },
  }),
  defineTool({
    name: "kairos_undo", app: CORE_APP, title: "Undo a change", annotations: DELETE, handler: kairosUndo, preview: previewUndo,
    description: "Undo one change from kairos_activity by its id. Refused when the item was changed after Kairos' change (undo never overwrites later edits), and for changes that cannot be undone (see why_not). Two steps: the first call only returns a preview and a confirmation; show the preview, wait for the user's yes, then call again with the same id plus confirmation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", description: "Change id from kairos_activity (act-...)." } } },
  }),
];
