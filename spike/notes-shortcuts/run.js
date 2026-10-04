#!/usr/bin/env node
// Notes Shortcuts spike, phase C: run one spike shortcut with a JSON input.
// Usage: node spike/notes-shortcuts/run.js "<Shortcut Name>" '<json>' [output-type]
// Prints {ms, ok, output | error} as JSON. Input goes through a private temp file.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runShortcut(name, input, outputType) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-spike-"));
  const inPath = join(dir, "in.json"), outPath = join(dir, "out");
  writeFileSync(inPath, JSON.stringify(input), { mode: 0o600 });
  const args = ["run", name, "-i", inPath, "-o", outPath];
  if (outputType) args.push("--output-type", outputType);
  const t0 = performance.now();
  return new Promise((resolve) => {
    execFile("/usr/bin/shortcuts", args, { timeout: 120000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const ms = Math.round(performance.now() - t0);
      let output = null;
      try { output = readFileSync(outPath, "utf8"); } catch {}
      rmSync(dir, { recursive: true, force: true });
      resolve(err ? { ms, ok: false, error: String(stderr || err.message).trim(), output } : { ms, ok: true, output, stdout: stdout || undefined });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, json, type] = process.argv.slice(2);
  console.log(JSON.stringify(await runShortcut(name, JSON.parse(json || "{}"), type), null, 1));
}
