import assert from "node:assert/strict";
import { test } from "node:test";
import { APPS, readConfig } from "../src/lib/config.js";

test("defaults: every app readable, nothing writable", () => {
  const c = readConfig({});
  assert.deepEqual([...c.apps], APPS);
  assert.equal(c.write.size, 0);
  assert.deepEqual(c.warnings, []);
});

test("parses lists, trims and lowercases", () => {
  const c = readConfig({ KAIROS_APPS: " Notes, calendar ,", KAIROS_WRITE: "notes" });
  assert.deepEqual([...c.apps].sort(), ["calendar", "notes"]);
  assert.deepEqual([...c.write], ["notes"]);
});

test("warns about unknown apps, unwritable apps and writes for disabled apps", () => {
  const c = readConfig({ KAIROS_APPS: "notes,messages", KAIROS_WRITE: "notes,contacts,mail,bogus" });
  assert.deepEqual([...c.apps], ["notes"]);
  assert.deepEqual([...c.write], ["notes"]);
  assert.equal(c.warnings.length, 4);
  assert.match(c.warnings.join("\n"), /messages/);
  assert.match(c.warnings.join("\n"), /contacts has no write tools/);
  assert.match(c.warnings.join("\n"), /mail is not in KAIROS_APPS/);
  assert.match(c.warnings.join("\n"), /bogus/);
});
