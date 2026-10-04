// Fake mode must answer from fixtures and never spawn osascript or the EventKit helper.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { eventkit } from "../src/lib/eventkit.js";
import { defineScript, jxa } from "../src/lib/osascript.js";

const ECHO = defineScript("example.echo", "function run(argv) { return argv[0]; }");
const OTHER = defineScript("example.other", "function run(argv) { return argv[0]; }");

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-basic.json", import.meta.url));
let saved;
before(() => { saved = process.env.KAIROS_FAKE; process.env.KAIROS_FAKE = FIXTURE; });
after(() => { if (saved === undefined) delete process.env.KAIROS_FAKE; else process.env.KAIROS_FAKE = saved; });

test("jxa answers from the matching fixture case", async () => {
  assert.deepEqual(await jxa(ECHO, { mode: "hello", extra: 1 }), { greeting: "Hello, Ada Example" });
});

test("jxa fixture errors are thrown", async () => {
  await assert.rejects(jxa(ECHO, { mode: "fail" }), /Example failure/);
});

test("missing fixtures fail loudly", async () => {
  await assert.rejects(jxa(OTHER, {}), /no osascript fixture/);
  await assert.rejects(eventkit(["reminders", "list", "--json"]), /no eventkit fixture/);
});

test("eventkit answers by exact args", async () => {
  const out = await eventkit(["calendar", "list", "--start", "2030-01-01", "--end", "2030-01-02", "--json"]);
  assert.equal(out[0].title, "Kairos Test event");
});

test("eventkit refuses anything but calendar and reminders commands", async () => {
  await assert.rejects(eventkit(["sync", "push"]), /not allowed/);
});
