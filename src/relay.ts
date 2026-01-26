import {
  DeviceMessage,
  RelayMessage,
  RegisterMessage,
  ResponseMessage,
  PendingRequest,
  DeviceInfo,
  RequestMessage,
  StatusResponse,
} from "./types";

// Request timeout in milliseconds
const REQUEST_TIMEOUT = 30000;  // 30 seconds
const PING_INTERVAL = 25000;    // 25 seconds (keep connection alive)
const POLL_TIMEOUT = 30000;     // 30 seconds for long-polling
const SESSION_TIMEOUT = 120000; // 2 minutes without activity = session expired
const DEVICE_ID_LENGTH = 12;

/**
 * Generate a random device ID (URL-safe alphanumeric)
 */
function generateDeviceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomValues = new Uint8Array(DEVICE_ID_LENGTH);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < DEVICE_ID_LENGTH; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Pending request waiting for device to poll
 */
interface QueuedRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  createdAt: number;
}

/**
 * MCPRelay Durable Object
 * 
 * Each instance handles one device's connection and all MCP requests to that device.
 * Supports both WebSocket connections and HTTP long-polling for devices that can't use WebSocket.
 */
export class MCPRelay implements DurableObject {
  private state: DurableObjectState;
  private baseUrl: string = "";
  
  // WebSocket mode
  private deviceSocket: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  
  // Shared state
  private deviceInfo: DeviceInfo | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  
  // HTTP polling mode
  private requestQueue: QueuedRequest[] = [];
  private pollWaiters: Array<{ resolve: (req: QueuedRequest | null) => void; timeout: ReturnType<typeof setTimeout> }> = [];
  private lastPollTime: number = 0;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    // Restore device info from storage if available
    this.state.blockConcurrencyWhile(async () => {
      this.deviceInfo = await this.state.storage.get("deviceInfo") || null;
    });
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.baseUrl = `${url.protocol}//${url.host}`;
    
    const path = url.pathname;
    const pathParts = path.split("/").filter(Boolean);
    const action = pathParts.length >= 2 ? pathParts[1] : "";

    // WebSocket connection from device
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // OPTIONS for CORS preflight
    if (request.method === "OPTIONS") {
      return this.corsResponse(new Response(null, { status: 204 }));
    }

    // HTTP endpoints
    switch (action) {
      case "status":
        if (request.method === "GET") {
          return this.handleStatusRequest();
        }
        break;
        
      case "mcp":
        if (request.method === "POST") {
          return this.handleMCPRequest(request);
        }
        break;
        
      // HTTP polling endpoints (for devices that can't use WebSocket)
      case "register":
        if (request.method === "POST") {
          return this.handleHttpRegister(request);
        }
        break;
        
      case "poll":
        if (request.method === "GET") {
          return this.handleHttpPoll(request);
        }
        break;
        
      case "response":
        if (request.method === "POST") {
          return this.handleHttpResponse(request);
        }
        break;
        
      case "pong":
        if (request.method === "POST") {
          return this.handleHttpPong();
        }
        break;
    }

    return this.corsResponse(
      new Response(JSON.stringify({ error: "Not Found", code: "NOT_FOUND" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  // ============================================
  // HTTP Polling Mode (for KOReader/LuaSocket)
  // ============================================

  /**
   * Handle device registration via HTTP
   */
  private async handleHttpRegister(request: Request): Promise<Response> {
    let body: RegisterMessage;
    try {
      body = await request.json();
    } catch (e) {
      console.error("Failed to parse registration JSON:", e);
      return this.corsResponse(
        new Response(JSON.stringify({ error: "Invalid JSON", code: "PARSE_ERROR" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Use provided deviceId or generate a new one
    const deviceId = body.deviceId || generateDeviceId();

    this.deviceInfo = {
      deviceId,
      deviceName: body.deviceName,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      version: body.version,
    };

    // Update last poll time to mark as online
    this.lastPollTime = Date.now();

    // Store device info
    await this.state.storage.put("deviceInfo", this.deviceInfo);

    // Build the relay URL
    const relayUrl = `${this.baseUrl}/${deviceId}/mcp`;

    console.log(`Device registered via HTTP: ${deviceId}`);

    return this.corsResponse(
      new Response(JSON.stringify({
        type: "registered",
        deviceId,
        relayUrl,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /**
   * Handle device polling for requests (long-polling)
   */
  private async handleHttpPoll(request: Request): Promise<Response> {
    // Check if session is valid
    if (!this.deviceInfo) {
      return this.corsResponse(
        new Response(JSON.stringify({ error: "Not registered", code: "NOT_REGISTERED" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Update last activity
    this.lastPollTime = Date.now();
    this.deviceInfo.lastActivity = Date.now();

    // Check if there's a request waiting
    if (this.requestQueue.length > 0) {
      const queuedRequest = this.requestQueue.shift()!;
      return this.corsResponse(
        new Response(JSON.stringify({
          type: "request",
          requestId: queuedRequest.requestId,
          method: queuedRequest.method,
          path: queuedRequest.path,
          headers: queuedRequest.headers,
          body: queuedRequest.body,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Long-poll: wait for a request to come in
    const waitResult = await new Promise<QueuedRequest | null>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove this waiter from the list
        const idx = this.pollWaiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) this.pollWaiters.splice(idx, 1);
        resolve(null);
      }, POLL_TIMEOUT);

      this.pollWaiters.push({ resolve, timeout });
    });

    if (waitResult) {
      return this.corsResponse(
        new Response(JSON.stringify({
          type: "request",
          requestId: waitResult.requestId,
          method: waitResult.method,
          path: waitResult.path,
          headers: waitResult.headers,
          body: waitResult.body,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Timeout with no request - send ping
    return this.corsResponse(
      new Response(JSON.stringify({ type: "ping" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /**
   * Handle response from device (HTTP polling mode)
   */
  private async handleHttpResponse(request: Request): Promise<Response> {
    let body: ResponseMessage;
    try {
      body = await request.json();
    } catch {
      return this.corsResponse(
        new Response(JSON.stringify({ error: "Invalid JSON", code: "PARSE_ERROR" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    this.handleResponse(body);

    return this.corsResponse(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /**
   * Handle pong from device (HTTP polling mode)
   */
  private handleHttpPong(): Response {
    if (this.deviceInfo) {
      this.deviceInfo.lastActivity = Date.now();
    }

    return this.corsResponse(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  // ============================================
  // WebSocket Mode
  // ============================================

  /**
   * Handle WebSocket upgrade from device
   */
  private handleWebSocketUpgrade(request: Request): Response {
    // Only allow one device connection at a time
    if (this.deviceSocket) {
      try {
        this.deviceSocket.close(1000, "New connection replacing old");
      } catch {
        // Ignore close errors
      }
      this.deviceSocket = null;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.deviceSocket = server;

    console.log("Device WebSocket connected");
    this.startPingInterval();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle WebSocket messages from device
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      console.error("Received non-string message from device");
      return;
    }

    let parsed: DeviceMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      console.error("Failed to parse device message:", message);
      this.sendToDevice({ type: "error", code: "PARSE_ERROR", message: "Invalid JSON" });
      return;
    }

    switch (parsed.type) {
      case "register":
        await this.handleWsRegister(parsed);
        break;

      case "response":
        this.handleResponse(parsed);
        break;

      case "pong":
        if (this.deviceInfo) {
          this.deviceInfo.lastActivity = Date.now();
        }
        break;

      default:
        console.warn("Unknown message type from device:", (parsed as any).type);
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`Device disconnected: code=${code}, reason=${reason}`);
    this.cleanup();
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("Device WebSocket error:", error);
    this.cleanup();
  }

  /**
   * Handle device registration via WebSocket
   */
  private async handleWsRegister(message: RegisterMessage): Promise<void> {
    const deviceId = message.deviceId || generateDeviceId();

    this.deviceInfo = {
      deviceId,
      deviceName: message.deviceName,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      version: message.version,
    };

    await this.state.storage.put("deviceInfo", this.deviceInfo);

    const relayUrl = `${this.baseUrl}/${deviceId}/mcp`;

    this.sendToDevice({
      type: "registered",
      deviceId,
      relayUrl,
    });

    console.log(`Device registered via WebSocket: ${deviceId}`);
  }

  // ============================================
  // Shared Logic
  // ============================================

  /**
   * Handle response from device (either mode)
   */
  private handleResponse(message: ResponseMessage): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      console.warn(`No pending request for ID: ${message.requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.requestId);
    pending.resolve(message);

    if (this.deviceInfo) {
      this.deviceInfo.lastActivity = Date.now();
    }
  }

  /**
   * Check if device is online
   */
  private isDeviceOnline(): boolean {
    // WebSocket mode
    if (this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN) {
      return true;
    }
    
    // HTTP polling mode - check if device polled recently
    if (this.deviceInfo && this.lastPollTime > 0) {
      const timeSinceLastPoll = Date.now() - this.lastPollTime;
      return timeSinceLastPoll < SESSION_TIMEOUT;
    }
    
    return false;
  }

  /**
   * Handle status check request
   */
  private handleStatusRequest(): Response {
    const status: StatusResponse = {
      deviceId: this.deviceInfo?.deviceId || "unknown",
      online: this.isDeviceOnline(),
      deviceName: this.deviceInfo?.deviceName,
      connectedAt: this.deviceInfo?.connectedAt,
      lastActivity: this.deviceInfo?.lastActivity,
    };

    return this.corsResponse(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /**
   * Handle MCP request from HTTP client
   */
  private async handleMCPRequest(request: Request): Promise<Response> {
    // Check if device is connected
    if (!this.isDeviceOnline()) {
      return this.corsResponse(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Device is offline",
            },
            id: null,
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }

    const body = await request.text();
    const requestId = generateRequestId();

    const requestMessage: RequestMessage = {
      type: "request",
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body,
    };

    // Create a promise that resolves when we get a response
    const responsePromise = new Promise<ResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Request timeout"));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        createdAt: Date.now(),
      });
    });

    // Send request to device (WebSocket or queue for polling)
    if (this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN) {
      this.sendToDevice(requestMessage);
    } else {
      // Queue for HTTP polling
      const queuedRequest: QueuedRequest = {
        requestId,
        method: requestMessage.method,
        path: requestMessage.path,
        headers: requestMessage.headers,
        body: requestMessage.body,
        createdAt: Date.now(),
      };

      // Check if there's a poll waiter
      if (this.pollWaiters.length > 0) {
        const waiter = this.pollWaiters.shift()!;
        clearTimeout(waiter.timeout);
        waiter.resolve(queuedRequest);
      } else {
        this.requestQueue.push(queuedRequest);
      }
    }

    try {
      const response = await responsePromise;

      const headers = new Headers(response.headers || {});
      headers.set("Content-Type", "application/json");

      return this.corsResponse(
        new Response(response.body, {
          status: response.status,
          headers,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return this.corsResponse(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Relay error: ${message}`,
            },
            id: null,
          }),
          {
            status: 504,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }
  }

  /**
   * Send a message to the connected device via WebSocket
   */
  private sendToDevice(message: RelayMessage): void {
    if (this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN) {
      this.deviceSocket.send(JSON.stringify(message));
    }
  }

  /**
   * Start ping interval for WebSocket keep-alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN) {
        this.sendToDevice({ type: "ping" });
      }
    }, PING_INTERVAL);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Cleanup on disconnect
   */
  private cleanup(): void {
    this.stopPingInterval();
    this.deviceSocket = null;

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Device disconnected"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Add CORS headers to response
   */
  private corsResponse(response: Response): Response {
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
}
