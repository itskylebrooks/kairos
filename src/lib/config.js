// Configuration from env vars set in the Claude config.
//   KAIROS_APPS   apps whose tools are listed (default: all)
//   KAIROS_WRITE  apps whose write tools are listed (default: none)

/** @typedef {"calendar"|"reminders"|"contacts"|"notes"|"mail"|"music"} App */

/** @type {readonly App[]} */
export const APPS = Object.freeze(["calendar", "reminders", "contacts", "notes", "mail", "music"]);

/** Apps that have write tools at all. Contacts never writes; Music not yet. */
/** @type {readonly App[]} */
export const WRITABLE = Object.freeze(["calendar", "reminders", "notes", "mail"]);

/**
 * @typedef {object} Config
 * @property {Set<App>} apps
 * @property {Set<App>} write
 * @property {string[]} warnings  problems worth logging to stderr
 */

const list = (s) => String(s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function readConfig(env = process.env) {
  const warnings = [];
  const pick = (names, varName) => {
    const out = new Set();
    for (const n of names) {
      if (APPS.includes(/** @type {App} */ (n))) out.add(/** @type {App} */ (n));
      else warnings.push(`${varName}: unknown app "${n}" ignored.`);
    }
    return out;
  };

  const apps = env.KAIROS_APPS == null || env.KAIROS_APPS.trim() === ""
    ? new Set(APPS)
    : pick(list(env.KAIROS_APPS), "KAIROS_APPS");

  const write = new Set();
  for (const app of pick(list(env.KAIROS_WRITE), "KAIROS_WRITE")) {
    if (!WRITABLE.includes(app)) warnings.push(`KAIROS_WRITE: ${app} has no write tools; ignored.`);
    else if (!apps.has(app)) warnings.push(`KAIROS_WRITE: ${app} is not in KAIROS_APPS; ignored.`);
    else write.add(app);
  }
  return { apps, write, warnings };
}
