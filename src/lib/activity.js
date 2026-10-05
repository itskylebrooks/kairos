// Activity log: every change Kairos makes, recorded by the server after it succeeded, so
// the user can ask what Claude changed and undo a change. Private and local:
//   ~/Library/Application Support/Kairos/activity/activity-YYYY-MM.jsonl  (dir 0700, files 0600)
// Entries hold the item's state before and after (titles, times, notes); full note text
// stays in the notes backups and is only referenced. Entries older than 90 days are removed.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export const KEEP_DAYS = 90;

/**
 * @typedef {object} Journal  what a write tool reports about its change
 * @property {string} action  create | update | complete | delete | replace | append | draft | undo
 * @property {{ kind: string, id: string | null, title?: string | null }} target
 * @property {string} summary  one sentence, as a person would say it
 * @property {any} [before]   machine readable state before (null for creations)
 * @property {any} [after]    machine readable state after (null for deletions)
 * @property {{ possible: boolean, reason?: string }} [undo]  set by the server for undo entries
 * @property {string} [undo_of]  for undo entries: the entry that was undone
 */

export const activityDir = () => join(dataDir(), "activity");
const fileFor = (d) => join(activityDir(), `activity-${d.toISOString().slice(0, 7)}.jsonl`);

/**
 * Appends one entry and returns it with its id and time.
 * @param {{ tool: string, app: string } & Journal} e
 */
export function record(e, now = new Date()) {
  mkdirSync(activityDir(), { recursive: true, mode: 0o700 });
  const entry = { v: 1, id: `act-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`, t: now.toISOString(), ...e };
  const fd = openSync(fileFor(now), "a", 0o600);
  try { writeSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  prune(now);
  return entry;
}

/**
 * Items removed by these tools within the last `windowMs`, read from the log (this month's
 * file and last month's, which an hour can reach back into), with the time of the oldest one.
 * An entry whose `before` lists several items (mail_trash) counts each of them.
 * @param {Set<string>} tools
 */
export function recentRemovals(tools, windowMs = 3600e3, now = Date.now()) {
  const from = now - windowMs;
  const months = new Set([fileFor(new Date(now)), fileFor(new Date(from))]);
  let count = 0, oldest = null;
  for (const f of months) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const t = Date.parse(e?.t);
      if (!tools.has(e?.tool) || !(t > from) || t > now) continue;
      count += Array.isArray(e.before) ? e.before.length : 1;
      if (oldest === null || t < oldest) oldest = t;
    }
  }
  return { count, oldest };
}

/** Every entry, oldest first. Damaged lines are skipped. */
export function readAll() {
  if (!existsSync(activityDir())) return [];
  const out = [];
  for (const f of readdirSync(activityDir()).filter((x) => /^activity-\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const line of readFileSync(join(activityDir(), f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.id && e.t) out.push(e); } catch {}
    }
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * Entries, oldest first, with `undone_by` for those that were undone, and `superseded_by`
 * when a later change to the same item (not an undo, not itself undone) has to be undone first.
 */
export function withUndoState(entries = readAll()) {
  const undoneBy = new Map(entries.filter((e) => e.undo_of).map((e) => [e.undo_of, e.id]));
  const key = (e) => (e.target?.id ? `${e.app}\n${e.target.id}` : null);
  return entries.map((e, i) => {
    const out = undoneBy.has(e.id) ? { ...e, undone_by: undoneBy.get(e.id) } : { ...e };
    if (!out.undone_by && !e.undo_of && key(e)) {
      const later = entries.slice(i + 1).find((x) => !x.undo_of && !undoneBy.has(x.id) && key(x) === key(e));
      if (later) out.superseded_by = later.id;
    }
    return out;
  });
}

export const findEntry = (id) => withUndoState().find((e) => e.id === id) || null;

/** Removes month files entirely older than KEEP_DAYS (whole months, so it stays cheap). */
function prune(now) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400e3).toISOString().slice(0, 7);
  for (const f of readdirSync(activityDir())) {
    const m = /^activity-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1] < cutoff) rmSync(join(activityDir(), f), { force: true });
  }
}

/* ---------- undo registry: apps register how to undo their actions ---------- */

/**
 * @typedef {object} Undoer
 * @property {(entry: any) => Promise<{ summary: string }>} preview  checks (including "changed since?"), no writes
 * @property {(entry: any) => Promise<{ result: any, journal: Journal }>} run  performs the undo
 */
const undoers = new Map();

/** @param {string} app @param {string} action @param {Undoer} u */
export function registerUndo(app, action, u) { undoers.set(`${app}:${action}`, u); }
export const undoerFor = (e) => undoers.get(`${e.app}:${e.action}`) || null;
