import { SignJWT, jwtVerify } from "jose";
import {
  RegisterMessage,
  ResponseMessage,
  PendingRequest,
  DeviceInfo,
  RequestMessage,
  StatusResponse,
  TokenResponse,
  TokenPayload,
  OAuthError,
} from "./types";

// Timeouts in milliseconds
const REQUEST_TIMEOUT = 30000;  // 30 seconds - how long client waits for device response
const POLL_TIMEOUT = 30000;     // 30 seconds - how long device poll blocks
const SESSION_TIMEOUT = 120000; // 2 minutes - device considered offline after this
const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour token lifetime

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Hash a passcode using SHA-256 (used to verify device-provided hashes)
 * The device sends a hash, we verify by hashing the provided passcode the same way
 */
async function hashPasscode(passcode: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(passcode);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a passcode against its stored hash
 */
async function verifyPasscode(passcode: string, storedHash: string): Promise<boolean> {
  const computedHash = await hashPasscode(passcode);
  return computedHash === storedHash;
}

/**
 * Generate a JWT token using jose library
 */
async function generateToken(payload: TokenPayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  
  const jwt = await new SignJWT({ scope: payload.scope })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_EXPIRY_SECONDS}s`)
    .sign(secretKey);
  
  return jwt;
}

/**
 * Verify and decode a JWT token using jose library
 */
async function verifyToken(token: string, secret: string, expectedAudience?: string): Promise<TokenPayload | null> {
  try {
    const encoder = new TextEncoder();
    const secretKey = encoder.encode(secret);
    
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
      ...(expectedAudience ? { audience: expectedAudience } : {}),
    });
    
    return {
      sub: payload.sub || "",
      aud: (Array.isArray(payload.aud) ? payload.aud[0] : payload.aud) || "",
      iat: payload.iat || 0,
      exp: payload.exp || 0,
      scope: (payload.scope as string) || "mcp:access",
    };
  } catch {
    return null;
  }
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
 * Implements OAuth 2.0 password grant for MCP client authentication.
 * 
 * Flow:
 * 1. Device generates deviceId + passcode locally
 * 2. Device calls /register with deviceId + passcodeHash
 * 3. Device calls /poll in a loop (long-polling, 30s timeout)
 * 4. MCP client gets token via /oauth/token using deviceId + passcode
 * 5. MCP client calls /mcp with Bearer token to send requests
 * 6. Relay queues request or delivers to waiting poll
 * 7. Device sends response via /response
 * 8. Relay delivers response to waiting MCP client
 */
export class MCPRelay implements DurableObject {
  private state: DurableObjectState;
  private baseUrl: string = "";
  private jwtSecret: string = "";
  
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
    this.baseUrl = request.headers.get("X-Relay-Base-URL") || `${url.protocol}//${url.host}`;
    this.jwtSecret = request.headers.get("X-JWT-Secret") || this.baseUrl; // Fallback to baseUrl as secret
    
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
      
      case "verify-credentials":
        return request.method === "POST"
          ? this.handleVerifyCredentials(request)
          : this.methodNotAllowed();
          
      default:
        return this.notFound();
    }
  }

  // ============================================
  // Device Endpoints
  // ============================================

  /**
   * POST /register - Device announces itself with device-generated credentials
   * 
   * First registration: device provides deviceId + passcodeHash
   * Re-registration: device provides same deviceId + passcodeHash (must match stored)
   */
  private async handleRegister(request: Request): Promise<Response> {
    let body: RegisterMessage;
    try {
      body = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }

    // Device ID is required and must be provided by the device
    if (!body.deviceId) {
      return this.jsonError("deviceId is required", "MISSING_DEVICE_ID", 400);
    }

    const isReconnection = !!this.deviceInfo;
    
    // On first registration, passcodeHash is required
    if (!isReconnection && !body.passcodeHash) {
      return this.jsonError("passcodeHash is required for first registration", "MISSING_PASSCODE_HASH", 400);
    }
    
    // On reconnection, verify the passcode hash matches
    if (isReconnection && this.deviceInfo?.passcodeHash) {
      // If a passcodeHash is provided, it must match
      if (body.passcodeHash && body.passcodeHash !== this.deviceInfo.passcodeHash) {
        return this.jsonError("Passcode hash mismatch", "INVALID_PASSCODE", 401);
      }
    }

    // Store or update device info
    const passcodeHash = body.passcodeHash || this.deviceInfo?.passcodeHash;
    
    this.deviceInfo = {
      deviceId: body.deviceId,
      deviceName: body.deviceName || this.deviceInfo?.deviceName,
      connectedAt: this.deviceInfo?.connectedAt || Date.now(),
      lastActivity: Date.now(),
      version: body.version,
      passcodeHash,
      registeredAt: this.deviceInfo?.registeredAt || Date.now(),
    };
    this.lastPollTime = Date.now();

    await this.state.storage.put("deviceInfo", this.deviceInfo);

    console.log(`Device registered: ${body.deviceId} (${body.deviceName || "unnamed"})${!isReconnection ? " [FIRST TIME]" : ""}`);

    const response: Record<string, unknown> = {
      type: "registered",
      deviceId: body.deviceId,
      relayUrl: `${this.baseUrl}/${body.deviceId}/mcp`,
      tokenEndpoint: `${this.baseUrl}/oauth/token`,
    };
    
    if (!isReconnection) {
      response.message = "Device registered successfully. Use the passcode you generated to authenticate MCP clients.";
    }

    return this.jsonResponse(response);
  }

  /**
   * POST /verify-credentials - Internal endpoint for token generation
   * Called by the main worker to verify passcode and generate JWT
   */
  private async handleVerifyCredentials(request: Request): Promise<Response> {
    let body: { passcode: string };
    try {
      body = await request.json();
    } catch {
      return this.oauthError("invalid_request", "Invalid JSON", 400);
    }

    if (!this.deviceInfo) {
      return this.oauthError("invalid_grant", "Device not registered", 401);
    }

    if (!this.deviceInfo.passcodeHash) {
      return this.oauthError("invalid_grant", "Device has no credentials", 401);
    }

    // Verify the provided passcode by hashing and comparing
    const valid = await verifyPasscode(body.passcode, this.deviceInfo.passcodeHash);
    if (!valid) {
      return this.oauthError("invalid_grant", "Invalid passcode", 401);
    }

    // Generate access token using jose
    const payload: TokenPayload = {
      sub: this.deviceInfo.deviceId,
      aud: `${this.baseUrl}/${this.deviceInfo.deviceId}/mcp`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS,
      scope: "mcp:access",
    };

    const token = await generateToken(payload, this.jwtSecret);

    const response: TokenResponse = {
      access_token: token,
      token_type: "Bearer",
      expires_in: TOKEN_EXPIRY_SECONDS,
      scope: "mcp:access",
    };

    return this.jsonResponse(response);
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
   * Requires Bearer token authentication
   */
  private async handleMCPRequest(request: Request): Promise<Response> {
    // Validate authentication
    const authHeader = request.headers.get("Authorization");
    
    // Check if device has credentials set (authentication required)
    if (this.deviceInfo?.passcodeHash) {
      if (!authHeader) {
        // Return 401 with WWW-Authenticate header per RFC 9728
        return this.unauthorizedResponse(
          "Bearer token required",
          `${this.baseUrl}/${this.deviceInfo?.deviceId || "unknown"}/.well-known/oauth-protected-resource`
        );
      }
      
      if (!authHeader.startsWith("Bearer ")) {
        return this.unauthorizedResponse(
          "Invalid authorization header format",
          `${this.baseUrl}/${this.deviceInfo?.deviceId || "unknown"}/.well-known/oauth-protected-resource`
        );
      }
      
      const token = authHeader.slice(7);
      const expectedAudience = `${this.baseUrl}/${this.deviceInfo.deviceId}/mcp`;
      const payload = await verifyToken(token, this.jwtSecret, expectedAudience);
      
      if (!payload) {
        return this.unauthorizedResponse(
          "Invalid or expired token",
          `${this.baseUrl}/${this.deviceInfo?.deviceId || "unknown"}/.well-known/oauth-protected-resource`
        );
      }
      
      // Verify token is for this device
      if (payload.sub !== this.deviceInfo?.deviceId) {
        return this.jsonResponse({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Token not valid for this device" },
          id: null,
        }, 403);
      }
    }

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

  private oauthError(error: string, description: string, status: number): Response {
    return this.corsResponse(new Response(JSON.stringify({ 
      error, 
      error_description: description 
    }), {
      status,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
      },
    }));
  }

  private unauthorizedResponse(message: string, resourceMetadataUrl: string): Response {
    return this.corsResponse(new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}", scope="mcp:access"`,
      },
    }));
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
