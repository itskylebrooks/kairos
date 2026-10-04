#!/usr/bin/env node
// Music play log command. Run hourly (and at login) by the opt-in LaunchAgent that
// install.sh sets up; also usable by hand.
//
//   music-log.js snapshot [--force]   take a snapshot if one is due (never opens Music)
//   music-log.js status               what has been logged so far
//   music-log.js agent install|remove|status
//
// The log file (~/Library/Logs/Kairos/music-log.log) holds counts and reasons, never track names.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineScript, jxa, sealScripts } from "../lib/osascript.js";
import { agentsDir, logDir } from "../lib/paths.js";
import { runSync } from "../lib/run.js";
import { AGENT_LABEL, musicDir, runSnapshot, status } from "../lib/playlog.js";
const SELF = fileURLToPath(import.meta.url);

// Bulk reads, one round trip per property. Returns at once, without opening Music, when it is closed.
const JXA_LIBRARY = defineScript("music.library", `
function run(argv) {
  const M = Application("Music");
  if (!M.running()) return JSON.stringify({ running: false });
  const t = M.libraryPlaylists[0].tracks;
  const ids = t.persistentID(), counts = t.playedCount(), dates = t.playedDate();
  const names = t.name(), artists = t.artist(), albums = t.album(), durations = t.duration();
  return JSON.stringify({ running: true, tracks: ids.map((id, i) => ({
    id: id, count: counts[i] || 0, last: dates[i] ? dates[i].toISOString() : null,
    name: names[i] || null, artist: artists[i] || null, album: albums[i] || null,
    duration: durations[i] ? Math.round(durations[i]) : null,
  })) });
}`);

export const readLibrary = () => jxa(JXA_LIBRARY, {}, { app: "Music", timeoutMs: 180000 });

function log(line) {
  try {
    mkdirSync(logDir(), { recursive: true, mode: 0o700 });
    const f = join(logDir(), "music-log.log");
    // Keep the log small: past 256 KB, keep the newest half.
    if (existsSync(f) && statSync(f).size > 256 * 1024) {
      const lines = readFileSync(f, "utf8").split("\n");
      writeFileSync(f, lines.slice(Math.floor(lines.length / 2)).join("\n"), { mode: 0o600 });
    }
    appendFileSync(f, `${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  } catch {}
}

/* ---------- LaunchAgent ---------- */

const plistPath = () => join(agentsDir(), `${AGENT_LABEL}.plist`);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Hourly and at login; low priority. Runs this file with the same (private) Node. */
export function agentPlist(node = process.execPath, script = SELF) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(script)}</string><string>snapshot</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${esc(join(logDir(), "music-log.err.log"))}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => runSync("/bin/launchctl", args);
const loaded = () => { try { launchctl("print", `${domain()}/${AGENT_LABEL}`); return true; } catch { return false; } };

function agent(cmd) {
  if (cmd === "install") {
    mkdirSync(agentsDir(), { recursive: true });
    mkdirSync(logDir(), { recursive: true, mode: 0o700 });
    writeFileSync(plistPath(), agentPlist(), { mode: 0o644 });
    if (loaded()) { try { launchctl("bootout", `${domain()}/${AGENT_LABEL}`); } catch {} }
    launchctl("bootstrap", domain(), plistPath());
    return { installed: true, plist: plistPath(), loaded: loaded() };
  }
  if (cmd === "remove") {
    if (loaded()) { try { launchctl("bootout", `${domain()}/${AGENT_LABEL}`); } catch {} }
    rmSync(plistPath(), { force: true });
    return { removed: true, data_kept: musicDir() };
  }
  if (cmd === "status") return { plist: existsSync(plistPath()) ? plistPath() : null, loaded: loaded() };
  throw new Error("agent takes install, remove or status");
}

async function main(argv) {
  sealScripts();
  const [cmd, sub] = argv;
  if (cmd === "snapshot") {
    const t0 = Date.now();
    try {
      const r = await runSnapshot({ force: argv.includes("--force"), readLibrary });
      log({ ...r, ms: Date.now() - t0 });
      console.log(JSON.stringify(r));
    } catch (e) {
      log({ action: "error", error: String(e.message || e).slice(0, 300), ms: Date.now() - t0 });
      console.error(String(e.message || e));
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "status") { console.log(JSON.stringify(status(), null, 1)); return; }
  if (cmd === "agent") { console.log(JSON.stringify(agent(sub), null, 1)); return; }
  console.error("usage: music-log.js snapshot [--force] | status | agent install|remove|status");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) await main(process.argv.slice(2));
