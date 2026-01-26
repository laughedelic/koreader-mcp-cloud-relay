import {
  RegisterMessage,
  ResponseMessage,
  PendingRequest,
  DeviceInfo,
  RequestMessage,
  StatusResponse,
} from "./types";

// Timeouts in milliseconds
const REQUEST_TIMEOUT = 30000;  // 30 seconds - how long client waits for device response
const POLL_TIMEOUT = 30000;     // 30 seconds - how long device poll blocks
const SESSION_TIMEOUT = 120000; // 2 minutes - device considered offline after this

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Queued request waiting for device to poll
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
 * Poll waiter - device waiting for a request
 */
interface PollWaiter {
  resolve: (req: QueuedRequest | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * MCPRelay Durable Object
 * 
 * Each instance handles one device's connection via HTTP long-polling.
 * 
 * Flow:
 * 1. Device calls /register to announce itself and get its public URL
 * 2. Device calls /poll in a loop (long-polling, 30s timeout)
 * 3. MCP client calls /mcp to send requests
 * 4. Relay queues request or delivers to waiting poll
 * 5. Device sends response via /response
 * 6. Relay delivers response to waiting MCP client
 */
export class MCPRelay implements DurableObject {
  private state: DurableObjectState;
  private baseUrl: string = "";
  
  // Device state
  private deviceInfo: DeviceInfo | null = null;
  private lastPollTime: number = 0;
  
  // Request handling
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestQueue: QueuedRequest[] = [];
  private pollWaiters: PollWaiter[] = [];

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    // Restore device info from storage
    this.state.blockConcurrencyWhile(async () => {
      this.deviceInfo = await this.state.storage.get("deviceInfo") || null;
    });
  }

  /**
   * Route incoming requests to handlers
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.baseUrl = `${url.protocol}//${url.host}`;
    
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[1] || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return this.corsResponse(new Response(null, { status: 204 }));
    }

    // Route to handlers
    switch (action) {
      case "register":
        return request.method === "POST" 
          ? this.handleRegister(request)
          : this.methodNotAllowed();
          
      case "poll":
        return request.method === "GET"
          ? this.handlePoll()
          : this.methodNotAllowed();
          
      case "response":
        return request.method === "POST"
          ? this.handleResponse(request)
          : this.methodNotAllowed();
          
      case "pong":
        return request.method === "POST"
          ? this.handlePong()
          : this.methodNotAllowed();
          
      case "mcp":
        return request.method === "POST"
          ? this.handleMCPRequest(request)
          : this.methodNotAllowed();
          
      case "status":
        return request.method === "GET"
          ? this.handleStatus()
          : this.methodNotAllowed();
          
      default:
        return this.notFound();
    }
  }

  // ============================================
  // Device Endpoints
  // ============================================

  /**
   * POST /register - Device announces itself
   */
  private async handleRegister(request: Request): Promise<Response> {
    let body: RegisterMessage;
    try {
      body = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }

    const deviceId = body.deviceId || this.generateDeviceId();

    this.deviceInfo = {
      deviceId,
      deviceName: body.deviceName,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      version: body.version,
    };
    this.lastPollTime = Date.now();

    await this.state.storage.put("deviceInfo", this.deviceInfo);

    console.log(`Device registered: ${deviceId} (${body.deviceName || "unnamed"})`);

    return this.jsonResponse({
      type: "registered",
      deviceId,
      relayUrl: `${this.baseUrl}/${deviceId}/mcp`,
    });
  }

  /**
   * GET /poll - Device long-polls for requests
   */
  private async handlePoll(): Promise<Response> {
    if (!this.deviceInfo) {
      return this.jsonError("Not registered", "NOT_REGISTERED", 410);
    }

    // Update activity timestamps
    this.lastPollTime = Date.now();
    this.deviceInfo.lastActivity = Date.now();

    // Immediate return if request is queued
    if (this.requestQueue.length > 0) {
      const queued = this.requestQueue.shift()!;
      return this.jsonResponse({
        type: "request",
        requestId: queued.requestId,
        method: queued.method,
        path: queued.path,
        headers: queued.headers,
        body: queued.body,
      });
    }

    // Long-poll: wait for a request
    const result = await new Promise<QueuedRequest | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(resolve);
        resolve(null);
      }, POLL_TIMEOUT);

      this.pollWaiters.push({ resolve, timeout });
    });

    if (result) {
      return this.jsonResponse({
        type: "request",
        requestId: result.requestId,
        method: result.method,
        path: result.path,
        headers: result.headers,
        body: result.body,
      });
    }

    // Timeout - send ping
    return this.jsonResponse({ type: "ping" });
  }

  /**
   * POST /response - Device sends response to a request
   */
  private async handleResponse(request: Request): Promise<Response> {
    let body: ResponseMessage;
    try {
      body = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }

    const pending = this.pendingRequests.get(body.requestId);
    if (!pending) {
      // Not an error - request may have timed out
      console.warn(`Response for unknown request: ${body.requestId}`);
      return this.jsonResponse({ success: true });
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(body.requestId);
    pending.resolve(body);

    if (this.deviceInfo) {
      this.deviceInfo.lastActivity = Date.now();
    }

    return this.jsonResponse({ success: true });
  }

  /**
   * POST /pong - Device heartbeat
   */
  private handlePong(): Response {
    if (this.deviceInfo) {
      this.deviceInfo.lastActivity = Date.now();
    }
    return this.jsonResponse({ success: true });
  }

  // ============================================
  // Client Endpoints
  // ============================================

  /**
   * POST /mcp - MCP client sends request to device
   */
  private async handleMCPRequest(request: Request): Promise<Response> {
    if (!this.isDeviceOnline()) {
      return this.jsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Device is offline" },
        id: null,
      }, 503);
    }

    const body = await request.text();
    const requestId = generateRequestId();

    const queuedRequest: QueuedRequest = {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body,
      createdAt: Date.now(),
    };

    // Set up response promise
    const responsePromise = new Promise<ResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Request timeout"));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timeout, createdAt: Date.now() });
    });

    // Deliver to waiting poll or queue
    if (this.pollWaiters.length > 0) {
      const waiter = this.pollWaiters.shift()!;
      clearTimeout(waiter.timeout);
      waiter.resolve(queuedRequest);
    } else {
      this.requestQueue.push(queuedRequest);
    }

    // Wait for response
    try {
      const response = await responsePromise;
      return this.corsResponse(new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return this.jsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Relay error: ${message}` },
        id: null,
      }, 504);
    }
  }

  /**
   * GET /status - Check if device is online
   */
  private handleStatus(): Response {
    const status: StatusResponse = {
      deviceId: this.deviceInfo?.deviceId || "unknown",
      online: this.isDeviceOnline(),
      deviceName: this.deviceInfo?.deviceName,
      connectedAt: this.deviceInfo?.connectedAt,
      lastActivity: this.deviceInfo?.lastActivity,
    };
    return this.jsonResponse(status);
  }

  // ============================================
  // Helpers
  // ============================================

  private isDeviceOnline(): boolean {
    if (!this.deviceInfo || this.lastPollTime === 0) return false;
    return (Date.now() - this.lastPollTime) < SESSION_TIMEOUT;
  }

  private generateDeviceId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const values = new Uint8Array(12);
    crypto.getRandomValues(values);
    return Array.from(values, v => chars[v % chars.length]).join("");
  }

  private removeWaiter(resolve: (req: QueuedRequest | null) => void): void {
    const idx = this.pollWaiters.findIndex(w => w.resolve === resolve);
    if (idx >= 0) this.pollWaiters.splice(idx, 1);
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return this.corsResponse(new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  }

  private jsonError(message: string, code: string, status: number): Response {
    return this.jsonResponse({ error: message, code }, status);
  }

  private notFound(): Response {
    return this.jsonError("Not Found", "NOT_FOUND", 404);
  }

  private methodNotAllowed(): Response {
    return this.jsonError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
  }

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
