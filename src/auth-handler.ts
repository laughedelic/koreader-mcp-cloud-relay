/**
 * OAuth Authorization Handler
 * 
 * Implements the /authorize endpoint for MCP OAuth 2.1 Authorization Code flow.
 * Users authenticate with a one-time pairing code shown on their KOReader
 * device (or, for older plugins, the device ID and permanent passcode).
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./types";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: AuthEnv }>();

/**
 * Extract device ID from OAuth resource URL
 * e.g., "https://relay.example.com/my-kindle/mcp" -> "my-kindle"
 */
function extractDeviceIdFromResource(resource: string | undefined): string | null {
  if (!resource) return null;
  try {
    const url = new URL(resource);
    const parts = url.pathname.split("/").filter(Boolean);
    // Expect path like /{deviceId}/mcp or /{deviceId}/.well-known/...
    if (parts.length >= 1) {
      const deviceId = parts[0].toLowerCase();
      // Validate format (hyphen at end to avoid regex /v flag issues)
      if (/^[a-z0-9][a-z0-9\-]{4,22}[a-z0-9]$/i.test(deviceId)) {
        return deviceId;
      }
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/** Escape text for HTML element content and quoted attribute values */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i;

interface LoginPageOptions {
  oauthState: string;
  clientName?: string;
  error?: string;
  lockedDeviceId?: string;
  legacyDeviceId?: string;
  showLegacy?: boolean;
}

function renderLoginPage(opts: LoginPageOptions): string {
  const client = opts.clientName ? escapeHtml(opts.clientName.slice(0, 80)) : "Your AI app";
  const legacyOpen = opts.showLegacy || !!opts.lockedDeviceId;
  const deviceIdField = opts.lockedDeviceId
    ? `<input type="hidden" name="device_id" value="${escapeHtml(opts.lockedDeviceId)}">
       <div class="device-info">Connecting to device: <code>${escapeHtml(opts.lockedDeviceId)}</code></div>`
    : `<div class="form-group">
         <label for="device_id">Device ID</label>
         <input type="text" id="device_id" name="device_id" placeholder="e.g., kindle-a1b2c3d4"
           value="${escapeHtml(opts.legacyDeviceId || "")}" autocomplete="username"
           autocapitalize="none" spellcheck="false">
       </div>`;

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connect to KOReader</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f6f7f9; min-height: 100vh; margin: 0; padding: 24px;
        display: flex; align-items: center; justify-content: center; color: #111827;
      }
      .card {
        background: #fff; border-radius: 12px; padding: 28px; width: 100%; max-width: 420px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.08);
      }
      h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
      .subtitle { color: #4b5563; margin: 0 0 20px; font-size: 14px; line-height: 1.5; }
      .error {
        background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
        padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;
      }
      .form-group { margin-bottom: 14px; }
      label { display: block; font-weight: 500; margin-bottom: 6px; color: #374151; font-size: 13px; }
      input[type="text"], input[type="password"] {
        width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px;
        font-size: 15px; background: #fff;
      }
      input.code {
        font-size: 28px; letter-spacing: 0.3em; text-align: center; padding: 12px;
        font-family: "SF Mono", Monaco, Menlo, monospace;
      }
      input:focus { outline: none; border-color: #111827; box-shadow: 0 0 0 3px rgba(17,24,39,0.08); }
      .hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
      button {
        width: 100%; margin-top: 18px; padding: 11px 20px; border: none; border-radius: 8px;
        background: #111827; color: #fff; font-size: 15px; font-weight: 500; cursor: pointer;
      }
      details { margin-top: 22px; border-top: 1px solid #e5e7eb; padding-top: 14px; }
      summary { cursor: pointer; font-size: 13px; color: #4b5563; }
      details .form-group:first-of-type { margin-top: 14px; }
      .device-info {
        background: #f9fafb; border: 1px solid #e5e7eb; padding: 10px 12px; border-radius: 8px;
        margin: 14px 0; font-size: 13px; color: #4b5563;
      }
      code { font-family: "SF Mono", Monaco, monospace; background: #e5e7eb; padding: 2px 6px; border-radius: 4px; color: #111827; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connect to KOReader</h1>
      <p class="subtitle">${client} wants to read the book open on your e-reader.
        On the reader, open <strong>MCP server &rsaquo; Connect an AI app</strong> and enter the code it shows.</p>

      ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ""}

      <form method="POST" action="/authorize">
        <input type="hidden" name="oauth_state" value="${escapeHtml(opts.oauthState)}">

        <div class="form-group">
          <label for="pairing_code">Pairing code</label>
          <input type="text" class="code" id="pairing_code" name="pairing_code"
            inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7"
            placeholder="000000" ${legacyOpen ? "" : "autofocus"}>
          <p class="hint">6 digits, valid for 10 minutes.</p>
        </div>

        <details ${legacyOpen ? "open" : ""}>
          <summary>Older plugin? Use device ID and passcode</summary>
          ${deviceIdField}
          <div class="form-group">
            <label for="passcode">Passcode</label>
            <input type="password" id="passcode" name="passcode" inputmode="numeric"
              pattern="[0-9]{6}" maxlength="6" autocomplete="current-password">
          </div>
        </details>

        <button type="submit">Connect</button>
      </form>
    </div>
  </body>
</html>`;
}

function encodeOAuthState(info: AuthRequest): string {
  return btoa(JSON.stringify(info));
}

/**
 * GET /authorize - OAuth authorization endpoint
 *
 * Shows the sign-in form: a one-time pairing code from the reader, or (for
 * older plugins) the device ID and permanent passcode.
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo: AuthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) {
    return c.text("Invalid client_id", 400);
  }

  const resource = Array.isArray(oauthReqInfo.resource) ? oauthReqInfo.resource[0] : oauthReqInfo.resource;
  const resourceDeviceId = extractDeviceIdFromResource(resource);

  return c.html(renderLoginPage({
    oauthState: encodeOAuthState(oauthReqInfo),
    clientName: clientInfo.clientName,
    lockedDeviceId: resourceDeviceId || undefined,
  }));
});

/**
 * POST /authorize - Handle the sign-in form
 *
 * Resolves the device from the pairing code (or device ID + passcode),
 * then completes the OAuth flow. Errors re-render the form in place.
 */
app.post("/authorize", async (c) => {
  const formData = await c.req.formData();
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const oauthState = field("oauth_state");
  const pairingCode = field("pairing_code").replace(/\s+/g, "");
  const deviceIdInput = field("device_id").toLowerCase();
  const passcode = field("passcode");

  if (!oauthState) {
    return c.text("Missing OAuth state", 400);
  }
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthState));
  } catch {
    return c.text("Invalid OAuth state", 400);
  }
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) {
    return c.text("Invalid client_id", 400);
  }
  const resource = Array.isArray(oauthReqInfo.resource) ? oauthReqInfo.resource[0] : oauthReqInfo.resource;
  const lockedDeviceId = extractDeviceIdFromResource(resource) || undefined;

  const fail = (error: string, status: 400 | 401 | 429 | 500 = 401, showLegacy = false) => c.html(renderLoginPage({
    oauthState,
    clientName: clientInfo.clientName,
    error,
    lockedDeviceId,
    legacyDeviceId: deviceIdInput,
    showLegacy,
  }), status);

  let deviceId: string;
  try {
    if (pairingCode) {
      const stub = c.env.PAIRING_INDEX.get(c.env.PAIRING_INDEX.idFromName("global"));
      const res = await stub.fetch(new Request("http://internal/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode, ip: c.req.header("CF-Connecting-IP") || "unknown" }),
      }));
      const body = await res.json() as { deviceId?: string; error?: string };
      if (!res.ok || !body.deviceId) {
        return fail(body.error || "That code didn't work. Get a new one on your reader.", res.status === 429 ? 429 : 401);
      }
      deviceId = body.deviceId;
      if (lockedDeviceId && deviceId !== lockedDeviceId) {
        return fail("That code belongs to a different reader.");
      }
    } else {
      deviceId = lockedDeviceId || deviceIdInput;
      if (!deviceId || !passcode) {
        return fail("Enter the pairing code shown on your reader.", 400, !!(deviceIdInput || passcode));
      }
      if (!DEVICE_ID_PATTERN.test(deviceId)) {
        return fail("Invalid device ID or passcode.", 401, true);
      }
      const stub = c.env.MCP_RELAY.get(c.env.MCP_RELAY.idFromName(deviceId));
      const res = await stub.fetch(new Request(`http://internal/${deviceId}/verify-passcode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      }));
      if (!res.ok) {
        let message = "Invalid device ID or passcode.";
        try {
          const body = await res.json() as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // keep the generic message
        }
        return fail(message, res.status === 429 ? 429 : 401, true);
      }
    }
  } catch (error) {
    console.error("Sign-in verification error:", error);
    return fail("Couldn't check the code. Please try again.", 500);
  }

  const clientName = (clientInfo.clientName || "").slice(0, 80);
  try {
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: deviceId,
      metadata: {
        label: `KOReader: ${deviceId}`,
        deviceId,
        clientName,
        method: pairingCode ? "pairing-code" : "passcode",
      },
      scope: oauthReqInfo.scope,
      props: { deviceId },
    });
    console.log(JSON.stringify({ event: "authorize", deviceId, method: pairingCode ? "pairing-code" : "passcode", clientName }));
    return c.redirect(redirectTo, 302);
  } catch (error) {
    console.error("completeAuthorization error:", error);
    return c.text(`Failed to complete authorization: ${error instanceof Error ? error.message : "Unknown error"}`, 500);
  }
});

// ============================================
// Device endpoints for pairing and connected apps
// (authenticated with the device secret via the device's Durable Object)
// ============================================

/** Authenticate a device request; returns the device ID or an error response */
async function authenticateDeviceRequest(
  c: { req: { header: (name: string) => string | undefined }; env: AuthEnv },
  options: { enablePairingCodes?: boolean } = {},
): Promise<{ deviceId: string } | { error: Response }> {
  const deviceId = (c.req.header("X-Device-Id") || "").trim().toLowerCase();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return { error: Response.json({ error: "X-Device-Id is required", code: "MISSING_DEVICE_ID" }, { status: 400 }) };
  }
  const stub = c.env.MCP_RELAY.get(c.env.MCP_RELAY.idFromName(deviceId));
  const res = await stub.fetch(new Request(`http://internal/${deviceId}/device-auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": c.req.header("Authorization") || "",
    },
    body: JSON.stringify(options),
  }));
  if (!res.ok) {
    // Buffered, so the device gets a Content-Length response rather than a stream
    return { error: new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } }) };
  }
  return { deviceId };
}

/**
 * POST /pairing-code - Device asks for a one-time pairing code
 * Headers: X-Device-Id, Authorization: Device <secret>
 * Response: { code, expiresAt, expiresIn, relayUrl }
 */
app.post("/pairing-code", async (c) => {
  const auth = await authenticateDeviceRequest(c, { enablePairingCodes: true });
  if ("error" in auth) return auth.error;
  const stub = c.env.PAIRING_INDEX.get(c.env.PAIRING_INDEX.idFromName("global"));
  const res = await stub.fetch(new Request("http://internal/mint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: auth.deviceId }),
  }));
  const body = await res.json() as Record<string, unknown>;
  if (res.ok) body.relayUrl = `${new URL(c.req.url).origin}/mcp`;
  return c.json(body, res.status as 200);
});

/**
 * GET /connected-apps - Device lists the AI apps it has authorized
 * Response: { apps: [{ id, name, connectedAt }] }
 */
app.get("/connected-apps", async (c) => {
  const auth = await authenticateDeviceRequest(c);
  if ("error" in auth) return auth.error;
  const apps: { id: string; name: string; connectedAt: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.OAUTH_PROVIDER.listUserGrants(auth.deviceId, { limit: 100, cursor });
    for (const grant of page.items) {
      let name = typeof grant.metadata?.clientName === "string" ? grant.metadata.clientName : "";
      if (!name) {
        const client = await c.env.OAUTH_PROVIDER.lookupClient(grant.clientId);
        name = client?.clientName || "Unknown app";
      }
      apps.push({ id: grant.id, name, connectedAt: grant.createdAt });
    }
    cursor = page.cursor;
  } while (cursor && apps.length < 500);
  apps.sort((a, b) => b.connectedAt - a.connectedAt);
  return c.json({ apps });
});

/**
 * DELETE /connected-apps/:id - Device disconnects an AI app (revokes its grant and tokens)
 */
app.delete("/connected-apps/:id", async (c) => {
  const auth = await authenticateDeviceRequest(c);
  if ("error" in auth) return auth.error;
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param("id"), auth.deviceId);
  return c.json({ ok: true });
});

/**
 * GET / - Home page with instructions
 */
app.get("/", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MCP Relay for KOReader</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            margin: 0;
            padding: 40px 20px;
          }
          .container {
            max-width: 700px;
            margin: 0 auto;
          }
          .card {
            background: white;
            border-radius: 8px;
            padding: 32px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 24px;
          }
          h1 {
            margin: 0 0 8px;
            color: #1a1a1a;
            font-size: 24px;
          }
          h2 {
            color: #333;
            font-size: 16px;
            margin: 24px 0 12px;
            font-weight: 600;
          }
          .subtitle {
            color: #666;
            font-size: 15px;
            margin-bottom: 24px;
          }
          .endpoint {
            background: #f9f9f9;
            padding: 8px 12px;
            border-radius: 4px;
            margin: 6px 0;
            font-family: "SF Mono", Monaco, monospace;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .method {
            background: #e5e5e5;
            color: #333;
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: 600;
            font-size: 11px;
          }
          .method.get { background: #dcfce7; color: #166534; }
          .method.post { background: #dbeafe; color: #1e40af; }
          ol {
            line-height: 1.8;
            padding-left: 20px;
          }
          code {
            background: #f0f0f0;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: "SF Mono", Monaco, monospace;
            font-size: 13px;
          }
          .url-box {
            background: #1a1a1a;
            color: #4ade80;
            padding: 12px 16px;
            border-radius: 6px;
            font-family: "SF Mono", Monaco, monospace;
            font-size: 14px;
            margin: 12px 0;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h1>MCP Relay for KOReader</h1>
            <p class="subtitle">Connect AI assistants to your e-reader via the Model Context Protocol</p>
            
            <h2>Quick Start</h2>
            <ol>
              <li>Enable the MCP server in KOReader (Menu → Tools → MCP server) with the cloud relay on</li>
              <li>Add this URL to your AI app as a custom connector:</li>
            </ol>
            
            <div class="url-box">${baseUrl}/mcp</div>
            
            <ol start="3">
              <li>When the app asks you to sign in, open <strong>MCP server → Connect an AI app</strong> on the reader and enter the 6-digit code it shows</li>
            </ol>

            <h2>OAuth Endpoints</h2>
            <div class="endpoint"><span class="method get">GET</span> /.well-known/oauth-authorization-server</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/token</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/register</div>

            <h2>Device Endpoints</h2>
            <div class="endpoint"><span class="method post">POST</span> /mcp</div>
            <div class="endpoint"><span class="method get">GET</span> /status</div>
          </div>
        </div>
      </body>
    </html>
  `);
});

/**
 * GET /mcp/.well-known/oauth-protected-resource
 * OAuth Protected Resource Metadata for the unified /mcp endpoint
 */
app.get("/mcp/.well-known/oauth-protected-resource", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    resource: origin, // see protectedResourceMetadata in index.ts
    authorization_servers: [origin],
    scopes_supported: ["mcp:access"],
    bearer_methods_supported: ["header"],
  });
});

/**
 * Catch-all for other routes - pass through to Durable Objects
 */
app.all("/:deviceId/*", async (c) => {
  const deviceId = c.req.param("deviceId");
  
  // Validate deviceId format
  if (!/^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i.test(deviceId)) {
    return c.json({
      error: {
        code: "INVALID_DEVICE_ID",
        message: "Invalid device ID format",
      }
    }, 400);
  }

  const url = new URL(c.req.url);
  const action = url.pathname.split("/").filter(Boolean)[1] || "";

  // The per-device MCP path is not an OAuth-protected route, so it can't be
  // served here: MCP clients must use the unified /mcp endpoint.
  if (action === "mcp") {
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32600, message: `Use ${url.origin}/mcp as the MCP server URL` },
      id: null,
    }, 404);
  }

  // Internal-only endpoints are never reachable from outside
  if (action === "verify-passcode" || action === "device-auth") {
    return c.json({ error: { code: "NOT_FOUND", message: "Not Found" } }, 404);
  }

  // Get Durable Object for this device
  const doId = c.env.MCP_RELAY.idFromName(deviceId);
  const stub = c.env.MCP_RELAY.get(doId);

  // Forward request to Durable Object
  // Add headers for DO; never pass through a client-supplied authentication marker
  const headers = new Headers(c.req.raw.headers);
  headers.delete("X-OAuth-Authenticated");
  headers.set("X-Relay-Base-URL", url.origin);

  return stub.fetch(new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
  }));
});

export { app as AuthHandler };
