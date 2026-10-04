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

## Next

### Day view across all apps
One tool for "what happened on September 12": the day's events, completed reminders, notes you edited, songs you played (from the play log) and, later, photos, merged into one timeline. Every app alone is a list; together they are a diary you did not have to write. Useful as context for a journal entry, but only when you ask for it.

### Free time finder
"When do I have two free hours next week?" across all calendars, with rules you set once, for example "training evenings are blocked" or "nothing before 9 on Fridays". Mostly date math on data Kairos already reads.

### Kairos' own EventKit helper (1.0)
A small Swift binary built from this repo, replacing the third party helper (`mcp-server-apple-events` 1.5.0) before the project is advertised. It removes these known limits:
- **Invitations from others** in your own calendars are not marked `from_others`: the current helper does not report organizers or attendees.
- **Reminder lists shared with you** are not marked `from_others`: the current helper does not report sharing.
- **Repeating events** cannot be changed or deleted: the current helper can only address the first occurrence.
- **Clearing a field** (an event's location or notes, a reminder's notes or URL) is impossible: the current helper rejects empty values.
- **Reminder flags** can only be read: setting them needs a third party shortcut.
- **Calendars are addressed by name**, so writes need unique calendar names: the current helper reports no calendar ids.
- **Day only reminders** get a hidden start date one hour earlier (harmless, but untidy).
- The helper also contains a network sync command that Kairos never calls; our own binary will not have it at all.

## Later

- **Music, additive writes:** create a playlist, add library songs, control playback. Never delete.
- **Music play log backfill:** import the play history from the privacy.apple.com data export, so the log reaches back before logging started.
- **Notes checklist ticking:** ticking a single checklist item needs a Notes action that Shortcuts on macOS 27 refuses to import; revisit with each macOS release.
- **Mail body search:** today search covers subject, sender and recipients only. Searching bodies would mean reading every message; only worth it as a capped option.

## Out of scope

- **Messages:** needs Full Disk Access, which Kairos never asks for.
- **Safari history, Maps:** no safe or useful scripting interface.
- **A copy of the mail index or any other Apple database:** Kairos reads what Apple already indexes and keeps no second copy (the play log stores only play counts, which Apple does not keep).
