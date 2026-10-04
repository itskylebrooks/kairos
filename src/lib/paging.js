// Number clamping and offset paging for list results.

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
