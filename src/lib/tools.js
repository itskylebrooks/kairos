// Tool definitions: annotation presets, a checked constructor, config filtering and
// a small argument validator for the JSON Schema subset our input schemas use.
import { APPS } from "./config.js";
import { UserError } from "./errors.js";

/** @typedef {import("./config.js").App} App */
/** @typedef {import("./config.js").Config} Config */
/** @typedef {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: false }} Annotations */

/** Reads nothing but local data and changes nothing. */
export const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/** Adds something new (create, append, draft); repeating it adds again. */
export const ADD = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
/** Overwrites fields of an existing item; repeating it changes nothing more. */
export const UPDATE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
/** Moves an existing item somewhere else; nothing is lost and it can be moved back. */
export const MOVE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/** Removes an existing item. */
export const DELETE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

/**
 * @typedef {object} Tool
 * @property {string} name  snake_case, prefixed with the app, e.g. "notes_list"
 * @property {App | "kairos"} app
 * @property {string} title
 * @property {string} description
 * @property {object} inputSchema
 * @property {Annotations} annotations
 * @property {(args: any, ctx?: { config: Config }) => Promise<any> | any} handler
 * @property {(args: any, ctx?: { config: Config }) => Promise<{ summary: string }>} [preview]  makes the tool two step (see lib/safety.js)
 */

/** Pseudo app of Kairos' own tools (kairos_activity, kairos_undo); always on, not in KAIROS_APPS. */
export const CORE_APP = "kairos";

const CONFIRMATION = { type: "string", description: "Leave out on the first call, which only previews. After the user said yes to the preview, repeat the call with the confirmation it returned." };

const CURSOR = { type: "string", description: "Leave out at first. When a result has paging.has_more, repeat the call with the same arguments plus cursor set to paging.cursor to get the next part." };
const PARTS = " Large results come in parts (see paging and cursor).";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

/**
 * Checks a tool definition and freezes it. Throws on anything missing.
 * @param {Tool} t
 * @returns {Readonly<Tool>}
 */
export function defineTool(t) {
  const bad = (why) => { throw new Error(`Tool ${t && t.name}: ${why}`); };
  if (!t || typeof t.name !== "string" || !/^[a-z]+(_[a-z0-9]+)+$/.test(t.name)) bad("name must be snake_case like notes_list");
  if (t.app !== CORE_APP && !APPS.includes(t.app)) bad(`unknown app "${t.app}"`);
  if (!t.name.startsWith(t.app + "_")) bad(`name must start with "${t.app}_"`);
  if (!t.title || typeof t.title !== "string") bad("title is required");
  if (!t.description || typeof t.description !== "string") bad("description is required");
  if (!t.inputSchema || t.inputSchema.type !== "object") bad("inputSchema must be an object schema");
  if (!t.annotations || !HINTS.every((h) => typeof t.annotations[h] === "boolean")) bad("all four annotation hints are required");
  if (t.annotations.openWorldHint !== false) bad("openWorldHint must be false");
  if (typeof t.handler !== "function") bad("handler is required");
  // Every tool that changes or removes existing data is two step: preview, then confirm.
  if (t.annotations.destructiveHint && typeof t.preview !== "function") bad("destructive tools need a preview");
  if (t.preview !== undefined && typeof t.preview !== "function") bad("preview must be a function");
  if (t.preview) {
    if (t.inputSchema.properties?.confirmation) bad("confirmation is added automatically");
    return Object.freeze({ ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties || {}), confirmation: CONFIRMATION } } });
  }
  // Read results larger than the size cap come in parts; the server handles the cursor.
  if (t.annotations.readOnlyHint) {
    if (t.inputSchema.properties?.cursor) bad("cursor is added automatically");
    return Object.freeze({ ...t, description: t.description + PARTS, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties || {}), cursor: CURSOR } } });
  }
  return Object.freeze({ ...t });
}

/**
 * Tools of enabled apps; write tools only for apps in KAIROS_WRITE.
 * @param {readonly Tool[]} tools
 * @param {Config} config
 */
export function selectTools(tools, config) {
  return tools.filter((t) => {
    // Kairos' own tools (activity log, undo): reading always; undo only when some app may write.
    if (t.app === CORE_APP) return t.annotations.readOnlyHint || config.write.size > 0;
    return config.apps.has(t.app) && (t.annotations.readOnlyHint || config.write.has(t.app));
  });
}

/** @param {Tool} t  the shape sent in tools/list */
export const describeTool = ({ name, title, description, inputSchema, annotations }) =>
  ({ name, title, description, inputSchema, annotations: { title, ...annotations } });

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const fits = (v, type) => {
  const types = Array.isArray(type) ? type : [type];
  const actual = typeOf(v);
  return types.some((t) => t === actual || (t === "number" && actual === "integer"));
};

/**
 * Validates top level arguments: object shape, required, type, enum and unknown names.
 * Throws a UserError naming the first problem.
 * @param {any} schema
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
export function validateArgs(schema, args) {
  if (args == null) args = {};
  if (typeOf(args) !== "object") throw new UserError("Arguments must be an object.");
  const a = /** @type {Record<string, unknown>} */ (args);
  const props = schema.properties || {};
  for (const k of schema.required || []) {
    if (!Object.hasOwn(a, k) || a[k] === undefined) throw new UserError(`Missing required argument "${k}".`);
  }
  for (const [k, v] of Object.entries(a)) {
    // Own properties only: "constructor" or "__proto__" must not pass as a known argument.
    const p = Object.hasOwn(props, k) ? props[k] : undefined;
    if (!p) {
      if (schema.additionalProperties === false) throw new UserError(`Unknown argument "${k}".`);
      continue;
    }
    if (v === undefined) continue;
    if (p.type && !fits(v, p.type)) throw new UserError(`Argument "${k}" must be ${[].concat(p.type).join(" or ")}.`);
    if (p.enum && !p.enum.includes(v)) throw new UserError(`Argument "${k}" must be one of: ${p.enum.join(", ")}.`);
  }
  return a;
}
