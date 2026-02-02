/**
 * OAuth Authorization Handler
 * 
 * Implements the /authorize endpoint for MCP OAuth 2.1 Authorization Code flow.
 * Users authenticate by entering the passcode displayed on their KOReader device.
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
      const deviceId = parts[0];
      // Validate format
      if (/^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i.test(deviceId)) {
        return deviceId;
      }
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * GET /authorize - OAuth authorization endpoint
 * 
 * Shows a login form where users enter the device ID and passcode
 * from their KOReader device.
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo: AuthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);

  if (!clientInfo) {
    return c.text("Invalid client_id", 400);
  }

  // Extract device ID from resource URL
  const resource = Array.isArray(oauthReqInfo.resource) ? oauthReqInfo.resource[0] : oauthReqInfo.resource;
  const resourceDeviceId = extractDeviceIdFromResource(resource);
  
  // Check for error from failed login attempt
  const error = c.req.query("error");
  const errorDeviceId = c.req.query("device_id") || "";
  
  // Use device ID from: 1) error redirect, 2) resource URL, 3) empty
  const deviceId = errorDeviceId || resourceDeviceId || "";
  const deviceIdFromResource = !!resourceDeviceId && !errorDeviceId;

  const loginPage = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Connect to KOReader</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .card {
            background: white;
            border-radius: 8px;
            padding: 32px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 100%;
          }
          h1 {
            margin: 0 0 8px;
            color: #1a1a1a;
            font-size: 20px;
            font-weight: 600;
          }
          .subtitle {
            color: #666;
            margin-bottom: 24px;
            font-size: 14px;
          }
          .error {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #b91c1c;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 16px;
            font-size: 14px;
          }
          .form-group {
            margin-bottom: 16px;
          }
          label {
            display: block;
            font-weight: 500;
            margin-bottom: 6px;
            color: #333;
            font-size: 14px;
          }
          input[type="text"], input[type="password"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 15px;
          }
          input:focus {
            outline: none;
            border-color: #333;
          }
          input[readonly] {
            background: #f9f9f9;
            color: #666;
          }
          .hint {
            font-size: 12px;
            color: #888;
            margin-top: 4px;
          }
          .actions {
            display: flex;
            gap: 10px;
            margin-top: 24px;
          }
          button {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          }
          .connect {
            background: #1a1a1a;
            color: white;
            flex: 1;
          }
          .connect:hover {
            background: #333;
          }
          .cancel {
            background: #f0f0f0;
            color: #666;
          }
          .cancel:hover {
            background: #e5e5e5;
          }
          .device-info {
            background: #f9f9f9;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 13px;
            color: #555;
          }
          .device-info code {
            color: #1a1a1a;
            font-family: "SF Mono", Monaco, monospace;
            background: #e5e5e5;
            padding: 2px 6px;
            border-radius: 3px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Connect to KOReader</h1>
          <p class="subtitle">Enter the passcode shown on your device.</p>

          ${deviceIdFromResource ? `
          <div class="device-info">
            Connecting to device: <code>${deviceId}</code>
          </div>
          ` : ""}

          ${error ? `<div class="error">Invalid credentials. Please check and try again.</div>` : ""}

          <form method="POST" action="/authorize">
            <input type="hidden" name="oauth_state" value="${btoa(JSON.stringify(oauthReqInfo))}">
            
            ${deviceIdFromResource ? `
            <input type="hidden" name="device_id" value="${deviceId}">
            ` : `
            <div class="form-group">
              <label for="device_id">Device ID</label>
              <input 
                type="text" 
                id="device_id" 
                name="device_id" 
                placeholder="e.g., kobo-library"
                value="${deviceId}"
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]{4,22}[a-zA-Z0-9]"
                autocomplete="username"
              >
              <p class="hint">Shown in KOReader: Menu → Tools → MCP Server</p>
            </div>
            `}

            <div class="form-group">
              <label for="passcode">Passcode</label>
              <input 
                type="password" 
                id="passcode" 
                name="passcode" 
                placeholder="6-digit code"
                required
                minlength="6"
                maxlength="6"
                pattern="[0-9]{6}"
                autocomplete="current-password"
                autofocus
              >
              <p class="hint">6-digit code shown on your device</p>
            </div>

            <div class="actions">
              <button type="button" class="cancel" onclick="window.close()">Cancel</button>
              <button type="submit" class="connect">Connect</button>
            </div>
          </form>
        </div>
      </body>
    </html>
  `;

  return c.html(loginPage);
});

/**
 * POST /authorize - Handle authorization form submission
 * 
 * Verifies the device ID and passcode, then completes the OAuth flow.
 */
app.post("/authorize", async (c) => {
  const formData = await c.req.formData();
  const oauthState = formData.get("oauth_state");
  const deviceId = formData.get("device_id") as string;
  const passcode = formData.get("passcode") as string;

  if (!oauthState || typeof oauthState !== "string") {
    return c.text("Missing OAuth state", 400);
  }

  if (!deviceId || !passcode) {
    return c.text("Missing device ID or passcode", 400);
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthState));
  } catch {
    return c.text("Invalid OAuth state", 400);
  }

  // Verify credentials with the device's Durable Object
  const doId = c.env.MCP_RELAY.idFromName(deviceId);
  const stub = c.env.MCP_RELAY.get(doId);
  
  try {
    // The DO expects paths like /{deviceId}/verify-passcode
    const verifyResponse = await stub.fetch(new Request(`http://internal/${deviceId}/verify-passcode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    }));

    if (!verifyResponse.ok) {
      // Redirect back to authorize with error
      const url = new URL(c.req.url);
      url.searchParams.set("error", "invalid_credentials");
      url.searchParams.set("device_id", deviceId);
      // Preserve original OAuth parameters
      for (const [key, value] of Object.entries(oauthReqInfo)) {
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        } else if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(" "));
        }
      }
      return c.redirect(url.toString(), 302);
    }
  } catch (error) {
    console.error("Verify passcode error:", error);
    return c.text(`Failed to verify credentials: ${error instanceof Error ? error.message : "Unknown error"}`, 500);
  }

  // Credentials valid - complete OAuth authorization
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: deviceId,
    metadata: {
      label: `KOReader: ${deviceId}`,
      deviceId: deviceId,
    },
    scope: oauthReqInfo.scope,
    props: {
      deviceId: deviceId,
    },
  });

  // Redirect back to the MCP client with authorization code
  return c.redirect(redirectTo, 302);
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
              <li>Enable MCP Server in KOReader (Menu → Tools → MCP Server)</li>
              <li>Note your <strong>Device ID</strong> and <strong>Passcode</strong></li>
              <li>Add this URL to your MCP client:</li>
            </ol>
            
            <div class="url-box">${baseUrl}/{deviceId}/mcp</div>
            
            <p style="font-size: 14px; color: #666;">Replace <code>{deviceId}</code> with your device ID.</p>

            <h2>OAuth Endpoints</h2>
            <div class="endpoint"><span class="method get">GET</span> /.well-known/oauth-authorization-server</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/token</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/register</div>

            <h2>Device Endpoints</h2>
            <div class="endpoint"><span class="method post">POST</span> /{deviceId}/mcp</div>
            <div class="endpoint"><span class="method get">GET</span> /{deviceId}/status</div>
          </div>
        </div>
      </body>
    </html>
  `);
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

  // Get Durable Object for this device
  const doId = c.env.MCP_RELAY.idFromName(deviceId);
  const stub = c.env.MCP_RELAY.get(doId);

  // Forward request to Durable Object
  const url = new URL(c.req.url);
  
  // Add headers for DO
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Relay-Base-URL", url.origin);

  return stub.fetch(new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
  }));
});

export { app as AuthHandler };
