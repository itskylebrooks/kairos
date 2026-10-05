// Configuration from env vars set in the Claude config.
//   KAIROS_APPS   apps whose tools are listed (default: all)
//   KAIROS_WRITE  apps whose write tools are listed (default: none)
//   KAIROS_CONFIRM  on (default): changes and deletes show a preview first and need the user's yes;
//                 off: they act at once (every change is still logged and can be undone)
//   KAIROS_MAX_REMOVALS  how many items Kairos may remove per hour (default 20, from 1 to 500):
//                 deleted notes, events and reminders, mail moved to the Trash
//   KAIROS_MAX_RESULT_CHARS  size of one result in characters; larger results come in parts
//                 (default 20,000, from 5,000 to 100,000)

/** @typedef {"calendar"|"reminders"|"contacts"|"notes"|"mail"|"music"} App */

/** @type {readonly App[]} */
export const APPS = Object.freeze(["calendar", "reminders", "contacts", "notes", "mail", "music"]);

/** Apps that have write tools at all. Contacts never writes; Music not yet. */
/** @type {readonly App[]} */
export const WRITABLE = Object.freeze(["calendar", "reminders", "notes", "mail"]);

/** Result size cap in characters: default and the range KAIROS_MAX_RESULT_CHARS may set. */
export const RESULT_CHARS = Object.freeze({ default: 20_000, min: 5_000, max: 100_000 });

/** Removals per hour: default and the range KAIROS_MAX_REMOVALS may set. */
export const REMOVALS = Object.freeze({ default: 20, min: 1, max: 500 });

/**
 * @typedef {object} Config
 * @property {Set<App>} apps
 * @property {Set<App>} write
 * @property {boolean} [confirm]  false when KAIROS_CONFIRM=off: no preview step (default true)
 * @property {number} [maxRemovals]  items Kairos may remove per hour (default REMOVALS.default)
 * @property {number} [maxResultChars]  results larger than this come in parts (default RESULT_CHARS.default)
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
  return { apps, write, confirm: confirmSetting(env.KAIROS_CONFIRM, warnings), maxRemovals: wholeNumber(env.KAIROS_MAX_REMOVALS, REMOVALS, "KAIROS_MAX_REMOVALS", warnings), maxResultChars: resultChars(env.KAIROS_MAX_RESULT_CHARS, warnings), warnings };
}

/** KAIROS_CONFIRM: on (default) or off; yes/no, true/false and 1/0 work too. */
function confirmSetting(raw, warnings) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return true;
  if (["on", "yes", "true", "1"].includes(v)) return true;
  if (["off", "no", "false", "0"].includes(v)) return false;
  warnings.push(`KAIROS_CONFIRM: "${raw}" is neither on nor off; previews stay on.`);
  return true;
}

/** A whole number setting, clamped to its range; nonsense falls back to the default with a warning. */
function wholeNumber(raw, range, name, warnings) {
  if (raw == null || String(raw).trim() === "") return range.default;
  const n = Number(String(raw).trim().replace(/[_,]/g, ""));
  if (!Number.isInteger(n)) {
    warnings.push(`${name}: "${raw}" is not a whole number; using ${range.default}.`);
    return range.default;
  }
  const c = Math.min(range.max, Math.max(range.min, n));
  if (c !== n) warnings.push(`${name}: ${n} is outside ${range.min} to ${range.max}; using ${c}.`);
  return c;
}

/** KAIROS_MAX_RESULT_CHARS: a whole number, clamped to RESULT_CHARS.min..max. */
function resultChars(raw, warnings) {
  if (raw == null || String(raw).trim() === "") return RESULT_CHARS.default;
  const n = Number(String(raw).trim().replace(/[_,]/g, ""));
  if (!Number.isInteger(n)) {
    warnings.push(`KAIROS_MAX_RESULT_CHARS: "${raw}" is not a whole number; using ${RESULT_CHARS.default}.`);
    return RESULT_CHARS.default;
  }
  const c = Math.min(RESULT_CHARS.max, Math.max(RESULT_CHARS.min, n));
  if (c !== n) warnings.push(`KAIROS_MAX_RESULT_CHARS: ${n} is outside ${RESULT_CHARS.min} to ${RESULT_CHARS.max}; using ${c}.`);
  return c;
}
