/**
 * MCP Relay - Cloudflare Worker
 * 
 * Entry point that routes requests to the appropriate Durable Object instance.
 * Each device gets its own Durable Object identified by deviceId.
 * 
 * Implements OAuth 2.0 Protected Resource Metadata (RFC 9728) for MCP authorization.
 */

import { Env, ErrorResponse, ProtectedResourceMetadata, TokenRequest, TokenResponse, OAuthError } from "./types";

// Re-export the Durable Object class
export { MCPRelay } from "./relay";

// Token expiration time (1 hour)
const TOKEN_EXPIRY_SECONDS = 3600;

/**
 * Main Worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = `${url.protocol}//${url.host}`;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Handle root path - show welcome/info
    if (path === "/" || path === "") {
      return corsResponse(new Response(
        JSON.stringify({
          name: "MCP Relay",
          description: "Cloud relay for KOReader MCP server with OAuth authentication",
          version: "2.0.0",
          docs: "https://github.com/laughedelic/mcp-relay-cloudflare",
          oauth: {
            protected_resource_metadata: `${baseUrl}/.well-known/oauth-protected-resource`,
            token_endpoint: `${baseUrl}/oauth/token`,
          },
          endpoints: {
            "GET /": "This info page",
            "GET /.well-known/oauth-protected-resource": "OAuth Protected Resource Metadata (RFC 9728)",
            "POST /oauth/token": "OAuth token endpoint (password grant)",
            "GET /{deviceId}/status": "Check if device is online",
            "POST /{deviceId}/mcp": "Forward MCP request to device (requires Bearer token)",
            "POST /{deviceId}/register": "Device registration (returns passcode on first registration)",
            "GET /{deviceId}/poll": "Poll for requests (device only)",
            "POST /{deviceId}/response": "Send response (device only)",
            "POST /{deviceId}/pong": "Keep-alive heartbeat (device only)",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      ));
    }

    // OAuth Protected Resource Metadata (RFC 9728)
    if (path === "/.well-known/oauth-protected-resource") {
      const metadata: ProtectedResourceMetadata = {
        resource: baseUrl,
        authorization_servers: [baseUrl], // We act as our own auth server
        scopes_supported: ["mcp:access"],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://github.com/laughedelic/mcp-relay-cloudflare",
      };
      return corsResponse(new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    // OAuth Authorization Server Metadata (simplified)
    if (path === "/.well-known/oauth-authorization-server") {
      const metadata = {
        issuer: baseUrl,
        token_endpoint: `${baseUrl}/oauth/token`,
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: ["password"],
        scopes_supported: ["mcp:access"],
        response_types_supported: [],
      };
      return corsResponse(new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    // OAuth Token Endpoint
    if (path === "/oauth/token" && request.method === "POST") {
      return handleTokenRequest(request, env, baseUrl);
    }

    // Parse path to extract deviceId and action
    // Expected formats:
    //   /{deviceId}/mcp    - HTTP MCP request from client
    //   /{deviceId}/status - Status check
    //   /{deviceId}/register - Device registration
    //   /{deviceId}/poll   - Device polling
    //   /{deviceId}/response - Device response
    //   /{deviceId}/pong   - Device heartbeat
    //   /{deviceId}/.well-known/oauth-protected-resource - Device-specific metadata
    const pathParts = path.split("/").filter(Boolean);
    
    if (pathParts.length < 2) {
      return jsonError("Invalid path. Expected /{deviceId}/{action}", "INVALID_PATH", 400);
    }

    const [deviceId, ...rest] = pathParts;
    const action = rest.join("/"); // Handle .well-known paths

    // Validate deviceId format (alphanumeric with optional hyphens, 6-24 characters)
    if (!/^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i.test(deviceId)) {
      return jsonError(
        "Invalid device ID. Must be 6-24 alphanumeric characters (hyphens allowed in middle).",
        "INVALID_DEVICE_ID",
        400
      );
    }

    // Device-specific Protected Resource Metadata
    if (action === ".well-known/oauth-protected-resource") {
      const metadata: ProtectedResourceMetadata = {
        resource: `${baseUrl}/${deviceId}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["mcp:access"],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://github.com/laughedelic/mcp-relay-cloudflare",
      };
      return corsResponse(new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    // Validate action
    const validActions = ["mcp", "status", "register", "poll", "response", "pong"];
    if (!validActions.includes(action)) {
      return jsonError(
        `Invalid action: ${action}. Valid actions: ${validActions.join(", ")}`,
        "INVALID_ACTION",
        400
      );
    }

    // Get or create Durable Object for this device
    // We use the deviceId as the name so the same device always gets the same DO
    const id = env.MCP_RELAY.idFromName(deviceId);
    const stub = env.MCP_RELAY.get(id);

    // Forward request to Durable Object
    // Rewrite URL to just the action path (DO handles the rest)
    const doUrl = new URL(request.url);
    doUrl.pathname = `/${deviceId}/${action}`;

    // Pass the JWT secret and base URL via headers to the DO
    const headers = new Headers(request.headers);
    headers.set("X-Relay-Base-URL", baseUrl);
    if (env.JWT_SECRET) {
      headers.set("X-JWT-Secret", env.JWT_SECRET);
    }

    return stub.fetch(new Request(doUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
    }));
  },
};

/**
 * Handle OAuth token request (password grant)
 */
async function handleTokenRequest(request: Request, env: Env, baseUrl: string): Promise<Response> {
  let body: TokenRequest;
  
  // Parse request body (support both JSON and form-urlencoded)
  const contentType = request.headers.get("Content-Type") || "";
  
  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return oauthError("invalid_request", "Invalid JSON body", 400);
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    body = {
      grant_type: formData.get("grant_type") as "password",
      username: formData.get("username") as string,
      password: formData.get("password") as string,
      scope: formData.get("scope") as string | undefined,
    };
  } else {
    return oauthError("invalid_request", "Content-Type must be application/json or application/x-www-form-urlencoded", 400);
  }

  // Validate grant type
  if (body.grant_type !== "password") {
    return oauthError("unsupported_grant_type", "Only 'password' grant type is supported", 400);
  }

  // Validate required fields
  if (!body.username || !body.password) {
    return oauthError("invalid_request", "username and password are required", 400);
  }

  const deviceId = body.username;
  const passcode = body.password;

  // Validate deviceId format
  if (!/^[a-z0-9][a-z0-9-]{4,22}[a-z0-9]$/i.test(deviceId)) {
    return oauthError("invalid_grant", "Invalid device ID format", 400);
  }

  // Forward to Durable Object for credential verification
  const id = env.MCP_RELAY.idFromName(deviceId);
  const stub = env.MCP_RELAY.get(id);

  const verifyUrl = new URL(`${baseUrl}/${deviceId}/verify-credentials`);
  const verifyResponse = await stub.fetch(new Request(verifyUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Base-URL": baseUrl,
      ...(env.JWT_SECRET ? { "X-JWT-Secret": env.JWT_SECRET } : {}),
    },
    body: JSON.stringify({ passcode }),
  }));

  if (!verifyResponse.ok) {
    const error = await verifyResponse.json() as OAuthError;
    return oauthError(error.error || "invalid_grant", error.error_description || "Invalid credentials", 401);
  }

  const result = await verifyResponse.json() as TokenResponse;
  return corsResponse(new Response(JSON.stringify(result), {
    status: 200,
    headers: { 
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  }));
}

/**
 * Helper to create JSON error response
 */
function jsonError(message: string, code: string, status: number): Response {
  const body: ErrorResponse = { error: message, code };
  return corsResponse(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

/**
 * Helper to create OAuth error response
 */
function oauthError(error: string, description: string, status: number): Response {
  const body: OAuthError = { error, error_description: description };
  return corsResponse(new Response(JSON.stringify(body), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  }));
}

/**
 * Add CORS headers to response
 */
function corsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
