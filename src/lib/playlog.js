// Music play log. Music keeps only each track's total play count and last play date, so a
// snapshot of the counts is saved now and then, and the differences between snapshots
// become a listening history.
//
// Files in ~/Library/Application Support/Kairos/music/ (never in the repo; private to the user):
//   snapshots-YYYY.jsonl  one line per snapshot: counts of the tracks that changed since the
//                         previous one (a baseline with ALL counts starts every month)
//   catalog.json          track metadata by Music's persistent ID, with earlier names
//   state.json            the latest counts and the last check; rebuilt from the snapshots
//                         when missing
//
// Plays between two snapshots can only be placed in that interval. Each track's last play
// date pins its latest play to an exact day; the others may be marked uncertain.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { addDays, isoLocal, localDay, startOfDay } from "./dates.js";
import { agentsDir, dataDir } from "./paths.js";

export const VERSION = 1;
/** launchd label of the opt-in background job (src/cli/music-log.js). */
export const AGENT_LABEL = "kairos.music-log";
/** Extra snapshots (when Music is already open) at most this often. */
export const INTERVAL_MS = 3 * 3600e3;
/** Snapshots further apart than this leave a gap in the history. */
export const GAP_MS = 30 * 3600e3;

/* ================= pure logic ================= */

/**
 * Whether to take a snapshot now. The background job never opens Music: when Music is
 * closed it simply tries again at the next hourly check.
 * @param {{ now: Date, last: string | null, musicRunning: boolean | null, force?: boolean }} o
 *   musicRunning null means "not checked yet" (the cheap checks come first)
 */
export function decide({ now, last, musicRunning, force = false }) {
  if (!force && last && localDay(new Date(last)) === localDay(now) && now - new Date(last) < INTERVAL_MS) return { take: false, reason: "recent" };
  if (musicRunning === null) return { take: null, reason: "check_music" };
  if (!musicRunning) return { take: false, reason: "music_closed" };
  if (force) return { take: true, reason: "manual" };
  if (!last) return { take: true, reason: "first" };
  if (localDay(new Date(last)) !== localDay(now)) return { take: true, reason: "daily" };
  return { take: true, reason: "interval" };
}

const month = (d) => localDay(d).slice(0, 7);

/**
 * A snapshot entry from the library and the previous state.
 * @param {{ prev: { t: string, counts: Record<string, number> } | null, tracks: { id: string, count: number, last: string | null }[], now: Date, reason: string }} o
 */
export function makeEntry({ prev, tracks, now, reason }) {
  const baseline = !prev || month(new Date(prev.t)) !== month(now);
  const counts = {}, last = {};
  const seen = new Set();
  for (const tr of tracks) {
    seen.add(tr.id);
    const before = prev ? prev.counts[tr.id] : undefined;
    const changed = before !== tr.count;
    if (baseline || changed) counts[tr.id] = tr.count;
    if (changed && tr.last) last[tr.id] = tr.last;
  }
  const removed = prev ? Object.keys(prev.counts).filter((id) => !seen.has(id)) : [];
  const entry = { v: VERSION, t: now.toISOString(), local: isoLocal(now), kind: baseline ? "baseline" : "delta", reason, counts, last, removed };
  const state = { t: entry.t, counts: Object.fromEntries(tracks.map((tr) => [tr.id, tr.count])) };
  const changed = prev ? tracks.filter((tr) => prev.counts[tr.id] !== tr.count).length : 0;
  return { entry, state, changed };
}

/** Updates the catalog in place: new tracks, renames (kept as aliases), removals. */
export function updateCatalog(catalog, tracks, now) {
  const t = now.toISOString();
  const cur = new Set();
  for (const tr of tracks) {
    cur.add(tr.id);
    const meta = { name: tr.name ?? null, artist: tr.artist ?? null, album: tr.album ?? null };
    const c = catalog.tracks[tr.id];
    if (!c) { catalog.tracks[tr.id] = { ...meta, duration_s: tr.duration ?? null, first_seen: t }; continue; }
    if (c.name !== meta.name || c.artist !== meta.artist || c.album !== meta.album) {
      const old = { name: c.name, artist: c.artist, album: c.album };
      c.aliases = [...(c.aliases || []).filter((a) => JSON.stringify(a) !== JSON.stringify(old)), old];
      Object.assign(c, meta);
    }
    if (tr.duration != null) c.duration_s = tr.duration;
    delete c.removed_at;
  }
  for (const [id, c] of Object.entries(catalog.tracks)) if (!cur.has(id) && !c.removed_at) c.removed_at = t;
  return catalog;
}

/**
 * Replays snapshot entries into play events and anomalies.
 * A count going down is a reset (library rebuilt, sync), never negative plays. A track that
 * first appears after the first snapshot counts its plays only if its last play falls after
 * the previous snapshot (otherwise it is an old track added again).
 */
export function replay(entries) {
  const counts = new Map();
  const events = [], anomalies = [], times = [];
  let prevT = null;
  for (const e of entries) {
    const t = Date.parse(e.t);
    for (const [id, n] of Object.entries(e.counts || {})) {
      const before = counts.get(id);
      const last = e.last && e.last[id] ? Date.parse(e.last[id]) : null;
      counts.set(id, n);
      if (prevT === null) continue;
      if (before === undefined) {
        if (n > 0 && last !== null && last > prevT) events.push({ id, n, from: prevT, to: t, last });
        continue;
      }
      if (n < before) anomalies.push({ id, at: t, from: before, to: n });
      else if (n > before) events.push({ id, n: n - before, from: prevT, to: t, last });
    }
    for (const id of e.removed || []) counts.delete(id);
    times.push(t);
    prevT = t;
  }
  return { events, anomalies, times, counts };
}

/**
 * When an event's plays happened, as far as known:
 *  - last play inside the interval: the latest play is on that day; the others are on the
 *    same day if the interval started that day, else uncertain (between `from` and `last`)
 *  - last play BEFORE the interval: the plays arrived late (iPhone sync); placed at `last`
 *  - no last play date: placed at the end of the interval, uncertain if it spans days
 */
export function placeEvent(ev) {
  const sameDay = (a, b) => localDay(new Date(a)) === localDay(new Date(b));
  if (ev.last !== null && ev.last <= ev.from) return { at: ev.last, n: ev.n, uncertain: Math.max(0, ev.n - 1), late: true };
  if (ev.last !== null) return { at: ev.last, n: ev.n, uncertain: sameDay(ev.from, ev.last) ? 0 : ev.n - 1, late: false };
  return { at: ev.to, n: ev.n, uncertain: sameDay(ev.from, ev.to) ? 0 : ev.n, late: false };
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether a catalog track matches every word of the query (current or earlier names). */
export function trackMatches(c, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([c, ...(c.aliases || [])].map((x) => `${x.name} ${x.artist} ${x.album}`).join("\n"));
  return words.every((w) => hay.includes(w));
}

/** Snapshot coverage of [since, until): first and last snapshot, gaps, days not logged. */
export function coverage(times, since, until) {
  if (!times.length) return { logged_from: null, logged_to: null, gaps: [] };
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1], b = times[i];
    if (b - a > GAP_MS && b > since && a < until) gaps.push({ from: isoLocal(new Date(a)), to: isoLocal(new Date(b)) });
  }
  return { logged_from: isoLocal(new Date(times[0])), logged_to: isoLocal(new Date(times[times.length - 1])), gaps };
}

export const LIMITS = "Only tracks in the Music library are counted (songs streamed without adding them are invisible), and only plays after logging started. Plays are known per interval between snapshots: the day of each track's latest play is exact, other plays in a multi day interval are counted as uncertain_day_plays. late_sync_plays arrived later through sync (for example from an iPhone).";

/** Placed plays in [since, until) with their catalog entry, filtered by query. */
function playsIn(log, since, until, query) {
  const out = [];
  for (const ev of log.events) {
    const p = placeEvent(ev);
    if (p.at < since || p.at >= until) continue;
    const c = log.catalog.tracks[ev.id] || { name: null, artist: null, album: null };
    if (query && !trackMatches(c, query)) continue;
    out.push({ ...p, id: ev.id, c });
  }
  return out;
}

/**
 * Most played tracks, artists or albums in [since, until).
 * @param {{ events: any[], times: number[], catalog: any }} log
 */
export function topPlays(log, { since, until, group_by = "track", query, limit = 25 }) {
  const groups = new Map();
  for (const p of playsIn(log, since, until, query)) {
    const key = group_by === "artist" ? fold(p.c.artist) : group_by === "album" ? `${fold(p.c.album)}\n${fold(p.c.artist)}` : p.id;
    let g = groups.get(key);
    if (!g) {
      g = group_by === "artist" ? { artist: p.c.artist } : group_by === "album" ? { album: p.c.album, artist: p.c.artist } : { name: p.c.name, artist: p.c.artist, album: p.c.album, id: p.id };
      Object.assign(g, { plays: 0, uncertain_day_plays: 0, late_sync_plays: 0, last_play: 0 });
      if (group_by !== "track") g.tracks = new Set();
      groups.set(key, g);
    }
    g.plays += p.n;
    g.uncertain_day_plays += p.uncertain;
    if (p.late) g.late_sync_plays += p.n;
    g.last_play = Math.max(g.last_play, p.at);
    if (g.tracks) g.tracks.add(p.id);
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.plays - a.plays || b.last_play - a.last_play)
    .map(({ tracks, last_play, ...g }) => ({ ...g, ...(tracks ? { tracks: tracks.size } : {}), last_play: isoLocal(new Date(last_play)) }));
  return { total_plays: rows.reduce((s, r) => s + r.plays, 0), count: rows.length, items: rows.slice(0, limit) };
}

const BUCKETS = {
  day: (d) => localDay(d),
  week: (d) => { const x = startOfDay(d); return localDay(addDays(x, -((x.getDay() + 6) % 7))); }, // Monday
  month: (d) => localDay(d).slice(0, 7),
};

/** Plays per day, week or month in [since, until). Buckets outside the logged span are null. */
export function timeline(log, { since, until, bucket = "day", query }) {
  const key = BUCKETS[bucket];
  const first = log.times[0] ?? Infinity, lastT = log.times.at(-1) ?? -Infinity;
  const rows = new Map();
  for (let d = startOfDay(new Date(since)); d < until; d = addDays(d, 1)) {
    const k = key(d);
    if (!rows.has(k)) rows.set(k, { period: k, plays: null, uncertain_day_plays: 0, late_sync_plays: 0 });
    const r = rows.get(k);
    // A day counts as logged when it overlaps the span between the first and last snapshot.
    if (addDays(d, 1) > first && d <= lastT && r.plays === null) r.plays = 0;
  }
  for (const p of playsIn(log, since, until, query)) {
    const r = rows.get(key(new Date(p.at)));
    if (!r) continue;
    r.plays = (r.plays ?? 0) + p.n;
    r.uncertain_day_plays += p.uncertain;
    if (p.late) r.late_sync_plays += p.n;
  }
  return [...rows.values()];
}

/* ================= files ================= */

export const musicDir = () => join(dataDir(), "music");
const statePath = () => join(musicDir(), "state.json");
const catalogPath = () => join(musicDir(), "catalog.json");
const lockPath = () => join(musicDir(), "snapshot.lock");

function ensureDir() { mkdirSync(musicDir(), { recursive: true, mode: 0o700 }); }

function writeJsonAtomic(path, obj) {
  ensureDir();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  renameSync(tmp, path);
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

/** All snapshot entries in order. Damaged lines (e.g. a write cut short) are skipped and counted. */
export function readEntries() {
  if (!existsSync(musicDir())) return { entries: [], damaged: 0 };
  const files = readdirSync(musicDir()).filter((f) => /^snapshots-\d{4}\.jsonl$/.test(f)).sort();
  const entries = [];
  let damaged = 0;
  for (const f of files) {
    for (const line of readFileSync(join(musicDir(), f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.t && e.counts) entries.push(e); else damaged++; } catch { damaged++; }
    }
  }
  entries.sort((a, b) => a.t.localeCompare(b.t));
  return { entries, damaged };
}

function appendEntry(entry, now) {
  ensureDir();
  const fd = openSync(join(musicDir(), `snapshots-${now.getFullYear()}.jsonl`), "a", 0o600);
  try { writeSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** The latest counts: state.json, or rebuilt from the snapshots when missing or behind. */
export function readState(entries = null) {
  const s = readJson(statePath());
  const list = entries ?? readEntries().entries;
  const latest = list.at(-1);
  if (s && s.t && s.counts && (!latest || s.t >= latest.t)) return s;
  if (!latest) return s && s.last_check ? { last_check: s.last_check } : null;
  const { counts } = replay(list);
  return { t: latest.t, counts: Object.fromEntries(counts), last_check: s?.last_check };
}

export const readCatalog = () => readJson(catalogPath()) || { v: VERSION, tracks: {} };

/** Everything the history tools need. */
export function loadLog() {
  const { entries, damaged } = readEntries();
  const { events, anomalies, times } = replay(entries);
  return { events, anomalies, times, damaged, catalog: readCatalog(), state: readState(entries) };
}

/** Exclusive lock; a lock older than 10 minutes is stale (a crashed run). */
function lock() {
  ensureDir();
  try {
    if (existsSync(lockPath()) && Date.now() - statSync(lockPath()).mtimeMs > 10 * 60e3) rmSync(lockPath(), { force: true });
    closeSync(openSync(lockPath(), "wx", 0o600));
    return () => rmSync(lockPath(), { force: true });
  } catch {
    return null;
  }
}

/**
 * One snapshot run: decide, read the library if needed, append the entry, update state and
 * catalog. `readLibrary` returns { running: false } or { running: true, tracks: [...] }.
 * @returns {Promise<{ action: "snapshot" | "skip", reason: string, tracks?: number, changed?: number, kind?: string }>}
 */
export async function runSnapshot({ now = new Date(), force = false, readLibrary }) {
  const unlock = lock();
  if (!unlock) return { action: "skip", reason: "locked" };
  try {
    const state = readState();
    const check = (reason) => { writeJsonAtomic(statePath(), { ...(state || {}), last_check: { t: now.toISOString(), reason } }); return { action: "skip", reason }; };
    let d = decide({ now, last: state?.t ?? null, musicRunning: null, force });
    if (d.take === false) return check(d.reason);
    const lib = await readLibrary();
    d = decide({ now, last: state?.t ?? null, musicRunning: !!lib.running, force });
    if (!d.take) return check(d.reason);
    const prev = state && state.t && state.counts ? state : null;
    const { entry, state: next, changed } = makeEntry({ prev, tracks: lib.tracks, now, reason: d.reason });
    appendEntry(entry, now);
    writeJsonAtomic(statePath(), { ...next, last_check: { t: now.toISOString(), reason: d.reason } });
    writeJsonAtomic(catalogPath(), updateCatalog(readCatalog(), lib.tracks, now));
    return { action: "snapshot", reason: d.reason, kind: entry.kind, tracks: lib.tracks.length, changed };
  } finally {
    unlock();
  }
}

/** What has been logged so far, and whether the background job is installed. */
export function status() {
  const l = loadLog();
  return {
    agent_installed: existsSync(join(agentsDir(), `${AGENT_LABEL}.plist`)),
    data: musicDir(),
    snapshots: l.times.length,
    first: l.times[0] ? isoLocal(new Date(l.times[0])) : null,
    last: l.times.length ? isoLocal(new Date(l.times.at(-1))) : null,
    last_check: l.state?.last_check ? { at: isoLocal(new Date(l.state.last_check.t)), result: l.state.last_check.reason } : null,
    tracks_known: Object.keys(l.catalog.tracks).length,
    plays_logged: l.events.reduce((s, e) => s + e.n, 0),
    resets: l.anomalies.length,
    damaged_lines: l.damaged,
  };
}
