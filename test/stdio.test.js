// End to end: spawn the real entry point and talk to it over stdio.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));

function session(lines, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, err, messages: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    child.stdin.end(lines.join("\n") + "\n");
  });
}

test("initialize, tools/list, then a clean exit when stdin closes", async () => {
  const { code, err, messages } = await session([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  assert.equal(messages.length, 2);
  assert.equal(byId[1].result.protocolVersion, "2025-11-25");
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["notes_folders", "notes_list", "notes_search", "notes_read"]);
  assert.match(err, /\[kairos\] v\d/);
});

test("garbage input gets a parse error and does not kill the server", async () => {
  const { code, messages } = await session(["{not json", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })]);
  assert.equal(code, 0);
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 3, result: {} });
});

test("config warnings go to stderr, never stdout", async () => {
  const { messages, err } = await session([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })], { KAIROS_APPS: "notes,messages" });
  assert.equal(messages.length, 1);
  assert.match(err, /unknown app "messages"/);
});
