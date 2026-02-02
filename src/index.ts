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

// Re-export the Durable Object class
export { MCPRelay } from "./relay";

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
    
    // Parse path to extract deviceId and action
    // Expected format: /{deviceId}/mcp
    const pathParts = path.split("/").filter(Boolean);
    
    if (pathParts.length < 2) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid path. Expected /{deviceId}/mcp" },
        id: null,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [deviceId, action] = pathParts;
    
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

    // Get the Durable Object for this device
    const doId = typedEnv.MCP_RELAY.idFromName(deviceId);
    const stub = typedEnv.MCP_RELAY.get(doId);

    // Forward request to Durable Object
    const headers = new Headers(request.headers);
    headers.set("X-Relay-Base-URL", url.origin);
    headers.set("X-OAuth-Authenticated", "true");

    return stub.fetch(new Request(url.toString(), {
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
export default new OAuthProvider({
  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Protected API route - requires valid Bearer token
  // This pattern matches /{deviceId}/mcp endpoints
  apiRoute: ["/*/mcp"],
  apiHandler: mcpApiHandler,

  // Default handler for all other routes (auth UI, home page, device endpoints)
  // @ts-expect-error - Type mismatch between Hono and OAuthProvider
  defaultHandler: AuthHandler,
});
