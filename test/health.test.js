// The health check in fake mode: every app, helper and shortcut answers from invented
// fixtures, and Kairos' own files live in a temporary folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { tools } from "../src/apps/kairos.js";
import { readConfig } from "../src/lib/config.js";
import { UserError } from "../src/lib/errors.js";
import { setFakeFixtures } from "../src/lib/fake.js";
import { checkHealth, helperPins } from "../src/lib/health.js";
import { agentsDir, dataDir } from "../src/lib/paths.js";

afterEach(() => setFakeFixtures(null));

const ACC = "x-coredata://TEST/ICAccount/p1";
const F = (n) => `x-coredata://TEST/ICFolder/p${n}`;
const N = (n) => `x-coredata://TEST/ICNote/p${n}`;
const FOLDERS = {
  accounts: [{ id: ACC, name: "iCloud", default_folder: F(2) }],
  folders: [
    { id: F(1), name: "Recently Deleted", shared: false, container: ACC, account: ACC, count: 1 },
    { id: F(2), name: "Notes", shared: false, container: ACC, account: ACC, count: 3 },
  ],
};
const SCAN = [
  { id: N(1), name: "Twice", folder: F(2), locked: false, shared: false, text: null },
  { id: N(2), name: "Twice", folder: F(2), locked: false, shared: false, text: null },
  { id: N(3), name: "Locked diary", folder: F(2), locked: true, shared: false, text: null },
  { id: N(4), name: "Ada's café list", folder: F(2), locked: false, shared: false, text: null },
];

/** A fake Kairos folder: private Node, pinned EventKit helper, install.sh with the pins. */
function fakeRoot({ tamper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kairos-root-"));
  mkdirSync(join(root, "runtime"));
  mkdirSync(join(root, "vendor", "eventkit"), { recursive: true });
  writeFileSync(join(root, "runtime", "node-kairos"), "node");
  writeFileSync(join(root, "vendor", "eventkit", "event"), "event binary");
  writeFileSync(join(root, "vendor", "eventkit", "event-disclaim"), "disclaim binary");
  const h = (s) => createHash("sha256").update(s).digest("hex");
  writeFileSync(join(root, "install.sh"), `EVENT_SHA256="${h(tamper ? "other" : "event binary")}"\nDISCLAIM_SHA256="${h("disclaim binary")}"\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  return root;
}

const app = (name, out) => ({ match: { app: name }, output: out });
function fixtures(over = {}) {
  return {
    osascript: {
      "health.app": over.apps ?? [app("Notes", { running: true, ok: true, error: null }), app("Contacts", { running: false, ok: true, error: null }), app("Calendar", { running: true, ok: true, error: null }), app("Mail", { running: true, ok: true, error: null }), app("Music", { running: true, ok: true, error: null })],
      "notes.folders": [{ output: FOLDERS }],
      "notes.scan": [{ output: SCAN }],
    },
    eventkit: [
      { prefix: ["calendar", "list"], output: over.events ?? [{ id: "e1", title: "Kairos Test event" }] },
      { prefix: ["reminders", "lists", "list"], output: over.lists ?? [{ id: "l1", title: "Kairos Test" }] },
    ],
    shortcuts_list: over.shortcuts ?? ["Some other shortcut", "Kairos Notes Create", "Kairos Notes Append", "Kairos Notes Read"],
    shortcuts: { "Kairos Notes Read": [{ match: { name: "Ada's café list" }, output: "matches: 1\nAda's café list\n" }] },
    agent_loaded: over.agent_loaded ?? true,
  };
}

const run = (fx, opts = {}) => {
  setFakeFixtures(fx);
  const root = opts.root ?? fakeRoot();
  return { fx, root, report: checkHealth({ config: opts.config ?? readConfig({}), root, execPath: join(root, "runtime", "node-kairos"), apps: opts.apps }) };
};
const find = (r, appName, check) => r.checks.find((c) => c.app === appName && c.check === check);

test("everything in place: no problems, one group per app, no personal data in the report", async () => {
  const { fx, report } = run(fixtures());
  const r = await report;
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.version, "9.9.9");
  assert.ok(r.checks.every((c) => ["ok", "skipped", "warning"].includes(c.status)));
  for (const a of ["notes", "contacts", "calendar", "reminders", "mail", "music"]) assert.ok(r.checks.some((c) => c.app === a), a);
  assert.equal(find(r, "kairos", "EventKit helper").status, "ok");
  assert.equal(find(r, "notes", "shortcut access to Notes").status, "ok");
  // The probe used the one unique, unlocked title, and nothing of it reaches the report.
  assert.deepEqual(fx.calls.shortcuts.map((c) => c.input), [{ name: "Ada's café list" }]);
  assert.doesNotMatch(JSON.stringify(r), /Ada|café|Twice|diary|Kairos Test event/);
  // Mail and Music are never opened; Notes, Contacts and Calendar may be.
  const opened = Object.fromEntries(fx.calls.osascript.filter((c) => c.name === "health.app").map((c) => [c.input.app, c.input.open]));
  assert.deepEqual(opened, { Notes: true, Contacts: true, Calendar: true, Mail: false, Music: false });
  const order = [...new Set(r.checks.map((c) => c.app))];
  assert.deepEqual(order, ["kairos", "notes", "contacts", "calendar", "reminders", "mail", "music"]);
});

test("each problem comes with a fix in plain words", async () => {
  mkdirSync(join(dataDir(), "activity"), { recursive: true });
  chmodSync(join(dataDir(), "activity"), 0o755);
  try {
    const { fx, report } = run(fixtures({
      apps: [
        app("Notes", { running: true, ok: false, error: "Error: Not authorized to send Apple events to Notes. (-1743)" }),
        app("Contacts", { running: true, ok: true, error: null }),
        app("Calendar", { running: true, ok: false, error: "Error: Application isn't running. (-600)" }),
        app("Mail", { running: false }),
        app("Music", { running: true, ok: true, error: null }),
      ],
      events: [], lists: [],
      shortcuts: ["Kairos Notes Create", "Kairos Notes Read", "Kairos Notes Read"],
    }), { root: fakeRoot({ tamper: true }), config: readConfig({ KAIROS_MAX_RESULT_CHARS: "lots" }) });
    const r = await report;
    assert.equal(r.ok, false);
    const notes = find(r, "notes", "Automation access");
    assert.equal(notes.status, "problem");
    assert.match(notes.fix, /Privacy & Security > Automation > node-kairos: switch on Notes/);
    assert.equal(find(r, "calendar", "Automation access").status, "problem");
    assert.equal(find(r, "mail", "Automation access").status, "skipped");
    assert.match(find(r, "mail", "Automation access").fix, /Open Mail/);
    assert.equal(find(r, "calendar", "Calendars access").status, "warning");
    assert.equal(find(r, "reminders", "Reminders access").status, "problem");
    assert.match(find(r, "reminders", "Reminders access").fix, /Privacy & Security > Reminders/);
    assert.equal(find(r, "kairos", "EventKit helper").status, "problem");
    assert.match(find(r, "kairos", "EventKit helper").detail, /pinned checksum/);
    assert.equal(find(r, "kairos", "activity log folder").status, "problem");
    assert.match(find(r, "kairos", "activity log folder").fix, /chmod 700/);
    assert.equal(find(r, "kairos", "settings").status, "warning");
    const sc = r.checks.filter((c) => c.check === "Kairos shortcuts");
    assert.equal(sc.length, 2, "missing and duplicated are reported separately");
    assert.ok(sc.every((c) => c.status === "problem" && c.fix));
    assert.equal(fx.calls.shortcuts, undefined, "a duplicated read shortcut is not run");
    assert.ok(r.checks.filter((c) => c.status === "problem").every((c) => c.fix || /could not/.test(c.detail)));
    assert.match(r.summary, /^\d+ problems and \d+ warnings\. /);
  } finally {
    chmodSync(join(dataDir(), "activity"), 0o700);
  }
});

test("a subset of apps checks only those; disabled apps are never touched", async () => {
  const { fx, report } = run(fixtures(), { apps: ["mail"] });
  const r = await report;
  assert.deepEqual([...new Set(r.checks.map((c) => c.app))], ["kairos", "mail"]);
  assert.deepEqual(fx.calls.osascript.map((c) => c.input.app), ["Mail"]);
  const r2 = await run(fixtures(), { config: readConfig({ KAIROS_APPS: "contacts" }) }).report;
  assert.deepEqual([...new Set(r2.checks.map((c) => c.app))], ["kairos", "contacts"]);
  assert.equal(r2.checks.find((c) => c.check === "EventKit helper"), undefined, "the helper is only checked for Calendar or Reminders");
});

test("a running Kairos on another Node, and a play log job that is not running, are reported", async () => {
  const root = fakeRoot();
  setFakeFixtures(fixtures({ agent_loaded: false }));
  mkdirSync(agentsDir(), { recursive: true });
  writeFileSync(join(agentsDir(), "kairos.music-log.plist"), "<plist/>");
  try {
    const r = await checkHealth({ config: readConfig({ KAIROS_APPS: "music" }), root, execPath: "/usr/local/bin/node" });
    assert.equal(find(r, "kairos", "private Node").status, "warning");
    assert.equal(find(r, "music", "play log").status, "problem");
    assert.match(find(r, "music", "play log").fix, /--music-log on/);
  } finally {
    rmSync(join(agentsDir(), "kairos.music-log.plist"));
  }
});

test("helper pins are read from install.sh, the one place they are written", () => {
  const real = helperPins();
  assert.match(String(real.event), /^[0-9a-f]{64}$/);
  assert.match(String(real.disclaim), /^[0-9a-f]{64}$/);
});

test("kairos_health is a read only tool and checks its apps argument", async () => {
  const t = tools.find((x) => x.name === "kairos_health");
  assert.equal(t.annotations.readOnlyHint, true);
  await assert.rejects(t.handler({ apps: ["messages"] }, { config: readConfig({}) }), (e) => e instanceof UserError && /apps must be/.test(e.message));
});

test("terminal command: reports a missing or misplaced kairos entry in Claude's config, exit code 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-cli-"));
  const fixture = join(dir, "fx.json");
  writeFileSync(fixture, JSON.stringify(fixtures()));
  const cli = fileURLToPath(new URL("../src/cli/health.js", import.meta.url));
  const runCli = (cfg) => {
    writeFileSync(join(dir, "claude.json"), JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [cli, "--json", "--config", join(dir, "claude.json")], { encoding: "utf8", env: { ...process.env, KAIROS_FAKE: fixture, KAIROS_APPS: "contacts", KAIROS_WRITE: "" } });
    return { code: r.status, report: JSON.parse(r.stdout) };
  };
  const none = runCli({ mcpServers: {} });
  assert.equal(none.code, 1);
  assert.equal(none.report.checks[0].app, "claude");
  assert.match(none.report.checks[0].detail, /no kairos entry/);
  const moved = runCli({ mcpServers: { kairos: { command: "/somewhere/else/node-kairos", args: ["/somewhere/else/src/server.js"] } } });
  assert.match(moved.report.checks[0].detail, /another folder/);
  rmSync(dir, { recursive: true, force: true });
});
