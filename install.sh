#!/bin/bash
# Kairos installer: a local MCP server that gives the Claude desktop app access to Apple
# data on this Mac. stdio only, no network at runtime, no Full Disk Access.
#
#   ./install.sh               install or update, then write the "kairos" entry in Claude's config
#   ./install.sh --dry-run     show the config change without writing anything
#   ./install.sh --write LIST  set which apps may write, e.g. notes,calendar (or all, or none)
#   ./install.sh --config F    use another Claude config file (for testing)
#
# Safe to run again: it skips what is already there and backs up the config before editing it.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PRIVATE_NODE="$DIR/runtime/node-kairos"
NODE_DIST="https://nodejs.org/dist/latest-v24.x"
SERVER="$DIR/src/server.js"
SHORTCUTS_DIR="$DIR/build/shortcuts"
NOTES_SHORTCUTS=("Kairos Notes Create" "Kairos Notes Append" "Kairos Notes Read")
APPS="notes,calendar,reminders,contacts,music"   # apps built so far
WRITABLE_APPS="notes calendar reminders"

# EventKit helper for Calendar and Reminders: FradSer's `event` CLI from the npm package
# mcp-server-apple-events, pinned by version, package integrity and binary hashes. Only the
# two binaries are kept. To be replaced by Kairos' own Swift helper before release.
EVENT_PKG="https://registry.npmjs.org/mcp-server-apple-events/-/mcp-server-apple-events-1.5.0.tgz"
EVENT_INTEGRITY="sha512-vQDRNoDXp+iDNnWZt/LvPRgBmMcMdWLxaNGUw54NBJgLM9PXTGqF89f+l2O5tAJSWKzCcXrWDEXUzu8HJ3zP+w=="
EVENT_SHA256="dee0b28da225f313a85f14179b761b8f46f051339f97d91fe5adfc3df1bbf9e7"
DISCLAIM_SHA256="4338a80457fba1359a56f0c010ecaf3b2c59856a74bd2b70acaaf6060a1814dc"
EVENT_DIR="$DIR/vendor/eventkit"

DRY=0 WRITE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --config) CONFIG="$2"; shift ;;
    --write) WRITE_ARG="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
# Asks on the terminal; without one (e.g. run from another program) the answer is no.
ask() {
  local a=""
  if { printf '  %s [y/N] ' "$1" >/dev/tty; } 2>/dev/null; then
    read -r a </dev/tty || true
  else
    echo "  $1 No terminal to ask on, so: no."
  fi
  [[ "$a" =~ ^[Yy] ]]
}

# 1. macOS
say "1. Checking macOS"
[ "$(uname -s)" = "Darwin" ] || fail "Kairos runs on macOS only."
MACOS="$(sw_vers -productVersion)"
case "$MACOS" in
  27.*) ok "macOS $MACOS" ;;
  *) warn "macOS $MACOS: Kairos is developed and tested on macOS 27. Notes formatting relies on Notes features that differ between releases." ;;
esac
[ -x /usr/bin/shortcuts ] || fail "The shortcuts command is missing; Kairos needs the Shortcuts app."

# 2. Private Node, verified against nodejs.org's checksum. All macOS permissions belong to
#    this one binary, not to a Node any other program also uses.
say "2. Private Node.js 24"
if [ -x "$PRIVATE_NODE" ] && [ "$("$PRIVATE_NODE" -p 'process.versions.node.split(".")[0]')" = "24" ]; then
  ok "Already there: $("$PRIVATE_NODE" -v)"
elif [ "$DRY" = 1 ]; then
  warn "Would download the official Node.js 24 LTS (dry run)."
else
  [ "$(uname -m)" = "arm64" ] && ARCH=arm64 || ARCH=x64
  echo "  Downloading the official Node.js 24 LTS ($ARCH)"
  LINE="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | grep "darwin-$ARCH.tar.gz\$")"
  SHA="${LINE%% *}"; FILE="${LINE##* }"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/$FILE" "$NODE_DIST/$FILE"
  echo "$SHA  $TMP/$FILE" | shasum -a 256 -c - >/dev/null || fail "Checksum mismatch for $FILE; nothing was installed."
  tar -xzf "$TMP/$FILE" -C "$TMP"
  mkdir -p "$DIR/runtime"
  cp "$TMP/${FILE%.tar.gz}/bin/node" "$PRIVATE_NODE"
  chmod 755 "$PRIVATE_NODE"
  xattr -d com.apple.quarantine "$PRIVATE_NODE" 2>/dev/null || true
  ok "Checksum verified; installed $("$PRIVATE_NODE" -v)"
fi
NODE="$PRIVATE_NODE"
[ -x "$NODE" ] || NODE="$(command -v node || true)"   # dry run before the first install
[ -n "$NODE" ] || fail "No Node.js to continue with."

# 2b. EventKit helper.
say "2b. EventKit helper for Calendar and Reminders"
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d" " -f1; }
if [ "$(sha "$EVENT_DIR/event")" = "$EVENT_SHA256" ] && [ "$(sha "$EVENT_DIR/event-disclaim")" = "$DISCLAIM_SHA256" ]; then
  ok "Already there (mcp-server-apple-events 1.5.0)"
elif [ "$DRY" = 1 ]; then
  warn "Would download the EventKit helper (dry run)."
else
  ETMP="$(mktemp -d)"
  curl -fsSL -o "$ETMP/pkg.tgz" "$EVENT_PKG"
  [ "sha512-$(openssl dgst -sha512 -binary "$ETMP/pkg.tgz" | base64)" = "$EVENT_INTEGRITY" ] || { rm -rf "$ETMP"; fail "The EventKit helper package does not match its pinned checksum; nothing was installed."; }
  tar -xzf "$ETMP/pkg.tgz" -C "$ETMP" package/bin/event package/bin/event-disclaim
  [ "$(sha "$ETMP/package/bin/event")" = "$EVENT_SHA256" ] && [ "$(sha "$ETMP/package/bin/event-disclaim")" = "$DISCLAIM_SHA256" ] || { rm -rf "$ETMP"; fail "An EventKit helper binary does not match its pinned hash."; }
  mkdir -p "$EVENT_DIR"
  cp "$ETMP/package/bin/event" "$ETMP/package/bin/event-disclaim" "$EVENT_DIR/"
  chmod 755 "$EVENT_DIR/event" "$EVENT_DIR/event-disclaim"
  xattr -d com.apple.quarantine "$EVENT_DIR/event" "$EVENT_DIR/event-disclaim" 2>/dev/null || true
  rm -rf "$ETMP"
  ok "Checksums verified; installed in vendor/eventkit"
fi

# 3. Kairos shortcuts. Shortcuts cannot be installed from the command line: each needs one
#    "Add Shortcut" click. Duplicate names make them unusable, so check for those first.
say "3. Kairos shortcuts for Notes"
installed="$(/usr/bin/shortcuts list)"
missing=()
for name in "${NOTES_SHORTCUTS[@]}"; do
  n="$(grep -cxF "$name" <<<"$installed" || true)"
  if [ "$n" -gt 1 ]; then fail "\"$name\" is installed $n times. Delete the extra copies in the Shortcuts app, then run this again."; fi
  [ "$n" -eq 1 ] && ok "$name" || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$DRY" = 1 ]; then
    warn "Would install: ${missing[*]} (dry run)."
  else
    echo "  Building and signing ${#missing[@]} shortcut(s). Signing contacts Apple; it happens only here, never while Kairos runs."
    rm -rf "$SHORTCUTS_DIR"
    "$NODE" "$DIR/scripts/build-shortcuts.js" "$SHORTCUTS_DIR" >/dev/null
    echo
    echo "  Shortcuts will now show an \"Add Shortcut\" window for each one. Click \"Add Shortcut\"."
    echo "  When one first runs, macOS asks whether it may access Notes: choose Always Allow."
    for name in "${missing[@]}"; do open "$SHORTCUTS_DIR/$name.shortcut"; sleep 1.5; done
    echo "  Waiting for the imports (up to 5 minutes)..."
    for _ in $(seq 1 150); do
      installed="$(/usr/bin/shortcuts list)"
      left=0
      for name in "${missing[@]}"; do grep -qxF "$name" <<<"$installed" || left=$((left + 1)); done
      [ "$left" -eq 0 ] && break
      sleep 2
    done
    [ "$left" -eq 0 ] || fail "$left shortcut(s) were not added. Open the files in $SHORTCUTS_DIR by hand, then run this again."
    for name in "${missing[@]}"; do ok "$name"; done
  fi
fi

# 4. Self test: the protocol only, reads no data.
say "4. Self test"
LISTED="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | KAIROS_APPS="$APPS" KAIROS_WRITE="$(tr ' ' ',' <<<"$WRITABLE_APPS")" "$NODE" "$SERVER" 2>/dev/null)"
for tool in notes_folders notes_read notes_create calendar_calendars calendar_read calendar_create reminders_lists reminders_read reminders_create contacts_search contacts_birthdays music_now music_played music_search; do
  grep -q "\"$tool\"" <<<"$LISTED" || fail "The server did not list $tool. Output: ${LISTED:0:300}"
done
ok "Kairos answers and lists its tools."

# 5. Claude config: back it up, then write the kairos entry. Other entries stay as they are.
say "5. Claude desktop config"
# Which apps may write. Earlier answers are kept; only apps new since the last install are asked.
desc() {
  case "$1" in
    notes) echo "create notes, add to them and replace their text" ;;
    calendar) echo "create events, and change or delete them" ;;
    reminders) echo "create reminders, and change, complete or delete them" ;;
  esac
}
in_list() { [[ ",$2," == *",$1,"* ]]; }
WRITE=""
add_write() { WRITE="${WRITE:+$WRITE,}$1"; }
if [ -n "$WRITE_ARG" ]; then
  case "$WRITE_ARG" in
    none) ;;
    all) for app in $WRITABLE_APPS; do add_write "$app"; done ;;
    *)
      for app in $(tr ',' ' ' <<<"$WRITE_ARG"); do
        in_list "$app" "$(tr ' ' ',' <<<"$WRITABLE_APPS")" || fail "--write takes a list of: $WRITABLE_APPS (or all, or none)."
        add_write "$app"
      done ;;
  esac
  ok "Write setting from --write: ${WRITE:-none}"
else
  PRIOR="$([ -f "$CONFIG" ] && "$NODE" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
    const e = (c.mcpServers && c.mcpServers.kairos && c.mcpServers.kairos.env) || {};
    process.stdout.write((e.KAIROS_APPS || "") + "|" + (e.KAIROS_WRITE || ""));
  ' "$CONFIG" 2>/dev/null || true)"
  PRIOR_APPS="${PRIOR%%|*}" PRIOR_WRITE="${PRIOR#*|}"
  [ "$PRIOR" = "$PRIOR_APPS" ] && PRIOR_WRITE=""
  echo "  Kairos always reads. Writing is switched on per app; Claude still asks you in the chat"
  echo "  before it changes, completes or deletes anything."
  for app in $WRITABLE_APPS; do
    if in_list "$app" "$PRIOR_APPS"; then
      if in_list "$app" "$PRIOR_WRITE"; then add_write "$app"; ok "$app: writing stays on"; else ok "$app: stays read only"; fi
    elif ask "Allow Kairos to $(desc "$app")? Type y and Enter for yes, just Enter for no."; then
      add_write "$app"
    fi
  done
  echo "  To change this later: ./install.sh --write notes,calendar,reminders (or all, or none)"
fi

edit_config() {
  "$NODE" -e '
    const fs = require("fs");
    const [file, node, server, apps, write, dry] = process.argv.slice(1);
    let cfg = {};
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.kairos = { command: node, args: [server], env: { KAIROS_APPS: apps, KAIROS_WRITE: write } };
    const text = JSON.stringify(cfg, null, 2) + "\n";
    if (dry === "1") { process.stdout.write(JSON.stringify(cfg.mcpServers.kairos, null, 2) + "\n"); }
    else fs.writeFileSync(file, text);
  ' "$CONFIG" "$PRIVATE_NODE" "$SERVER" "$APPS" "$WRITE" "$DRY"
}

if [ "$DRY" = 1 ]; then
  echo "  Would write this entry to $CONFIG (dry run):"
  edit_config | sed 's/^/    /'
else
  mkdir -p "$(dirname "$CONFIG")"
  if [ -f "$CONFIG" ]; then
    BACKUP="$CONFIG.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$CONFIG" "$BACKUP"
    ok "Backup: $(basename "$BACKUP")"
  fi
  edit_config
  ok "Wrote the kairos entry (apps: $APPS, write: ${WRITE:-none})."
fi

say "Done. Left for you:"
echo "  1. Quit Claude completely (Cmd+Q) and open it again. Closing the window is not enough."
echo "  2. The first time Kairos reads Notes, Contacts or Music or lists calendars, macOS asks whether it"
echo "     may control that app, and the EventKit helper asks for Calendars and Reminders. Allow them."
echo "  3. The first time each Kairos shortcut runs, choose Always Allow for Notes."
echo "  Kairos never needs Full Disk Access; leave it off."
