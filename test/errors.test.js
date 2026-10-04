import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError, isPermissionError, permissionError } from "../src/lib/errors.js";

test("recognizes osascript permission failures", () => {
  assert.equal(isPermissionError(new Error("execution error: Not authorized to send Apple events to Notes. (-1743)")), true);
  assert.equal(isPermissionError("Error -10004"), true);
  assert.equal(isPermissionError(new Error("Can't get object.")), false);
});

test("permission errors say what to allow and where", () => {
  const e = permissionError("Notes");
  assert.ok(e instanceof UserError);
  assert.match(e.message, /Notes/);
  assert.match(e.message, /Privacy & Security > Automation/);
});
