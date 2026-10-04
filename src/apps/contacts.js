// Contacts tools (read only), through Contacts scripting.
// Every card is read in one Apple Events round trip per property (bulk fetch); Contacts is
// quit again if this call had to start it. Results are cached for 5 minutes.
import { jxa } from "../lib/osascript.js";
import { clampInt, page } from "../lib/paging.js";
import { fold } from "../lib/text.js";
import { READ, defineTool } from "../lib/tools.js";

const JXA_CONTACTS = `
function run(argv) {
  const C = Application("Contacts");
  const wasRunning = C.running();
  try {
    const P = C.people;
    const g = (f) => { try { return f(); } catch (e) { return null; } };
    return JSON.stringify({
      id: g(() => P.id()) || [],
      name: g(() => P.name()) || [],
      first: g(() => P.firstName()), middle: g(() => P.middleName()), last: g(() => P.lastName()),
      nickname: g(() => P.nickname()), org: g(() => P.organization()), job: g(() => P.jobTitle()), dept: g(() => P.department()),
      note: g(() => P.note()),
      bday: (g(() => P.birthDate()) || []).map((d) => (d ? [d.getFullYear(), d.getMonth() + 1, d.getDate()] : null)),
      phoneV: g(() => P.phones.value()), phoneL: g(() => P.phones.label()),
      emailV: g(() => P.emails.value()), emailL: g(() => P.emails.label()),
      relV: g(() => P.relatedNames.value()), relL: g(() => P.relatedNames.label()),
      urlV: g(() => P.urls.value()),
      addrV: g(() => P.addresses.formattedAddress()), addrL: g(() => P.addresses.label()),
    });
  } finally {
    if (!wasRunning) { try { C.quit(); } catch (e) {} }
  }
}`;

// "_$!<Mobile>!$_" -> "mobile"
const cleanLabel = (l) => (l ? String(l).replace(/^_\$!</, "").replace(/>!\$_$/, "").toLowerCase() : null);
const at = (arr, i) => (Array.isArray(arr) ? arr[i] : null);
const pairs = (vals, labels, i, key) =>
  (at(vals, i) || []).map((v, j) => ({ label: cleanLabel(at(at(labels, i), j)), [key]: v })).filter((x) => x[key]);

/** Bulk arrays from the JXA script to contact cards, sorted by name. */
export function toContacts(raw) {
  const out = [];
  raw.name.forEach((full, i) => {
    const name = [at(raw.first, i), at(raw.middle, i), at(raw.last, i)].filter(Boolean).join(" ") || full || at(raw.org, i);
    if (!name) return;
    const b = at(raw.bday, i);
    out.push({
      id: at(raw.id, i) || null,
      name,
      nickname: at(raw.nickname, i) || null,
      organization: at(raw.org, i) || null,
      job_title: at(raw.job, i) || null,
      department: at(raw.dept, i) || null,
      birthday: b ? { month: b[1], day: b[2], year: b[0] > 1700 ? b[0] : null } : null, // 1604 = year unknown
      phones: pairs(raw.phoneV, raw.phoneL, i, "number"),
      emails: pairs(raw.emailV, raw.emailL, i, "address"),
      addresses: pairs(raw.addrV, raw.addrL, i, "address"),
      related_names: pairs(raw.relV, raw.relL, i, "name"),
      urls: (at(raw.urlV, i) || []).filter(Boolean),
      note: at(raw.note, i) || null,
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let cache = null, cacheAt = 0;
async function allContacts() {
  if (cache && Date.now() - cacheAt < 5 * 60e3) return cache;
  cache = toContacts(await jxa("contacts.all", JXA_CONTACTS, {}, { app: "Contacts", timeoutMs: 120000 }));
  cacheAt = Date.now();
  return cache;
}

const digits = (s) => String(s ?? "").replace(/\D/g, "");

/** Every query word in some field, or the trailing digits of a phone number. */
export function contactMatches(c, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([c.name, c.nickname, c.organization, c.job_title, c.department, c.note,
    ...c.emails.map((e) => e.address), ...c.phones.map((p) => p.number), ...c.addresses.map((a) => a.address),
    ...c.related_names.map((r) => `${r.label} ${r.name}`)].filter(Boolean).join("\n"));
  if (words.every((w) => hay.includes(w))) return true;
  const d = digits(query);
  return d.length >= 6 && c.phones.some((p) => digits(p.number).endsWith(d.slice(-9)));
}

async function contactsSearch({ query, limit, offset } = {}) {
  const all = await allContacts();
  const p = page(all.filter((c) => contactMatches(c, query || "")), limit, offset, 25, 500);
  return { total: p.total, offset: p.offset, limit: p.limit, has_more: p.has_more, contacts: p.items };
}

/** Birthdays within `window` days of `now`; 29 February falls on 28 February in other years. */
export function upcomingBirthdays(contacts, window, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const on = (y, m, d) => (m === 2 && d === 29 && !isLeap(y) ? Date.UTC(y, 1, 28) : Date.UTC(y, m - 1, d));
  const out = [];
  for (const c of contacts) {
    if (!c.birthday) continue;
    const { month, day, year } = c.birthday;
    let y = now.getFullYear();
    let next = on(y, month, day);
    if (next < today) next = on(++y, month, day);
    const until = Math.round((next - today) / 86400e3);
    if (until > window) continue;
    const nd = new Date(next);
    out.push({
      name: c.name,
      id: c.id,
      date: `${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`,
      days_until: until,
      turning: year ? y - year : null,
      ...(month === 2 && day === 29 && nd.getUTCDate() === 28 ? { note: "Born on 29 February; shown on 28 February this year." } : {}),
    });
  }
  return out.sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name));
}

async function contactsBirthdays({ days } = {}) {
  const window = clampInt(days, 0, 366, 30);
  return { window_days: window, birthdays: upcomingBirthdays(await allContacts(), window) };
}

export const tools = [
  defineTool({
    name: "contacts_search", app: "contacts", title: "Search contacts", annotations: READ, handler: contactsSearch,
    description: "Search all contacts by name, nickname, company, job, phone, email, address, note or related name (e.g. 'brother'); every word must match, accents ignored. An empty query lists everyone. Returns full cards: phones, emails, addresses, birthday, related names, URLs, note.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { query: { type: "string" }, limit: { type: "integer", description: "Max contacts (default 25, up to 500)." }, offset: { type: "integer", description: "Skip this many (paging)." } },
    },
  }),
  defineTool({
    name: "contacts_birthdays", app: "contacts", title: "Upcoming birthdays", annotations: READ, handler: contactsBirthdays,
    description: "Contacts whose birthday falls within the next N days (default 30, up to 366; today is 0), with the age they turn when the birth year is known. For one person's birthday use contacts_search.",
    inputSchema: { type: "object", additionalProperties: false, properties: { days: { type: "integer" } } },
  }),
];
