# Notes spike: formatted writes through Shortcuts

Verified on macOS 27.0.1 (Apple silicon), iCloud account, 2026-10-04. All test notes lived in a dedicated "Kairos Test" folder; every example below is invented. Code: `spike/notes-shortcuts/`.

## Verdict

**Go**, as a hybrid:

- **Writes** go through generated Shortcuts that call Notes' App Intents. Notes parses the Markdown itself, so headings, checklists (with ticked state), tables and links come out as real Notes formatting.
- **Reads** go through JXA: fast, no prompts, and every note carries its `x-coredata://` id. Shortcuts is used for reading only where JXA is blind (checklist state).

## What works on macOS 27

| Question | Result |
|---|---|
| Input as data | JSON goes in via `shortcuts run <name> -i in.json` and comes back byte for byte (quotes, `do shell script` text, emoji, CJK, RTL, literal `<h1>`). Nothing is ever interpreted as script. |
| Create in a folder | `CreateNoteLinkAction` with the folder name passed as **text** works. |
| Body on create | `CreateNoteLinkAction`'s `contents` is ignored. Create with a title, then append the body in the same run. |
| Append Markdown | Legacy `is.workflow.actions.appendnote` (`WFInput`, `WFNote`, `interpretAsMarkdown: true`, `AppIntentDescriptor` for `AppendToNoteLinkAction`) works. |
| Find note by name | `is.workflow.actions.filter.notes` with `AppIntentIdentifier: NoteEntity`, Name is ..., limit 2. |
| Exactly one match guard | Count, Text, `If Text is "1"` around the append. 0 or 2 matches skip the append with no prompt. |
| Recently Deleted | Shortcuts' Find excludes deleted notes. JXA `notes` includes them (container "Recently Deleted"), so JXA reads must filter them. |
| Checklist state | Shortcuts' `Body` property renders list lines as `\t<marker>\t<text>`: `◦` open, `✓` done, `⁃` bullet, `1.` numbered. Nesting depth is flattened. JXA HTML shows checklists as plain `<ul><li>`. |
| Speed | Warm runs 0.2 to 1.7 s, cold 5 to 7 s. Signing a shortcut takes about 3 s and appears to contact Apple (install time only). |

### Markdown fidelity (append with `interpretAsMarkdown`)

| Markdown | Result |
|---|---|
| `#`, `##`, `###` | Title, Heading, Subheading (`<h1>`..`<h3>` in JXA HTML) |
| `####` and deeper | clamped to Subheading |
| `**bold**`, `*italic*`, `~~strike~~` | bold, italic, strikethrough |
| `- item`, nested by 2 or 4 spaces | dashed list with nesting |
| `1.` | numbered list |
| `- [ ]`, `- [x]` | real checklist items, ticked state kept |
| `[text](url)` | real link |
| pipe table | real Notes table |
| fenced code | monostyled |
| `` `inline code` `` | text kept, style lost |
| `> quote` | plain text |
| literal HTML | escaped, shown as text |
| U+FFFC | dropped (Notes uses it for attachments) |

## What does not work, and the traps

- **No Find for folders.** `filter.notes` with `FolderEntity` fails with "an action could not be found" (`VisibleFoldersQuery` has no filter parameters). Pass folder names as text instead.
- **The Markdown intents notes-mcp uses are gone.** `CreateNoteFromMarkdownLinkAction` and `AppendMarkdownToNoteLinkAction` (macOS 26) are not in the macOS 27 catalog.
- **Untyped values.** A `Get Dictionary Value` result is untyped. Rich text parameters ignore it; pass it through a Text action first (learned from iangray001/applenotes-mcp).
- **Unresolved parameters prompt a person.** When a note or text parameter ends up empty (no match, wrong encoding), `shortcuts run` does not fail: Shortcuts opens a window asking someone to pick a note and type text, and the write lands wherever they choose. In the spike this put test text into a real note outside the test folder (the user picked it). Every write shortcut must therefore guard with an exactly one match check inside the shortcut, and must be tested against the no match and duplicate cases before shipping.
- **Per shortcut Notes permission.** Each newly imported shortcut asks for Notes access on its first run and fails with "This shortcut can't access Notes" until allowed.
- **Install needs a click per shortcut**, and duplicate names break `shortcuts run`. The CLI cannot delete shortcuts.
- **No App Intents id read back yet.** Neither the created note entity nor its properties exposed an id we could map to `x-coredata://`. Notes are matched by exact name.
- **Permissions live with Shortcuts, not our Node binary.** Notes write access is granted to each Kairos shortcut. This departs from "all permissions belong to one private Node binary" and must be documented for users.

## Design for the Notes module

- **notes_create** (Markdown in): one shortcut, Create Note (title, folder as text) then Append Markdown to the note it just created. It cannot touch any other note.
- **notes_append** (id, Markdown in): Kairos resolves the id with JXA to name and folder, refuses unless that name is unique among all notes not in Recently Deleted, then runs the guarded append shortcut, and checks it reports `matches: 1`.
- **notes_list_folders, notes_list, notes_search, notes_read**: JXA, excluding Recently Deleted, always reporting folder and id. `notes_read` converts HTML to Markdown and, where the note has lists, merges checklist state from the Shortcuts `Body` rendering by position.
- **Body replace** stays JXA only, behind the write flag, refused for notes with checklists or attachments.

## Open questions

- Can Find filter by folder or creation date (would make duplicates across folders safe)? Needs the editor's exact encoding.
- Does `AppendToNoteLinkAction`'s `section` parameter append under a given heading?
- Can an App Intents note id be read back and matched to `x-coredata://`?
