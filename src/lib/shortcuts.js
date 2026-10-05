// Runner for Kairos' own shortcuts via the `shortcuts` CLI. Input goes in as a JSON file
// (data, never script), output comes back as plain text. Runs are serialized: one at a time.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.js";
import { fakeFixtures, fakeShortcut } from "./fake.js";
import { run } from "./run.js";

const SHORTCUTS = "/usr/bin/shortcuts";

/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/**
 * @param {string} name  installed shortcut name, e.g. "Kairos: Append to Note"
 * @param {Record<string, unknown>} input
 * @param {{ app?: string, timeoutMs?: number }} [opts]  app: the app it touches, for messages
 * @returns {Promise<string>} the shortcut's text output ("" when it returns nothing)
 */
export function runShortcut(name, input, opts = {}) {
  const next = queue.then(() => runOnce(name, input, opts));
  queue = next.catch(() => {});
  return next;
}

async function runOnce(name, input, { app = "Notes", timeoutMs = 90000 } = {}) {
  const fx = fakeFixtures();
  if (fx) {
    try { return fakeShortcut(fx, name, input); } catch (e) { throw shortcutError(name, app, String(e.message), timeoutMs); }
  }

  const dir = mkdtempSync(join(tmpdir(), "kairos-"));
  const inPath = join(dir, "in.json"), outPath = join(dir, "out.txt");
  try {
    writeFileSync(inPath, JSON.stringify(input), { mode: 0o600 });
    try {
      await run(SHORTCUTS, ["run", name, "-i", inPath, "-o", outPath, "--output-type", "public.plain-text"], { timeoutMs });
    } catch (e) {
      throw shortcutError(name, app, String(e.message), timeoutMs);
    }
    try { return readFileSync(outPath, "utf8"); } catch { return ""; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Names of all installed shortcuts (for the health check, which only counts Kairos' own).
 * @returns {Promise<string[]>}
 */
export async function listShortcuts() {
  const fx = fakeFixtures();
  if (fx) return [...(fx.shortcuts_list || [])];
  const out = await run(SHORTCUTS, ["list"], { timeoutMs: 30000 });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Turns `shortcuts run` failures into messages that say what to do. */
export function shortcutError(name, app, msg, timeoutMs = 90000) {
  if (/took longer than/i.test(msg)) {
    return new UserError(`The shortcut "${name}" did not finish within ${timeoutMs / 1000}s. Shortcuts may be showing a window that waits for a person: click Cancel there. Nothing should be typed or picked in it.`);
  }
  if (/can.t access/i.test(msg)) {
    return new UserError(`The shortcut "${name}" is not allowed to access ${app} yet. macOS asks the first time it runs: choose Always Allow, then try again. It can also be changed in the Shortcuts app, in that shortcut's privacy settings.`);
  }
  if (/an action could not be found/i.test(msg)) {
    return new UserError(`The shortcut "${name}" uses an action this version of macOS does not have. Run install.sh again to install the current Kairos shortcuts.`);
  }
  if (/couldn.t find shortcut|could not be found|not found/i.test(msg)) {
    return new UserError(`The shortcut "${name}" is not installed, or is installed twice. Run install.sh to install the Kairos shortcuts, and delete duplicates in the Shortcuts app.`);
  }
  if (/cancel/i.test(msg)) {
    return new UserError(`The shortcut "${name}" was cancelled.`);
  }
  return new Error(`Shortcut "${name}" failed: ${msg}`);
}
