# Changelog

## Unreleased

**Docs**
- The dictation routine in the README also carries out spoken commands: a dictation that starts with "Claude" is done with Kairos' tools at the next run; any other dictation is never treated as a command.

## 0.15.0 (2026-10-05)

**A limit on removals**
- Kairos now removes at most 20 items per hour: notes deleted, events and reminders deleted, mail moved to the Trash. A call that would go over is refused by the Kairos server before anything happens, so a confused or fooled Claude cannot remove more, whatever it was told. The count comes from the activity log, so a restart or a new chat does not reset it. Creating, moving, archiving and marking are not counted, and undo is never limited.
- The limit is fixed in Kairos' code on purpose, not a setting Claude could change. The health check shows it and how many removals the last hour holds. The dictation routine prompt in the README stops at the limit and leaves the rest for its next run.
- README: a scheduled task gets no folder or an empty one of its own, never the Kairos folder, so it can only use Kairos' tools and never change Kairos' own files.

## 0.14.0 (2026-10-05)

**Mail housekeeping**
- New tools `mail_trash`, `mail_archive` and `mail_mark`: move 1 to 10 messages, by id, to their account's own Trash or Archive, or mark them read or unread. Never a permanent delete: nothing empties the Trash, and no Mail script can delete a message (a test checks this). Every call is logged; `kairos_undo` moves the messages back or sets their read state back. They follow the previews setting: a preview first when it is on, at once when it is off.
- Each account's real Trash is taken from Mail's combined Trash, so an account with both "Trash" and "Deleted Messages" is never guessed; an account without exactly one Archive mailbox is refused.
- Moved messages get new ids, which the result lists; undo finds them by their Message-ID. Undo of a move waits until the move is a minute old, because moving straight back can leave a copy behind on IMAP servers.

**Fixes**
- **Mail:** search no longer lists the leftover copies a move leaves behind on IMAP accounts (flagged deleted, until the server cleans them up).

## 0.13.0 (2026-10-05)

**Previews are now a setting**
- New setting `KAIROS_CONFIRM` (installer: `./install.sh --confirm off`). On, the default, works as before: changes and deletes show a preview and wait for your yes. Off: they act at once, in one step, and Claude reports afterwards what changed. Everything else stays: every change is logged and can be undone, nothing is deleted permanently, shared places need agreement, and text from others is still marked as data.
- The installer asks once when some app may write, and keeps the answer; the health check shows the setting; Claude's instructions and the tool descriptions follow it.

## 0.12.1 (2026-10-05)

**Fixes**
- **Notes:** folder names with emoji were found only when typed exactly, including the invisible variation selector many emoji carry. Kairos now also finds "🎙️ Dictations" as "🎙 Dictations" or "Dictations", as long as that is unique; two folders that differ only by emoji are never guessed.

## 0.12.0 (2026-10-05)

**Notes**
- New tool `notes_trash`: moves one note, by id, to Recently Deleted. Never a permanent delete: Notes keeps it there for 30 days, the change is logged, and `kairos_undo` puts it back in its folder. One step, like moving, so a routine can delete processed notes on its own. Refused for locked notes; shared notes need agreement.

**Dictation inbox**
- The README recipe now needs one folder, Dictations: the routine deletes each processed dictation, and journal dictations become notes titled "Journal …" that an iPhone automation turns into Journal entries (Journal has no Shortcuts action on macOS 27).

**Shortcuts renamed**
- Kairos' shortcuts are now named "Kairos: Create Note", "Kairos: Append to Note" and "Kairos: Read Note". To update: run `./install.sh` and click Add Shortcut for each, then delete the old "Kairos Notes Create", "Kairos Notes Append" and "Kairos Notes Read" in the Shortcuts app (the installer and the health check point out any that are left). macOS asks "Always Allow" once more for the new ones.

**Fixes**
- **Notes:** a folder created moments ago was reported as unknown for up to a minute (Kairos keeps the folder list for 60 seconds). An unknown folder name now reads the list again once before giving up.

## 0.11.0 (2026-10-05)

**Notes**
- New tool `notes_move`: moves a note to another folder of the same account, by id. One step like creating, because nothing is lost: the move is logged and `kairos_undo` moves the note back (refused when it was moved again since). Refused for Recently Deleted and between accounts; shared places need agreement.

**Dictation inbox**
- A recipe in the README: Spokenly saves each recording into a Notes inbox through your own shortcut, and a Claude routine on the Mac sorts the inbox with Kairos' tools and files each original with `notes_move`. Kairos needs no setup of its own for it.

## 0.10.0 (2026-10-05)

**Health check**
- New tool `kairos_health`: ask Claude "is Kairos set up correctly?". It checks every enabled app's macOS permissions (Automation, Calendars, Reminders), Kairos' Notes shortcuts and their access to Notes, the private Node and the EventKit helper (against its pinned checksums), the settings, the privacy of Kairos' folders, and the Music play log, and gives a fix in plain words for each problem.
- The same check in the terminal, for when Kairos does not show up in Claude: `runtime/node-kairos src/cli/health.js`. It also checks Claude's config entry, and runs exactly as Kairos does under Claude, so permissions are checked for Kairos, not for Terminal.
- The installer runs it as its last step; macOS asks for missing permissions there.
- It only looks: Notes, Contacts and Calendar may open briefly and close again, Mail and Music are never opened, and the report holds no personal data.

**Changes**
- **Music play log:** a snapshot every hour while Music is open (before: every 3 hours), so the history knows more closely when songs were played. Only changed play counts are stored, so the log stays small.

**Fixes**
- **Notes:** the "Kairos Notes Read" shortcut waited for a person (a Shortcuts window) when no note matched the title, which could happen while `notes_replace` waited for a renamed note. It now reads a note only when exactly one matches. To update: delete "Kairos Notes Read" in the Shortcuts app, then run `./install.sh` and click Add Shortcut.
- **Music play log:** the background job skipped its hourly check when the hour fell into sleep, so after a nap the log could go hours without a check. It now runs every full hour and catches up once after the Mac wakes. Run `./install.sh` to update the job.

## 0.9.2 (2026-10-04)

**Large results come in parts**
- One result now holds at most 20,000 characters (before: 100,000), so a single answer no longer fills Claude's context. Change it with `KAIROS_MAX_RESULT_CHARS` (5,000 to 100,000) in the Claude config; the installer keeps that setting.
- A larger read result is no longer refused: it comes in parts. Lists are split between whole items (events, notes, messages, tracks), never inside one. One long text (a note, an email body, or a single oversized item in a list) is split by characters, at a line break where possible, and the result says so.
- Each part carries `paging` (what is paged, total, offset, returned, `has_more`) and a `cursor`; every read tool takes `cursor` to fetch the next part, only when Claude needs it.
- Sizes count characters as Claude receives them, so Cyrillic and other non Latin text counts one per character, not per byte; emoji are never cut in half.
- A finished write is still always reported as done, never hidden by the size limit.
- `notes_read` returns 12,000 characters of Markdown per part by default (before: 20,000), so a default part fits.

## 0.9.1 (2026-10-04)

Fixes from a security and bug review.

**Safety**
- **Mail:** a message is treated as your own only when it lies in a sent, drafts or outbox mailbox. Before, a forged sender address was enough for a message to skip the `from_others` marking.
- **Mail drafts:** each recipient entry is checked as a whole, so one entry can no longer carry a second, unchecked address; `from` must be one of your account addresses.
- **Invisible text:** Unicode tag characters (invisible copies of ASCII that a model still reads) and the Arabic letter mark are removed from text written by others.
- **Notes:** notes in a shared folder count as shared: they are marked `from_others`, and `notes_replace` refuses them.
- **Calendar:** an event id that stands for several occurrences is refused like a repeating event.
- **Arguments:** names such as `constructor` or `__proto__` no longer pass as known arguments.

**Bugs**
- **Calendar:** an all day event of several days was missing when only its last day was read; moving such an event across a clock change could shorten it by a day.
- **Notes and Music:** a bare `modified_until` or `until` date now includes that day, as everywhere else.
- **Dates:** times such as 18:75 or 24:00 are refused instead of rolling over.
- **Server:** when a finished write returns too much text, the result says the change was made, instead of an error that invites a repeat. A tool's own note is kept when the warning about text from others is added.

## 0.9.0 (2026-10-04)

The first public version. Tested on macOS 27 (Apple silicon).

**Apps**
- **Calendar:** list calendars, read events (all day events and time zones handled exactly), create, change and delete events by id. Repeating events are read but never changed.
- **Reminders:** list lists, read reminders with overdue computed by Kairos, create, change, complete and delete by id.
- **Contacts:** search (every word, accents ignored) and upcoming birthdays.
- **Notes:** folders, list and search (Recently Deleted left out), read as Markdown with checklist state, create, append and replace with real formatting through Kairos' own shortcuts.
- **Mail:** mailboxes, unread counts, search by subject, sender and recipients within a date range, read as plain text in parts, drafts and replies that are never sent.
- **Music:** now playing, recently played, most played, search, playlists, plus an opt in play log that turns play counts into a listening history.

**Safety**
- No Full Disk Access, stdio only, no network calls, a private Node binary that holds all macOS permissions.
- Writes opt in per app; changes and deletes take two steps with a preview and a one time confirmation.
- Text from other people marked and cleaned; results capped at 100,000 characters.
- Scripts fixed at startup, programs limited to an allowlist, never a shell.
- Writing into shared notes needs consent.
- An activity log of every change, kept 90 days, with a careful undo.

**Installer**
- One command: private Node.js 24 and the EventKit helper (both checksum verified), the Kairos shortcuts, a self test, write permissions per app, the optional play log, and the Claude config entry with a backup.

**Known limits** are listed in the [roadmap](docs/ROADMAP.md); most go away with Kairos' own EventKit helper, planned for 1.0.
