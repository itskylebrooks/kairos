// Runs a program without a shell. Only the programs Kairos needs may be started.
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EVENTKIT = fileURLToPath(new URL("../../vendor/eventkit/", import.meta.url));

// Every program Kairos may start, by absolute path. Private, so nothing can add to it.
const ALLOWED = new Set([
  "/usr/bin/osascript",          // JXA scripts (registered ones only, see osascript.js)
  "/usr/bin/shortcuts",          // Kairos' own Notes shortcuts
  "/bin/launchctl",              // the opt in Music play log agent
  `${EVENTKIT}event`,            // EventKit helper (calendar and reminders commands only)
  `${EVENTKIT}event-disclaim`,
]);

/** The allowed programs (a copy). */
export const allowedPrograms = () => [...ALLOWED];

function check(cmd) {
  if (!ALLOWED.has(cmd)) throw new Error(`Kairos may not start ${cmd}.`);
}

/**
 * @param {string} cmd  absolute path, one of the allowed programs
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function run(cmd, args, { timeoutMs = 30000 } = {}) {
  try { check(cmd); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed && err.signal === "SIGKILL";
        const msg = timedOut ? `${cmd} took longer than ${timeoutMs / 1000}s and was stopped.` : String(stderr || err.message || err);
        reject(new Error(msg.trim().slice(0, 500)));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Synchronous variant for short commands (launchctl, shortcuts sign). */
export function runSync(cmd, args) {
  check(cmd);
  return execFileSync(cmd, args, { stdio: "pipe" }).toString();
}
