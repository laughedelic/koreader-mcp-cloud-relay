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

  // Check for error from failed login attempt
  const error = c.req.query("error");
  const errorDeviceId = c.req.query("device_id") || "";

  const loginPage = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Connect to KOReader Device</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 450px;
            width: 100%;
          }
          h1 {
            margin: 0 0 10px;
            color: #333;
            font-size: 24px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 30px;
            line-height: 1.5;
          }
          .error {
            background: #fee;
            border: 1px solid #fcc;
            color: #c00;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 14px;
          }
          .form-group {
            margin-bottom: 20px;
          }
          label {
            display: block;
            font-weight: 600;
            margin-bottom: 8px;
            color: #333;
          }
          input[type="text"], input[type="password"] {
            width: 100%;
            padding: 14px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.2s;
          }
          input:focus {
            outline: none;
            border-color: #667eea;
          }
          .hint {
            font-size: 12px;
            color: #888;
            margin-top: 6px;
          }
          .actions {
            display: flex;
            gap: 12px;
            margin-top: 30px;
          }
          button {
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            transition: transform 0.1s, box-shadow 0.2s;
          }
          button:active {
            transform: scale(0.98);
          }
          .connect {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            flex: 1;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
          }
          .connect:hover {
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
          }
          .cancel {
            background: #f0f0f0;
            color: #666;
          }
          .client-info {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 25px;
            font-size: 14px;
          }
          .client-info strong {
            color: #333;
          }
          .instructions {
            background: #e8f4fd;
            border-left: 4px solid #667eea;
            padding: 15px;
            margin-bottom: 25px;
            font-size: 14px;
            line-height: 1.6;
          }
          .instructions ol {
            margin: 10px 0 0 0;
            padding-left: 20px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>📚 Connect to KOReader</h1>
          <p class="subtitle">Enter your device credentials to authorize access.</p>
          
          <div class="instructions">
            <strong>How to find your credentials:</strong>
            <ol>
              <li>Open KOReader on your device</li>
              <li>Go to: ☰ Menu → Tools → MCP Server → Status</li>
              <li>Find your Device ID and Passcode</li>
            </ol>
          </div>

          <div class="client-info">
            <strong>${clientInfo.clientName || "MCP Client"}</strong> is requesting access to your KOReader device.
          </div>

          ${error ? `<div class="error">❌ ${error === "invalid_credentials" ? "Invalid device ID or passcode. Please check your credentials and try again." : "Authentication failed. Please try again."}</div>` : ""}

          <form method="POST" action="/authorize">
            <input type="hidden" name="oauth_state" value="${btoa(JSON.stringify(oauthReqInfo))}">
            
            <div class="form-group">
              <label for="device_id">Device ID</label>
              <input 
                type="text" 
                id="device_id" 
                name="device_id" 
                placeholder="e.g., kobo-library"
                value="${errorDeviceId}"
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]{4,22}[a-zA-Z0-9]"
                autocomplete="username"
              >
              <p class="hint">6-24 characters, letters, numbers, and hyphens</p>
            </div>

            <div class="form-group">
              <label for="passcode">Passcode</label>
              <input 
                type="password" 
                id="passcode" 
                name="passcode" 
                placeholder="Enter your 6-digit passcode"
                required
                minlength="6"
                maxlength="6"
                pattern="[0-9]{6}"
                autocomplete="current-password"
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
    const verifyResponse = await stub.fetch(new Request("http://internal/verify-passcode", {
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
    return c.text("Failed to verify credentials", 500);
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
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            margin: 0;
            padding: 40px 20px;
          }
          .container {
            max-width: 800px;
            margin: 0 auto;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            margin-bottom: 30px;
          }
          h1 {
            margin: 0 0 10px;
            color: #333;
          }
          h2 {
            color: #444;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
          }
          .subtitle {
            color: #666;
            font-size: 18px;
            margin-bottom: 30px;
          }
          .endpoint {
            background: #f5f5f5;
            padding: 12px 15px;
            border-radius: 6px;
            margin: 10px 0;
            font-family: "SF Mono", Monaco, monospace;
            font-size: 14px;
            display: flex;
            gap: 10px;
          }
          .method {
            background: #667eea;
            color: white;
            padding: 2px 8px;
            border-radius: 4px;
            font-weight: 600;
            font-size: 12px;
          }
          .method.get { background: #22c55e; }
          .method.post { background: #3b82f6; }
          ol, ul {
            line-height: 1.8;
          }
          code {
            background: #f0f0f0;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: "SF Mono", Monaco, monospace;
          }
          .url-box {
            background: #1a1a2e;
            color: #00ff88;
            padding: 15px 20px;
            border-radius: 8px;
            font-family: "SF Mono", Monaco, monospace;
            margin: 15px 0;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h1>📚 MCP Relay for KOReader</h1>
            <p class="subtitle">Connect AI assistants to your e-reader via the Model Context Protocol</p>
            
            <h2>Quick Start</h2>
            <ol>
              <li>Enable MCP Server in KOReader (Menu → Tools → MCP Server)</li>
              <li>Note your <strong>Device ID</strong> and <strong>Passcode</strong></li>
              <li>Add this server to your MCP client:</li>
            </ol>
            
            <div class="url-box">${baseUrl}/{deviceId}/mcp</div>
            
            <p>Replace <code>{deviceId}</code> with your actual device ID (e.g., <code>kobo-library</code>).</p>

            <h2>OAuth Endpoints</h2>
            <div class="endpoint"><span class="method get">GET</span> /.well-known/oauth-authorization-server</div>
            <div class="endpoint"><span class="method get">GET</span> /.well-known/oauth-protected-resource</div>
            <div class="endpoint"><span class="method get">GET</span> /authorize</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/token</div>
            <div class="endpoint"><span class="method post">POST</span> /oauth/register</div>

            <h2>Device Endpoints</h2>
            <div class="endpoint"><span class="method post">POST</span> /{deviceId}/mcp - MCP requests (requires auth)</div>
            <div class="endpoint"><span class="method get">GET</span> /{deviceId}/status - Check if device is online</div>
            <div class="endpoint"><span class="method post">POST</span> /{deviceId}/register - Device registration</div>
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
