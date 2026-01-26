/**
 * MCP Relay - Cloudflare Worker
 * 
 * Entry point that routes requests to the appropriate Durable Object instance.
 * Each device gets its own Durable Object identified by deviceId.
 */

import { Env, ErrorResponse } from "./types";

// Re-export the Durable Object class
export { MCPRelay } from "./relay";

/**
 * Main Worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle root path - show welcome/info
    if (path === "/" || path === "") {
      return new Response(
        JSON.stringify({
          name: "MCP Relay",
          description: "Cloud relay for KOReader MCP server",
          version: "1.0.0",
          docs: "https://github.com/laughedelic/mcp-relay-cloudflare",
          endpoints: {
            "GET /": "This info page",
            "GET /{deviceId}/status": "Check if device is online",
            "POST /{deviceId}/mcp": "Forward MCP request to device",
            "WebSocket /{deviceId}/ws": "Device connection endpoint (WebSocket mode)",
            "POST /{deviceId}/register": "Device registration (HTTP polling mode)",
            "GET /{deviceId}/poll": "Poll for requests (HTTP polling mode)",
            "POST /{deviceId}/response": "Send response (HTTP polling mode)",
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Parse path to extract deviceId and action
    // Expected formats:
    //   /{deviceId}/ws     - WebSocket connection from device
    //   /{deviceId}/mcp    - HTTP MCP request from client
    //   /{deviceId}/status - Status check
    const pathParts = path.split("/").filter(Boolean);
    
    if (pathParts.length < 2) {
      return jsonError("Invalid path. Expected /{deviceId}/{action}", "INVALID_PATH", 400);
    }

    const [deviceId, action] = pathParts;

    // Validate deviceId format (alphanumeric, 8-24 characters)
    if (!/^[a-z0-9]{8,24}$/i.test(deviceId)) {
      return jsonError(
        "Invalid device ID. Must be 8-24 alphanumeric characters.",
        "INVALID_DEVICE_ID",
        400
      );
    }

    // Validate action
    const validActions = ["ws", "mcp", "status", "register", "poll", "response", "pong"];
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

    return stub.fetch(new Request(doUrl.toString(), request));
  },
};

/**
 * Helper to create JSON error response
 */
function jsonError(message: string, code: string, status: number): Response {
  const body: ErrorResponse = { error: message, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
