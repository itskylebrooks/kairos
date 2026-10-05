# Changelog

## Unreleased

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
