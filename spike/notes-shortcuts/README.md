# Notes Shortcuts spike

Proves (or disproves) the route for formatted Notes writes on macOS 27: generated Shortcuts that call Notes' App Intents with Markdown. Findings go to `docs/notes-spike.md`.

All test content here is invented. Generated files land in `out/`, which is not committed.

## Phases

1. **A, build:** `node spike/notes-shortcuts/build.js` writes unsigned `Kairos Spike *.shortcut` plists to `out/`. Touches nothing.
2. **B, install:** sign each with `shortcuts sign --mode anyone`, open it, click "Add Shortcut".
3. **C, run:** every write goes to new notes named `Kairos Spike <timestamp>` in the iCloud folder "Kairos Test". Inputs go in as JSON via `shortcuts run <name> -i in.json -o out.txt`.
4. **D, clean up:** spike notes go to Recently Deleted; the spike shortcuts are removed by hand in Shortcuts.app (the CLI cannot delete).

## Shortcuts

| Name | Input | Output | Question |
|---|---|---|---|
| Kairos Spike Echo | `{text}` | the text | input stays data |
| Kairos Spike Create | `{name, markdown, folder}` | the new Note entity | Markdown fidelity, folder param, id read back |
| Kairos Spike Append | `{name, markdown, section}` | the Note entity | append Markdown, section, keeps checklists |
| Kairos Spike Find | `{name}` | up to 2 Note entities | duplicates, Recently Deleted |
| Kairos Spike Props | `{name}` | labelled properties | property names on 27, body with checklist state |

`sample.md` is the Markdown fidelity test.
