// Fake mode for tests: when KAIROS_FAKE points at a fixture file, the osascript and
// EventKit runners answer from it instead of touching real data.
//
// Fixture shape (all data invented):
// {
//   "osascript": { "<script name>": [ { "match": { ...input subset }, "output": <any> } | { "match": {}, "error": "..." } ] },
//   "shortcuts": { "<shortcut name>": [ { "match": { ... }, "output": "<text>" } ] },
//   "eventkit":  [ { "args": ["calendar", "list", ...], "output": <any> } | { "prefix": ["calendar", "list"], ... } ]
// }
// Cases are tried in order; the first whose match is a subset of the input wins.
// A case with "once": true answers a single time, then the next matching case takes over.
// Tests may also set fake fixtures in memory with setFakeFixtures().
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

let cache = { path: "", data: null };

let inMemory = null;

/** For tests: use these fixtures (or null to go back to KAIROS_FAKE). @param {any} fx */
export function setFakeFixtures(fx) { inMemory = fx; }

/** @returns {any | null} the parsed fixture file, or null outside fake mode */
export function fakeFixtures() {
  if (inMemory) return inMemory;
  const p = process.env.KAIROS_FAKE;
  if (!p) return null;
  const abs = resolve(p);
  if (cache.path !== abs) cache = { path: abs, data: JSON.parse(readFileSync(abs, "utf8")) };
  return cache.data;
}

const answer = (c) => {
  if (c.once) c.used = true;
  if (c.error) throw new Error(c.error);
  return structuredClone(c.output);
};

/**
 * @param {any} fx
 * @param {string} name
 * @param {Record<string, unknown>} input
 */
export function fakeOsascript(fx, name, input) {
  ((fx.calls ||= {}).osascript ||= []).push({ name, input });
  const cases = (fx.osascript && fx.osascript[name]) || [];
  const hit = cases.find((c) => !c.used && Object.entries(c.match || {}).every(([k, v]) => isDeepStrictEqual(input[k], v)));
  if (!hit) throw new Error(`fake: no osascript fixture for ${name} ${JSON.stringify(input)}`);
  return answer(hit);
}

/**
 * Shortcut fixtures use the same shape as osascript ones, keyed by shortcut name.
 * Runs are recorded in fx.calls.shortcuts so tests can assert what would have run.
 * @param {any} fx
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function fakeShortcut(fx, name, input) {
  ((fx.calls ||= {}).shortcuts ||= []).push({ name, input });
  const cases = (fx.shortcuts && fx.shortcuts[name]) || [];
  const hit = cases.find((c) => !c.used && Object.entries(c.match || {}).every(([k, v]) => isDeepStrictEqual(input[k], v)));
  if (!hit) throw new Error(`fake: no shortcut fixture for ${name} ${JSON.stringify(input)}`);
  return answer(hit);
}

/**
 * @param {any} fx
 * @param {string[]} args
 */
export function fakeEventKit(fx, args) {
  ((fx.calls ||= {}).eventkit ||= []).push(args);
  // "args" must match exactly; "prefix" matches the first arguments only.
  const hit = (fx.eventkit || []).find((c) => !c.used && (c.prefix ? isDeepStrictEqual(args.slice(0, c.prefix.length), c.prefix) : isDeepStrictEqual(c.args, args)));
  if (!hit) throw new Error(`fake: no eventkit fixture for ${JSON.stringify(args)}`);
  return answer(hit);
}
