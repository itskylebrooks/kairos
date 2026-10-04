// Number clamping and offset paging for list results, and paging of oversized results.
import { UserError } from "./errors.js";
import { argsHash } from "./safety.js";

/**
 * @param {unknown} n
 * @param {number} lo
 * @param {number} hi
 * @param {number} dflt  used when n is missing or not a number
 */
export const clampInt = (n, lo, hi, dflt) => {
  if (n == null || n === "") return dflt;
  const x = Math.floor(Number(n));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

/**
 * @template T
 * @param {T[]} items
 * @param {unknown} limit
 * @param {unknown} offset
 * @param {number} [dflt]
 * @param {number} [max]
 */
export function page(items, limit, offset, dflt = 50, max = 500) {
  const l = clampInt(limit, 1, max, dflt);
  const o = clampInt(offset, 0, 1e9, 0);
  return { total: items.length, offset: o, limit: l, has_more: o + l < items.length, items: items.slice(o, o + l) };
}

/* ================= result paging (applied by the server to read tools) ================= */
// A read result larger than the cap comes in parts instead of being refused. Lists are paged
// by whole items (events, notes, messages, tracks); a single text too long for one part (a
// note, an email body, or one oversized item in a list) is paged by characters, and paging
// says so. The next part is fetched by repeating the call with the same arguments plus the
// cursor, which is tied to those arguments. Sizes count characters of the JSON result, the
// way Claude receives it (Cyrillic or other non Latin text counts one per character).

const size = (v) => JSON.stringify(v ?? null).length;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const tooLarge = (n, max) => new UserError(`The result is too large to return (${n.toLocaleString("en")} characters, limit ${max.toLocaleString("en")}) and cannot be split into parts. Narrow the request: a shorter date range, a smaller limit, or fewer fields.`);
const stale = () => new UserError("The cursor no longer matches this result (the data changed since the first part). Call again without cursor to start over.");

/** Opaque cursor: which part comes next, bound to the tool and its arguments. */
const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(cursor, h) {
  let c = null;
  try { c = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); } catch { /* invalid */ }
  if (!isObj(c) || typeof c.f !== "string" || !Number.isInteger(c.o) || c.o < 0 || (c.t !== undefined && (typeof c.t !== "string" || !Number.isInteger(c.c) || c.c < 0))) {
    throw new UserError("Invalid cursor. Pass the cursor from the previous part exactly as it was returned.");
  }
  if (c.h !== h) throw new UserError("This cursor belongs to a different call. Repeat the call with exactly the same arguments as the call that returned it, plus the cursor.");
  return c;
}

/** The field to page: the largest non empty list or text at the top level. */
function pickField(r) {
  let best = null, bestSize = -1;
  for (const [k, v] of Object.entries(r)) {
    if (!((Array.isArray(v) && v.length) || (typeof v === "string" && v.length))) continue;
    const n = size(v);
    if (n > bestSize) { best = k; bestSize = n; }
  }
  return best;
}

/** The longest text field of one item, for paging a single oversized item. */
function longestText(item) {
  if (!isObj(item)) return null;
  let best = null;
  for (const [k, v] of Object.entries(item)) if (typeof v === "string" && v.length && (best === null || v.length > item[best].length)) best = k;
  return best;
}

/**
 * How many characters of s, from `from`, fit into `room` characters of JSON. Ends at a line
 * break or space when one is near the end, and never inside a surrogate pair (emoji).
 */
export function textCut(s, from, room) {
  let n = Math.min(s.length - from, room);
  for (;;) {
    const over = size(s.slice(from, from + n)) - 2 - room; // escapes (\n, \") take extra room
    if (over <= 0 || n <= 0) break;
    n -= over; // each character takes at least one JSON character
  }
  n = Math.max(0, n);
  if (from + n < s.length && n > 0) {
    const part = s.slice(from, from + n);
    const nl = part.lastIndexOf("\n"), sp = part.lastIndexOf(" ");
    if (nl >= n * 0.8) n = nl + 1;
    else if (sp >= n * 0.9) n = sp + 1;
  }
  const code = s.charCodeAt(from + n - 1);
  if (n > 1 && code >= 0xd800 && code <= 0xdbff) n -= 1;
  return n;
}

/**
 * Fits a read result into maxChars. Without a cursor, a result that fits is returned as it
 * is; otherwise the part at the cursor (or the first part) comes back with `paging`.
 * @param {any} result  after the untrusted text marking
 * @param {{ maxChars: number, cursor?: unknown, tool: string, args: Record<string, unknown> }} o
 */
export function fitResult(result, { maxChars, cursor, tool, args }) {
  const h = argsHash(tool, args).slice(0, 16);
  const pos = cursor === undefined || cursor === null ? null : decodeCursor(cursor, h);
  if (!pos && size(result) <= maxChars) return result;
  if (!isObj(result)) throw tooLarge(size(result), maxChars);
  const f = pos ? pos.f : pickField(result);
  if (f === null) throw tooLarge(size(result), maxChars);
  const v = result[f];
  if (Array.isArray(v)) return pos?.t !== undefined ? itemText(result, f, pos.o, pos.t, pos.c, pos, h, maxChars) : items(result, f, pos, h, maxChars);
  if (typeof v === "string") return text(result, f, pos ? pos.o : 0, pos, h, maxChars);
  if (pos) throw stale();
  throw tooLarge(size(result), maxChars);
}

/** Whole items from the cursor on, as many as fit. */
function items(result, f, pos, h, maxChars) {
  const arr = result[f], total = arr.length, from = pos ? pos.o : 0;
  const changed = pos && pos.n !== total ? { changed: true } : {};
  if (from > total) throw stale();
  const build = (taken) => {
    const next = from + taken.length, has_more = next < total;
    return { ...result, [f]: taken, paging: { unit: "items", field: f, total, offset: from, returned: taken.length, has_more, ...(has_more ? { cursor: encodeCursor({ h, f, o: next, n: total }) } : {}), ...changed } };
  };
  const base = size(build([])) + 120; // the cursor grows a little with larger offsets
  if (base > maxChars) throw tooLarge(size(result), maxChars);
  const taken = [];
  let used = 0;
  for (let i = from; i < total; i++) {
    const n = size(arr[i]) + (taken.length ? 1 : 0);
    if (base + used + n > maxChars) break;
    taken.push(arr[i]);
    used += n;
  }
  let out = build(taken);
  while (size(out) > maxChars && taken.length) { taken.pop(); out = build(taken); }
  if (taken.length) return out;
  if (from === total) return out;
  // Not even one item fits: page that item's longest text.
  const t = longestText(arr[from]);
  if (t === null) throw tooLarge(size(arr[from]), maxChars);
  return itemText(result, f, from, t, 0, pos, h, maxChars);
}

/** One oversized item of a list, alone, with its text field paged. */
function itemText(result, f, i, t, from, pos, h, maxChars) {
  const arr = result[f], total = arr.length;
  const item = arr[i];
  if (!isObj(item) || typeof item[t] !== "string" || from > item[t].length) throw stale();
  const s = item[t];
  const changed = pos && pos.n !== total ? { changed: true } : {};
  const build = (n) => {
    const end = from + n, cut = end < s.length, has_more = cut || i + 1 < total;
    const next = cut ? { h, f, o: i, t, c: end, n: total } : { h, f, o: i + 1, n: total };
    return {
      ...result, [f]: [{ ...item, [t]: s.slice(from, end) }],
      paging: { unit: "characters", field: `${f}[${i}].${t}`, item_index: i, total_items: total, total: s.length, offset: from, returned: n, text_continues: cut, has_more, ...(has_more ? { cursor: encodeCursor(next) } : {}), ...changed },
    };
  };
  return cutToFit(build, s, from, maxChars, result);
}

/** A top level text field, paged by characters. */
function text(result, f, from, pos, h, maxChars) {
  const s = result[f];
  if (from > s.length) throw stale();
  const changed = pos && pos.n !== s.length ? { changed: true } : {};
  const build = (n) => {
    const end = from + n, has_more = end < s.length;
    return { ...result, [f]: s.slice(from, end), paging: { unit: "characters", field: f, total: s.length, offset: from, returned: n, has_more, ...(has_more ? { cursor: encodeCursor({ h, f, o: end, n: s.length }) } : {}), ...changed } };
  };
  return cutToFit(build, s, from, maxChars, result);
}

/** The longest cut of s that keeps the whole result within maxChars. */
function cutToFit(build, s, from, maxChars, result) {
  let room = maxChars - size(build(0)) - 40;
  if (room < 1) throw tooLarge(size(result), maxChars);
  for (let tries = 0; tries < 8; tries++) {
    const n = textCut(s, from, room);
    if (n <= 0 && from < s.length) throw tooLarge(size(result), maxChars);
    const out = build(n), over = size(out) - maxChars;
    if (over <= 0) return out;
    room -= over;
  }
  throw tooLarge(size(result), maxChars);
}
