#!/usr/bin/env node
// Kairos health check for the terminal, for when Kairos does not even show up in Claude:
//
//   runtime/node-kairos src/cli/health.js [--config <claude config>] [--json]
//
// Same checks as the kairos_health tool, plus whether Claude's config has a working kairos
// entry. Settings come from that entry (or from KAIROS_APPS / KAIROS_WRITE when set).
// Exit code 1 when a problem was found. Only looks; changes nothing.
//
// macOS gives permissions to the app "responsible" for a process: started from Terminal,
// that would be Terminal, not Kairos. Claude starts Kairos with that responsibility
// disclaimed, so this command restarts itself the same way, through the EventKit helper's
// event-disclaim shim, and then checks exactly what Kairos sees under Claude.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../lib/config.js";
import { ROOT, checkHealth } from "../lib/health.js";
import { sealScripts } from "../lib/osascript.js";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const json = argv.includes("--json");
const configPath = resolve(opt("--config") ?? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"));

const SHIM = join(ROOT, "vendor", "eventkit", "event-disclaim");
if (!process.env.KAIROS_DISCLAIMED && !process.env.KAIROS_FAKE && existsSync(SHIM)) {
  // Starts Kairos' own Node again, nothing else: process.execPath and this script.
  const r = spawnSync(SHIM, [process.execPath, ...process.execArgv, process.argv[1], ...argv], { stdio: "inherit", env: { ...process.env, KAIROS_DISCLAIMED: "1" } });
  process.exit(r.status ?? 1);
}

/** The kairos entry of Claude's config, checked: present, and pointing at this folder. */
function claudeEntry() {
  const node = join(ROOT, "runtime", "node-kairos"), server = join(ROOT, "src", "server.js");
  let cfg;
  try { cfg = JSON.parse(readFileSync(configPath, "utf8") || "{}"); } catch (e) {
    return { env: {}, check: { status: "problem", detail: existsSync(configPath) ? `Claude's config could not be read: ${e.message}` : "Claude's config does not exist yet.", fix: "Run ./install.sh in the Kairos folder." } };
  }
  const k = cfg?.mcpServers?.kairos;
  if (!k) return { env: {}, check: { status: "problem", detail: "Claude's config has no kairos entry, so Claude does not start Kairos.", fix: "Run ./install.sh, then quit Claude (Cmd+Q) and open it again." } };
  const env = k.env ?? {};
  if (k.command !== node || !Array.isArray(k.args) || k.args[0] !== server) {
    return { env, check: { status: "problem", detail: "Claude's kairos entry points to another folder or another Node (was the Kairos folder moved?).", fix: "Run ./install.sh from this folder, then quit Claude (Cmd+Q) and open it again." } };
  }
  return { env, check: { status: "ok", detail: "Claude's config starts Kairos from this folder with its private Node." } };
}

const SYMBOL = { ok: "✓", problem: "✗", warning: "!", skipped: "–" };
const NAMES = { kairos: "Kairos", claude: "Claude", notes: "Notes", calendar: "Calendar", reminders: "Reminders", contacts: "Contacts", mail: "Mail", music: "Music" };

async function main() {
  sealScripts();
  const entry = claudeEntry();
  const env = process.env.KAIROS_APPS !== undefined || process.env.KAIROS_WRITE !== undefined ? process.env : { ...process.env, ...entry.env };
  const config = readConfig(env);
  const report = await checkHealth({ config });
  report.checks.unshift(/** @type {any} */ ({ app: "claude", check: "Claude config", ...entry.check }));
  if (entry.check.status === "problem") {
    report.ok = false;
    report.summary = `${entry.check.detail} ${report.summary}`;
  }
  if (json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`Kairos ${report.version} health check, macOS ${report.macos ?? "unknown"}\n`);
    let last = null;
    for (const c of report.checks) {
      if (c.app !== last) { console.log(NAMES[c.app] ?? c.app); last = c.app; }
      console.log(`  ${SYMBOL[c.status]} ${c.check}: ${c.detail}`);
      if (c.fix && c.status !== "ok") console.log(`    Fix: ${c.fix}`);
    }
    const problems = report.checks.filter((c) => c.status === "problem").length;
    const warnings = report.checks.filter((c) => c.status === "warning").length;
    console.log(`\n${problems ? `${problems} problem${problems > 1 ? "s" : ""}` : "No problems"}${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}.`);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(`Health check failed: ${e.message}`); process.exit(2); });
