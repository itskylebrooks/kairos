// JXA runner. Only REGISTERED scripts can run: scripts are defined with defineScript() while
// the modules load, and the registry is sealed before the first request is handled. Input
// never becomes code: it travels as JSON in argv[0] and each script parses it with
// JSON.parse(argv[0]); scripts return JSON.stringify(...).
import { isPermissionError, permissionError } from "./errors.js";
import { fakeFixtures, fakeOsascript } from "./fake.js";
import { run } from "./run.js";

const OSASCRIPT = "/usr/bin/osascript";
const registry = new WeakSet();
let sealed = false;

/**
 * Registers a script. Only possible while modules load (before sealScripts()).
 * @param {string} name  short id for errors and fixtures, e.g. "contacts.all"
 * @param {string} source  JXA source defining run(argv)
 * @returns {Readonly<{ name: string, source: string }>}
 */
export function defineScript(name, source) {
  if (sealed) throw new Error(`Script "${name}" defined after startup: scripts must be fixed when Kairos starts.`);
  if (typeof name !== "string" || typeof source !== "string" || !/function run\(argv\)|function run\(\)/.test(source)) throw new Error(`Script "${name}" must be fixed source text with a run function.`);
  const script = Object.freeze({ name, source });
  registry.add(script);
  return script;
}

/** No more scripts after this. The server and the music-log command call it at startup. */
export function sealScripts() { sealed = true; }

/** Whether a value is a registered script (for tests). */
export const isRegistered = (s) => registry.has(s);

/**
 * @param {{ name: string, source: string }} script  from defineScript()
 * @param {Record<string, unknown>} [input]
 * @param {{ app?: string, timeoutMs?: number }} [opts]  app: name used in permission errors
 * @returns {Promise<any>}
 */
export async function jxa(script, input = {}, { app, timeoutMs = 60000 } = {}) {
  if (!registry.has(script)) throw new Error("Only scripts registered with defineScript() at startup may run.");
  const fx = fakeFixtures();
  if (fx) return fakeOsascript(fx, script.name, input);
  let out;
  try {
    out = await run(OSASCRIPT, ["-l", "JavaScript", "-e", script.source, JSON.stringify(input)], { timeoutMs });
  } catch (e) {
    if (app && isPermissionError(e)) throw permissionError(app);
    throw e;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${script.name} returned unreadable output: ${out.trim().slice(0, 200)}`);
  }
}
