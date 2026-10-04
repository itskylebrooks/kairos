#!/usr/bin/env node
// Notes Shortcuts spike, phase A: generate the unsigned spike shortcuts as plist files.
// Touches nothing: no Notes, no Shortcuts library, no signing. See README.md here.
//
// Encoding learned from eliotshea/notes-mcp (docs/spike-findings.md), adapted to the
// macOS 27 Notes intents: CreateNoteLinkAction and AppendToNoteLinkAction, both with
// interpretAsMarkdown. The macOS 26 Markdown intents notes-mcp uses no longer exist.
//
// Usage: node spike/notes-shortcuts/build.js [outDir]   (default: spike/notes-shortcuts/out)
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = "com.apple.Notes";
const PLACEHOLDER = "￼"; // Shortcuts' variable placeholder inside text fields
export const PREFIX = "Kairos Spike";

/* ---------- plist XML ---------- */

class Real { constructor(n) { this.n = n; } }
const real = (n) => new Real(n);
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

export const toPlist = (obj) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(obj, 0)}\n</plist>\n`;

/* ---------- workflow building blocks ---------- */

const uuid = () => randomUUID().toUpperCase();

const descriptor = (intent, requiresApp = false) => ({
  TeamIdentifier: "0000000000",
  BundleIdentifier: BUNDLE,
  Name: "Notes",
  AppIntentIdentifier: intent,
  ...(requiresApp ? { ActionRequiresAppInstallation: true } : {}),
});

/** A variable reference to a previous action's output, optionally a property of it. */
const ref = (outputUUID, outputName, property) => ({
  OutputUUID: outputUUID,
  Type: "ActionOutput",
  OutputName: outputName,
  ...(property ? { Aggrandizements: [{ Type: "WFPropertyVariableAggrandizement", PropertyName: property }] } : {}),
});

/** A text field mixing literal text and variables: parts are strings or ref(...) objects. */
function text(...parts) {
  let s = "";
  const attachments = {};
  for (const p of parts) {
    if (typeof p === "string") { s += p; continue; }
    attachments[`{${s.length}, 1}`] = p; // offsets are UTF-16 units, like JS string length
    s += PLACEHOLDER;
  }
  return { Value: { string: s, attachmentsByRange: attachments }, WFSerializationType: "WFTextTokenString" };
}

/** A non text parameter holding a previous action's output. */
const attachment = (r) => ({ Value: r, WFSerializationType: "WFTextTokenAttachment" });

const getValueForKey = (id, key) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
  WFWorkflowActionParameters: {
    WFInput: { Value: { Type: "ExtensionInput" }, WFSerializationType: "WFTextTokenAttachment" },
    WFDictionaryKey: key,
    WFGetDictionaryValueType: "Value",
    UUID: id,
  },
});

/** Find entities whose Name is the given text. entity: "NoteEntity" | "FolderEntity". */
const findByName = (id, entity, nameText, limit) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.filter.notes",
  WFWorkflowActionParameters: {
    AppIntentDescriptor: descriptor(entity, true),
    UUID: id,
    WFContentItemLimitEnabled: true,
    WFContentItemLimitNumber: real(limit),
    WFContentItemFilter: {
      WFSerializationType: "WFContentPredicateTableTemplate",
      Value: {
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterPrefix: 1,
        WFActionParameterFilterTemplates: [{ Operator: 99, Property: "Name", Removable: true, Values: { Unit: 4, String: nameText } }],
      },
    },
    // Deliberately no WFContentItemInputParameter: with it, Find filters the shortcut
    // input instead of querying Notes (notes-mcp findings, section 8).
  },
});

const getText = (id, value) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
  WFWorkflowActionParameters: { WFTextActionText: value, UUID: id },
});

const count = (id, input) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.count",
  WFWorkflowActionParameters: { Input: attachment(input), WFCountType: "Items", UUID: id },
});

const notesAction = (id, intent, params) => ({
  WFWorkflowActionIdentifier: `${BUNDLE}.${intent}`,
  WFWorkflowActionParameters: { AppIntentDescriptor: descriptor(intent), UUID: id, ...params },
});

const workflow = (actions) => ({
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

const DV = "Dictionary Value";

/* ---------- the spike shortcuts ---------- */

// Each takes JSON on stdin (shortcuts run -i file.json) and returns text or an entity.
export const SHORTCUTS = {
  // Q7: input travels as data. Touches no Notes.
  // in: {"text": "..."}  out: the same text
  [`${PREFIX} Echo`]: () => {
    const k = uuid();
    return workflow([getValueForKey(k, "text"), getText(uuid(), text(ref(k, DV)))]);
  },

  // Q1, Q3: create from Markdown inside a named folder, return the new note entity.
  // in: {"name": "...", "markdown": "...", "folder": "Kairos Test"}
  // out: the Note entity (try several --output-type values to look for its id)
  [`${PREFIX} Create`]: () => {
    const kn = uuid(), km = uuid(), kf = uuid(), ff = uuid();
    return workflow([
      getValueForKey(kn, "name"),
      getValueForKey(km, "markdown"),
      getValueForKey(kf, "folder"),
      findByName(ff, "FolderEntity", text(ref(kf, DV)), 1),
      notesAction(uuid(), "CreateNoteLinkAction", {
        name: text(ref(kn, DV)),
        contents: text(ref(km, DV)),
        folder: attachment(ref(ff, "Folder")),
        interpretAsMarkdown: true,
      }),
    ]);
  },

  // Q2: append Markdown to the note with this exact name, optionally under a section.
  // in: {"name": "...", "markdown": "...", "section": "optional heading"}
  [`${PREFIX} Append`]: () => {
    const kn = uuid(), km = uuid(), ks = uuid(), fn = uuid();
    return workflow([
      getValueForKey(kn, "name"),
      getValueForKey(km, "markdown"),
      getValueForKey(ks, "section"),
      findByName(fn, "NoteEntity", text(ref(kn, DV)), 1),
      notesAction(uuid(), "AppendToNoteLinkAction", {
        operation: "append",
        entity: attachment(ref(fn, "Note")),
        text: text(ref(km, DV)),
        section: text(ref(ks, DV)),
        ignoreWhitespace: false,
        interpretAsMarkdown: true,
      }),
    ]);
  },

  // Q3, Q4: raw Find result for a name, up to 2 matches, to detect duplicates and to
  // see whether deleted notes are returned. out: the Note entities themselves.
  // in: {"name": "..."}
  [`${PREFIX} Find`]: () => {
    const kn = uuid();
    return workflow([getValueForKey(kn, "name"), findByName(uuid(), "NoteEntity", text(ref(kn, DV)), 2)]);
  },

  // Q3, Q5: properties of the first note with this name, as labelled text.
  // Property names are guesses for macOS 27 ("Body" worked on 26); wrong ones come back empty.
  // in: {"name": "..."}
  [`${PREFIX} Props`]: () => {
    const kn = uuid(), fn = uuid(), c = uuid();
    return workflow([
      getValueForKey(kn, "name"),
      findByName(fn, "NoteEntity", text(ref(kn, DV)), 2),
      count(c, ref(fn, "Note")),
      getText(uuid(), text(
        "matches: ", ref(c, "Count"),
        "\nname: ", ref(fn, "Note", "Name"),
        "\nfolder: ", ref(fn, "Note", "Folder"),
        "\ncreated: ", ref(fn, "Note", "Creation Date"),
        "\nmodified: ", ref(fn, "Note", "Modification Date"),
        "\n--- body\n", ref(fn, "Note", "Body"),
        "\n--- content\n", ref(fn, "Note", "Content"),
        "\n--- end",
      )),
    ]);
  },
};

export function build(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [name, make] of Object.entries(SHORTCUTS)) {
    const file = join(outDir, `${name}.unsigned.shortcut`);
    writeFileSync(file, toPlist(make()));
    files.push(file);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || fileURLToPath(new URL("./out/", import.meta.url)));
  for (const f of build(out)) console.log(f);
}
