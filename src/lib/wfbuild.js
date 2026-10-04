// Builds Shortcuts workflow plists (unsigned) from small building blocks.
// Encoding learned in the Notes spike (docs/notes-spike.md), from eliotshea/notes-mcp and
// iangray001/applenotes-mcp, and verified on macOS 27.
import { randomUUID } from "node:crypto";

const PLACEHOLDER = "￼"; // Shortcuts' variable placeholder inside text fields
export const DV = "Dictionary Value";

/* ---------- plist XML ---------- */

class Real { constructor(n) { this.n = n; } }
/** A plist <real> (plain JS numbers become <integer>). @param {number} n */
export const real = (n) => new Real(n);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistValue(v, ind) {
  const pad = "\t".repeat(ind);
  if (v instanceof Real) return `${pad}<real>${v.n}</real>`;
  if (typeof v === "string") return `${pad}<string>${esc(v)}</string>`;
  if (typeof v === "boolean") return `${pad}<${v}/>`;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`use real() for ${v}`);
    return `${pad}<integer>${v}</integer>`;
  }
  if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map((x) => plistValue(x, ind + 1)).join("\n")}\n${pad}</array>` : `${pad}<array/>`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return `${pad}<dict/>`;
    return `${pad}<dict>\n${keys.map((k) => `${pad}\t<key>${esc(k)}</key>\n${plistValue(v[k], ind + 1)}`).join("\n")}\n${pad}</dict>`;
  }
  throw new Error(`cannot encode ${typeof v}`);
}

/** @param {object} obj @returns {string} XML plist */
export const toPlist = (obj) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(obj, 0)}\n</plist>\n`;

/* ---------- building blocks ---------- */

/** Every action UUID must be unique across the whole Shortcuts library. */
export const uuid = () => randomUUID().toUpperCase();

/** @param {string} bundle @param {string} name @param {string} intent */
export const descriptor = (bundle, name, intent, requiresApp = false) => ({
  TeamIdentifier: "0000000000",
  BundleIdentifier: bundle,
  Name: name,
  AppIntentIdentifier: intent,
  ...(requiresApp ? { ActionRequiresAppInstallation: true } : {}),
});

/** A reference to a previous action's output, optionally one property of it. */
export const ref = (outputUUID, outputName, property) => ({
  OutputUUID: outputUUID,
  Type: "ActionOutput",
  OutputName: outputName,
  ...(property ? { Aggrandizements: [{ Type: "WFPropertyVariableAggrandizement", PropertyName: property }] } : {}),
});

/** A text field mixing literal strings and ref(...) variables. */
export function text(...parts) {
  let s = "";
  const attachments = {};
  for (const p of parts) {
    if (typeof p === "string") { s += p; continue; }
    attachments[`{${s.length}, 1}`] = p; // offsets in UTF-16 units, like JS string length
    s += PLACEHOLDER;
  }
  return { Value: { string: s, attachmentsByRange: attachments }, WFSerializationType: "WFTextTokenString" };
}

/** A non text parameter holding a previous action's output. */
export const attachment = (r) => ({ Value: r, WFSerializationType: "WFTextTokenAttachment" });

/** Get Value for Key from the shortcut's JSON input. Its output is UNTYPED: pass it
 *  through getText before handing it to a rich text or comparison parameter. */
export const getValueForKey = (id, key) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
  WFWorkflowActionParameters: {
    WFInput: { Value: { Type: "ExtensionInput" }, WFSerializationType: "WFTextTokenAttachment" },
    WFDictionaryKey: key,
    WFGetDictionaryValueType: "Value",
    UUID: id,
  },
});

/** Text action: its output ("Text") is a typed string. */
export const getText = (id, value) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
  WFWorkflowActionParameters: { WFTextActionText: value, UUID: id },
});

/** Count items of a previous output; its output is named "Count". */
export const count = (id, input) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.count",
  WFWorkflowActionParameters: { Input: attachment(input), WFCountType: "Items", UUID: id },
});

/** If <variable> is <value>: string comparison, so compare a Text action's output. */
export const ifIs = (group, value, variable) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
  WFWorkflowActionParameters: {
    UUID: uuid(),
    GroupingIdentifier: group,
    WFControlFlowMode: 0,
    WFCondition: 4, // "is"
    WFConditionalActionString: value,
    WFInput: { Type: "Variable", Variable: attachment(variable) },
  },
});

export const endIf = (group) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
  WFWorkflowActionParameters: { UUID: uuid(), GroupingIdentifier: group, WFControlFlowMode: 2 },
});

/** A whole workflow taking text (our JSON) as input and returning text. */
export const workflow = (actions) => ({
  WFWorkflowClientVersion: "4610",
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowMinimumClientVersionString: "900",
  WFWorkflowIcon: { WFWorkflowIconStartColor: 2071128575, WFWorkflowIconGlyphNumber: 61440 },
  WFWorkflowImportQuestions: [],
  WFWorkflowTypes: [],
  WFWorkflowInputContentItemClasses: ["WFStringContentItem"],
  WFWorkflowOutputContentItemClasses: ["WFStringContentItem"],
  WFWorkflowHasOutputFallback: true,
  WFWorkflowHasShortcutInputVariables: true,
  WFQuickActionSurfaces: [],
  WFWorkflowActions: actions,
});
