#!/usr/bin/env node
// Builds and signs Kairos' shortcuts into a directory, ready to open and "Add Shortcut".
// Usage: node scripts/build-shortcuts.js <outDir> [--unsigned]
// Signing (`shortcuts sign --mode anyone`) contacts Apple; it happens only at install time.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NOTES_SHORTCUTS } from "../src/apps/notes-shortcuts.js";
import { toPlist } from "../src/lib/wfbuild.js";

const out = resolve(process.argv[2] || "build/shortcuts");
const unsigned = process.argv.includes("--unsigned");
mkdirSync(out, { recursive: true });
for (const [name, build] of Object.entries(NOTES_SHORTCUTS)) {
  const raw = join(out, `${name}.unsigned.shortcut`);
  const signed = join(out, `${name}.shortcut`);
  writeFileSync(raw, toPlist(build()));
  if (unsigned) { console.log(raw); continue; }
  // Signing is sometimes flaky ("Failed to modify some records"): retry a few times.
  for (let i = 1; ; i++) {
    try {
      execFileSync("/usr/bin/shortcuts", ["sign", "--mode", "anyone", "-i", raw, "-o", signed], { stdio: "pipe" });
      break;
    } catch (e) {
      if (i >= 4) throw new Error(`Signing ${name} failed: ${String(e.stderr || e.message).trim()}`);
      execFileSync("/bin/sleep", [String(2 * i)]);
    }
  }
  rmSync(raw, { force: true });
  console.log(signed);
}
