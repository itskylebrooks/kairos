// Fake mode for tests: when KAIROS_FAKE points at a fixture file, the osascript and
// EventKit runners answer from it instead of touching real data.
//
// Fixture shape (all data invented):
// {
//   "osascript": { "<script name>": [ { "match": { ...input subset }, "output": <any> } | { "match": {}, "error": "..." } ] },
//   "eventkit":  [ { "args": ["calendar", "list", ...], "output": <any> } ]
// }
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

let cache = { path: "", data: null };

/** @returns {any | null} the parsed fixture file, or null outside fake mode */
export function fakeFixtures() {
  const p = process.env.KAIROS_FAKE;
  if (!p) return null;
  const abs = resolve(p);
  if (cache.path !== abs) cache = { path: abs, data: JSON.parse(readFileSync(abs, "utf8")) };
  return cache.data;
}

const answer = (c) => {
  if (c.error) throw new Error(c.error);
  return structuredClone(c.output);
};

/**
 * @param {any} fx
 * @param {string} name
 * @param {Record<string, unknown>} input
 */
export function fakeOsascript(fx, name, input) {
  const cases = (fx.osascript && fx.osascript[name]) || [];
  const hit = cases.find((c) => Object.entries(c.match || {}).every(([k, v]) => isDeepStrictEqual(input[k], v)));
  if (!hit) throw new Error(`fake: no osascript fixture for ${name} ${JSON.stringify(input)}`);
  return answer(hit);
}

/**
 * @param {any} fx
 * @param {string[]} args
 */
export function fakeEventKit(fx, args) {
  const hit = (fx.eventkit || []).find((c) => isDeepStrictEqual(c.args, args));
  if (!hit) throw new Error(`fake: no eventkit fixture for ${JSON.stringify(args)}`);
  return answer(hit);
}
