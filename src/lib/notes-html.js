// Notes body HTML (as JXA returns it) to Markdown, plus checklist state from the Shortcuts
// rendering. Shapes observed on macOS 27 (docs/notes-spike.md):
//   - one <div> per line; <div><br></div> is an empty line
//   - headings as <div><b><h2>Text</h2></b><font><h2><br></h2></font></div>
//   - lists as <ul>/<ol>; nested lists are SIBLINGS of their parent <li>, not children;
//     dashed lists carry class="Apple-dash-list"; checklists are a bare <ul>, without state
//   - entities sometimes lack the semicolon (&lt, &amp)

const VOID = new Set(["br", "img", "hr", "meta", "input"]);

/** @typedef {{ tag: string, attrs: Record<string,string>, children: Node[] } | { text: string }} Node */

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the named entities above (with or without ";") and numeric ones. */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITY[k] ?? m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** A lenient parser: unknown closing tags are ignored, unclosed ones close at their parent. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+|<)/g;
  for (const m of String(html ?? "").matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.children.push({ text: decodeEntities(m[5]) }); continue; }
    if (!m[2]) continue; // comment
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3]), children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  return root;
}

const isEl = (n) => n && "tag" in n;

/** Plain text of a subtree (no Markdown). */
export function plainText(n) {
  if (!isEl(n)) return n.text;
  if (n.tag === "br") return "\n";
  return n.children.map(plainText).join("");
}

const WRAP = { b: "**", strong: "**", i: "*", em: "*", strike: "~~", s: "~~", del: "~~", tt: "`", code: "`" };

/** Escapes characters Notes' Markdown importer would read as formatting (it honours "\"). */
export const escapeInline = (t) => t.replace(/[\\`*_~[\]]/g, "\\$&");
const unescapeInline = (t) => t.replace(/\\([\\`*_~[\]])/g, "$1");

/** Inline Markdown of a subtree. Headings inside are rendered as plain inline text. */
function inline(n) {
  if (!isEl(n)) return escapeInline(n.text.replace(/ /g, " "));
  if (n.tag === "br") return "\n";
  if (n.tag === "img") return "\\[image\\]";
  const inner = n.children.map(inline).join("");
  const w = WRAP[n.tag];
  if (w) {
    // Keep markers tight around the text: "** bold **" would not parse.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? `${m[1]}${w}${m[2]}${w}${m[3]}` : inner;
  }
  if (n.tag === "a" && n.attrs.href) return inner.trim() ? `[${inner}](${n.attrs.href})` : inner;
  return inner;
}

const HEADING = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };

/** The first heading element with text in a subtree, if any. */
function findHeading(n) {
  if (!isEl(n)) return null;
  if (HEADING[n.tag] && plainText(n).trim()) return n;
  for (const c of n.children) { const h = findHeading(c); if (h) return h; }
  return null;
}

/**
 * @typedef {{ type: "line", text: string }
 *   | { type: "heading", level: number, text: string }
 *   | { type: "item", kind: "dash"|"ul"|"ol", depth: number, index: number, text: string, plain: string, bridge?: BridgeItem }
 *   | { type: "table", rows: string[][] }
 *   | { type: "code", text: string }} Block
 */

/** @returns {Block[]} */
export function toBlocks(html) {
  const out = [];
  const walk = (n, depth) => {
    if (!isEl(n)) {
      const t = n.text.replace(/ /g, " ");
      if (t.trim()) out.push({ type: "line", text: t.trim() });
      return;
    }
    if (n.tag === "ul" || n.tag === "ol") {
      const kind = n.tag === "ol" ? "ol" : /Apple-dash-list/.test(n.attrs.class || "") ? "dash" : "ul";
      let index = 0;
      for (const c of n.children) {
        if (isEl(c) && c.tag === "li") {
          const text = inline(c).replace(/\n+/g, " ").trim();
          out.push({ type: "item", kind, depth, index: ++index, text, plain: plainText(c).trim() });
        } else if (isEl(c) && (c.tag === "ul" || c.tag === "ol")) {
          walk(c, depth + 1);
        }
      }
      return;
    }
    if (n.tag === "table") {
      const rows = [];
      const collect = (x) => {
        if (!isEl(x)) return;
        if (x.tag === "tr") rows.push(x.children.filter((c) => isEl(c) && (c.tag === "td" || c.tag === "th")).map((c) => inline(c).replace(/\n+/g, " ").trim()));
        else x.children.forEach(collect);
      };
      collect(n);
      out.push({ type: "table", rows });
      return;
    }
    if (n.tag === "div" || n.tag === "p" || n.tag === "#root" || n.tag === "object" || n.tag === "body" || n.tag === "html") {
      const blockChild = n.children.some((c) => isEl(c) && ["div", "p", "ul", "ol", "table", "object"].includes(c.tag));
      if (n.tag !== "div" && n.tag !== "p" || blockChild) {
        // Container: inline runs between block children become their own lines.
        let run = [];
        const flush = () => {
          if (!run.length) return;
          const holder = { tag: "div", attrs: {}, children: run };
          run = [];
          lineOf(holder);
        };
        for (const c of n.children) {
          if (isEl(c) && ["div", "p", "ul", "ol", "table", "object"].includes(c.tag)) { flush(); walk(c, depth); }
          else if (isEl(c) || c.text.trim()) run.push(c); // skip whitespace between tags
        }
        flush();
        return;
      }
      lineOf(n);
      return;
    }
    lineOf({ tag: "div", attrs: {}, children: [n] });
  };
  const lineOf = (div) => {
    const tt = monoText(div);
    if (tt !== null) { out.push({ type: "code", text: tt }); return; }
    const h = findHeading(div);
    if (h) { out.push({ type: "heading", level: HEADING[h.tag], text: inline(h).replace(/(?<!\\)\*\*/g, "").replace(/\n+/g, " ").trim() }); return; }
    const t = inline(div).replace(/\n+$/, "");
    if (!t.trim()) { out.push({ type: "line", text: "" }); return; }
    for (const part of t.split("\n")) out.push({ type: "line", text: part.trimEnd() });
  };
  walk(parseHtml(html), 0);
  return out;
}

/** The plain text of a line that is monostyled as a whole, else null. */
function monoText(div) {
  const kids = div.children.filter((c) => isEl(c) ? c.tag !== "br" : c.text.trim());
  if (kids.length !== 1 || !isEl(kids[0]) || (kids[0].tag !== "tt" && kids[0].tag !== "code")) return null;
  return plainText(kids[0]).replace(/\n+$/, "");
}

/* ---------- checklist state from the Shortcuts rendering ---------- */

/** @typedef {{ kind: "check"|"dash"|"bullet"|"ol", checked: boolean, text: string }} BridgeItem */

/** Parses list lines of the App Intents body: "\t<marker>\t<text>". */
export function parseBridgeItems(body) {
  const items = [];
  for (const line of String(body ?? "").split("\n")) {
    const m = /^\t+(◦|✓|⁃|•|\d+\.)\t(.*)$/.exec(line);
    if (!m) continue;
    const mk = m[1];
    items.push({
      kind: mk === "◦" || mk === "✓" ? "check" : mk === "⁃" ? "dash" : mk === "•" ? "bullet" : "ol",
      checked: mk === "✓",
      text: m[2].trim(),
    });
  }
  return items;
}

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

/**
 * Note HTML to Markdown. The first line (the note's title) is returned separately.
 * @param {string} html
 * @param {BridgeItem[] | null} [bridge]  list items from the Shortcuts rendering, if read
 * @returns {{ title: string, markdown: string, checklists: "resolved" | "unknown" | "none" }}
 */
export function noteToMarkdown(html, bridge = null) {
  const blocks = toBlocks(html);
  while (blocks.length && blocks[0].type === "line" && !blocks[0].text) blocks.shift();
  let title = "";
  const first = blocks[0];
  if (first && (first.type === "heading" || first.type === "line")) { title = unescapeInline(first.text.replace(/(?<!\\)(\*\*|\*|~~|`)/g, "")); blocks.shift(); }

  const items = blocks.filter((b) => b.type === "item");
  const maybeChecklists = items.some((b) => b.kind === "ul");
  let resolved = false;
  if (bridge && bridge.length === items.length && items.every((b, i) => norm(bridge[i].text) === norm(b.plain))) {
    items.forEach((b, i) => { b.bridge = bridge[i]; });
    resolved = true;
  }

  const lines = [];
  let prev = null;
  for (const b of blocks) {
    // Markdown would read a line right after a list as part of the last item.
    const leavingList = prev && (prev.type === "item" || prev.type === "table") && b.type !== "item";
    if (leavingList && !(b.type === "line" && !b.text)) lines.push("");
    if (b.type === "code") {
      if (prev?.type !== "code") { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); lines.push("```"); }
      lines.push(b.text);
      prev = b;
      continue;
    }
    if (prev?.type === "code") { lines.push("```"); if (!(b.type === "line" && !b.text)) lines.push(""); }
    if (b.type === "line") lines.push(escapeLineStart(b.text));
    else if (b.type === "heading") lines.push(`${"#".repeat(b.level)} ${b.text}`);
    else if (b.type === "table") {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(...tableMd(b.rows));
    }
    else lines.push(`${"    ".repeat(b.depth)}${itemMarker(b)}${b.text}`);
    prev = b;
  }
  if (prev?.type === "code") lines.push("```");
  const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return { title, markdown, checklists: !maybeChecklists ? "none" : resolved ? "resolved" : "unknown" };
}

function itemMarker(b) {
  const br = b.bridge;
  if (br) {
    if (br.kind === "check") return br.checked ? "- [x] " : "- [ ] ";
    if (br.kind === "ol") return `${b.index}. `;
    return "- ";
  }
  if (b.kind === "ol") return `${b.index}. `;
  return "- "; // dashed list, or a bare <ul> whose type (bullet or checklist) is unknown
}

// A plain line that starts like Markdown syntax would change meaning when written back.
export const escapeLineStart = (t) => t
  .replace(/^(\s*)(\d+)([.)]\s)/, "$1$2\\$3")
  .replace(/^(\s*)(#{1,6}\s|[-+]\s|>\s?)/, "$1\\$2");

function tableMd(rows) {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (c) => (c ?? "").replace(/\|/g, "\\|");
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}
