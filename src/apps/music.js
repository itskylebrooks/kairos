// Music tools (read only), through Music scripting. Music is never opened unless the caller
// sets open_if_closed. Music keeps only each track's LAST play date and total play count,
// not a play history.
import { parseArgDate } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { jxa } from "../lib/osascript.js";
import { clampInt } from "../lib/paging.js";
import { READ, defineTool } from "../lib/tools.js";

// One static program; the mode and options arrive as JSON in argv[0].
const JXA_MUSIC = `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const Music = Application("Music");
  if (!Music.running() && !o.open_if_closed) return JSON.stringify({ running: false });
  const lib = Music.libraryPlaylists[0];
  const iso = (d) => (d ? d.toISOString() : null);
  const rows = (t) => {
    const n = t.name(), a = t.artist(), al = t.album(), pc = t.playedCount(), pd = t.playedDate();
    return n.map((x, i) => ({ name: x, artist: a[i] || null, album: al[i] || null, plays: pc[i], last_played: iso(pd[i]) }));
  };
  if (o.mode === "now") {
    const out = { running: true, state: String(Music.playerState()) };
    try {
      const t = Music.currentTrack;
      out.track = out.state === "stopped" ? null : { name: t.name(), artist: t.artist(), album: t.album(), position_s: Math.round(Music.playerPosition()), duration_s: Math.round(t.duration()) };
    } catch (e) { out.track = null; }
    return JSON.stringify(out);
  }
  if (o.mode === "played") {
    const t = o.since ? lib.tracks.whose({ playedDate: { _greaterThan: new Date(o.since) } }) : lib.tracks;
    const until = o.until ? new Date(o.until).toISOString() : null;
    const r = rows(t).filter((x) => x.last_played && (!until || x.last_played < until));
    r.sort((a, b) => String(b.last_played).localeCompare(String(a.last_played)));
    return JSON.stringify({ running: true, total: r.length, tracks: r.slice(0, o.limit) });
  }
  if (o.mode === "search") {
    // whose({ _or: [...] }) fails with "Can't convert types" on macOS 27: read everything
    // in bulk (fast) and match here, every word, accents ignored.
    // (Backslashes are doubled: this source sits inside a JS template string.)
    const fold = (s) => String(s || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();
    const words = fold(o.query).split(/\\s+/).filter(Boolean);
    const r = rows(lib.tracks).filter((x) => { const h = fold([x.name, x.artist, x.album].join(" | ")); return words.every((w) => h.includes(w)); });
    return JSON.stringify({ running: true, total: r.length, tracks: r.slice(0, o.limit) });
  }
  if (o.mode === "top") {
    const r = rows(lib.tracks).filter((x) => x.plays > 0).sort((a, b) => b.plays - a.plays);
    return JSON.stringify({ running: true, tracks: r.slice(0, o.limit) });
  }
  if (o.mode === "playlists") {
    const out = Music.userPlaylists().map((p) => {
      let n = null, smart = null;
      try { n = p.tracks.length; } catch (e) {}
      try { smart = p.smart(); } catch (e) {}
      return { name: p.name(), tracks: n, smart: smart };
    });
    return JSON.stringify({ running: true, playlists: out });
  }
  if (o.mode === "playlist") {
    const p = Music.userPlaylists.whose({ name: o.name })();
    if (!p.length) return JSON.stringify({ running: true, error: "no_playlist" });
    const r = rows(p[0].tracks);
    return JSON.stringify({ running: true, name: o.name, total: r.length, tracks: r.slice(0, o.limit) });
  }
  return JSON.stringify({ error: "unknown_mode" });
}`;

const CLOSED = "Music is not running. Pass open_if_closed: true to open it.";

async function music(opts) {
  const r = await jxa("music", JXA_MUSIC, opts, { app: "Music", timeoutMs: 90000 });
  if (r.running === false) return { running: false, message: CLOSED };
  if (r.error === "no_playlist") throw new UserError(`No playlist named "${opts.name}". Call music_playlists without a name to see them.`);
  if (r.error) throw new Error(`Music script: ${r.error}`);
  return r;
}

const open = (o) => !!o;
const when = (v, name) => { const d = parseArgDate(v, name); return d ? d.getTime() : null; };

const musicNow = ({ open_if_closed } = {}) => music({ mode: "now", open_if_closed: open(open_if_closed) });
const musicPlayed = ({ since, until, limit, open_if_closed } = {}) =>
  music({ mode: "played", since: when(since, "since"), until: when(until, "until"), limit: clampInt(limit, 1, 2000, 100), open_if_closed: open(open_if_closed) });
const musicTop = ({ limit, open_if_closed } = {}) => music({ mode: "top", limit: clampInt(limit, 1, 2000, 50), open_if_closed: open(open_if_closed) });
async function musicSearch({ query, limit, open_if_closed } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new UserError("query must not be empty.");
  return music({ mode: "search", query: q, limit: clampInt(limit, 1, 2000, 50), open_if_closed: open(open_if_closed) });
}
const musicPlaylists = ({ name, limit, open_if_closed } = {}) => (name
  ? music({ mode: "playlist", name: String(name), limit: clampInt(limit, 1, 5000, 200), open_if_closed: open(open_if_closed) })
  : music({ mode: "playlists", open_if_closed: open(open_if_closed) }));

const OPEN = { type: "boolean", description: "Open Music if it is not running (default false)." };
const LIMIT = { type: "integer", description: "Max tracks." };
const DATE = { type: "string", description: "Date or local date-time, e.g. 2030-01-31 or 2030-01-31 18:00." };

export const tools = [
  defineTool({
    name: "music_now", app: "music", title: "Now playing", annotations: READ, handler: musicNow,
    description: "What Apple Music is playing right now: state, track, artist, album, position.",
    inputSchema: { type: "object", additionalProperties: false, properties: { open_if_closed: OPEN } },
  }),
  defineTool({
    name: "music_played", app: "music", title: "Recently played", annotations: READ, handler: musicPlayed,
    description: "Library tracks by when they were LAST played, newest first, for any period. Music stores only each track's last play date and total play count, so this is not a full play history: a track played twice in the period appears once.",
    inputSchema: { type: "object", additionalProperties: false, properties: { since: DATE, until: DATE, limit: LIMIT, open_if_closed: OPEN } },
  }),
  defineTool({
    name: "music_top", app: "music", title: "Most played", annotations: READ, handler: musicTop,
    description: "Most played library tracks by all time play count (Music keeps no per period counts).",
    inputSchema: { type: "object", additionalProperties: false, properties: { limit: LIMIT, open_if_closed: OPEN } },
  }),
  defineTool({
    name: "music_search", app: "music", title: "Search music", annotations: READ, handler: musicSearch,
    description: "Search the Music library by song, artist or album (every word must match, accents ignored), with play counts and last played dates.",
    inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, limit: LIMIT, open_if_closed: OPEN } },
  }),
  defineTool({
    name: "music_playlists", app: "music", title: "Playlists", annotations: READ, handler: musicPlaylists,
    description: "List your playlists (with track counts and whether they are smart), or pass name to get one playlist's tracks.",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, limit: LIMIT, open_if_closed: OPEN } },
  }),
];
