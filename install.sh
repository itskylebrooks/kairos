#!/bin/bash
# Kairos installer: a local MCP server that gives the Claude desktop app access to Apple
# data on this Mac. stdio only, no network at runtime, no Full Disk Access.
#
#   ./install.sh               install or update, then write the "kairos" entry in Claude's config
#   ./install.sh --migrate     also remove the old "apple-data" and "apple-events" entries (asks first)
#   ./install.sh --dry-run     show the config change without writing anything
#   ./install.sh --write notes allow Kairos to write to Notes without asking (--write none: read only)
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
APPS="notes"   # apps built so far

MIGRATE=0 DRY=0 WRITE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) MIGRATE=1 ;;
    --dry-run) DRY=1 ;;
    --config) CONFIG="$2"; shift ;;
    --write) WRITE_ARG="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
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
  | KAIROS_APPS="$APPS" KAIROS_WRITE="notes" "$NODE" "$SERVER" 2>/dev/null)"
for tool in notes_folders notes_list notes_search notes_read notes_create notes_append notes_replace; do
  grep -q "\"$tool\"" <<<"$LISTED" || fail "The server did not list $tool. Output: ${LISTED:0:300}"
done
ok "Kairos answers and lists its Notes tools."

# 5. Claude config: back it up, then write the kairos entry. Other entries stay as they are.
say "5. Claude desktop config"
WRITE=""
if [ -n "$WRITE_ARG" ]; then
  case "$WRITE_ARG" in
    notes) WRITE="notes" ;;
    none) WRITE="" ;;
    *) fail "--write takes notes or none." ;;
  esac
  ok "Write setting from --write: ${WRITE:-none}"
elif [ -f "$CONFIG" ] && WRITE_NOW="$("$NODE" -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
  const k = c.mcpServers && c.mcpServers.kairos;
  process.stdout.write(k && k.env && typeof k.env.KAIROS_WRITE === "string" ? k.env.KAIROS_WRITE : "");
' "$CONFIG" 2>/dev/null)" && [ -n "$WRITE_NOW" ]; then
  WRITE="$WRITE_NOW"
  ok "Keeping your write setting: KAIROS_WRITE=$WRITE"
else
  echo "  Kairos reads Notes by default. It can also create notes, add to them and replace their"
  echo "  text (always asking you first in the chat before changing or replacing anything)."
  if ask "Allow Kairos to write to Notes? Type y and press Enter for yes, or just Enter for no."; then WRITE="notes"; fi
  [ -n "$WRITE" ] || echo "  Read only. To allow writing later: ./install.sh --write notes"
fi

MIGRATE_OK=0
if [ "$MIGRATE" = 1 ]; then
  echo "  --migrate removes the old \"apple-data\" and \"apple-events\" entries from Claude's config."
  echo "  Their files in ~/Code/apple-mcp are not touched."
  ask "Remove them now?" && MIGRATE_OK=1
fi

edit_config() {
  "$NODE" -e '
    const fs = require("fs");
    const [file, node, server, apps, write, migrate, dry] = process.argv.slice(1);
    let cfg = {};
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.kairos = { command: node, args: [server], env: { KAIROS_APPS: apps, KAIROS_WRITE: write } };
    const removed = [];
    if (migrate === "1") for (const k of ["apple-data", "apple-events"]) if (cfg.mcpServers[k]) { delete cfg.mcpServers[k]; removed.push(k); }
    const text = JSON.stringify(cfg, null, 2) + "\n";
    if (dry === "1") { process.stdout.write(JSON.stringify(cfg.mcpServers.kairos, null, 2) + "\n"); }
    else fs.writeFileSync(file, text);
    if (removed.length) console.error("  removed: " + removed.join(", "));
  ' "$CONFIG" "$PRIVATE_NODE" "$SERVER" "$APPS" "$WRITE" "$MIGRATE_OK" "$DRY"
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
echo "  2. The first time Kairos reads Notes, macOS asks whether it may control Notes. Allow it."
echo "  3. The first time each Kairos shortcut runs, choose Always Allow for Notes."
echo "  Kairos never needs Full Disk Access; leave it off."
if [ "$MIGRATE" = 0 ]; then
  echo "  Your old apple-data and apple-events entries are still there. Remove them later with: ./install.sh --migrate"
fi
