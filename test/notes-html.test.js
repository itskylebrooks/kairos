import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeEntities, noteToMarkdown, parseBridgeItems } from "../src/lib/notes-html.js";

// Invented content, in the HTML shape Notes produced for it on macOS 27.
const SAMPLE = readFileSync(new URL("./fixtures/notes-sample.html", import.meta.url), "utf8");
const BRIDGE = [
  "Kairos Test sample", "",
  "\t⁃\tBullet one", "\t⁃\tBullet two", "\t⁃\tNested bullet (four spaces)", "\t⁃\tNested bullet (two spaces)",
  "\t1.\tNumbered one", "\t2.\tNumbered two",
  "\t◦\tOpen checklist item", "\t✓\tDone checklist item", "\t◦\tNested checklist item",
].join("\n");

test("entities with and without semicolons", () => {
  assert.equal(decodeEntities("&lth1&gt &amp&amp &quot;x&quot; &#228; &#x1F44B; &nbsp;"), "<h1> && \"x\" ä 👋  ");
  assert.equal(decodeEntities("&ltu&gt"), "<u>"); // a greedy name match would eat the u
  assert.equal(decodeEntities("&unknown; &"), "&unknown; &");
});

test("title is split off and headings keep their level", () => {
  const r = noteToMarkdown(SAMPLE);
  assert.equal(r.title, "Kairos Test sample");
  const lines = r.markdown.split("\n");
  assert.equal(lines[0], "# Kairos Spike Title");
  assert.ok(lines.includes("## Heading level two"));
  assert.ok(lines.includes("### Heading level three"));
  assert.ok(lines.includes("### Heading level four")); // Notes clamps to three levels
});

test("inline styles, links, tables and code", () => {
  const md = noteToMarkdown(SAMPLE).markdown;
  assert.match(md, /Plain paragraph with \*\*bold\*\*, \*italic\*, ~~strikethrough~~ and inline code\.\nSecond line of the same paragraph\./);
  assert.match(md, /\[A link\]\(https:\/\/example\.com\)/);
  assert.match(md, /\n\n\| Col A \| Col B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(md, /```\nfenced code block\n  keeps indentation\?\n```/);
});

test("text that looks like HTML or script stays text", () => {
  const md = noteToMarkdown(SAMPLE).markdown;
  assert.match(md, /Literal HTML: <h1>not a heading<\/h1> & <b>not bold<\/b>\./);
  assert.match(md, /Script-looking text: "\); do shell script "echo hi" --/);
  assert.match(md, /emoji 👋🏽 and a family 👨‍👩‍👧/);
});

test("without the bridge, bare lists are reported as unknown checklists", () => {
  const r = noteToMarkdown(SAMPLE);
  assert.equal(r.checklists, "unknown");
  assert.match(r.markdown, /\n- Open checklist item\n- Done checklist item\n {4}- Nested checklist item/);
  assert.match(r.markdown, /\n- Bullet one\n- Bullet two\n {4}- Nested bullet \(four spaces\)/);
  assert.match(r.markdown, /\n1\. Numbered one\n2\. Numbered two/);
});

test("with the bridge, checklist ticks are merged by position", () => {
  const r = noteToMarkdown(SAMPLE, parseBridgeItems(BRIDGE));
  assert.equal(r.checklists, "resolved");
  assert.match(r.markdown, /\n- \[ \] Open checklist item\n- \[x\] Done checklist item\n {4}- \[ \] Nested checklist item/);
  assert.match(r.markdown, /\n- Bullet one\n/);
});

test("a bridge that does not line up is ignored rather than guessed", () => {
  const r = noteToMarkdown(SAMPLE, parseBridgeItems("\t◦\tSomething else"));
  assert.equal(r.checklists, "unknown");
  assert.doesNotMatch(r.markdown, /\[x\]/);
});

test("notes without lists report none", () => {
  const r = noteToMarkdown("<div><h1>Ada's list</h1></div>\n<div>Just text.</div>");
  assert.deepEqual(r, { title: "Ada's list", markdown: "Just text.", checklists: "none" });
});

test("plain lines that look like Markdown are escaped", () => {
  const r = noteToMarkdown("<div>Title</div><div># not a heading</div><div>- not a list</div><div>3. not numbered</div>");
  assert.equal(r.markdown, "\\# not a heading\n\\- not a list\n3\\. not numbered");
});

test("characters Notes would read as formatting are escaped, and the title is not", () => {
  const r = noteToMarkdown("<div><h1>Plan *draft* v2_1</h1></div><div>Use file_name, a*b, `x` and [y]</div><div><b>real bold</b></div>");
  assert.equal(r.title, "Plan *draft* v2_1");
  assert.equal(r.markdown, "Use file\\_name, a\\*b, \\`x\\` and \\[y\\]\n**real bold**");
});

test("a line after a list gets a blank line so it is not read as part of the list", () => {
  const r = noteToMarkdown("<div>T</div><ul class=\"Apple-dash-list\"><li>a</li></ul><div>after</div>");
  assert.equal(r.markdown, "- a\n\nafter");
});

test("bridge marker parsing", () => {
  assert.deepEqual(parseBridgeItems("title\n\t◦\topen\n\t✓\tdone\n\t⁃\tdash\n\t•\tbullet\n\t12.\tnum\nplain"), [
    { kind: "check", checked: false, text: "open" },
    { kind: "check", checked: true, text: "done" },
    { kind: "dash", checked: false, text: "dash" },
    { kind: "bullet", checked: false, text: "bullet" },
    { kind: "ol", checked: false, text: "num" },
  ]);
});
