// Local calendar-day helpers and the date formats EventKit tooling emits.
import { UserError } from "./errors.js";

export const WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

const pad2 = (n) => String(n).padStart(2, "0");

/** @param {Date} d @returns {string} "YYYY-MM-DD" in local time */
export const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** @param {Date} d @returns {string} "YYYY-MM-DD HH:mm" in local time */
export const localStamp = (d) => `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** @param {Date} d */
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Calendar-day arithmetic, safe across DST changes. @param {Date} d @param {number} n */
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * Parses ISO with zone, local "YYYY-MM-DD HH:mm(:ss)", 12 hour "YYYY-MM-DD h:mm:ss AM"
 * and date only. Local forms are read in local time.
 * @param {unknown} v
 * @returns {{ date: Date, dateOnly: boolean } | null}
 */
export function parseEkDate(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return valid(new Date(+m[1], +m[2] - 1, +m[3]), +m[1], +m[2], +m[3], true);
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?$/i.exec(s);
  if (m) {
    let h = +m[4];
    const ap = (m[7] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return valid(new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +(m[6] || 0)), +m[1], +m[2], +m[3], false);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { date: new Date(t), dateOnly: false };
}

// Rejects dates the Date constructor would silently roll over, like 2026-02-30.
function valid(date, y, mo, d, dateOnly) {
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? { date, dateOnly } : null;
}

/**
 * A tool argument date ("2026-10-02", "2026-10-02 18:00"). Throws a UserError when unreadable.
 * @param {unknown} v
 * @param {string} name  argument name for the message
 * @returns {Date | null}
 */
export function parseArgDate(v, name) {
  if (v == null || v === "") return null;
  const p = parseEkDate(v);
  if (!p) throw new UserError(`Could not read ${name}: "${v}". Use a date like 2026-10-02 or 2026-10-02 18:00.`);
  return p.date;
}

/** "YYYY-MM-DD HH:mm:ss" in local time, the form the EventKit helper takes. @param {Date} d */
export const ekStamp = (d) => `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** Local time with offset and seconds, e.g. "2030-01-02T10:00:05+01:00". @param {Date} d */
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${localDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** True for a bare "YYYY-MM-DD". @param {unknown} v */
export const isBareDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
