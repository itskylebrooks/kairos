// Music tools (read only), through Music scripting. Music is never opened unless the caller
// sets open_if_closed. Music keeps only each track's LAST play date and total play count,
// not a play history.
import { addDays, isBareDay, isoLocal, parseArgDate, startOfDay } from "../lib/dates.js";
import { UserError } from "../lib/errors.js";
import { defineScript, jxa } from "../lib/osascript.js";
import { clampInt } from "../lib/paging.js";
import { LIMITS, coverage, loadLog, status, timeline, topPlays } from "../lib/playlog.js";
import { READ, defineTool } from "../lib/tools.js";

// One static program; the mode and options arrive as JSON in argv[0].
const JXA_MUSIC = defineScript("music", `
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
    const fold = (s) => String(s || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\u00df|\\u1e9e/g, "ss").toLowerCase();
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
}`);

const CLOSED = "Music is not running. Pass open_if_closed: true to open it.";

async function music(opts) {
  const r = await jxa(JXA_MUSIC, opts, { app: "Music", timeoutMs: 90000 });
  if (r.running === false) return { running: false, message: CLOSED };
  if (r.error === "no_playlist") throw new UserError(`No playlist named "${opts.name}". Call music_playlists without a name to see them.`);
  if (r.error) throw new Error(`Music script: ${r.error}`);
  return r;
}

const open = (o) => !!o;
const when = (v, name) => { const d = parseArgDate(v, name); return d ? d.getTime() : null; };
/** An until argument as a time: a bare date includes that whole day. */
const whenUntil = (v) => { const d = parseArgDate(v, "until"); return d ? (isBareDay(v) ? addDays(d, 1) : d).getTime() : null; };

const musicNow = ({ open_if_closed } = /** @type {any} */ ({})) => music({ mode: "now", open_if_closed: open(open_if_closed) });
const musicPlayed = ({ since, until, limit, open_if_closed } = /** @type {any} */ ({})) =>
  music({ mode: "played", since: when(since, "since"), until: whenUntil(until), limit: clampInt(limit, 1, 2000, 100), open_if_closed: open(open_if_closed) });
const musicTop = ({ limit, open_if_closed } = /** @type {any} */ ({})) => music({ mode: "top", limit: clampInt(limit, 1, 2000, 50), open_if_closed: open(open_if_closed) });
async function musicSearch({ query, limit, open_if_closed } = /** @type {any} */ ({})) {
  const q = String(query ?? "").trim();
  if (!q) throw new UserError("query must not be empty.");
  return music({ mode: "search", query: q, limit: clampInt(limit, 1, 2000, 50), open_if_closed: open(open_if_closed) });
}
const musicPlaylists = ({ name, limit, open_if_closed } = /** @type {any} */ ({})) => (name
  ? music({ mode: "playlist", name: String(name), limit: clampInt(limit, 1, 5000, 200), open_if_closed: open(open_if_closed) })
  : music({ mode: "playlists", open_if_closed: open(open_if_closed) }));

/* ---------- play log (history from saved snapshots; never touches Music) ---------- */

const NOT_ON = "The Music play log has no snapshots yet. It is switched on by install.sh (question \"Keep a daily Music play log?\"); history starts with the first snapshot.";

/** since/until arguments to a [from, to) range; a bare until date includes that day. */
function range(since, until, defaultDays) {
  const today = startOfDay(new Date());
  const to = until ? (isBareDay(until) ? addDays(parseArgDate(until, "until"), 1) : parseArgDate(until, "until")) : addDays(today, 1);
  const from = since ? parseArgDate(since, "since") : addDays(to, -defaultDays);
  if (to <= from) throw new UserError("until must be after since.");
  return { from, to };
}

function withCoverage(log, from, to, result) {
  const inRange = (t) => t >= from.getTime() && t < to.getTime();
  return {
    range: { from: isoLocal(from), to: isoLocal(to) },
    ...result,
    coverage: { ...coverage(log.times, from.getTime(), to.getTime()), resets: log.anomalies.filter((a) => inRange(a.at)).length },
    note: LIMITS,
  };
}

async function musicHistoryStatus() {
  const s = status();
  return s.snapshots ? s : { ...s, message: NOT_ON };
}

async function musicHistoryTop({ since, until, group_by = "track", query, limit } = /** @type {any} */ ({})) {
  const log = loadLog();
  if (!log.times.length) throw new UserError(NOT_ON);
  const { from, to } = range(since, until, 30);
  const r = topPlays(log, { since: from.getTime(), until: to.getTime(), group_by, query, limit: clampInt(limit, 1, 500, 25) });
  return withCoverage(log, from, to, { group_by, ...(query ? { query } : {}), total_plays: r.total_plays, count: r.count, items: r.items });
}

async function musicHistoryTimeline({ since, until, bucket = "day", query } = /** @type {any} */ ({})) {
  const log = loadLog();
  if (!log.times.length) throw new UserError(NOT_ON);
  const { from, to } = range(since, until, bucket === "month" ? 365 : bucket === "week" ? 84 : 14);
  if ((to.getTime() - from.getTime()) / 86400e3 > 3700) throw new UserError("The range is too long (ten years at most).");
  const rows = timeline(log, { since: from.getTime(), until: to.getTime(), bucket, query });
  return withCoverage(log, from, to, { bucket, ...(query ? { query } : {}), total_plays: rows.reduce((s, r) => s + (r.plays ?? 0), 0), periods: rows });
}

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
    description: "Library tracks by when they were LAST played, newest first, for any period. Music stores only each track's last play date and total play count, so this is not a full play history: a track played twice in the period appears once. For plays per period (\"what did I listen to most in September\") use music_history_top when the play log is on.",
    inputSchema: { type: "object", additionalProperties: false, properties: { since: DATE, until: { ...DATE, description: `${DATE.description} A bare date includes that day.` }, limit: LIMIT, open_if_closed: OPEN } },
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
    name: "music_history_status", app: "music", title: "Play log status", annotations: READ, handler: musicHistoryStatus,
    description: "Whether the Music play log is on, since when it has data, the last snapshot and the last check. The play log saves play counts several times a day, so history exists only from its first snapshot on.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  }),
  defineTool({
    name: "music_history_top", app: "music", title: "Most played in a period", annotations: READ, handler: musicHistoryTop,
    description: "From the Music play log: most played tracks, artists or albums between since and until (a bare until date includes that day; default the last 30 days), optionally filtered by query (track, artist or album words). Answers \"what did I listen to yesterday\" or \"most played artists in September\". Read coverage: plays before logging started or during gaps are unknown.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        since: DATE, until: DATE,
        group_by: { type: "string", enum: ["track", "artist", "album"], description: "Default track." },
        query: { type: "string", description: "Only tracks whose name, artist or album contain these words." },
        limit: { type: "integer", description: "Max rows (default 25)." },
      },
    },
  }),
  defineTool({
    name: "music_history_timeline", app: "music", title: "Plays over time", annotations: READ, handler: musicHistoryTimeline,
    description: "From the Music play log: plays per day, week (starting Monday) or month between since and until, optionally for one track, artist or album (query). Periods outside the logged span have plays: null (unknown), not 0.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        since: DATE, until: DATE,
        bucket: { type: "string", enum: ["day", "week", "month"], description: "Default day." },
        query: { type: "string", description: "Only tracks whose name, artist or album contain these words." },
      },
    },
  }),
  defineTool({
    name: "music_playlists", app: "music", title: "Playlists", annotations: READ, handler: musicPlaylists,
    description: "List your playlists (with track counts and whether they are smart), or pass name to get one playlist's tracks.",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, limit: LIMIT, open_if_closed: OPEN } },
  }),
];
