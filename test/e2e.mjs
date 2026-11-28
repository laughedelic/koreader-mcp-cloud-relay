#!/usr/bin/env node
/**
 * End-to-end test of the relay against a local `wrangler dev`.
 *
 *   npx wrangler dev --port 8787          # in one terminal
 *   node test/e2e.mjs [http://127.0.0.1:8787]
 *
 * It plays both sides: a reader (register, long-poll, answer, push
 * snapshots) and AI apps (dynamic client registration, pairing code,
 * OAuth code flow with PKCE, MCP requests). It takes about a minute,
 * mostly waiting for the reader to count as offline.
 */

import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

const TOOLS = [
  { name: "get_reading_context", title: "Get reading context", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_book_metadata", title: "Get book metadata", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "read_pages", title: "Read pages", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "search_book", title: "Search book", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "goto_page", title: "Go to page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "annotate", title: "Highlight or add note", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "future_tool", title: "A tool newer than this relay", inputSchema: { type: "object", properties: {} } },
];

class Reader {
  constructor() {
    this.deviceId = "test-" + randomBytes(5).toString("hex");
    this.secret = b64url(randomBytes(32));
    this.polling = false;
    this.handled = [];
  }

  headers(extra = {}) {
    return { "X-Device-Id": this.deviceId, Authorization: `Device ${this.secret}`, ...extra };
  }

  async register() {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: this.deviceId,
        passcodeHash: sha256hex("123456"),
        deviceSecret: this.secret,
        deviceName: "Test reader",
        version: "9.9.9",
        manifest: {
          tools: TOOLS,
          instructions: "Test instructions from the reader.",
          serverInfo: { name: "koreader-mcp", title: "KOReader", version: "9.9.9" },
        },
      }),
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  /** Long-poll and answer every request with an echo, until stop() */
  start() {
    this.polling = true;
    this.loop = (async () => {
      while (this.polling) {
        this.controller = new AbortController();
        let message;
        try {
          const res = await fetch(`${BASE}/poll`, { headers: this.headers(), signal: this.controller.signal });
          message = await res.json();
        } catch {
          continue;
        }
        if (message.type !== "request") continue;
        const request = JSON.parse(message.body);
        this.handled.push(request.method);
        await fetch(`${BASE}/response`, {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            requestId: message.requestId,
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { from: "reader", method: request.method } }),
          }),
        });
      }
    })();
  }

  async stop() {
    this.polling = false;
    this.controller?.abort();
    await this.loop;
  }

  async pairingCode() {
    const res = await fetch(`${BASE}/pairing-code`, { method: "POST", headers: this.headers() });
    assert.equal(res.status, 200);
    return (await res.json()).code;
  }

  snapshot(method, body, extraHeaders = {}) {
    return fetch(`${BASE}/snapshot`, {
      method,
      headers: this.headers({ ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders }),
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

const SNAPSHOT = {
  v: 1,
  taken_at: Math.floor(Date.now() / 1000),
  scope: "pages",
  retention_days: 7,
  book: { title: "The Test Book", authors: "A. Writer", language: "en", format: "epub", total_pages: 300 },
  position: { page: 118, percent_finished: 0.39, chapter: { name: "Chapter Seven", index: 7, start_page: 110, end_page: 131 } },
  toc: [
    { index: 1, title: "Chapter One", page: 1, depth: 1 },
    { index: 7, title: "Chapter Seven", page: 110, depth: 1 },
    { index: 8, title: "Chapter Eight", page: 132, depth: 1 },
  ],
  annotations: [
    { text: "a remarkable sentence", note: "Ask about this later", page: 40, chapter: "Chapter Two", datetime: "2026-11-20 10:00:00" },
    { text: "another highlight", page: 117, chapter: "Chapter Seven", datetime: "2026-11-27 21:00:00" },
  ],
  pages: [
    { number: 117, text: "Page one-seventeen text. **another highlight** follows here." },
    { number: 118, text: "She said “Don’t look back” and walked on. The lighthouse was dark." },
    { number: 119, text: "Page one-nineteen text, where the secret is revealed." },
    { number: 120, text: "Page one-twenty text." },
  ],
};

// ---------------------------------------------------------------------------
// An AI app
// ---------------------------------------------------------------------------

class App {
  constructor(name) {
    this.name = name;
    this.redirectUri = "http://localhost:9/callback";
    this.nextId = 1;
  }

  async pair(code) {
    let res = await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: this.name,
        redirect_uris: [this.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    this.clientId = (await res.json()).client_id;

    const verifier = b64url(randomBytes(32));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "mcp:access",
      state: "xyz",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    res = await fetch(`${BASE}/authorize?${query}`);
    assert.equal(res.status, 200);
    const oauthState = (await res.text()).match(/name="oauth_state"\s+value="([^"]+)"/)?.[1];
    assert.ok(oauthState, "sign-in page carries the OAuth state");

    res = await fetch(`${BASE}/authorize`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ oauth_state: oauthState, pairing_code: code }),
    });
    assert.equal(res.status, 302, await res.clone().text());
    const authCode = new URL(res.headers.get("Location")).searchParams.get("code");

    res = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const tokens = await res.json();
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
  }

  async refresh() {
    const res = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: this.clientId }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const tokens = await res.json();
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
  }

  /** Send one JSON-RPC request the handshake-era way */
  async rpc(method, params = {}, extraHeaders = {}) {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.accessToken}`,
        "MCP-Protocol-Version": "2025-11-25",
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async tool(name, args = {}) {
    const { status, body } = await this.rpc("tools/call", { name, arguments: args });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.result, JSON.stringify(body));
    return { ...body.result, text: body.result.content?.[0]?.text ?? "" };
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

async function main() {
  const reader = new Reader();
  const registered = await reader.register();
  assert.equal(registered.deviceSecretRegistered, true);
  assert.equal(registered.offlineMemory?.maxBytes, 262144);
  assert.equal(registered.offlineMemory?.maxRetentionDays, 30);
  ok("register reports offline memory limits");

  // Snapshots need the device secret
  let res = await fetch(`${BASE}/snapshot`, { method: "PUT", headers: { "X-Device-Id": reader.deviceId }, body: "{}" });
  assert.equal(res.status, 401);
  ok("snapshot without the device secret is refused");

  // No paired app yet: nothing is kept
  res = await reader.snapshot("PUT", SNAPSHOT);
  assert.deepEqual(await res.json(), { stored: false, reason: "NO_PAIRED_APPS", apps: 0 });
  ok("snapshot with no paired app is not stored");

  reader.start();
  const app = new App("Test App One");
  await app.pair(await reader.pairingCode());
  ok("app paired with a one-time code");

  // Online: requests reach the reader untouched
  let { status, body } = await app.rpc("tools/list");
  assert.equal(status, 200);
  assert.deepEqual(body.result, { from: "reader", method: "tools/list" });
  ok("online request is answered by the reader");

  // Too soon after the first push
  res = await reader.snapshot("PUT", SNAPSHOT);
  assert.equal(res.status, 429);
  ok("snapshots are rate limited");
  await sleep(15500);

  res = await reader.snapshot("PUT", { ...SNAPSHOT, v: 2 });
  assert.equal(res.status, 400);
  await sleep(100);
  res = await reader.snapshot("PUT", SNAPSHOT);
  let stored = await res.json();
  assert.equal(stored.stored, true, JSON.stringify(stored));
  assert.equal(stored.apps, 1);
  assert.ok(stored.expiresAt - Date.now() <= 7 * 86400000 + 1000 && stored.expiresAt - Date.now() > 6.9 * 86400000);
  ok("snapshot stored for the paired app, with the requested retention");

  res = await reader.snapshot("GET");
  stored = await res.json();
  assert.equal(stored.stored, true);
  assert.equal(stored.scope, "pages");
  assert.ok(!JSON.stringify(stored).includes("Test Book"));
  ok("snapshot status shows no content");

  // Still online: the saved copy is not used
  ({ body } = await app.rpc("tools/call", { name: "get_reading_context", arguments: {} }));
  assert.equal(body.result.from, "reader");
  ok("online tool call still goes to the reader");

  // The reader vanishes with its long poll still open (as when WiFi drops).
  // The relay can't tell yet, so the first request is handed to that poll,
  // waits the request timeout, and is then answered from the saved copy.
  await reader.stop();
  await sleep(500);
  const started = Date.now();
  let result = await app.tool("get_reading_context");
  const waited = Date.now() - started;
  assert.ok(waited < 35000, `offline answer took ${waited} ms`);
  assert.match(result.text, /did not answer in time/);
  assert.match(result.text, /^\[Reader offline: answering from a saved copy\]/);
  assert.match(result.text, /on page 118 of 300/);
  assert.match(result.text, /pages 117-120 only/);
  assert.match(result.text, /The Test Book by A\. Writer/);
  assert.match(result.text, /Don’t look back/);
  assert.match(result.text, /Ask about this later/);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.reader.online, false);
  assert.equal(result.structuredContent.reader.source, "saved_copy");
  assert.equal(result.structuredContent.current_page.number, 118);
  ok(`offline get_reading_context answers from the saved copy (after ${waited} ms)`);

  // From here on the reader is known to be away: answers are immediate
  const t = Date.now();
  result = await app.tool("get_reading_context", { extra_pages_before: 1, extra_pages_after: 5 });
  assert.ok(Date.now() - t < 3000);
  assert.match(result.text, /== Page 117 ==/);
  assert.match(result.text, /== Current page: 118 ==/);
  assert.match(result.text, /== Page 120 ==/);
  assert.doesNotMatch(result.text, /== Page 121 ==/);
  ok("offline get_reading_context with extra pages");

  result = await app.tool("get_book_metadata");
  assert.match(result.text, /Title: The Test Book/);
  assert.match(result.text, /Progress: 39%/);
  assert.match(result.text, /7\. Chapter Seven \(page 110\)/);
  assert.equal(result.structuredContent.total_pages, 300);
  ok("offline get_book_metadata");

  result = await app.tool("read_pages", { pages: "119-120" });
  assert.match(result.text, /=== Page 119 ===\nPage one-nineteen text/);
  assert.match(result.text, /=== Page 120 ===/);
  assert.equal(result.isError, undefined);
  result = await app.tool("read_pages", { pages: "119-125" });
  assert.match(result.text, /5 of the requested pages are not in the saved copy/);
  result = await app.tool("read_pages", { pages: "10-12" });
  assert.equal(result.isError, true);
  assert.match(result.text, /Pages 10-12 is not in the saved copy\. The saved copy holds pages 117-120\./);
  result = await app.tool("read_pages", { chapter: 7 });
  assert.match(result.text, /Chapter: Chapter Seven\nPages: 110-131/);
  assert.match(result.text, /18 of the requested pages are not in the saved copy/);
  result = await app.tool("read_pages", { chapter: 1 });
  assert.equal(result.isError, true);
  ok("offline read_pages serves saved pages and names what is missing");

  result = await app.tool("search_book", { query: "Don't look back" });
  assert.match(result.text, /The rest of the book was NOT searched/);
  assert.match(result.text, /Page 118: .*\*\*Don’t look back\*\*/);
  assert.equal(result.structuredContent.total_count, 1);
  assert.equal(result.structuredContent.searched.whole_book, false);
  result = await app.tool("search_book", { query: "LIGHTHOUSE" });
  assert.equal(result.structuredContent.total_count, 1);
  result = await app.tool("search_book", { query: "LIGHTHOUSE", case_sensitive: true });
  assert.equal(result.structuredContent.total_count, 0);
  result = await app.tool("search_book", { query: "ask about this" });
  assert.match(result.text, /Found in 1 highlight or note/);
  result = await app.tool("search_book", { query: "nowhere to be found" });
  assert.match(result.text, /No results found for: nowhere to be found/);
  assert.match(result.text, /does not mean the text is absent/);
  ok("offline search_book covers saved pages and notes, and says so");

  for (const name of ["goto_page", "annotate", "future_tool"]) {
    result = await app.tool(name, { page: 5, text: "x" });
    assert.equal(result.isError, true);
    assert.match(result.text, /^\[Reader offline\]/);
    assert.match(result.text, /Nothing was changed/);
  }
  ({ body } = await app.rpc("tools/call", { name: "no_such_tool", arguments: {} }));
  assert.equal(body.error.code, -32602);
  ok("offline write tools refuse, unknown tools are errors");

  ({ body } = await app.rpc("tools/list"));
  assert.deepEqual(body.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  ({ body } = await app.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.version, "9.9.9");
  assert.equal(body.result.instructions, "Test instructions from the reader.");
  ({ status } = await app.rpc("ping"));
  assert.equal(status, 200);
  ok("offline initialize and tools/list match the reader's manifest");

  ({ body } = await app.rpc("resources/list"));
  assert.equal(body.result.resources.length, 4);
  ({ body } = await app.rpc("resources/read", { uri: "book://current/bookmarks" }));
  const bookmarks = JSON.parse(body.result.contents[0].text);
  assert.equal(bookmarks.notes.length, 1);
  assert.equal(bookmarks.highlights.length, 1);
  ({ body } = await app.rpc("resources/read", { uri: "book://current/pages/118" }));
  assert.match(body.result.contents[0].text, /=== Page 118 ===/);
  ({ body } = await app.rpc("resources/read", { uri: "library://books" }));
  assert.equal(body.error.code, -32002);
  ({ body } = await app.rpc("prompts/list"));
  assert.ok(body.result.prompts.length > 0);
  ({ body } = await app.rpc("prompts/get", { name: body.result.prompts[0].name, arguments: {} }));
  assert.match(body.result.messages[0].content.text, /saved copy/);
  ok("offline resources and prompts");

  // Stateless protocol (2026-07-28)
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const modernHeaders = { "MCP-Protocol-Version": "2026-07-28" };
  ({ status, body } = await app.rpc("server/discover", { _meta: modernMeta }, modernHeaders));
  assert.equal(status, 200);
  assert.ok(body.result.supportedVersions.includes("2026-07-28"));
  assert.equal(body.result.resultType, "complete");
  ({ body } = await app.rpc("tools/call", { name: "get_reading_context", arguments: {}, _meta: modernMeta }, modernHeaders));
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.ttlMs, 0);
  assert.equal(body.result._meta["io.modelcontextprotocol/serverInfo"].name, "koreader-mcp");
  assert.match(body.result.content[0].text, /saved copy/);
  ({ status, body } = await app.rpc("tools/list", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } }, { "MCP-Protocol-Version": "2099-01-01" }));
  assert.equal(body.error.code, -32022);
  ({ status } = await app.rpc("ping", { _meta: modernMeta }, modernHeaders));
  assert.equal(status, 404);
  ok("offline answers in the stateless protocol too");

  // A second app, paired after the snapshot was saved, can't open it...
  const second = new App("Test App Two");
  await second.pair(await reader.pairingCode());
  result = await second.tool("get_reading_context");
  assert.equal(result.isError, true);
  assert.match(result.text, /this app can't open it yet/);
  assert.doesNotMatch(result.text, /Test Book/);
  ok("an app paired after the snapshot can't read it");

  // ...until the reader saves again
  res = await reader.snapshot("PUT", { ...SNAPSHOT, position: { ...SNAPSHOT.position, page: 119 } });
  stored = await res.json();
  assert.equal(stored.apps, 2, JSON.stringify(stored));
  result = await second.tool("get_reading_context");
  assert.match(result.text, /on page 119 of 300/);
  result = await app.tool("get_reading_context");
  assert.match(result.text, /on page 119 of 300/);
  ok("the next snapshot is readable by both apps");

  // Tokens rotate; the key travels with the grant
  await app.refresh();
  result = await app.tool("get_book_metadata");
  assert.match(result.text, /Title: The Test Book/);
  ok("saved copy still readable after a token refresh");

  // Disconnecting an app
  res = await fetch(`${BASE}/connected-apps`, { headers: reader.headers() });
  const apps = (await res.json()).apps;
  assert.equal(apps.length, 2);
  const first = apps.find((entry) => entry.name === "Test App One");
  res = await fetch(`${BASE}/connected-apps/${first.id}`, { method: "DELETE", headers: reader.headers() });
  assert.equal(res.status, 200);
  ({ status } = await app.rpc("tools/list"));
  assert.equal(status, 401);
  res = await reader.snapshot("GET");
  assert.equal((await res.json()).apps, 1);
  ok("a disconnected app loses access and its key");

  // The reader comes back: live answers again
  reader.start();
  await sleep(300);
  ({ body } = await second.rpc("tools/call", { name: "get_reading_context", arguments: {} }));
  assert.equal(body.result.from, "reader");
  ok("back online, requests reach the reader again");

  // The reader says goodbye with its last snapshot (as before it sleeps):
  // its open poll is released and the next request is answered at once
  reader.polling = false; // like the plugin, it does not poll again after this
  res = await reader.snapshot("PUT", SNAPSHOT, { "X-Reader-Leaving": "1" });
  assert.ok(res.status === 200 || res.status === 429, `status ${res.status}`);
  await reader.stop();
  const asked = Date.now();
  result = await second.tool("get_reading_context");
  assert.ok(Date.now() - asked < 3000, `took ${Date.now() - asked} ms`);
  assert.match(result.text, /^\[Reader offline: answering from a saved copy\]/);
  assert.match(result.text, /is not connected right now/);
  ok("a reader that announces it is leaving is offline at once");

  // Forget
  res = await reader.snapshot("DELETE");
  assert.deepEqual(await res.json(), { ok: true, deleted: true });
  result = await second.tool("get_reading_context");
  assert.equal(result.isError, true);
  assert.match(result.text, /is not connected right now/);
  assert.match(result.text, /^\[Reader offline\]/);
  assert.match(result.text, /No saved copy of the book is available/);
  assert.match(result.text, /last seen/);
  result = await second.tool("annotate", { text: "x" });
  assert.equal(result.isError, true);
  ok("after forgetting, offline answers say the reader is offline");

  // Limits
  res = await reader.snapshot("PUT", { ...SNAPSHOT, pages: [{ number: 1, text: "x".repeat(1100000) }] });
  assert.equal(res.status, 413);
  ok("oversized snapshot is refused");

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error("\nFAILED:", error);
  process.exit(1);
});
