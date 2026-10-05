# Kairos

[![CI](https://github.com/itskylebrooks/kairos/actions/workflows/ci.yml/badge.svg)](https://github.com/itskylebrooks/kairos/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Kairos is a local MCP server that gives the Claude desktop app access to your Apple data on macOS: Calendar, Reminders, Contacts, Notes, Mail and Music. It runs on your Mac only, talks to Claude over stdio, never opens a network port, and never needs Full Disk Access.

The point is care: Kairos reads by default, writes only where you allow it and only where it is safe, asks for your yes before it changes or deletes anything, keeps a log of every change it made so you can undo it, and handles the details other Apple MCP servers get wrong, such as all day events, reminders without a time, accents, deleted notes and repeating events.

> Version 0.11.0, tested on macOS 27 (Apple silicon). Version 1.0 follows once Kairos has its own EventKit helper (see the [roadmap](docs/ROADMAP.md)).

## What you can ask Claude

- "What's on my calendar this week?" or "Move the dentist to Thursday at 3."
- "Which reminders are overdue?" or "Remind me tomorrow to call Ada."
- "Whose birthday is coming up?"
- "Find my note about the trip and add a packing checklist to it."
- "Any unread mail from Ada? Draft a reply that says yes."
- "What did I listen to most last month?" (with the Music play log on)
- "What did you change today?" and "Undo that."

## Install

**You need:** macOS 27 (other versions may work, but Notes formatting relies on features that change between releases), the Claude desktop app, and the Shortcuts app (built in).

**1. Get Kairos.** Either with git:

```bash
git clone https://github.com/itskylebrooks/kairos.git ~/kairos
```

or without git: on GitHub click **Code**, then **Download ZIP**, unzip it, and move the folder to a place where it can stay, for example your home folder. Claude starts Kairos from this folder, so do not move it after installing (if you do, run the installer again from the new place).

**2. Run the installer** in Terminal, from that folder:

```bash
cd ~/kairos && ./install.sh
```

It downloads a private Node.js 24 and the EventKit helper (both checksum verified), builds three Kairos shortcuts for Notes and opens them (click **Add Shortcut** for each), runs a self test, asks which apps Kairos may write to and whether to keep a Music play log, backs up Claude's config and adds one `kairos` entry, and finally runs the health check (see Troubleshooting), during which macOS asks for the permissions Kairos needs. Answer a question with `y` and Enter for yes, or just Enter for no.

**3. Quit Claude completely** (Cmd+Q, closing the window is not enough) and open it again.

Running the installer again is safe: it skips what is installed and keeps your earlier answers. Options:

| Option | Effect |
|---|---|
| `--write notes,calendar,reminders,mail` | Which apps may write, without asking (`all` or `none` also work); for Mail, writing means drafts only |
| `--music-log on` / `--music-log off` | Switch the Music play log on or off without asking |
| `--dry-run` | Show what would change, change nothing |

**Result size (optional):** one result holds at most 20,000 characters; larger ones come in parts. To change that, quit Claude, add `"KAIROS_MAX_RESULT_CHARS": "40000"` (any number from 5,000 to 100,000) to the `env` of the `kairos` entry in `~/Library/Application Support/Claude/claude_desktop_config.json`, and open Claude again. The installer keeps this setting.

### Permission prompts

The first time Kairos uses an app (usually during the installer's health check), macOS asks once:

- **Notes, Contacts, Mail, Music, Calendar list:** "… wants to control …". Allow it.
- **Calendar and Reminders events:** the EventKit helper (`event`) asks for access to Calendars and Reminders. Allow it.
- **Kairos shortcuts:** the first run of each Kairos shortcut asks for access to Notes, sometimes once per step ("save in a note", "append to a note", "output text"), and again when another app such as Spokenly runs the shortcut for the first time. Choose **Always Allow** each time; after that they stay quiet. You can review this in the Shortcuts app, in each shortcut's privacy settings.

If a Shortcuts window ever asks you to **pick a note or type text**, click **Cancel**: Kairos never needs that, and it would mean something went wrong.

## Tools

| App | Read | Write (if allowed) |
|---|---|---|
| Calendar | `calendar_calendars`, `calendar_read` | `calendar_create`, `calendar_update`, `calendar_delete` |
| Reminders | `reminders_lists`, `reminders_read` | `reminders_create`, `reminders_update`, `reminders_complete`, `reminders_delete` |
| Contacts | `contacts_search`, `contacts_birthdays` | none |
| Notes | `notes_folders`, `notes_list`, `notes_search`, `notes_read` | `notes_create`, `notes_append`, `notes_move`, `notes_replace` |
| Mail | `mail_mailboxes`, `mail_unread`, `mail_search`, `mail_read` | `mail_create_draft` (never sends) |
| Music | `music_now`, `music_played`, `music_top`, `music_search`, `music_playlists`, `music_history_status`, `music_history_top`, `music_history_timeline` | none |
| Kairos | `kairos_activity`, `kairos_health` | `kairos_undo` (when any app may write) |

Limits worth knowing:

- **Repeating events** cannot be changed or deleted through Kairos yet (the EventKit helper would change the first occurrence). Change those in Calendar.
- **Clearing a field** (an event's location, a reminder's notes) is not possible yet; replacing it with new text is.
- **Mail** must be running (Kairos never opens it). Search looks at subject, sender and recipients within a date range (default the last 30 days), not inside message bodies, and leaves out trash and junk unless asked. Reading returns plain text without quoted history and signatures, in parts of 8,000 characters. Creating a draft shows a Mail window for a moment; replies keep the conversation thread and quote the original.
- **Notes** are written through Shortcuts so Notes itself turns Markdown into real headings, checklists and tables. Block quotes and inline code lose their styling. Kairos only changes notes whose title is unique, and `notes_replace` keeps a private backup of the old text in `~/Library/Application Support/Kairos/backups/notes/`. Writing into a shared note or folder needs your explicit agreement, since other people can read it; replacing a shared note, or a note in a shared folder, is refused. Long notes are read in parts.
- **Large results come in parts.** One result holds at most 20,000 characters, so Claude's context does not fill up with a year of events at once. Lists are split between whole items (events, notes, messages, songs), and one long text, such as a note or an email, is split by characters. Claude asks for the next part only when it needs it.

## Activity log and undo

Kairos keeps a private log of every change it makes for Claude: what, when, and the state before and after. Ask Claude "what did you change this week?" (`kairos_activity`) or "undo that" (`kairos_undo`).

- **Undo is careful.** It shows a preview and needs your yes, like every change. It is refused when the item was changed after Kairos' change, so it never overwrites your own later edits, and an older change waits until later changes to the same item are undone.
- **What can be undone:** created events and reminders are deleted again, changed ones get their earlier values back, deleted ones are recreated (with a new id; event alerts are not restored), completed reminders are reopened, notes Kairos added to or replaced get their earlier text back from the private backup, a moved note goes back to its folder (unless it was moved again since), and a note Kairos created moves to Recently Deleted. Mail drafts are not undone (delete them in Mail), and changes the EventKit helper cannot reverse (clearing a field that was empty before) say why.
- **Private and short lived:** the log lives in `~/Library/Application Support/Kairos/activity/`, readable only by you, and keeps 90 days. It lists only changes made through Kairos, never edits you make in the apps.

## Dictation inbox (a recipe)

Press one key, speak, press it again: the text lands as a note in a Notes inbox, and a Claude routine sorts it later with Kairos' tools. Kairos needs no setup of its own for this.

**1. Folders.** In Notes, create a folder **Dictations** (the inbox) with a subfolder **Processed**.

**2. Shortcut.** In the Shortcuts app, make a shortcut **Save Dictation**. On macOS 27 you can describe it in plain words:

```
Create a shortcut named "Save Dictation" that receives text as input and is allowed to run from the command line. It should take the text it receives, put the line "Dictation" followed by the current date and time at the top, then a new line, then the received text exactly as it is. Then create a new note in the Notes app in the folder "Dictations" with that text, so the first line becomes the note's title. It must not ask me anything, not show any window or notification, and not output anything. If the received text is empty, do nothing.
```

Or build it by hand: let the shortcut receive **Text**, add a **Text** action with "Dictation", the **Current Date** and, on the next line, the **Shortcut Input**, then a **Create Note** action with that text in the folder **Dictations**. Check that the folder is fixed, not "Ask each time", or every dictation would open a picker. Any date format works; with the time included, several dictations a day stay apart.

**3. Spokenly.** Use the version from [spokenly.app](https://spokenly.app/download), not the Mac App Store one: that one is sandboxed, cannot run shortcuts, and is no longer updated.
- Create a separate mode for the inbox, for example **Kairos**, so your other modes still type into apps as before.
- Leave its AI instructions empty and set its **Pre-AI Script** to:
  ```
  shortcuts run "Save Dictation" --input-path -
  ```
  The script prints nothing, and a script that prints nothing inserts nothing: the text only lands in Notes. (With AI cleanup in the mode, use the Post-AI Script slot instead, and the note gets the cleaned text.) Spokenly's history keeps every recording, so nothing is lost if a save ever fails.
- Give the mode its own activation key, for example the **right Option key**: press to start, press again to stop, and the note appears.
- Instead of a key, a button: copy the mode's deeplink in Spokenly (`spokenly://toggle?mode_id=…`), put it into a one action shortcut (**Open URL**) and pin that to the menu bar or Control Center, or give it a keyboard shortcut.
- The first recordings make macOS ask whether "Save Dictation" may save to a note and output text: choose **Always Allow** each time; after that it stays quiet.

**4. Routine.** Set up a scheduled task in the Claude desktop app on this Mac (not a cloud routine: those cannot reach Kairos). Its prompt holds your own rules for sorting; Kairos holds none, it only provides the tools. For example, twice a day: read the notes in Dictations, decide for each whether it is a journal entry, a task (`reminders_create`), a draft (`notes_create`) or something to ask about, then file the original with `notes_move` into Dictations/Processed. Moving is one step, logged and undoable, so the routine can run on its own.

## Music play log

Apple Music keeps only each song's **total** play count and **last** play date, never a history. With the play log on, Kairos saves the play counts several times a day; the differences between snapshots become a listening history, so Claude can answer "what did I listen to yesterday" or "plays per week for one artist".

How it works:

- A background job (`~/Library/LaunchAgents/kairos.music-log.plist`) checks **every full hour, at login and after the Mac wakes up**. It takes the **first snapshot of each day** as soon as you use your Mac with Music open, and **another every hour** while Music is open. It **never opens Music**: if Music is closed, it tries again an hour later.
- Only changed play counts are stored, keyed by Music's persistent track ID, with a full baseline each month. A year of history is around a megabyte.
- Data lives in `~/Library/Application Support/Kairos/music/` (readable only by you). A short log with counts only, no song names, is in `~/Library/Logs/Kairos/music-log.log`.

What it cannot know, and says so in every answer:

- plays before logging started, and plays of songs that are **not in your library** (streamed without adding them),
- the exact time of each play: plays are known per interval between snapshots, and the day of each song's latest play is exact,
- plays from other devices arrive when they sync and are reported as `late_sync_plays`.

Turn it off with `./install.sh --music-log off`. Your saved history stays; delete the `music` folder above to remove it. You can also run a snapshot by hand:

```bash
runtime/node-kairos src/cli/music-log.js snapshot --force
runtime/node-kairos src/cli/music-log.js status
```

## Security

Everything below applies only to what Kairos' tools do for Claude. Kairos changes nothing in macOS or in other apps, and adds no background service except the Music play log you can opt into.

**What Kairos guarantees by itself**, whatever Claude is told:

- **No Full Disk Access, ever.** Kairos uses Apple's scripting and EventKit, which ask for each app separately. Mail data, for example, stays closed to it at the file level.
- **One private Node binary.** The installer downloads the official Node.js 24 (checksum verified) into `runtime/`, so macOS permissions belong to that binary, not to a Node that other programs share.
- **stdio only.** Nothing listens on a port, and Kairos makes no network calls while it runs.
- **Input never becomes code.** All scripts are fixed when Kairos starts and the registry is then sealed; your data reaches them only as JSON. Kairos can start only `osascript`, `shortcuts`, `launchctl` and its EventKit helper, never a shell.
- **Writes are opt in per app** (`--write`). Without it, an app's write tools do not exist for Claude.
- **Changes and deletes take two steps.** Any tool that changes, completes or deletes something first returns only a preview written by Kairos, plus a one time confirmation. The change happens only when Claude repeats the call with that confirmation, for exactly the same change, within 10 minutes. Creating things (events, reminders, notes, drafts) is one step.
- **Mail never sends.** There is no send tool, and a test checks that no Mail script can send.
- **No invitations.** Calendar events are created without attendees, so Kairos cannot send meeting invites.
- **Shared places need consent.** Writing into a shared note or folder is refused unless you agreed, because other people can read it. Replacing a shared note, or a note in a shared folder, is always refused.
- **Text from other people is marked.** Emails, events from read only calendars, shared notes and notes in shared folders come back flagged `from_others`, with invisible characters removed and their text fields listed as untrusted. Only your own mail in sent, drafts and outbox mailboxes is left unmarked: a sender address alone can be forged, so a message in your inbox that claims to be from you is still treated as someone else's.
- **Every change is logged and can be undone.** See "Activity log and undo" above.
- **Safety nets.** Notes are never deleted (undoing a note Kairos created moves it to Recently Deleted), `notes_replace` keeps a private backup, repeating events are never changed through Kairos, and no single result is larger than 20,000 characters: larger ones come in parts.

**What depends on Claude:** following the rule that text from others is data, and asking you before answering a preview with a confirmation. Kairos makes this as hard to get wrong as it can (Claude never sees a change happen without a preview step), but it cannot tell whether *you* said yes.

**Claude's approval prompts: your choice.** The Claude app can ask before every tool call, or you choose "Always allow" per tool. Kairos is built so that running it fully autonomously is a reasonable choice:

- **Fully autonomous** ("Always allow" for every Kairos tool): Claude reads, creates and changes without asking you each time. The safety nets above stay in place: Kairos still previews every change or delete in the chat first, Mail can never send or delete, and every change is logged and can be undone with "undo that". The remaining risk is text written by someone else (an email, an invitation) talking Claude into a change you did not want; you would see it in the activity log and undo it.
- **Middle ground:** "Always allow" for the reading and creating tools, and keep the prompt only for tools that change, complete or delete existing things (`*_update`, `*_delete`, `reminders_complete`, `notes_replace`, `kairos_undo`). Those are rare, so the prompt seldom appears.

macOS and the Shortcuts app ask their own questions once (see "Permission prompts"); those are separate from Claude's approvals.

**Known limits:** invitations someone else sent into one of your own calendars, and reminder lists shared with you, are not marked as `from_others` yet, because the EventKit helper does not report organizers or sharing. Kairos' own EventKit helper (planned) will fix this; see the [roadmap](docs/ROADMAP.md) for this and the other known limits.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Troubleshooting

**Start with the health check.** Ask Claude "is Kairos set up correctly?", or, if Kairos does not show up in Claude at all, run this in the Kairos folder:

```bash
runtime/node-kairos src/cli/health.js
```

It checks every enabled app's permissions, Kairos' Notes shortcuts, its private Node and EventKit helper, the settings, Claude's config entry and the Music play log, and says for each problem how to fix it. It only looks and changes nothing. Notes, Contacts and Calendar may open for a moment and close again; Mail and Music are never opened, so open them first if you want them checked. If macOS has not asked about a permission yet, its prompt appears during the check: allow it.

| Problem | What to do |
|---|---|
| Claude does not show Kairos' tools | Quit Claude with Cmd+Q (not just the window) and open it again. If they still do not appear, run `./install.sh` again and check that it ends with "Wrote the kairos entry". |
| "macOS hasn't allowed access to …" | Allow it in **System Settings > Privacy & Security**: under **Automation** for Notes, Contacts, Mail, Music and Calendar (the entry is `node-kairos`), under **Calendars** and **Reminders** for the EventKit helper (`event`). |
| Calendar or Reminders come back empty | The EventKit helper answers with empty lists while it has no permission. Check **Calendars** and **Reminders** in Privacy & Security. |
| "The shortcut … is not installed, or is installed twice" | Open the Shortcuts app, delete any duplicate **Kairos Notes** shortcuts, then run `./install.sh` again. |
| A Shortcuts window asks you to pick a note or type text | Click **Cancel**. Nothing is written without your choice, and Kairos never needs it. |
| Notes stops answering Kairos (a write times out, or the answer says Notes may be stuck) | Quit Notes (Cmd+Q) and open it again. Kairos waits for Notes to settle after its own writes, but a stuck Notes needs a restart. |
| "Mail is not running" | Open Mail. Kairos never opens it by itself. |
| You moved the Kairos folder | Run `./install.sh` again from the new place, then restart Claude. macOS may ask for permissions again. |
| Is the Music play log working? | `runtime/node-kairos src/cli/music-log.js status` shows the last snapshot and the last check. |

## Updating

```bash
cd ~/kairos && git pull && ./install.sh
```

(Without git: download the new ZIP, replace the folder's contents, keep `runtime/` and `vendor/`, and run the installer.) Then Cmd+Q Claude and reopen it. If a Kairos shortcut changed, delete the old one in the Shortcuts app first (importing over an existing name creates a duplicate), then run the installer.

## Uninstall

1. `./install.sh --music-log off` (if the play log is on).
2. Remove the `kairos` entry from `~/Library/Application Support/Claude/claude_desktop_config.json` while Claude is quit.
3. Delete the three **Kairos Notes** shortcuts in the Shortcuts app.
4. Delete this folder, and `~/Library/Application Support/Kairos/` if you do not want to keep backups, the activity log and play history.

## Roadmap

What comes next and which known limits each step removes: [docs/ROADMAP.md](docs/ROADMAP.md). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## Development

Plain Node 24, ESM, no runtime dependencies, no build step. `npm test` runs the test suite in fake mode against invented fixtures in temporary folders; it never touches your data. `npm run typecheck` checks the JSDoc types with TypeScript (a development dependency only). Both run on GitHub for every push. See `CLAUDE.md` for the rules and the platform quirks found so far.

## Credits

- Calendar and Reminders go through the `event` EventKit helper from [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events) (MIT), downloaded by the installer and pinned by checksum. Kairos will replace it with its own helper.
- How to drive Notes' App Intents through generated Shortcuts was learned from [eliotshea/notes-mcp](https://github.com/eliotshea/notes-mcp) and, for macOS 27, [iangray001/applenotes-mcp](https://github.com/iangray001/applenotes-mcp).

## License

[MIT](LICENSE), copyright 2026 Kyle Brooks.
