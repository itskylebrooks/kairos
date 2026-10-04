// Runner for the vendored `event` EventKit CLI (FradSer's mcp-server-apple-events 1.5.0),
// launched through its `event-disclaim` shim so macOS attributes Calendar and Reminders
// access to `event` itself rather than to Claude.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError, permissionError } from "./errors.js";
import { fakeEventKit, fakeFixtures } from "./fake.js";
import { run } from "./run.js";

const BIN_DIR = fileURLToPath(new URL("../../vendor/node_modules/mcp-server-apple-events/bin/", import.meta.url));

// The binary also has a Cloudflare D1 `sync` command. Only local EventKit commands may run.
const ALLOWED = new Set(["calendar", "reminders"]);

/**
 * @param {string[]} args  e.g. ["calendar", "list", "--start", "2026-01-01", "--end", "2026-01-02", "--json"]
 * @param {{ json?: boolean, timeoutMs?: number }} [opts]  json: false for commands that print plain text (delete)
 * @returns {Promise<any>}
 */
export async function eventkit(args, { json = true, timeoutMs = 60000 } = {}) {
  if (!ALLOWED.has(args[0])) throw new Error(`eventkit: command "${args[0]}" is not allowed.`);
  const fx = fakeFixtures();
  if (fx) return fakeEventKit(fx, args);

  const cli = join(BIN_DIR, "event");
  const shim = join(BIN_DIR, "event-disclaim");
  if (!existsSync(cli)) throw new UserError(`EventKit helper not found at ${cli}. Run install.sh again.`);
  const useShim = existsSync(shim);
  let out;
  try {
    out = await run(useShim ? shim : cli, useShim ? [cli, ...args] : args, { timeoutMs });
  } catch (e) {
    if (/permission denied/i.test(String(e.message))) {
      throw permissionError(args[0] === "calendar" ? "Calendar" : "Reminders", args[0] === "calendar" ? "Calendars" : "Reminders");
    }
    throw e;
  }
  const t = out.trim();
  if (!json) return t;
  if (!t) return [];
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`EventKit helper returned unreadable output: ${t.slice(0, 200)}`);
  }
}
