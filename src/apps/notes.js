// Notes tools. Reads go through JXA (fast, no prompts, every note keeps its x-coredata id).
// Writes go through Kairos' own shortcuts, so Notes parses Markdown into real formatting
// (docs/notes-spike.md). Every write is guarded so it can only reach the intended note.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, isBareDay, isoLocal, parseArgDate } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { defineScript, jxa } from "../lib/osascript.js";
import { dataDir } from "../lib/paths.js";
import { clampInt } from "../lib/paging.js";
import { registerUndo } from "../lib/activity.js";
import { assertNotShared } from "../lib/safety.js";
import { runShortcut } from "../lib/shortcuts.js";
import { fold } from "../lib/text.js";
import { ADD, READ, UPDATE, defineTool } from "../lib/tools.js";
import { escapeInline, noteToMarkdown, parseBridgeItems } from "../lib/notes-html.js";
import { SHORTCUT_APPEND, SHORTCUT_CREATE, SHORTCUT_READ } from "./notes-shortcuts.js";

const APP = "Notes";

// Notes does not mark its trash folder in the scripting dictionary; it is a top level
// folder with this name (per language). Notes in it are never listed unless asked for.
const DELETED_NAMES = new Set(["Recently Deleted", "Zuletzt gelöscht", "Недавно удаленные", "Récemment supprimés", "Eliminados recientemente", "Eliminati di recente"]);

/* ================= JXA (static scripts; input arrives as JSON in argv[0]) ================= */

const JXA_FOLDERS = defineScript("notes.folders", `
function run(argv) {
  const N = Application("Notes");
  const out = { accounts: [], folders: [] };
  for (const a of N.accounts()) {
    let def = null;
    try { def = a.defaultFolder().id(); } catch (e) {}
    out.accounts.push({ id: a.id(), name: a.name(), default_folder: def });
    const ids = a.folders.id(), names = a.folders.name(), shared = a.folders.shared();
    for (let i = 0; i < ids.length; i++) {
      const f = a.folders.byId(ids[i]);
      let container = null, count = null;
      try { container = f.container().id(); } catch (e) {}
      try { count = f.notes.length; } catch (e) {}
      out.folders.push({ id: ids[i], name: names[i], shared: shared[i], container: container, account: a.id(), count: count });
    }
  }
  return JSON.stringify(out);
}`);

// All notes in one bulk read (one Apple Events round trip per property), plus a note to
// folder map built from each folder's note ids. Bulk container lookups return nothing.
const JXA_SCAN = defineScript("notes.scan", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const N = Application("Notes");
  const want = new Set(o.folders);
  const folderOf = {};
  for (const fid of o.folders) { try { for (const nid of N.folders.byId(fid).notes.id()) folderOf[nid] = fid; } catch (e) {} }
  const all = N.notes;
  const ids = all.id(), names = all.name(), cd = all.creationDate(), md = all.modificationDate(), pw = all.passwordProtected(), sh = all.shared();
  const pt = o.text === "none" ? null : all.plaintext();
  const iso = (d) => (d ? d.toISOString() : null);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const fid = folderOf[ids[i]];
    if (!fid || !want.has(fid)) continue;
    let t = pt ? pt[i] || "" : null;
    if (pw[i]) t = null;
    else if (t !== null && o.text === "preview") t = t.slice(0, 400);
    out.push({ id: ids[i], name: names[i], folder: fid, created: iso(cd[i]), modified: iso(md[i]), locked: pw[i], shared: sh[i], text: t });
  }
  return JSON.stringify(out);
}`);

const JXA_GET = defineScript("notes.get", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const N = Application("Notes");
  const n = N.notes.byId(o.id);
  let name;
  try { name = n.name(); } catch (e) { return JSON.stringify({ found: false }); }
  const out = { found: true, id: n.id(), name: name, folder: n.container().id(),
    created: n.creationDate().toISOString(), modified: n.modificationDate().toISOString(),
    locked: n.passwordProtected(), shared: n.shared(), attachments: [] };
  try { out.attachments = n.attachments().map((a) => ({ name: a.name(), id: a.id() })); } catch (e) {}
  if (!out.locked && o.body) { out.body = n.body(); out.text = n.plaintext(); }
  return JSON.stringify(out);
}`);

// Every note with this exact name, with its folder: to prove a name is unique.
const JXA_BY_NAME = defineScript("notes.by_name", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const N = Application("Notes");
  const ns = N.notes.whose({ name: o.name })();
  return JSON.stringify(ns.map((n) => ({ id: n.id(), folder: n.container().id(), created: n.creationDate().toISOString() })));
}`);

const JXA_SET_BODY = defineScript("notes.set_body", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const n = Application("Notes").notes.byId(o.id);
  n.body = o.html;
  return JSON.stringify({ modified: n.modificationDate().toISOString(), name: n.name() });
}`);

// Empties a note and keeps it findable by title: with an empty body the note keeps the
// name set here. Notes then builds the new body, title included, from Markdown. Writing
// the title as HTML here instead would turn it into fake bold text, not the Title style.
const JXA_CLEAR = defineScript("notes.clear", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const n = Application("Notes").notes.byId(o.id);
  n.body = "";
  n.name = o.name;
  return JSON.stringify({ name: n.name() });
}`);

// Moves a note to Recently Deleted (recoverable there for 30 days). Used only to undo a note
// Kairos itself created, and only while it is unchanged since.
const JXA_TRASH = defineScript("notes.trash", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const N = Application("Notes");
  N.delete(N.notes.byId(o.id));
  return JSON.stringify({ ok: true });
}`);

const JXA_MOVE = defineScript("notes.move", `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const N = Application("Notes");
  N.move(N.notes.byId(o.id), { to: N.folders.byId(o.folder) });
  return JSON.stringify({ ok: true });
}`);

const notesJxa = (script, input, timeoutMs) => jxa(script, input, { app: APP, timeoutMs });

/* ================= folders ================= */

let folderCache = null, folderCacheAt = 0;

/** All folders with account, path and trash flag. Cached for 60 s. */
async function folderTree({ fresh = false } = /** @type {any} */ ({})) {
  if (!fresh && folderCache && Date.now() - folderCacheAt < 60e3) return folderCache;
  const raw = await notesJxa(JXA_FOLDERS, {}, 120000);
  const accounts = new Map(raw.accounts.map((a) => [a.id, a]));
  const byId = new Map(raw.folders.map((f) => [f.id, f]));
  const pathOf = (f, seen = new Set()) => {
    if (seen.has(f.id)) return f.name;
    seen.add(f.id);
    const parent = f.container && byId.get(f.container);
    return parent ? `${pathOf(parent, seen)}/${f.name}` : `${accounts.get(f.account)?.name ?? "?"}/${f.name}`;
  };
  const folders = raw.folders.map((f) => {
    const topLevel = !byId.has(f.container);
    return {
      id: f.id,
      name: f.name,
      path: pathOf(f),
      account: accounts.get(f.account)?.name ?? null,
      note_count: f.count,
      shared: !!f.shared,
      deleted: topLevel && DELETED_NAMES.has(f.name),
      is_default: accounts.get(f.account)?.default_folder === f.id,
    };
  });
  folderCache = { folders, byId: new Map(folders.map((f) => [f.id, f])) };
  folderCacheAt = Date.now();
  return folderCache;
}

/** Folder argument (id, path like "iCloud/Work/Projects", or unique name) to a folder. */
async function resolveFolder(arg) {
  const { folders, byId } = await folderTree();
  const s = String(arg).trim();
  if (byId.has(s)) return byId.get(s);
  const lc = s.toLowerCase().replace(/\/+$/, "");
  let hits = folders.filter((f) => f.path.toLowerCase() === lc);
  if (!hits.length) hits = folders.filter((f) => f.path.toLowerCase().split("/").slice(1).join("/") === lc);
  if (!hits.length && !s.includes("/")) hits = folders.filter((f) => f.name.toLowerCase() === lc);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UserError(`No Notes folder "${s}". Use notes_folders to see folder ids and paths.`);
  throw new UserError(`"${s}" matches ${hits.length} folders: ${hits.map((f) => f.path).join(", ")}. Pass the folder id or full path.`);
}

const visibleFolders = (folders, includeDeleted) => folders.filter((f) => includeDeleted || !f.deleted);

/* ================= shared helpers ================= */


function summary(n, byId) {
  const f = byId.get(n.folder);
  return {
    id: n.id,
    title: n.name,
    folder: f ? f.path : null,
    folder_id: n.folder,
    created: n.created ? isoLocal(new Date(n.created)) : null,
    modified: n.modified ? isoLocal(new Date(n.modified)) : null,
    locked: !!n.locked,
    shared: !!n.shared,
    // Shared notes, and notes in a shared folder, may hold text other people wrote: marked
    // and cleaned centrally.
    ...(n.shared || (f && f.shared) ? { from_others: true } : {}),
    ...(f && f.deleted ? { deleted: true } : {}),
  };
}


// Case and accent insensitive matching.

async function getNote(id, { body = false } = /** @type {any} */ ({})) {
  if (typeof id !== "string" || !id.startsWith("x-coredata://") || !/\/ICNote\//.test(id)) {
    throw new UserError(`"${id}" is not a note id. Note ids look like x-coredata://.../ICNote/p123; get them from notes_list or notes_search.`);
  }
  const n = await notesJxa(JXA_GET, { id, body });
  if (!n.found) throw new UserError(`No note with id ${id}. It may have been deleted.`);
  return n;
}

/** Notes (outside Recently Deleted) with exactly this name. */
async function liveNotesNamed(name) {
  const { byId } = await folderTree();
  const all = await notesJxa(JXA_BY_NAME, { name });
  return all.filter((n) => !byId.get(n.folder)?.deleted);
}

/** Checklist state through the read shortcut, when the note can be addressed by name. */
async function bridgeItems(name) {
  const live = await liveNotesNamed(name);
  if (live.length !== 1) return { items: null, why: `another note has the same title, so checklist state could not be read` };
  try {
    const out = await runShortcut(SHORTCUT_READ, { name });
    const m = /^matches: (\d+)\n?([\s\S]*)$/.exec(out);
    if (!m || m[1] !== "1") return { items: null, why: "the read shortcut could not find the note by its title" };
    return { items: parseBridgeItems(m[2]), why: null };
  } catch (e) {
    return { items: null, why: String(e.message || e) };
  }
}

async function readMarkdown(n) {
  let conv = noteToMarkdown(n.body);
  let checklistNote = null;
  if (conv.checklists === "unknown") {
    const b = await bridgeItems(n.name);
    if (b.items) conv = noteToMarkdown(n.body, b.items);
    if (conv.checklists === "unknown") checklistNote = `Lists shown as "- " may be checklists whose ticked state is unknown: ${(b.why || "list structure did not match").replace(/\.$/, "")}.`;
  }
  return { ...conv, checklist_note: checklistNote };
}

function checkMarkdownInput(markdown, field = "markdown") {
  if (typeof markdown !== "string") throw new UserError(`${field} must be a string.`);
  // U+FFFC is Notes' attachment placeholder; Notes drops it, so drop it visibly here.
  return markdown.replace(/￼/g, "").replace(/\r\n?/g, "\n");
}

function checkTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) throw new UserError("title must not be empty.");
  if (/[\r\n]/.test(t)) throw new UserError("title must be one line.");
  if (t.length > 300) throw new UserError("title is too long (300 characters at most).");
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until the note's last change is SETTLE_MS old. Writing a note by script right after
 * Notes finished a Shortcuts write jams Notes (verified on macOS 27: the script hangs, and the
 * note refuses script writes until Notes restarts).
 */
const SETTLE_MS = 4000;
async function settleNote(id) {
  const n = await getNote(id);
  const age = Date.now() - Date.parse(n.modified);
  if (age >= 0 && age < SETTLE_MS) await sleep(SETTLE_MS - age); // a future date (clock skew) is not "just written"
}

/** Script writes to a note: a short timeout, so a stuck Notes is noticed quickly. */
const WRITE_TIMEOUT_MS = 20000;

/** Polls fn until it returns a truthy value or the time is up. */
async function waitFor(fn, ms = 6000, step = 400) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await sleep(step);
  }
}

/** First and last lines of visible text a Markdown body should produce, for verification. */
export function expectedTextLines(markdown) {
  const lines = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence || /^\s*\|/.test(raw)) continue;
    const t = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\\([\\`*_~#>\[\]()-])/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (t) lines.push(t);
  }
  return lines.length ? [lines[0], lines[lines.length - 1]] : [];
}

const squash = (s) => String(s ?? "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();

/* ================= backups (notes_replace) ================= */

const KEEP_BACKUPS = 100;

function writeBackup(n, md) {
  const dir = join(dataDir(), "backups", "notes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${createHash("sha256").update(n.id).digest("hex").slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify({ id: n.id, title: n.name, folder: n.folder, modified: n.modified, saved: new Date().toISOString(), markdown: md.markdown, checklists: md.checklists, html: n.body }, null, 1), { mode: 0o600 });
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) rmSync(join(dir, old), { force: true });
  return file;
}

/** Attachments other than tables (Notes stores each table as an unnamed attachment). */
function realAttachments(n) {
  const tables = (String(n.body ?? "").match(/<table[\s>]/gi) || []).length;
  let unnamedTables = tables;
  return n.attachments.filter((a) => {
    if (!a.name && unnamedTables > 0) { unnamedTables--; return false; }
    return true;
  });
}


/* ================= handlers ================= */

async function notesFolders() {
  const { folders } = await folderTree({ fresh: true });
  const list = folders.filter((f) => !f.deleted).sort((a, b) => a.path.localeCompare(b.path));
  return { count: list.length, folders: list.map(({ deleted, ...f }) => f) };
}

async function scan({ folder, include_deleted, text }) {
  const tree = await folderTree();
  const targets = folder ? [await resolveFolder(folder)] : visibleFolders(tree.folders, include_deleted);
  const raw = await notesJxa(JXA_SCAN, { folders: targets.map((f) => f.id), text }, 180000);
  return { raw, byId: tree.byId };
}

function dateFilter(items, since, until) {
  const from = parseArgDate(since, "modified_since");
  let to = parseArgDate(until, "modified_until");
  if (to && isBareDay(until)) to = addDays(to, 1); // a bare end date means through that day
  return items.filter((n) => (!from || new Date(n.modified) >= from) && (!to || new Date(n.modified) < to));
}

async function notesList({ folder, modified_since, modified_until, include_deleted, limit, offset } = /** @type {any} */ ({})) {
  const { raw, byId } = await scan({ folder, include_deleted, text: "preview" });
  const items = dateFilter(raw, modified_since, modified_until).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const l = clampInt(limit, 1, 500, 50), o = clampInt(offset, 0, 1e9, 0);
  const notes = items.slice(o, o + l).map((n) => ({ ...summary(n, byId), preview: n.text === null ? null : previewOf(n.text, n.name) }));
  return { total: items.length, offset: o, limit: l, has_more: o + l < items.length, notes };
}

function previewOf(text, title) {
  let t = String(text);
  if (t.startsWith(title)) t = t.slice(title.length);
  return t.replace(/\s+/g, " ").trim().slice(0, 160) || null;
}

async function notesSearch({ query, folder, include_deleted, limit, offset } = /** @type {any} */ ({})) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) throw new UserError("query must not be empty.");
  const { raw, byId } = await scan({ folder, include_deleted, text: "full" });
  const hits = [];
  for (const n of raw) {
    const hay = fold(`${n.name}\n${n.text ?? ""}`);
    if (!words.every((w) => hay.includes(w))) continue;
    hits.push({ n, snippet: snippetOf(n.text ?? "", words[0]) });
  }
  hits.sort((a, b) => String(b.n.modified).localeCompare(String(a.n.modified)));
  const l = clampInt(limit, 1, 200, 25), o = clampInt(offset, 0, 1e9, 0);
  const notes = hits.slice(o, o + l).map(({ n, snippet }) => ({ ...summary(n, byId), snippet }));
  return { query, total: hits.length, offset: o, limit: l, has_more: o + l < hits.length, notes };
}

function snippetOf(text, word) {
  const folded = fold(text);
  const i = folded.indexOf(word);
  if (i < 0) return null;
  // fold() keeps length for most text; fall back to the folded text if it does not.
  const src = folded.length === text.length ? text : folded;
  const a = Math.max(0, i - 60), b = Math.min(src.length, i + word.length + 60);
  return `${a > 0 ? "…" : ""}${src.slice(a, b).replace(/\s+/g, " ").trim()}${b < src.length ? "…" : ""}`;
}

async function notesRead({ id, max_chars, offset } = /** @type {any} */ ({})) {
  const n = await getNote(id, { body: true });
  const { byId } = await folderTree();
  const base = { ...summary(n, byId), attachments: (n.locked ? n.attachments : realAttachments(n)).map((a) => a.name || "(unnamed attachment)") };
  if (n.locked) return { ...base, markdown: null, message: "This note is locked with a password; its text cannot be read." };
  const md = await readMarkdown(n);
  // Long notes come in parts, so one note cannot flood the context.
  const max = clampInt(max_chars, 200, 100000, 12000), off = clampInt(offset, 0, 1e9, 0);
  /** @type {Record<string, any>} */
  const out = { ...base, markdown: md.markdown.slice(off, off + max), markdown_chars: md.markdown.length, checklists: md.checklists };
  if (off + max < md.markdown.length) Object.assign(out, { truncated: true, next_offset: off + max });
  if (md.checklist_note) out.checklist_note = md.checklist_note;
  return out;
}

async function notesCreate({ title, markdown = "", folder, allow_shared } = /** @type {any} */ ({})) {
  const t = checkTitle(title);
  let body = checkMarkdownInput(markdown);
  // The title is written separately; drop a leading "# <title>" the model may have repeated.
  const firstLine = body.replace(/^\n+/, "").split("\n")[0];
  if (/^#\s+/.test(firstLine) && firstLine.replace(/^#\s+/, "").trim() === t) body = body.replace(/^\n*[^\n]*\n?/, "");
  body = body.replace(/^\n+/, "");

  const { folders } = await folderTree({ fresh: true });
  const target = folder ? await resolveFolder(folder) : folders.find((f) => f.is_default && !f.deleted);
  if (!target) throw new UserError("Could not find the default Notes folder. Pass folder.");
  if (target.deleted) throw new UserError("Notes cannot be created in Recently Deleted.");
  assertNotShared(target.shared, allow_shared, `The folder "${target.path}"`);

  // The shortcut takes a folder NAME, so it must be unique; otherwise create in the
  // default folder (if its name is unique) and move the note by id afterwards.
  const unique = (f) => folders.filter((x) => x.name === f.name).length === 1;
  const via = unique(target) ? target : folders.find((f) => f.is_default && !f.deleted && unique(f));
  if (!via) throw new UserError(`The folder name "${target.name}" is used more than once, and so is the default folder's name, so Kairos cannot place the note safely.`);

  const t0 = Date.now() - 2000;
  const out = await runShortcut(SHORTCUT_CREATE, { title: t, folder: via.name, markdown: body, has_body: body.trim() ? "yes" : "no" });
  if (!/created/.test(out)) throw new Error(`Create shortcut returned unexpected output: ${out.slice(0, 200)}`);

  const found = await waitFor(async () => {
    const same = (await notesJxa(JXA_BY_NAME, { name: t })).filter((n) => n.folder === via.id && Date.parse(n.created) >= t0);
    return same.length ? same.sort((a, b) => b.created.localeCompare(a.created))[0] : null;
  });
  if (!found) throw new UserError(`The note "${t}" was created, but Kairos could not find it afterwards in ${via.path}. Check Notes.`);
  if (via.id !== target.id) await notesJxa(JXA_MOVE, { id: found.id, folder: target.id });

  const n = await getNote(found.id);
  const { byId } = await folderTree({ fresh: true });
  return {
    ...summary(n, byId),
    _journal: {
      action: "create", target: { kind: "note", id: n.id, title: n.name }, summary: `Created the note "${n.name}" in ${byId.get(n.folder)?.path ?? "Notes"}.`,
      before: null, after: { id: n.id, title: n.name, folder: n.folder, modified: n.modified }, undo: { possible: true },
    },
  };
}

/** Checks shared by append and replace: the note exists, is live, unlocked, uniquely named. */
async function writableNote(id, { body = false } = /** @type {any} */ ({})) {
  const n = await getNote(id, { body });
  const { byId } = await folderTree();
  if (byId.get(n.folder)?.deleted) throw new UserError("This note is in Recently Deleted. Restore it in Notes first.");
  if (n.locked) throw new UserError("This note is locked with a password; Kairos cannot change it.");
  const same = await liveNotesNamed(n.name);
  if (same.length !== 1) {
    throw new UserError(`${same.length} notes are titled "${n.name}". Kairos writes through Shortcuts, which find notes by title, so it only changes notes whose title is unique. Rename one of them first.`);
  }
  return n;
}

async function appendGuarded(name, markdown) {
  const out = await runShortcut(SHORTCUT_APPEND, { name, markdown });
  const m = /matches: (\d+)/.exec(out);
  if (!m) throw new Error(`Append shortcut returned unexpected output: ${out.slice(0, 200)}`);
  if (m[1] !== "1") throw new UserError(`Nothing was written: Shortcuts found ${m[1]} notes titled "${name}", and Kairos only writes when exactly one matches.`);
}

async function notesAppend({ id, markdown, allow_shared } = /** @type {any} */ ({})) {
  const md = checkMarkdownInput(markdown).replace(/^\n+|\n+$/g, "");
  if (!md.trim()) throw new UserError("markdown must not be empty.");
  const n = await writableNote(id, { body: true });
  const folderShared = !!(await folderTree()).byId.get(n.folder)?.shared;
  assertNotShared(n.shared || folderShared, allow_shared, `The note "${n.name}"`);
  // The text before the append is kept, so the append can be undone.
  const old = await readMarkdown(n);
  const backup = writeBackup(n, old);
  await appendGuarded(n.name, md);
  const after = await waitFor(async () => { const x = await getNote(id); return x.modified !== n.modified ? x : null; }, 5000);
  const { byId } = await folderTree();
  return {
    appended: true, characters: md.length, ...summary(after || n, byId),
    _journal: {
      action: "append", target: { kind: "note", id, title: n.name }, summary: `Added ${md.length} characters to the note "${n.name}".`,
      before: { title: n.name, backup }, after: { id, title: (after || n).name, modified: (after || n).modified },
      undo: restorable(n, old, folderShared),
    },
  };
}

/** Whether a note can be put back from its backup through notes_replace. */
function restorable(n, old, folderShared = false) {
  if (n.shared || folderShared) return { possible: false, reason: "The note is shared; Kairos does not rewrite shared notes." };
  if (realAttachments(n).length) return { possible: false, reason: "The note has attachments, which cannot be rebuilt from text." };
  if (old.checklists === "unknown") return { possible: false, reason: "Its checklist ticks could not be read, so restoring would lose them. The old text is in the backup." };
  return { possible: true };
}

/** Refuses when the note is gone or was changed after Kairos' change. */
async function noteUnchangedSince(entry) {
  let n;
  try { n = await getNote(entry.after.id); } catch { throw new UserError(`The note "${entry.after.title}" no longer exists.`); }
  if ((await folderTree()).byId.get(n.folder)?.deleted) throw new UserError(`The note "${n.name}" is in Recently Deleted.`);
  if (Math.abs(Date.parse(n.modified) - Date.parse(entry.after.modified)) >= 1000) {
    throw new UserError(`The note "${n.name}" was changed after Kairos' change, so undoing would overwrite those later edits.`);
  }
  return n;
}

function readBackup(file) {
  if (!file || !existsSync(file)) throw new UserError("The backup of the earlier text is gone, so this change cannot be undone.");
  return JSON.parse(readFileSync(file, "utf8"));
}

registerUndo("notes", "create", {
  async preview(e) { await noteUnchangedSince(e); return { summary: `Move the note "${e.after.title}" that Kairos created to Recently Deleted (recoverable there for 30 days).` }; },
  async run(e) {
    await noteUnchangedSince(e);
    await settleNote(e.after.id);
    await notesJxa(JXA_TRASH, { id: e.after.id }, WRITE_TIMEOUT_MS);
    return { result: { moved_to: "Recently Deleted", id: e.after.id, title: e.after.title }, journal: { action: "trash", target: { kind: "note", id: e.after.id, title: e.after.title }, summary: `Moved "${e.after.title}" to Recently Deleted (undo of its creation).`, before: e.after, after: null } };
  },
});

for (const action of ["append", "replace"]) {
  registerUndo("notes", action, {
    async preview(e) {
      await noteUnchangedSince(e);
      const b = readBackup(e.before.backup);
      return { summary: `Restore the note "${e.after.title}" to its text from before Kairos' ${action === "append" ? "addition" : "replacement"}${b.title !== e.after.title ? `, with its old title "${b.title}"` : ""} (${b.markdown.length} characters of Markdown).` };
    },
    async run(e) {
      const n = await noteUnchangedSince(e);
      const b = readBackup(e.before.backup);
      const r = await notesReplace({ id: e.after.id, markdown: b.markdown, title: b.title, expected_modified: n.modified });
      return { result: r, journal: { action: "replace", target: { kind: "note", id: e.after.id, title: b.title }, summary: `Restored "${b.title}" to its earlier text (undo of a ${action}).`, before: { title: e.after.title, backup: r.backup }, after: { id: e.after.id, title: r.title, modified: r._modified } } };
    },
  });
}

/** Every check notes_replace makes, without writing. */
async function planReplace({ id, markdown, title, expected_modified } = /** @type {any} */ ({})) {
  const body = checkMarkdownInput(markdown).replace(/^\n+|\n+$/g, "");
  const n = await writableNote(id, { body: true });
  const expected = Date.parse(String(expected_modified ?? ""));
  if (!Number.isFinite(expected)) throw new UserError("expected_modified must be the modified timestamp from notes_read.");
  if (Math.abs(Date.parse(n.modified) - expected) >= 1000) {
    throw new UserError(`The note changed since it was read (modified ${isoLocal(new Date(n.modified))}). Read it again with notes_read before replacing it.`);
  }
  // A note in a shared folder is shared too, even when the note itself does not say so.
  if (n.shared || (await folderTree()).byId.get(n.folder)?.shared) throw new UserError("This note is shared with other people; Kairos does not replace shared notes. Use notes_append instead.");
  const files = realAttachments(n);
  if (files.length) throw new UserError(`This note has ${files.length} attachment(s) that cannot be rebuilt from Markdown, so Kairos does not replace it. Use notes_append instead.`);
  const newTitle = title === undefined || title === null || title === "" ? n.name : checkTitle(title);
  if (newTitle !== n.name && (await liveNotesNamed(newTitle)).length) {
    throw new UserError(`Another note is already titled "${newTitle}". Choose a unique title.`);
  }
  return { n, body, newTitle };
}

async function previewReplace(a = /** @type {any} */ ({})) {
  const { n, body, newTitle } = await planReplace(a);
  const { byId } = await folderTree();
  const where = byId.get(n.folder)?.path ?? "Notes";
  const oldChars = String(n.text ?? "").length;
  return {
    summary: `Replace the whole text of "${n.name}" (${where}, about ${oldChars} characters now) with ${body.length} characters of new Markdown${newTitle !== n.name ? `, and rename it to "${newTitle}"` : ""}. The old text is saved to a private backup first.`,
    note_id: n.id,
    new_text_start: body.slice(0, 400),
  };
}

async function notesReplace(a = /** @type {any} */ ({})) {
  const { id } = a;
  const { n, body, newTitle } = await planReplace(a);

  const old = await readMarkdown(n);
  const backup = writeBackup(n, old);

  // Empty the note (keeping its title as name), then let Notes build title and body from Markdown.
  const rebuild = async (t, md) => {
    await settleNote(id);
    await notesJxa(JXA_CLEAR, { id, name: t }, WRITE_TIMEOUT_MS);
    // Shortcuts' index learns a new title a few seconds later; write only once it does.
    if (t !== n.name || t !== newTitle) {
      const seen = await waitFor(async () => /^matches: 1\b/.test(await runShortcut(SHORTCUT_READ, { name: t })), 15000, 1000);
      if (!seen) throw new UserError(`Shortcuts did not find the note under the title "${t}" in time.`);
    }
    await appendGuarded(t, `# ${escapeInline(t)}${md.trim() ? `\n\n${md}` : ""}`);
  };
  const restore = async (why) => {
    try {
      await rebuild(n.name, old.markdown);
      return `${why} The previous text was written back${old.checklists === "unknown" ? " (checklist ticks may be lost)" : ""}. A copy is in ${backup}.`;
    } catch (e) {
      let putBack = false;
      try { await notesJxa(JXA_SET_BODY, { id, html: n.body }, WRITE_TIMEOUT_MS); putBack = true; } catch {}
      return putBack
        ? `${why} Restoring the previous text through Shortcuts also failed (${e.message}); the old HTML was put back instead, which may lose checklists. A full copy is in ${backup}.`
        : `${why} Restoring the previous text also failed (${e.message}), and Notes did not accept the old text either: the note may be empty or incomplete now. Notes may be stuck: quit and reopen Notes. The full previous text is saved in ${backup}.`;
    }
  };

  try {
    await rebuild(newTitle, body);
  } catch (e) {
    throw new UserError(await restore(`Replacing failed: ${e.message}`));
  }

  // Verify: the first and last lines of text must be there.
  const want = expectedTextLines(body).map(squash);
  const after = await waitFor(async () => {
    const x = await getNote(id, { body: true });
    const have = squash(x.text);
    return want.every((w) => have.includes(w)) ? x : null;
  }, 6000);
  if (!after) throw new UserError(await restore("The new text did not show up in the note."));

  const { byId } = await folderTree();
  return {
    replaced: true, backup, ...summary(after, byId), _modified: after.modified,
    _journal: {
      action: "replace", target: { kind: "note", id, title: after.name }, summary: `Replaced the text of "${n.name}"${after.name !== n.name ? ` and renamed it to "${after.name}"` : ""}.`,
      before: { title: n.name, backup }, after: { id, title: after.name, modified: after.modified },
      undo: restorable(n, old),
    },
  };
}

/* ================= tool definitions ================= */

const FOLDER = { type: "string", description: "Folder id, path like \"iCloud/Work/Projects\", or a folder name that is unique." };
const DATE = { type: "string", description: "Date or date-time, e.g. 2030-01-31 or 2030-01-31T18:00 (local time)." };
const ALLOW_SHARED = { type: "boolean", description: "Set only after the user agreed in the chat: writing into a shared folder or note lets other people read it." };
const NOTE_ID = { type: "string", description: "Note id (x-coredata://.../ICNote/p123) from notes_list or notes_search." };
const MD = "Markdown, parsed by Notes itself: # Title, ## Heading, ### Subheading, **bold**, *italic*, ~~strike~~, - bullets, 1. numbered, - [ ] / - [x] checklists, nesting by 4 spaces, [links](url), pipe tables, ``` code. Block quotes and inline code lose their styling.";

export const tools = [
  defineTool({
    name: "notes_folders", app: "notes", title: "List Notes folders", annotations: READ, handler: notesFolders,
    description: "All Notes folders with id, name, full path (account/parent/child), note count and whether they are shared or the default folder. Recently Deleted is left out.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  }),
  defineTool({
    name: "notes_list", app: "notes", title: "List notes", annotations: READ, handler: notesList,
    description: "Notes, most recently changed first, with id, title, folder, dates, locked/shared flags and a short preview. Optionally one folder and a modified date range. Notes in Recently Deleted are left out unless include_deleted is true.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        folder: FOLDER, modified_since: DATE, modified_until: { ...DATE, description: `${DATE.description} A bare date includes that day.` },
        include_deleted: { type: "boolean", description: "Also list notes in Recently Deleted (default false)." },
        limit: { type: "integer", description: "Max notes (default 50, up to 500)." },
        offset: { type: "integer", description: "Skip this many (paging)." },
      },
    },
  }),
  defineTool({
    name: "notes_search", app: "notes", title: "Search notes", annotations: READ, handler: notesSearch,
    description: "Find notes whose title or text contains every word of the query (case and accent insensitive). Returns id, title, folder, dates and a snippet around the first word. Recently Deleted is left out unless include_deleted is true.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string" }, folder: FOLDER,
        include_deleted: { type: "boolean", description: "Also search Recently Deleted (default false)." },
        limit: { type: "integer", description: "Max notes (default 25, up to 200)." },
        offset: { type: "integer", description: "Skip this many (paging)." },
      },
    },
  }),
  defineTool({
    name: "notes_read", app: "notes", title: "Read a note", annotations: READ, handler: notesRead,
    description: "One note as Markdown, in parts of 12000 characters by default (max_chars, offset; the title is returned separately and is not repeated in markdown), with folder, dates, flags and attachment names. Checklist ticks are included when they can be read (checklists: resolved). Pass modified to notes_replace as expected_modified.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: { id: NOTE_ID, max_chars: { type: "integer", description: "Max characters of markdown (default 12000)." }, offset: { type: "integer", description: "Continue a long note from next_offset." } },
    },
  }),
  defineTool({
    name: "notes_create", app: "notes", title: "Create a note", annotations: ADD, handler: notesCreate,
    description: `Create a new note with a title and a Markdown body, in a folder (default: the default Notes folder). Returns the new note's id. Shared folders are refused unless allow_shared is true (ask the user first). ${MD}`,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["title"],
      properties: { title: { type: "string", description: "One line; becomes the note's title." }, markdown: { type: "string", description: "The body, without the title." }, folder: FOLDER, allow_shared: ALLOW_SHARED },
    },
  }),
  defineTool({
    name: "notes_append", app: "notes", title: "Append to a note", annotations: ADD, handler: notesAppend,
    description: `Add Markdown at the end of an existing note, keeping everything already in it (checklists, attachments). Refused for locked notes, notes in Recently Deleted, and notes whose title is not unique; shared notes or folders need allow_shared (ask the user first). ${MD}`,
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "markdown"], properties: { id: NOTE_ID, markdown: { type: "string" }, allow_shared: ALLOW_SHARED } },
  }),
  defineTool({
    name: "notes_replace", app: "notes", title: "Replace a note's text", annotations: UPDATE, handler: notesReplace, preview: previewReplace,
    description: `Replace the whole body of a note with Markdown, in place (same id, folder and creation date). Destructive, so two steps: the first call only returns a preview and a confirmation; show the preview, wait for the user's yes, then call again with the same arguments plus confirmation. Requires expected_modified from a fresh notes_read. Refused for locked notes, shared notes and notes in a shared folder, notes with attachments, and notes whose title is not unique. The old version is saved to a private backup file first. ${MD}`,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id", "markdown", "expected_modified"],
      properties: {
        id: NOTE_ID,
        markdown: { type: "string", description: "The new body, without the title." },
        title: { type: "string", description: "New title (default: keep the current one)." },
        expected_modified: { type: "string", description: "The modified value from notes_read; the replace is refused if the note changed since." },
      },
    },
  }),
];
