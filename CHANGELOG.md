# Changelog

## Unreleased

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
