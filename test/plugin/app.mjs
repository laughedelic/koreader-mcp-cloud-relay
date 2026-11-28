#!/usr/bin/env node
/**
 * The AI app's half of the plugin test (see run.sh). The reader's half is
 * reader.lua, which runs the real plugin code; the two take turns through
 * flag files in a shared folder.
 */

import assert from "node:assert/strict";
import { App, sleep } from "../lib.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const DIR = process.argv[2];
const flag = (name) => { writeFileSync(`${DIR}/${name}`, "1"); console.log(`app: ${name}`); };
async function waitFlag(name, seconds = 90) {
  for (let i = 0; i < seconds * 10; i++) { if (existsSync(`${DIR}/${name}`)) return readFileSync(`${DIR}/${name}`, "utf8"); await sleep(100); }
  throw new Error(`timed out waiting for ${name}`);
}
const [, code] = (await waitFlag("code")).split(" ");
const app = new App("Lua test app");
await app.pair(code);
console.log("app: paired");
await waitFlag("stored");

// Online: the real plugin answers
let { body } = await app.rpc("tools/list");
const liveTools = body.result.tools.map((t) => t.name);
let result = await app.tool("get_reading_context");
assert.match(result.text, /Text of page 118/);
assert.doesNotMatch(result.text, /Reader offline/);
console.log("app: online answer:", JSON.stringify(result.text.slice(0, 160)));
const init = (await app.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } })).body.result;
flag("online_ok");

// The reader said goodbye: saved copy at once
await waitFlag("left");
let t = Date.now();
result = await app.tool("get_reading_context");
assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
assert.match(result.text, /^\[Reader offline: answering from a saved copy\]/);
assert.match(result.text, /is not connected right now/);
assert.match(result.text, /on page 122 of 300/);
assert.match(result.text, /Text of page 122/);
assert.match(result.text, /pages 120-132 only/);
console.log("app: offline answer:\n" + result.text.split("\n").slice(0, 12).join("\n"));
// Same tools and instructions as the live reader
({ body } = await app.rpc("tools/list"));
assert.deepEqual(body.result.tools.map((x) => x.name), liveTools);
const offlineInit = (await app.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } })).body.result;
assert.equal(offlineInit.instructions.startsWith(init.instructions), true);
assert.deepEqual(offlineInit.serverInfo, init.serverInfo);
result = await app.tool("search_book", { query: "remarkable" });
assert.match(result.text, /page 40/i);
result = await app.tool("get_book_metadata");
assert.match(result.text, /Chapter Seven/);
flag("offline_ok");

await waitFlag("background");
result = await app.tool("get_reading_context");
assert.match(result.text, /on page 125 of 300/);
flag("background_ok");

await waitFlag("forgotten");
result = await app.tool("get_reading_context");
assert.match(result.text, /No saved copy of the book is available/);
await waitFlag("done", 120);
result = await app.tool("get_reading_context");
assert.match(result.text, /No saved copy of the book is available/);
console.log("app: all app-side checks passed");
