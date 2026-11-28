/**
 * Shared pieces of the relay tests: a reader and an AI app that talk to a
 * relay over HTTP (default: a local `wrangler dev`, or RELAY_URL).
 */

import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

export const BASE = process.env.RELAY_URL || "http://127.0.0.1:8787";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
export const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export const TOOLS = [
  { name: "get_reading_context", title: "Get reading context", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_book_metadata", title: "Get book metadata", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "read_pages", title: "Read pages", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "search_book", title: "Search book", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "goto_page", title: "Go to page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "annotate", title: "Highlight or add note", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "future_tool", title: "A tool newer than this relay", inputSchema: { type: "object", properties: {} } },
];

export class Reader {
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

export const SNAPSHOT = {
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

export class App {
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

