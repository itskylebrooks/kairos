# Kairos

Kairos is a local MCP server that gives the Claude desktop app access to your Apple data on macOS: Calendar, Reminders, Contacts, Notes, Mail and Music. It runs on your Mac only, talks to Claude over stdio, never opens a network port, and never needs Full Disk Access.

The point is care: Kairos reads by default, writes only where you allow it and only where it is safe, and handles the details other Apple MCP servers get wrong, such as all day events, reminders without a time, accents, deleted notes and repeating events.

> Status: in development, tested on macOS 27 (Apple silicon). A release build is still to come.

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
- **Shared places need consent.** Writing into a shared note or folder is refused unless you agreed, because other people can read it. Replacing a shared note is always refused.
- **Text from other people is marked.** Emails not sent by you, events from read only calendars and shared notes come back flagged `from_others`, with invisible characters removed and their text fields listed as untrusted.
- **Every change is logged and can be undone.** See "Activity log and undo" below.
- **Safety nets.** Notes are never deleted (undoing a note Kairos created moves it to Recently Deleted), `notes_replace` keeps a private backup, repeating events are never changed through Kairos, and no result can exceed 100,000 characters.

**What depends on Claude:** following the rule that text from others is data, and asking you before answering a preview with a confirmation. Kairos makes this as hard to get wrong as it can (Claude never sees a change happen without a preview step), but it cannot tell whether *you* said yes.

**Our advice:** leave the Claude app's approval prompt **on** for Kairos' write tools, and do not choose "Always allow" for them. That prompt is a second check that only you can answer.

**Known limits:** invitations someone else sent into one of your own calendars, and reminder lists shared with you, are not marked as `from_others` yet, because the EventKit helper does not report organizers or sharing. Kairos' own EventKit helper (planned) will fix this; see the [roadmap](docs/ROADMAP.md) for this and the other known limits.

## Requirements

- macOS 27 (other versions may work, but Notes formatting depends on Notes features that change between releases)
- The Claude desktop app
- The Shortcuts app (built in)

## Install

```bash
git clone https://github.com/itskylebrooks/kairos.git
cd kairos
./install.sh
```

The installer:

1. installs a private Node.js 24 in `runtime/` (checksum verified),
2. installs the EventKit helper for Calendar and Reminders in `vendor/eventkit/` (pinned by checksum),
3. builds three Kairos shortcuts for Notes and opens them: click **Add Shortcut** for each,
4. runs a self test,
5. asks which apps Kairos may write to, backs up Claude's config and adds one `kairos` entry,
6. asks whether to keep a Music play log (see below).

Then quit Claude completely (Cmd+Q) and open it again.

Options:

| Option | Effect |
|---|---|
| `--write notes,calendar,reminders,mail` | Which apps may write, without asking (`all` or `none` also work); for Mail, writing means drafts only |
| `--music-log on` / `--music-log off` | Switch the Music play log on or off without asking |
| `--dry-run` | Show what would change, change nothing |

Running the installer again is safe: it skips what is installed and keeps your earlier answers.

### Permission prompts

The first time Kairos uses an app, macOS asks once:

- **Notes, Contacts, Mail, Music, Calendar list:** "… wants to control …". Allow it.
- **Calendar and Reminders events:** the EventKit helper (`event`) asks for access to Calendars and Reminders. Allow it.
- **Kairos shortcuts:** the first run of each Kairos shortcut asks for access to Notes. Choose **Always Allow**.

If a Shortcuts window ever asks you to **pick a note or type text**, click **Cancel**: Kairos never needs that, and it would mean something went wrong.

## Tools

| App | Read | Write (if allowed) |
|---|---|---|
| Calendar | `calendar_calendars`, `calendar_read` | `calendar_create`, `calendar_update`, `calendar_delete` |
| Reminders | `reminders_lists`, `reminders_read` | `reminders_create`, `reminders_update`, `reminders_complete`, `reminders_delete` |
| Contacts | `contacts_search`, `contacts_birthdays` | none |
| Notes | `notes_folders`, `notes_list`, `notes_search`, `notes_read` | `notes_create`, `notes_append`, `notes_replace` |
| Mail | `mail_mailboxes`, `mail_unread`, `mail_search`, `mail_read` | `mail_create_draft` (never sends) |
| Music | `music_now`, `music_played`, `music_top`, `music_search`, `music_playlists`, `music_history_status`, `music_history_top`, `music_history_timeline` | none |
| Kairos | `kairos_activity` | `kairos_undo` (when any app may write) |

Limits worth knowing:

- **Repeating events** cannot be changed or deleted through Kairos yet (the EventKit helper would change the first occurrence). Change those in Calendar.
- **Clearing a field** (an event's location, a reminder's notes) is not possible yet; replacing it with new text is.
- **Mail** must be running (Kairos never opens it). Search looks at subject, sender and recipients within a date range (default the last 30 days), not inside message bodies, and leaves out trash and junk unless asked. Reading returns plain text without quoted history and signatures, in parts of 8,000 characters. Creating a draft shows a Mail window for a moment; replies keep the conversation thread and quote the original.
- **Notes** are written through Shortcuts so Notes itself turns Markdown into real headings, checklists and tables. Block quotes and inline code lose their styling. Kairos only changes notes whose title is unique, and `notes_replace` keeps a private backup of the old text in `~/Library/Application Support/Kairos/backups/notes/`. Writing into a shared note or folder needs your explicit agreement, since other people can read it; replacing a shared note is refused. Long notes are read in parts.

## Activity log and undo

Kairos keeps a private log of every change it makes for Claude: what, when, and the state before and after. Ask Claude "what did you change this week?" (`kairos_activity`) or "undo that" (`kairos_undo`).

- **Undo is careful.** It shows a preview and needs your yes, like every change. It is refused when the item was changed after Kairos' change, so it never overwrites your own later edits, and an older change waits until later changes to the same item are undone.
- **What can be undone:** created events and reminders are deleted again, changed ones get their earlier values back, deleted ones are recreated (with a new id; event alerts are not restored), completed reminders are reopened, notes Kairos added to or replaced get their earlier text back from the private backup, and a note Kairos created moves to Recently Deleted. Mail drafts are not undone (delete them in Mail), and changes the EventKit helper cannot reverse (clearing a field that was empty before) say why.
- **Private and short lived:** the log lives in `~/Library/Application Support/Kairos/activity/`, readable only by you, and keeps 90 days. It lists only changes made through Kairos, never edits you make in the apps.

## Music play log

Apple Music keeps only each song's **total** play count and **last** play date, never a history. With the play log on, Kairos saves the play counts several times a day; the differences between snapshots become a listening history, so Claude can answer "what did I listen to yesterday" or "plays per week for one artist".

How it works:

- A background job (`~/Library/LaunchAgents/kairos.music-log.plist`) checks **every hour and at login**. It takes the **first snapshot of each day** as soon as you use your Mac with Music open, and **another every 3 hours** while Music is open. It **never opens Music**: if Music is closed, it tries again an hour later.
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

## Updating

```bash
git pull
./install.sh
```

Then Cmd+Q Claude and reopen it. If a Kairos shortcut changed, delete the old one in the Shortcuts app first (importing over an existing name creates a duplicate), then run the installer.

## Uninstall

1. `./install.sh --music-log off` (if the play log is on).
2. Remove the `kairos` entry from `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. Delete the three **Kairos Notes** shortcuts in the Shortcuts app.
4. Delete this folder, and `~/Library/Application Support/Kairos/` if you do not want to keep backups and play history.

## Roadmap

What comes next and which known limits each step removes: [docs/ROADMAP.md](docs/ROADMAP.md).

## Development

Plain Node 24, ESM, no dependencies, no build step. `npm test` runs the test suite against invented fixtures only; it never touches your data. See `CLAUDE.md` for the rules and the platform quirks found so far.
