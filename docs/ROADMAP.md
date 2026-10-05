# Kairos roadmap

What is done, what comes next, and the known limits each step removes. Kept current with every change; see the README for what Kairos does today.

## Done

- **Notes:** read as Markdown with checklist state, create, append and replace with real formatting through Kairos' own shortcuts.
- **Calendar and Reminders:** read, create, change, complete and delete, through the EventKit helper.
- **Contacts:** search and upcoming birthdays.
- **Music:** live tools, plus the opt in play log that turns play counts into a listening history.
- **Mail:** search, read, unread counts and drafts that are never sent.
- **Safety core:** text from others marked and cleaned, registered scripts only, allowed programs only, consent for shared places, previews and one time confirmations for every change or delete.
- **Activity log with undo:** a private log of every change Kairos makes, kept 90 days, with "what did Claude change" and a careful undo that never overwrites later edits.
- **Release prep (0.9.0):** MIT license, README for people who are not developers, changelog, security policy, type checking and CI.
- **Health check (0.10):** `kairos_health` and a terminal command say which permissions or parts are missing and how to fix each, in plain words; the installer runs it as its last step.
- **Notes move and dictation inbox (0.11):** `notes_move` moves a note to another folder in one step, logged and undoable, so a routine can file processed notes. Dictation itself needs nothing from Kairos: Spokenly saves each recording into a Notes inbox through your own shortcut, and a Claude routine on the Mac sorts the inbox with Kairos' tools (recipe in the README).
- **Notes trash and a one folder dictation inbox (0.12):** `notes_trash` moves a note to Recently Deleted in one step (kept 30 days, logged, undoable), so a routine can delete processed dictations. Journal dictations become "Journal …" notes that an iPhone automation turns into Journal entries (README recipe).

## Next

Planned as small releases, in this order. Sizes: S (a day or two), M (about a week), L (several weeks). Each milestone lists what it needs first.

### Open questions (short experiments)

Answered before the features that depend on them are built, so their design rests on facts:
- **Own EventKit helper:** how is a Swift binary signed and delivered, and does each Mac need Xcode to build it? (Decides how 1.0 is installed.)
- **Notes images:** can a file be attached to a note through a Kairos shortcut without a window? (Only if cheap; the feature itself is under Later.)

Answered: **Spokenly** (2026-10-05). The direct download of Spokenly runs a script per mode with the transcript, and a script that prints nothing inserts nothing, so a recording can go straight into Notes through a shortcut. The Mac App Store version is sandboxed and cannot run shortcuts, and it is no longer updated. One inbox turned out simpler than routing by mode: see the dictation inbox recipe in the README.

### Save to Apple Journal (S), blocked on macOS 27
A tool `journal_create` (text, title, date, bookmark) through one Kairos shortcut with Journal's "Create Entry" action, so a routine can turn dictations into journal entries directly. Write only: Journal offers no way to read or delete entries, so such a change could not be undone.

**Blocked** (checked 2026-10-05, Journal 3.0): on macOS 27 Journal still declares "Create Entry" (text, title, date, bookmark, place, media) but without a name, so Shortcuts on the Mac shows no Journal action and refuses to import one ("not supported on this device"). On macOS 26 it was available. Journal has no AppleScript support, its `moments://` links only open the app and its settings, and its data is protected (it would need Full Disk Access, which Kairos never asks for) and encrypted. Until the action returns: journal entries wait in Dictations as notes titled "Journal …", and an iPhone automation turns them into Journal entries (README recipe). Re-check after each macOS 27 update.

### 0.13 See your time

#### Day view across all apps (M)
One tool for "what happened on September 12": the day's events, completed reminders, notes you edited, songs you played (from the play log) and, later, photos, merged into one timeline. Every app alone is a list; together they are a diary you did not have to write. Useful as context for a journal entry, but only when you ask for it.

#### Free time finder (S to M)
"When do I have two free hours next week?" across all calendars, with rules you set once, for example "training evenings are blocked" or "nothing before 9 on Fridays". Mostly date math on data Kairos already reads.

*Needs:* nothing new; both share the calendar reading and date code. The day view gets richer the longer the Music play log has been running.

### 0.14 Mail housekeeping (M)
Three new Mail write tools: move to Trash, archive, and mark as read or unread. Mail writes stay opt in through the existing write setting for Mail.
- **Never a permanent delete.** No tool empties the Trash or deletes a message outright. Messages only move, so they can always be found again in Mail (until Mail's own setting for erasing deleted messages removes them from the Trash).
- **Two steps and undo, like every change.** Each call shows Kairos' preview and needs a one time confirmation, and goes into the activity log. Undo moves a message back to its original mailbox, or flips read back to unread (and the other way). Undo refuses when the message was moved or changed since.
- **Small and exact.** At most 10 messages per call, addressed by id only, never by a search query.
- **Only on your word.** Acting on a message because text written by someone else asks for it (an email saying "delete this" or "archive your inbox") is refused, unless you named that message yourself in the chat. Kairos cannot see who asked for a call, so this rule lives in Kairos' instructions and the tool descriptions; the preview and its confirmation are the check you see.
- **Archive** uses the account's own archive mailbox and refuses when an account has none, rather than guessing.

*Needs:* the move, undo and preview patterns proven in 0.11.

### 1.0 Kairos' own EventKit helper (L)
A small Swift binary built from this repo, replacing the third party helper (`mcp-server-apple-events` 1.5.0) before the project is advertised. It removes these known limits:
- **Invitations from others** in your own calendars are not marked `from_others`: the current helper does not report organizers or attendees.
- **Reminder lists shared with you** are not marked `from_others`: the current helper does not report sharing.
- **Repeating events** cannot be changed or deleted: the current helper can only address the first occurrence.
- **Clearing a field** (an event's location or notes, a reminder's notes or URL) is impossible: the current helper rejects empty values.
- **Reminder flags** can only be read: setting them needs a third party shortcut.
- **Calendars are addressed by name**, so writes need unique calendar names: the current helper reports no calendar ids.
- **Day only reminders** get a hidden start date one hour earlier (harmless, but untidy).
- The helper also contains a network sync command that Kairos never calls; our own binary will not have it at all.

*Needs:* the EventKit answer above. This closes the last safety gap (invitations and shared reminder lists from others not marked), so it comes before Kairos is advertised.

## Later

- **Music, additive writes:** create a playlist, add library songs, control playback. Never delete.
- **Music play log backfill:** import the play history from the privacy.apple.com data export, so the log reaches back before logging started.
- **Notes checklist ticking:** ticking a single checklist item needs a Notes action that Shortcuts on macOS 27 refuses to import; revisit with each macOS release.
- **Permissions per AI app:** if Kairos is ever used by several AI apps at once, each could get its own set of apps and write rights. Today this already works by giving each app its own `kairos` entry with its own `KAIROS_APPS` and `KAIROS_WRITE`. The name an app reports when it connects is self declared, not proven, so it must never widen rights, only narrow them.
- **Notes, attach images from files on the Mac:** add an image file (for example a photo or screenshot) to a new or existing note. To test on macOS 27: whether Notes' App Intents through a Kairos shortcut can attach a file without opening a window. Only image files, with a size limit, and only files you name in the chat, so a note can never become a way to copy other files off the Mac; attaching into a shared note needs your agreement like any shared write.
- **Mail body search:** today search covers subject, sender and recipients only. Searching bodies would mean reading every message; only worth it as a capped option.

## Out of scope

- **Messages:** needs Full Disk Access, which Kairos never asks for.
- **Safari history, Maps:** no safe or useful scripting interface.
- **A copy of the mail index or any other Apple database:** Kairos reads what Apple already indexes and keeps no second copy (the play log stores only play counts, which Apple does not keep).
