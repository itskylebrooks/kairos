// Runs a program without a shell and resolves with its stdout.
import { execFile } from "node:child_process";

/**
 * @param {string} cmd  absolute path
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function run(cmd, args, { timeoutMs = 30000 } = {}) {
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
