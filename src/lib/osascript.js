// JXA runner. Scripts are static source; all input travels as JSON in argv[0] and the
// script returns JSON.stringify(...). Never splice user text into a script.
import { isPermissionError, permissionError } from "./errors.js";
import { fakeFixtures, fakeOsascript } from "./fake.js";
import { run } from "./run.js";

const OSASCRIPT = "/usr/bin/osascript";

/**
 * @param {string} name  short id for errors and fixtures, e.g. "contacts.all"
 * @param {string} script  JXA source defining run(argv)
 * @param {Record<string, unknown>} [input]
 * @param {{ app?: string, timeoutMs?: number }} [opts]  app: name used in permission errors
 * @returns {Promise<any>}
 */
export async function jxa(name, script, input = {}, { app, timeoutMs = 60000 } = {}) {
  const fx = fakeFixtures();
  if (fx) return fakeOsascript(fx, name, input);
  let out;
  try {
    out = await run(OSASCRIPT, ["-l", "JavaScript", "-e", script, JSON.stringify(input)], { timeoutMs });
  } catch (e) {
    if (app && isPermissionError(e)) throw permissionError(app);
    throw e;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${name} returned unreadable output: ${out.trim().slice(0, 200)}`);
  }
}
