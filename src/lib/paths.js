// Where Kairos keeps its own files on this Mac. Never inside the repo.
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/Library/Application Support/Kairos, or KAIROS_DATA_DIR (tests). */
export const dataDir = () => process.env.KAIROS_DATA_DIR || join(homedir(), "Library", "Application Support", "Kairos");

/** ~/Library/Logs/Kairos, or KAIROS_LOG_DIR (tests). */
export const logDir = () => process.env.KAIROS_LOG_DIR || join(homedir(), "Library", "Logs", "Kairos");

/** ~/Library/LaunchAgents, or KAIROS_AGENTS_DIR (tests). */
export const agentsDir = () => process.env.KAIROS_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
