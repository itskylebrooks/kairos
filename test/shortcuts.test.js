import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NOTES_SHORTCUTS, SHORTCUT_APPEND, SHORTCUT_CREATE, SHORTCUT_READ } from "../src/apps/notes-shortcuts.js";
import { UserError } from "../src/lib/errors.js";
import { shortcutError } from "../src/lib/shortcuts.js";
import { toPlist } from "../src/lib/wfbuild.js";

const WRITES = new Set(["is.workflow.actions.appendnote"]);
const actionsOf = (name) => NOTES_SHORTCUTS[name]().WFWorkflowActions;

test("every write action sits inside an If guard", () => {
  for (const name of Object.keys(NOTES_SHORTCUTS)) {
    const open = [];
    for (const a of actionsOf(name)) {
      const p = a.WFWorkflowActionParameters;
      if (a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional") {
        if (p.WFControlFlowMode === 0) open.push(p.GroupingIdentifier);
        else if (p.WFControlFlowMode === 2) assert.equal(open.pop(), p.GroupingIdentifier, `${name}: If blocks must nest`);
      }
      if (WRITES.has(a.WFWorkflowActionIdentifier)) assert.ok(open.length, `${name}: unguarded write`);
    }
    assert.deepEqual(open, [], `${name}: unclosed If`);
  }
});

test("the append guard compares the match count, as text, with 1", () => {
  const ifs = actionsOf(SHORTCUT_APPEND).filter((a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional" && a.WFWorkflowActionParameters.WFControlFlowMode === 0);
  assert.equal(ifs.length, 1);
  assert.equal(ifs[0].WFWorkflowActionParameters.WFConditionalActionString, "1");
  assert.equal(ifs[0].WFWorkflowActionParameters.WFCondition, 4);
});

test("the read shortcut reads a Body only inside its If matches is 1 guard (no note at all would wait for a person)", () => {
  const open = [];
  let bodies = 0;
  for (const a of actionsOf(SHORTCUT_READ)) {
    const p = a.WFWorkflowActionParameters;
    if (a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional") {
      if (p.WFControlFlowMode === 0) { assert.equal(p.WFConditionalActionString, "1"); open.push(p.GroupingIdentifier); } else open.pop();
    }
    if (JSON.stringify(p).includes('"PropertyName":"Body"')) { bodies++; assert.ok(open.length, "Body read outside the guard"); }
  }
  assert.equal(bodies, 1);
});

test("the read shortcut never writes", () => {
  for (const a of actionsOf(SHORTCUT_READ)) assert.ok(!WRITES.has(a.WFWorkflowActionIdentifier) && !/CreateNote/.test(a.WFWorkflowActionIdentifier));
});

test("finds never carry WFContentItemInputParameter (it would filter the input, not Notes)", () => {
  for (const name of Object.keys(NOTES_SHORTCUTS)) {
    for (const a of actionsOf(name)) {
      if (a.WFWorkflowActionIdentifier === "is.workflow.actions.filter.notes") assert.equal(a.WFWorkflowActionParameters.WFContentItemInputParameter, undefined);
    }
  }
});

test("action UUIDs are unique, also across builds", () => {
  const ids = [];
  for (let i = 0; i < 2; i++) for (const name of Object.keys(NOTES_SHORTCUTS)) for (const a of actionsOf(name)) ids.push(a.WFWorkflowActionParameters.UUID);
  assert.equal(new Set(ids).size, ids.length);
});

test("create passes the folder by name and the body only when there is one", () => {
  const acts = actionsOf(SHORTCUT_CREATE);
  const create = acts.find((a) => a.WFWorkflowActionIdentifier === "com.apple.Notes.CreateNoteLinkAction");
  assert.ok(create.WFWorkflowActionParameters.folder);
  assert.equal(create.WFWorkflowActionParameters.contents, undefined); // ignored by Notes on macOS 27
  const guard = acts.find((a) => a.WFWorkflowActionParameters.WFConditionalActionString === "yes");
  assert.ok(guard, "append of the body is guarded by has_body");
});

test("plists are valid", { skip: !existsSync("/usr/bin/plutil") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-plist-"));
  try {
    for (const name of Object.keys(NOTES_SHORTCUTS)) {
      const f = join(dir, "x.plist");
      writeFileSync(f, toPlist(NOTES_SHORTCUTS[name]()));
      execFileSync("/usr/bin/plutil", ["-lint", f], { stdio: "pipe" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shortcut failures become messages that say what to do", () => {
  const m = (msg) => shortcutError("Kairos: Append to Note", "Notes", msg);
  assert.match(m("Error: This shortcut can’t access “Notes”.").message, /Always Allow/);
  assert.match(m("Couldn’t find shortcut").message, /not installed/);
  assert.match(m("The shortcut could not be run because an action could not be found.").message, /install\.sh again/);
  assert.match(m("/usr/bin/shortcuts took longer than 90s and was stopped.").message, /click Cancel/);
  assert.ok(m("took longer than") instanceof UserError);
  assert.ok(!(m("something odd") instanceof UserError));
});
