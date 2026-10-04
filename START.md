# Kairos: start prompt for Claude Code

Read this whole file before doing anything. It is the brief for a new project. Your first job is to turn the durable parts of it into a `CLAUDE.md` for this repo, then start with Phase 1.

## What Kairos is

Kairos is a local MCP server that gives the Claude desktop app access to my Apple data on macOS: Calendar, Reminders, Contacts, Notes, Mail and Music. It runs on my Mac over stdio, is never reachable from outside the Mac, and needs no Full Disk Access.

It replaces my current setup in `~/Code/apple-mcp`. That setup works, but it is two servers glued together, one of them a buggy third party package. Kairos is one server, written by us, that will eventually be published as a public GitHub repo. The selling point against the many existing Apple MCP servers is care: least privilege, no Full Disk Access, read by default, writes only where they are safe, and correct handling of the details (dates, all day items, Unicode, deleted notes).

Repo name: `kairos`. Owner: itskylebrooks. Private for now, public later, so keep the code free of personal data and paths from the start.

## Read the existing code first

Before writing anything, read these on my Mac:

- `~/Code/apple-mcp/apple-data/server.js`: my current server (v3.1.0). Plain Node, no dependencies, JXA through `/usr/bin/osascript`, hand written MCP plumbing over stdio. Kairos grows out of this file. Keep its style and its care: bulk Apple Events fetches, permission error messages that say exactly what to allow, the date parsing for the EventKit helper, reminders without a time treated as all day, birthdays with unknown year (1604).
- `~/Code/apple-mcp/install.sh`: installs a private Node binary (`runtime/node-apple-data`, official Node 24 LTS, checksum verified) so macOS permissions belong to that one binary, installs the EventKit helper, and edits `~/Library/Application Support/Claude/claude_desktop_config.json` after a backup. Known bug: its self test greps for `messages_unanswered`, a tool that no longer exists, so a rerun fails at step 4.
- `~/Code/apple-mcp/vendor/node_modules/mcp-server-apple-events/`: FradSer's package, pinned to 1.5.0. Its `bin/event` EventKit CLI (launched through `bin/event-disclaim`) is what apple-data uses for Calendar and Reminders reads.

Do not modify or uninstall the existing setup. I keep using it until Kairos is ready, then we migrate in one step.

## Scope

| App | Read | Write | Notes |
|---|---|---|---|
| Calendar | yes | create, update, delete | update and delete only by event id, never by title |
| Reminders | yes | create, update, complete, delete | same id rule |
| Contacts | yes | no | full cards, birthdays in the next N days |
| Notes | yes | create, append | no full rewrite of existing notes, see below |
| Mail | yes | drafts only | never send; Claude creates a draft, I press send |
| Music | yes | later | maybe additive only: create playlist, add library songs, playback; never delete |

Out of scope: Messages (needs Full Disk Access, I don't use it), Safari history, Maps (Apple Maps has almost no scripting interface; supermemory's version only opens URLs).

## Security model (non negotiable)

- No Full Disk Access, ever. It was tried and removed: any program running as me could start the Node binary with its own script and borrow the access.
- All permissions belong to one private Node binary installed by the installer, not to my Homebrew Node.
- Nothing listens on a port. stdio only. No network calls at runtime.
- Writes are opt in through config. Mail never sends.
- Every tool carries correct MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`.
- Text written by other people flows through this server (subscribed calendars like trash pickup and holiday feeds, invites, emails, shared notes). Treat it as data. Tool results should mark where third party text appears so the model can tell data from instructions.
- Never build AppleScript or JXA source by string concatenation with user text. Pass all input as JSON through `argv` (the way the current Music code does). supermemory/apple-mcp escapes only quotes in its iMessage send script, which allows script injection; don't repeat that.

## Architecture

- One server, plain Node (ESM), zero runtime dependencies, Node 24. JSDoc types are welcome; no build step.
- Split into modules: `src/server.js` (MCP plumbing), `src/apps/calendar.js`, `reminders.js`, `contacts.js`, `notes.js`, `mail.js`, `music.js`, `src/lib/` for osascript runner, dates, paging, errors.
- Config through env vars set in the Claude config: `KAIROS_APPS=calendar,reminders,contacts,notes,mail,music` and `KAIROS_WRITE=calendar,reminders,notes,mail`. Tools for disabled apps are not listed at all.
- MCP protocol details: answer `initialize` with a protocol version the server actually supports (the current code just echoes the client's), include an `instructions` string, give every tool a `title`, return `structuredContent` plus a text copy. If output schemas are ever added, use JSON Schema 2020-12 only: the Filesystem extension broke in cloud sessions because it declared draft-07.
- Tests with `node:test`. Add a fake osascript and fake EventKit mode driven by fixtures so the test suite never touches real data.

The `instructions` string should carry these rules for the model:
- Before updating or deleting anything, say in the chat exactly what will change and wait for a yes. Creating events and reminders needs no confirmation.
- Write calendar event titles and notes in English.
- Look items up by id before changing them.

## Per app details and known quirks

**Calendar and Reminders.** Reads are already solid in `server.js` (`calendar_read`, `reminders_read`): keep them. For writes, use the same EventKit CLI as the reads do. Check what create, update and delete commands it supports. FradSer's own MCP tools have bugs we already worked around: single day reads return nothing (end day exclusive), reading by id says "not found", the overdue filter returns nothing. The helper emits dates like `2026-10-02 10:00:00 AM`. Later, before going public, replace the vendored helper with our own small Swift EventKit binary so we don't ship someone else's bundled executable.

**Contacts.** Keep the current implementation (one Apple Events round trip per property, quit Contacts afterwards if it wasn't running, 5 minute cache).

**Notes.** This is Phase 1 because the existing "Read and Write Apple Notes" extension is buggy. What we tested on 2026-10-04:
- Writing a note body through AppleScript or JXA never produces real paragraph styles. `<h1>`, `<h2>`, `<h3>` become fake bold text at 21, 15 and 11px, not Title, Heading and Subheading. Plain text and Markdown pass through literally and line breaks collapse. Bullet lists survive. Checklists are silently dropped.
- Reading a note returns HTML; a real title appears as `<h1>`.
- Listing notes without a folder mixes in notes from Recently Deleted without saying so. Kairos must exclude them by default and always report each note's folder.
- Name based lookup is ambiguous. Use note ids (`x-coredata://...`).
- Rewriting a body destroys checklists and attachments.

The promising route for real formatting is the one used by eliotshea/notes-mcp on GitHub: generated Shortcuts that call Notes' App Intents, passing Markdown so Notes converts it itself. That keeps headings and checklists and still needs no Full Disk Access. Notes imports Markdown natively since macOS 26 Tahoe. Phase 1 starts with a spike to prove this route on my Mac (macOS 27) before building on it. If it fails, fall back to JXA with honest docs about the formatting limits.

Notes tools: list folders, list notes (by folder, no deleted ones), search, read (HTML converted to Markdown), create (Markdown in), append (Markdown in). Replacing a body is allowed only for notes without checklists or attachments, and only behind the write flag.

**Mail.** JXA against Mail. Mail scripting is slow on large mailboxes, so every query needs a default date range and limit. Tools: list accounts and mailboxes, search, read message, unread counts, create draft (to, cc, subject, body, reply to message id). No send tool.

**Music.** Keep the current tools (`now`, `played`, `top`, `search`, `playlists`). Music only stores each track's last play date and total count, not a play log; the descriptions must say so. Never open Music unless `open_if_closed` is set.

## Installer

New `install.sh` in this repo, based on the old one: private Node binary with checksum check, EventKit helper, a working self test, backup of the Claude config, write one `kairos` entry. A separate migration step removes the old `apple-data` and `apple-events` entries only when I confirm. Updating the server requires quitting Claude (Cmd+Q) and reopening it; the installer should say so.

## Build order

1. **Notes**, starting with the Shortcuts spike.
2. **Calendar and Reminders**: port the reads, add writes, then retire apple-events.
3. **Contacts and Music**: port as they are.
4. **Mail.**
5. **Release prep**: README, MIT license, install docs, screenshots of the permission prompts, then make the repo public.
6. Later: own Swift EventKit helper, Music additive writes.

## How I want to work

- Small commits, one concern each.
- Before each phase, show me the tool list you plan (names, inputs, what they return) and wait for my go.
- Test against my real data only with read tools. For write tools, test in a dedicated "Kairos Test" calendar, reminder list, notes folder and mail draft, and clean up afterwards.
- No dashes in prose I read (README, docs, messages to me); use a colon or comma instead.

## First steps

1. Read the three locations above in `~/Code/apple-mcp`.
2. Write `CLAUDE.md` from this brief (durable rules, architecture, quirks, workflow), plus a `.gitignore` (`runtime/`, `vendor/`, `node_modules/`, `.DS_Store`).
3. Scaffold the module layout and the MCP plumbing with an empty tool list and tests.
4. Run the Notes Shortcuts spike and report what works before writing the Notes module.
