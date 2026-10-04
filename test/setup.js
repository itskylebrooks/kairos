// Loaded before every test file (npm test): every folder Kairos writes to points into a
// temporary directory, so no test can touch the real data, logs or LaunchAgents.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kairos-tests-"));
for (const [k, d] of [["KAIROS_DATA_DIR", "data"], ["KAIROS_LOG_DIR", "logs"], ["KAIROS_AGENTS_DIR", "agents"]]) {
  if (!process.env[k]) process.env[k] = join(root, d);
}
