// The Shortcuts Kairos installs for Notes. They call Notes' App Intents, so Notes itself
// parses Markdown into real formatting. Verified on macOS 27 (docs/notes-spike.md).
//
// Rule for every write shortcut: no parameter may ever be empty when an action runs.
// An empty note or text parameter makes Shortcuts open a window asking a person to pick
// a note and type text, and the write lands wherever they choose. So every write sits
// inside an If that only passes when its inputs are known to be there.
import {
  DV, attachment, count, descriptor, endIf, getText, getValueForKey, ifIs, real, ref, text, uuid, workflow,
} from "../lib/wfbuild.js";

export const SHORTCUT_CREATE = "Kairos: Create Note";
export const SHORTCUT_APPEND = "Kairos: Append to Note";
export const SHORTCUT_READ = "Kairos: Read Note";
/** Names used before 0.12; such shortcuts are no longer run and can be deleted. */
export const OLD_SHORTCUT_NAMES = Object.freeze(["Kairos Notes Create", "Kairos Notes Append", "Kairos Notes Read"]);

const NOTES = (intent, requiresApp) => descriptor("com.apple.Notes", "Notes", intent, requiresApp);

/** Find notes whose Name is the given text (Recently Deleted is never included). */
const findNotesByName = (id, nameText, limit) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.filter.notes",
  WFWorkflowActionParameters: {
    AppIntentDescriptor: NOTES("NoteEntity", true),
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
    // No WFContentItemInputParameter: with it, Find filters the shortcut input instead of Notes.
  },
});

/** Legacy Append to Note action, backed by AppendToNoteLinkAction, Markdown parsed by Notes. */
const appendMarkdown = (textRef, noteRef) => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.appendnote",
  WFWorkflowActionParameters: {
    UUID: uuid(),
    AppIntentDescriptor: NOTES("AppendToNoteLinkAction"),
    WFInput: text(textRef),
    WFNote: attachment(noteRef),
    interpretAsMarkdown: true,
  },
});

/**
 * Create a note with a title in a folder (by name), then append the Markdown body to the
 * note this run created. It can only ever write to that new note.
 * in:  {"title": "...", "folder": "<folder name>", "markdown": "...", "has_body": "yes" | "no"}
 * out: "created"
 */
function buildCreate() {
  const kt = uuid(), kf = uuid(), km = uuid(), kb = uuid(), tm = uuid(), tb = uuid(), cn = uuid(), g = uuid();
  return workflow([
    getValueForKey(kt, "title"),
    getValueForKey(kf, "folder"),
    getValueForKey(km, "markdown"),
    getValueForKey(kb, "has_body"),
    getText(tm, text(ref(km, DV))),
    getText(tb, text(ref(kb, DV))),
    {
      WFWorkflowActionIdentifier: "com.apple.Notes.CreateNoteLinkAction",
      WFWorkflowActionParameters: {
        UUID: cn,
        AppIntentDescriptor: NOTES("CreateNoteLinkAction"),
        name: text(ref(kt, DV)),
        folder: text(ref(kf, DV)),
        interpretAsMarkdown: true,
      },
    },
    ifIs(g, "yes", ref(tb, "Text")),
    appendMarkdown(ref(tm, "Text"), ref(cn, "Note")),
    endIf(g),
    getText(uuid(), text("created")),
  ]);
}

/**
 * Append Markdown to the note with this exact name, only when exactly one note matches.
 * in:  {"name": "...", "markdown": "..."}
 * out: "matches: N" (appended only when N is 1)
 */
function buildAppend() {
  const kn = uuid(), km = uuid(), tm = uuid(), fn = uuid(), c = uuid(), tc = uuid(), g = uuid();
  return workflow([
    getValueForKey(kn, "name"),
    getValueForKey(km, "markdown"),
    getText(tm, text(ref(km, DV))),
    findNotesByName(fn, text(ref(kn, DV)), 2),
    count(c, ref(fn, "Note")),
    getText(tc, text(ref(c, "Count"))),
    ifIs(g, "1", ref(tc, "Text")),
    appendMarkdown(ref(tm, "Text"), ref(fn, "Note")),
    endIf(g),
    getText(uuid(), text("matches: ", ref(c, "Count"))),
  ]);
}

/**
 * Read a note's body as Notes renders it for App Intents, which is the only place
 * checklist state is visible: list lines are "\t<marker>\t<text>" with ◦ open, ✓ done,
 * ⁃ dashed, • bulleted, "1." numbered. Reads only; never writes.
 * The body is read only inside "If matches is 1": reading the Body of no note at all makes
 * Shortcuts wait for a person (verified on macOS 27), so a missing title must never get there.
 * in:  {"name": "..."}
 * out: "matches: N\n<body>"  (body only when N is 1; otherwise the second line is not a body)
 */
function buildRead() {
  const kn = uuid(), fn = uuid(), c = uuid(), tc = uuid(), g = uuid(), tb = uuid(), end = uuid();
  return workflow([
    getValueForKey(kn, "name"),
    findNotesByName(fn, text(ref(kn, DV)), 2),
    count(c, ref(fn, "Note")),
    getText(tc, text(ref(c, "Count"))),
    ifIs(g, "1", ref(tc, "Text")),
    getText(tb, text(ref(fn, "Note", "Body"))),
    endIf(g, end),
    getText(uuid(), text("matches: ", ref(c, "Count"), "\n", ref(end, "If Result"))),
  ]);
}

/** name -> builder. Each build gets fresh action UUIDs. */
export const NOTES_SHORTCUTS = Object.freeze({
  [SHORTCUT_CREATE]: buildCreate,
  [SHORTCUT_APPEND]: buildAppend,
  [SHORTCUT_READ]: buildRead,
});
