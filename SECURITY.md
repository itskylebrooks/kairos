# Security

Kairos reads and changes personal data, so security problems matter more than features.

## Reporting a problem

Please report security problems privately through GitHub: on this repository, open **Security**, then **Report a vulnerability**. Do not open a public issue for them.

Helpful to include: the macOS version, the Kairos version, what you did, what happened, and what you expected. Never include real personal data (calendar events, notes, mail and so on); invented examples are enough.

You get an answer within a week. Fixes are released as soon as they are ready, and credited to you if you wish.

## What counts

Anything that breaks the promises in the README's Security section, for example:

- a tool that changes or deletes something without the two step confirmation,
- text from an email, invite or shared note that makes Kairos run code or change data,
- a way to make Kairos send mail, open a network connection or start a program outside its allowlist,
- Kairos data (activity log, backups, play log) readable by other users,
- a write that lands somewhere other than the item Kairos was asked to change.

Claude following instructions hidden in third party text is a known risk that Kairos reduces but cannot remove on its own; reports of ways Kairos could reduce it further are welcome too.

## Supported versions

Only the latest version gets fixes.
