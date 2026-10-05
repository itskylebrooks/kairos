// Health check: what is missing for Kairos to work, and how to fix it, in plain words.
// It only looks and changes nothing. Notes, Contacts and Calendar are opened briefly if
// closed (as any read would) and quit again; Mail and Music are never opened. A permission
// macOS has not asked about yet shows its prompt here: answering it is the fix. The report
// holds counts and states only, never personal data.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, localDay, startOfDay } from "./dates.js";
import { isPermissionError } from "./errors.js";
import { eventkit } from "./eventkit.js";
import { fakeFixtures } from "./fake.js";
import { defineScript, jxa } from "./osascript.js";
import { dataDir } from "./paths.js";
import { AGENT_LABEL, status as playlogStatus } from "./playlog.js";
import { runSync } from "./run.js";
import { listShortcuts, runShortcut } from "./shortcuts.js";
import { OLD_SHORTCUT_NAMES, SHORTCUT_APPEND, SHORTCUT_CREATE, SHORTCUT_READ } from "../apps/notes-shortcuts.js";
import { uniqueNoteTitle } from "../apps/notes.js";

/** @typedef {"ok" | "problem" | "warning" | "skipped"} Status */
/** @typedef {{ app: string, check: string, status: Status, detail: string, fix?: string }} Check */

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTED_MACOS = 27;
const AUTOMATION = "System Settings > Privacy & Security > Automation";

// Scripting names of the apps Kairos controls, and whether the check may open them.
const APPS = {
  notes: { name: "Notes", open: true },
  contacts: { name: "Contacts", open: true },
  calendar: { name: "Calendar", open: true },
  mail: { name: "Mail", open: false },
  music: { name: "Music", open: false },
};

// One harmless Apple Event (the app's version) tests Automation access. An app this script
// had to open is quit again. Mail and Music are only asked when already running.
const JXA_APP = defineScript("health.app", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const A = Application(o.app);
  const was = A.running();
  if (!was && !o.open) return JSON.stringify({ running: false });
  let ok = false, error = null;
  try { A.version(); ok = true; } catch (e) { error = String(e.message || e) + " (" + (e.errorNumber || "") + ")"; }
  if (!was) { try { A.quit(); } catch (e) {} }
  return JSON.stringify({ running: was, ok: ok, error: error });
}`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mode = (p) => statSync(p).mode & 0o777;
const oct = (m) => m.toString(8).padStart(3, "0");

/** The macOS version from SystemVersion.plist (a plain file; no program needed). */
export function macosVersion(file = "/System/Library/CoreServices/SystemVersion.plist") {
  try { return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(file, "utf8"))?.[1] ?? null; } catch { return null; }
}

/** The pinned helper hashes, read from install.sh (the single place they are written). */
export function helperPins(root = ROOT) {
  try {
    const s = readFileSync(join(root, "install.sh"), "utf8");
    const pin = (k) => new RegExp(`^${k}="([0-9a-f]{64})"`, "m").exec(s)?.[1] ?? null;
    return { event: pin("EVENT_SHA256"), disclaim: pin("DISCLAIM_SHA256") };
  } catch { return { event: null, disclaim: null }; }
}

/**
 * Whether two paths name the same file. macOS folders are case insensitive, so Claude may
 * start Kairos as ".../Kairos/..." while it lives in ".../kairos/...": compare real paths.
 * @param {string} a @param {string} b
 */
export function samePath(a, b) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return p; } };
  return typeof a === "string" && typeof b === "string" && real(a) === real(b);
}

const kairosVersion = (root) => { try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version; } catch { return null; } };

/**
 * Runs every check for the enabled apps (or the given subset) and returns the report.
 * @param {{ config: import("./config.js").Config, apps?: string[], root?: string, execPath?: string, timeoutMs?: number }} o
 */
export async function checkHealth({ config, apps, root = ROOT, execPath = process.execPath, timeoutMs = 90000 }) {
  /** @type {Check[]} */
  const checks = [];
  const add = (app, check, status, detail, fix) => checks.push({ app, check, status, detail, ...(fix ? { fix } : {}) });
  const want = (a) => config.apps.has(a) && (!apps || apps.includes(a));

  /* ---------- Kairos itself ---------- */
  const version = kairosVersion(root), macos = macosVersion();
  const major = macos ? Number(macos.split(".")[0]) : null;
  if (major === TESTED_MACOS) add("kairos", "macOS version", "ok", `macOS ${macos}.`);
  else add("kairos", "macOS version", "warning", `macOS ${macos ?? "unknown"}. Kairos is tested on macOS ${TESTED_MACOS}; Notes formatting and permission prompts can differ on other versions.`);

  const node = join(root, "runtime", "node-kairos");
  if (!existsSync(node)) add("kairos", "private Node", "problem", "Kairos' private Node is missing.", "Run ./install.sh in the Kairos folder.");
  else if (!samePath(execPath, node)) add("kairos", "private Node", "warning", "Kairos is running on a Node other than its private one, so macOS permissions belong to that Node instead.", "Run ./install.sh, then quit Claude (Cmd+Q) and open it again.");
  else add("kairos", "private Node", "ok", "Kairos runs on its private Node.");

  const enabled = [...config.apps].join(", ") || "none";
  const writes = [...config.write].join(", ") || "none";
  add("kairos", "settings", config.warnings.length ? "warning" : "ok",
    `Apps: ${enabled}. May write: ${writes}. Previews before changes: ${config.confirm === false ? "off" : "on"}. Result size: ${(config.maxResultChars ?? 20000).toLocaleString("en")} characters.${config.warnings.length ? " " + config.warnings.join(" ") : ""}`,
    config.warnings.length ? "Fix the setting named above in the kairos entry of Claude's config, or run ./install.sh." : undefined);

  // Kairos' private folders must be readable by the user only.
  for (const [what, p] of [["activity log", join(dataDir(), "activity")], ["note backups", join(dataDir(), "backups", "notes")], ["Music play log", join(dataDir(), "music")]]) {
    if (!existsSync(p)) continue; // created on first use
    const m = mode(p);
    if (m & 0o077) add("kairos", `${what} folder`, "problem", `The ${what} folder can be read by other users of this Mac (permissions ${oct(m)}).`, `Run: chmod 700 "${p}"`);
    else add("kairos", `${what} folder`, "ok", `The ${what} folder is private.`);
  }

  /* ---------- EventKit helper (Calendar and Reminders) ---------- */
  if (want("calendar") || want("reminders")) {
    const dir = join(root, "vendor", "eventkit"), pins = helperPins(root);
    const files = [["event", pins.event], ["event-disclaim", pins.disclaim]];
    const missing = files.filter(([f]) => !existsSync(join(dir, f)));
    if (missing.length) add("kairos", "EventKit helper", "problem", "The EventKit helper for Calendar and Reminders is missing.", "Run ./install.sh in the Kairos folder.");
    else if (files.some(([f, pin]) => !pin || sha256(join(dir, f)) !== pin)) add("kairos", "EventKit helper", "problem", "The EventKit helper does not match its pinned checksum: it may have been changed.", "Run ./install.sh in the Kairos folder to install the pinned version again.");
    else add("kairos", "EventKit helper", "ok", "The EventKit helper is installed and matches its pinned checksum.");
  }

  /* ---------- Automation access, one app at a time (a prompt may appear) ---------- */
  for (const [app, { name, open }] of Object.entries(APPS)) {
    if (!want(app)) continue;
    let r;
    try {
      r = await jxa(JXA_APP, { app: name, open }, { timeoutMs });
    } catch (e) {
      if (/took longer than/i.test(String(e.message))) add(app, "Automation access", "warning", `${name} did not answer in time. macOS may be showing a permission prompt.`, `Answer the prompt (choose Allow), then check again.`);
      else add(app, "Automation access", "problem", `Kairos could not check ${name}: ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (r.running === false && !r.ok && !r.error) {
      add(app, "Automation access", "skipped", `${name} is closed, and Kairos never opens it.`, `Open ${name}, then check again.`);
    } else if (r.ok) {
      add(app, "Automation access", "ok", `Kairos may control ${name}.`);
    } else if (isPermissionError(r.error)) {
      add(app, "Automation access", "problem", `macOS does not allow Kairos to control ${name}.`, `${AUTOMATION} > node-kairos: switch on ${name}.`);
    } else {
      add(app, "Automation access", "problem", `${name} did not answer: ${String(r.error).slice(0, 200)}`, `Quit ${name} (Cmd+Q), open it again, then check again.`);
    }
  }

  /* ---------- EventKit access ---------- */
  if (want("calendar")) {
    try {
      const today = startOfDay(new Date());
      const events = await eventkit(["calendar", "list", `--start=${localDay(addDays(today, -365))}`, `--end=${localDay(addDays(today, 60))}`, "--json"], { timeoutMs });
      if (Array.isArray(events) && events.length) add("calendar", "Calendars access", "ok", "The EventKit helper can read your calendars.");
      else add("calendar", "Calendars access", "warning", "The EventKit helper found no events in the past year. If your calendars have events, it probably has no access.", "System Settings > Privacy & Security > Calendars: allow \"event\" full access.");
    } catch (e) {
      add("calendar", "Calendars access", "problem", `The EventKit helper could not read calendars: ${String(e.message).slice(0, 200)}`, "System Settings > Privacy & Security > Calendars: allow \"event\" full access, or run ./install.sh.");
    }
  }
  if (want("reminders")) {
    try {
      const lists = await eventkit(["reminders", "lists", "list", "--json"], { timeoutMs });
      if (Array.isArray(lists) && lists.length) add("reminders", "Reminders access", "ok", "The EventKit helper can read your reminders.");
      else add("reminders", "Reminders access", "problem", "The EventKit helper sees no reminder lists, which means it has no access.", "System Settings > Privacy & Security > Reminders: allow \"event\" full access.");
    } catch (e) {
      add("reminders", "Reminders access", "problem", `The EventKit helper could not read reminders: ${String(e.message).slice(0, 200)}`, "System Settings > Privacy & Security > Reminders: allow \"event\" full access, or run ./install.sh.");
    }
  }

  /* ---------- Kairos' Notes shortcuts ---------- */
  if (want("notes")) {
    let names = null;
    try { names = await listShortcuts(); } catch (e) {
      add("notes", "Kairos shortcuts", "problem", `The Shortcuts app could not be asked for its shortcuts: ${String(e.message).slice(0, 200)}`);
    }
    if (names) {
      const ours = [SHORTCUT_CREATE, SHORTCUT_APPEND, SHORTCUT_READ];
      const count = (n) => names.filter((x) => x === n).length;
      const missing = ours.filter((n) => count(n) === 0), twice = ours.filter((n) => count(n) > 1);
      if (missing.length) add("notes", "Kairos shortcuts", "problem", `Not installed: ${missing.map((n) => `"${n}"`).join(", ")}. Without them Kairos cannot write notes.`, "Run ./install.sh and click Add Shortcut for each.");
      if (twice.length) add("notes", "Kairos shortcuts", "problem", `Installed more than once: ${twice.map((n) => `"${n}"`).join(", ")}. Shortcuts then cannot tell which one to run.`, "Open the Shortcuts app, delete every copy of these, then run ./install.sh.");
      if (!missing.length && !twice.length) add("notes", "Kairos shortcuts", "ok", "All three Kairos shortcuts are installed, once each.");
      const old = OLD_SHORTCUT_NAMES.filter((n) => count(n) > 0);
      if (old.length) add("notes", "old Kairos shortcuts", "warning", `No longer used since Kairos 0.12: ${old.map((n) => `"${n}"`).join(", ")}.`, "Delete them in the Shortcuts app; Kairos uses the shortcuts named \"Kairos: …\" now.");
      // Notes access belongs to each shortcut. The probe reads a note whose title exists
      // exactly once: older read shortcuts wait for a person when nothing matches. The text
      // read is discarded.
      if (count(SHORTCUT_READ) === 1) {
        let title = null;
        try { title = await uniqueNoteTitle(); } catch { /* Notes access is reported above */ }
        if (title === null) {
          add("notes", "shortcut access to Notes", "skipped", "There is no note with a unique title to test the shortcuts with.");
        } else {
          try {
            const out = await runShortcut(SHORTCUT_READ, { name: title }, { timeoutMs: Math.min(timeoutMs, 45000) });
            if (/^matches: [12]\b/.test(out)) add("notes", "shortcut access to Notes", "ok", "Kairos' shortcuts may use Notes.");
            else add("notes", "shortcut access to Notes", "warning", "The read shortcut answered unexpectedly; it may be out of date.", "Delete the Kairos shortcuts in the Shortcuts app, then run ./install.sh.");
          } catch (e) {
            add("notes", "shortcut access to Notes", "problem", String(e.message).slice(0, 300), "Run the check again and choose Always Allow when macOS asks, or allow Notes in the shortcut's settings in the Shortcuts app.");
          }
        }
      }
    }
  }

  /* ---------- Music play log ---------- */
  if (want("music")) {
    const s = playlogStatus();
    if (!s.agent_installed) {
      add("music", "play log", "skipped", "The Music play log is off.", "To switch it on: ./install.sh --music-log on");
    } else {
      const fx = fakeFixtures();
      let loaded;
      if (fx) loaded = !!fx.agent_loaded;
      else { try { runSync("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${AGENT_LABEL}`]); loaded = true; } catch { loaded = false; } }
      const lastCheck = s.last_check ? Date.parse(s.last_check.at) : null;
      const hours = lastCheck ? (Date.now() - lastCheck) / 3600e3 : null;
      if (!loaded) add("music", "play log", "problem", "The play log's background job is installed but not running.", "Run: ./install.sh --music-log on");
      else if (hours === null || hours > 3) add("music", "play log", "warning", hours === null ? "The play log has not checked Music yet." : `The play log last checked ${Math.round(hours)} hours ago; it checks every hour while the Mac is awake.`, "If the Mac was not asleep in that time, run: ./install.sh --music-log on, then check again in an hour.");
      else add("music", "play log", "ok", `The play log is on: ${s.snapshots} snapshots since ${s.first ? s.first.slice(0, 10) : "today"}, last check ${Math.round(hours * 60)} minutes ago.`);
      if (s.damaged_lines) add("music", "play log data", "warning", `${s.damaged_lines} damaged lines in the play log were skipped.`, "Nothing to do unless the number grows; then report it.");
    }
  }

  // One group per app, in a fixed order; checks keep their order within the app.
  const ORDER = ["kairos", "notes", "contacts", "calendar", "reminders", "mail", "music"];
  checks.sort((x, y) => ORDER.indexOf(x.app) - ORDER.indexOf(y.app));
  const problems = checks.filter((c) => c.status === "problem"), warnings = checks.filter((c) => c.status === "warning");
  const label = (c) => `${c.app === "kairos" ? "Kairos" : APPS[c.app]?.name ?? c.app}: ${c.detail}`;
  const summary = !problems.length && !warnings.length
    ? `Everything Kairos needs is in place (${checks.filter((c) => c.status === "ok").length} checks passed).`
    : [problems.length ? `${problems.length} problem${problems.length > 1 ? "s" : ""}` : "", warnings.length ? `${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ") + ". " + [...problems, ...warnings].map(label).join(" ");
  return { version, macos, ok: problems.length === 0, summary, checks };
}
