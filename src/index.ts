/**
 * MCP Relay - Cloudflare Worker
 * 
 * Entry point that implements OAuth 2.1 for MCP authentication using
 * @cloudflare/workers-oauth-provider.
 * 
 * Each KOReader device gets its own Durable Object identified by deviceId.
 * MCP clients authenticate via OAuth Authorization Code flow with PKCE.
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";
import type { Env } from "./types";
import { DEMO_DEVICE_ID, handleDemoMcp } from "./demo";

// Re-export the Durable Object class
export { MCPRelay } from "./relay";
export { PairingIndex } from "./pairing";

/**
 * MCP API Handler - handles authenticated MCP requests
 * 
 * This handler receives requests that have already been authenticated
 * by the OAuthProvider. The access token has been validated and the
 * user context (deviceId) is available.
 */
const mcpApiHandler = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const typedEnv = env as Env;
    const url = new URL(request.url);
    const path = url.pathname;
    const pathParts = path.split("/").filter(Boolean);
    const headerDeviceId = request.headers.get("X-Device-Id") || undefined;
    const contextProps = (ctx as unknown as { props?: { deviceId?: string; demoSession?: string } })?.props;
    const contextDeviceId = contextProps?.deviceId;

    let deviceId: string | undefined;
    let action: string | undefined;

    if (pathParts.length === 1 && pathParts[0] === "mcp") {
      deviceId = contextDeviceId || headerDeviceId;
      action = "mcp";
    } else if (pathParts.length >= 2) {
      deviceId = contextDeviceId || pathParts[0];
      action = pathParts[1];
    }

    if (deviceId) {
      deviceId = deviceId.toLowerCase();
    }

    if (!deviceId || action !== "mcp") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Missing device context for /mcp" },
        id: null,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // Only handle /mcp endpoint here (other endpoints don't need OAuth)
    if (action !== "mcp") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "This endpoint requires authentication" },
        id: null,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate deviceId format
    if (!/^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i.test(deviceId)) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid device ID format" },
        id: null,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // The built-in demo reader answers in the Worker itself
    // Only grants made with the demo code (marked with demoSession), and only
    // while the demo is enabled
    if (deviceId === DEMO_DEVICE_ID) {
      if (!typedEnv.DEMO_PAIRING_CODE || !contextProps?.demoSession) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "The demo reader is not available" },
          id: null,
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleDemoMcp(request, contextProps.demoSession);
    }

    // Get the Durable Object for this device
    const doId = typedEnv.MCP_RELAY.idFromName(deviceId);
    const stub = typedEnv.MCP_RELAY.get(doId);

    // Forward request to Durable Object
    const headers = new Headers(request.headers);
    headers.set("X-Relay-Base-URL", url.origin);
    headers.set("X-OAuth-Authenticated", "true");

    const forwardUrl = new URL(request.url);
    forwardUrl.pathname = `/${deviceId}/mcp`;

    return stub.fetch(new Request(forwardUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
    }));
  },
};

/**
 * Export the OAuthProvider as the default export
 * 
 * The OAuthProvider automatically handles:
 * - /.well-known/oauth-authorization-server metadata
 * - /.well-known/oauth-protected-resource metadata  
 * - /oauth/token endpoint (authorization code exchange)
 * - /oauth/register endpoint (dynamic client registration)
 * - Token validation for protected routes
 */
const oauthProvider = new OAuthProvider({
  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Protected API route - requires valid Bearer token
  // Use a stable prefix so OAuthProvider can match it
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,

  // Default handler for all other routes (auth UI, home page, device endpoints)
  // @ts-expect-error - Type mismatch between Hono and OAuthProvider
  defaultHandler: AuthHandler,
  onError: (error) => {
    if (error.code === "invalid_token") {
      const headers = {
        ...error.headers,
        "WWW-Authenticate": `Bearer realm="mcp", error="invalid_token", error_description="${error.description}", resource_metadata="/mcp/.well-known/oauth-protected-resource"`,
      };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: error.description },
        id: null,
      }), {
        status: error.status,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      });
    }
  },
});

/**
 * RFC 9728 Protected Resource Metadata for the /mcp endpoint.
 *
 * Served here, before the OAuth provider, because the provider treats every
 * path under its apiRoute ("/mcp") as protected and would answer
 * /mcp/.well-known/... with 401. Available at the RFC 9728 location
 * (/.well-known/oauth-protected-resource/mcp), the root location, and the
 * legacy /mcp/.well-known/oauth-protected-resource path.
 */
const PROTECTED_RESOURCE_METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
  "/mcp/.well-known/oauth-protected-resource",
]);

function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function protectedResourceMetadata(origin: string): Response {
  return new Response(JSON.stringify({
    // The origin, not `${origin}/mcp`: clients put this in the OAuth `resource`
    // parameter, it becomes the token's audience, and workers-oauth-provider
    // 0.2.x accepts only an audience equal to the request origin. MCP clients
    // accept a resource that is a prefix of the server URL. Switch to the /mcp
    // URL after upgrading to a provider with path-aware audience matching (1.x).
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: ["mcp:access"],
    bearer_methods_supported: ["header"],
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * Give /mcp auth failures an absolute resource_metadata URL (onError has no
 * access to the request origin) and let browser clients read the challenge.
 */
function finalizeMcpAuthResponse(response: Response, origin: string): Response {
  if (response.status !== 401) return response;
  const headers = new Headers(response.headers);
  const challenge = headers.get("WWW-Authenticate");
  if (challenge) {
    headers.set("WWW-Authenticate",
      challenge.replace(/resource_metadata="[^"]*"/, `resource_metadata="${protectedResourceMetadataUrl(origin)}"`));
  } else {
    headers.set("WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${protectedResourceMetadataUrl(origin)}"`);
  }
  headers.set("Access-Control-Allow-Origin", headers.get("Access-Control-Allow-Origin") || "*");
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (PROTECTED_RESOURCE_METADATA_PATHS.has(pathname) && (request.method === "GET" || request.method === "HEAD")) {
      return protectedResourceMetadata(url.origin);
    }

    // CORS preflights for the root device endpoints: answered here, since
    // they carry no device ID to route by and would otherwise reach OAuth
    if (request.method === "OPTIONS" &&
        ["/register", "/poll", "/pong", "/response", "/status"].includes(pathname)) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Device endpoints are now root-level and identified by X-Device-Id
    if (pathname === "/register" && request.method === "POST") {
      let bodyText = "";
      try {
        bodyText = await request.clone().text();
        const payload = JSON.parse(bodyText);
        const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim().toLowerCase() : "";
        if (!deviceId) {
          return new Response(JSON.stringify({ error: "deviceId is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (deviceId === DEMO_DEVICE_ID) {
          return new Response(JSON.stringify({ error: "This device ID is reserved", code: "RESERVED_DEVICE_ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const doId = env.MCP_RELAY.idFromName(deviceId);
        const stub = env.MCP_RELAY.get(doId);
        const forwardUrl = new URL(request.url);
        forwardUrl.pathname = `/${deviceId}/register`;

        const headers = new Headers(request.headers);
        headers.delete("X-OAuth-Authenticated");
        headers.set("X-Relay-Base-URL", url.origin);

        return stub.fetch(new Request(forwardUrl.toString(), {
          method: request.method,
          headers,
          body: bodyText,
        }));
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if ((pathname === "/poll" && request.method === "GET") ||
        (pathname === "/pong" && request.method === "POST") ||
        (pathname === "/response" && request.method === "POST") ||
        (pathname === "/status" && request.method === "GET")) {
      const headerDeviceId = request.headers.get("X-Device-Id") || "";
      const queryDeviceId = url.searchParams.get("device_id") || "";
      const deviceId = (headerDeviceId || queryDeviceId).trim().toLowerCase();

      if (!deviceId || deviceId === DEMO_DEVICE_ID) {
        return new Response(JSON.stringify({ error: "deviceId is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const doId = env.MCP_RELAY.idFromName(deviceId);
      const stub = env.MCP_RELAY.get(doId);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/${deviceId}${pathname}`;

      const headers = new Headers(request.headers);
      headers.delete("X-OAuth-Authenticated");
      headers.set("X-Relay-Base-URL", url.origin);

      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    const response = await oauthProvider.fetch(request, env, ctx);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      return finalizeMcpAuthResponse(response, url.origin);
    }
    return response;
  },
};
