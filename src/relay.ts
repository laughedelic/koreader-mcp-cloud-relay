import {
  RegisterMessage,
  ResponseMessage,
  PendingRequest,
  DeviceInfo,
  RequestMessage,
  StatusResponse,
  OAuthError,
  Manifest,
  OfflineInfo,
  StoredAppKey,
  StoredSnapshot,
} from "./types";
import { APP_KEY_ID_PATTERN, parsePublicJwk, sealSnapshot } from "./memory-crypto";
import { OFFLINE_FRAME_HEADER, encodeOfflineFrame } from "./offline-frame";

// Timeouts in milliseconds
const REQUEST_TIMEOUT = 30000;  // 30 seconds - how long client waits for device response
const POLL_TIMEOUT = 30000;     // 30 seconds - how long device poll blocks
const SESSION_TIMEOUT = 120000; // 2 minutes - device reported offline by /status after this
// How long a device may stay silent between polls before a waiting request is
// answered as "reader offline". A live device polls again within a few
// seconds of its last contact (its longest gap between polls is 5 seconds).
const PICKUP_GRACE = 15000;
const PICKUP_RECHECK = 2000;    // how often a queued request rechecks for signs of life
const LAST_SEEN_WRITE_INTERVAL = 600_000; // persist "last seen" at most every 10 minutes

// Offline memory
const DEFAULT_SNAPSHOT_MAX_BYTES = 262144; // 256 KB: keeps an offline answer well inside the free plan's CPU time
const DEFAULT_SNAPSHOT_MAX_RETENTION_DAYS = 30;
const MIN_SNAPSHOT_INTERVAL = 15000;      // a device may store a snapshot at most this often
const MAX_APP_KEYS = 20;                  // paired apps that can read a device's snapshots
const APP_KEY_IDLE_LIMIT = 90 * 86_400_000; // forget an app's public key after 90 days unused
const APP_KEY_TOUCH_INTERVAL = 86_400_000;  // persist an app key's last use at most daily
const MAX_MANIFEST_BYTES = 65536;
const DAY_MS = 86_400_000;

// Passcode brute-force protection
const MAX_FREE_PASSCODE_ATTEMPTS = 5;      // failures allowed before lockout kicks in
const PASSCODE_LOCKOUT_BASE_MS = 60_000;   // first lockout: 1 minute, doubling each further failure
const PASSCODE_LOCKOUT_MAX_MS = 3_600_000; // lockout capped at 1 hour

// Request headers forwarded from the MCP client to the device.
// Everything else (Authorization, Cookie, CF-* headers, ...) stays at the relay,
// so a device can never see the client's OAuth token.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
  "last-event-id",
  "user-agent",
];

// Response headers passed back from the device to the MCP client.
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "allow",
];

// HTTP statuses that must not carry a body
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${crypto.randomUUID()}`;
}

/**
 * Constant-time string comparison (for hashes of equal, known length)
 */
function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Pick an allowlisted subset of headers (lowercased names)
 */
function pickHeaders(headers: Headers | Record<string, string> | undefined, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const get = headers instanceof Headers
    ? (name: string) => headers.get(name)
    : (name: string) => {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === name) return v;
        }
        return null;
      };
  for (const name of allowed) {
    const value = get(name);
    if (value !== null && value !== undefined) result[name] = value;
  }
  return result;
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
  return timingSafeEqual(computedHash, storedHash);
}

/** Parse a non-negative integer setting, or use the default */
function nonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Thrown inside handleMCPRequest when the device turns out to be away */
class DeviceSilent extends Error {
  /** True if the device took the request but never answered it */
  unresponsive: boolean;
  constructor(unresponsive: boolean) {
    super("Device is offline");
    this.unresponsive = unresponsive;
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
 * Something the relay tells the device without expecting a response, such
 * as an AI app finishing sign-in. Plugins that don't know a type ignore it.
 */
interface DeviceEvent {
  event: string;
  [key: string]: unknown;
}

/** Events wait for the next poll for at most this long */
const EVENT_TTL_MS = 60_000;
const MAX_QUEUED_EVENTS = 5;

type PollMessage =
  | { kind: "request"; request: QueuedRequest }
  | { kind: "event"; event: DeviceEvent; createdAt: number };

/**
 * Poll waiter - device waiting for a request or event
 */
interface PollWaiter {
  resolve: (message: PollMessage | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Failed passcode verification tracking (persisted per device)
 */
interface PasscodeAttempts {
  failures: number;
  lockedUntil: number;
}

/**
 * MCPRelay Durable Object
 * 
 * Each instance handles one device's connection via HTTP long-polling.
 * MCP client authentication uses OAuth 2.1 Authorization Code flow with PKCE
 * (handled by the OAuthProvider in index.ts).
 * 
 * Flow:
 * 1. Device generates deviceId + passcode locally
 * 2. Device calls /register with deviceId + passcodeHash
 * 3. Device calls /poll in a loop (long-polling, 30s timeout)
 * 4. MCP client starts OAuth auth code flow (GET /authorize) and user enters device ID + passcode
 * 5. MCP client exchanges auth code at /oauth/token for an access token
 * 6. MCP client calls /mcp with Bearer token to send requests
 * 7. Relay queues request or delivers to waiting poll
 * 8. Device sends response via /response
 * 9. Relay delivers response to waiting MCP client
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
  private eventQueue: { event: DeviceEvent; createdAt: number }[] = [];
  private pollWaiters: PollWaiter[] = [];
  // Requests handed to the device that it hasn't answered yet
  private inFlight: Set<string> = new Set();
  // Last sign of life from the device (poll, response or pong), in memory
  private lastContact: number = 0;
  /** True after the device announced it is going away, until it is heard from again */
  private left = false;
  // The same, as last written to storage (survives eviction)
  private lastSeen: number = 0;
  // After a restart of this object, a device seen shortly before gets a
  // moment to poll again before requests are answered as offline
  private startupGraceUntil: number = 0;

  // Offline memory
  private appKeys: Record<string, StoredAppKey> = {};
  private lastSnapshotAt: number = 0;
  private snapshotMaxBytes: number;
  private snapshotMaxRetentionDays: number;

  // When true, devices that never registered a device secret are rejected
  // on /poll, /response and /pong (set REQUIRE_DEVICE_SECRET="true" once
  // all devices run a plugin version that sends one).
  private requireDeviceSecret: boolean;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    const vars = (env || {}) as {
      REQUIRE_DEVICE_SECRET?: string;
      SNAPSHOT_MAX_BYTES?: string;
      SNAPSHOT_MAX_RETENTION_DAYS?: string;
    };
    this.requireDeviceSecret = vars.REQUIRE_DEVICE_SECRET === "true";
    // Never above 1 MB: a stored value can hold at most 2 MB
    this.snapshotMaxBytes = Math.min(
      nonNegativeInt(vars.SNAPSHOT_MAX_BYTES, DEFAULT_SNAPSHOT_MAX_BYTES), 1024 * 1024);
    this.snapshotMaxRetentionDays =
      Math.max(1, nonNegativeInt(vars.SNAPSHOT_MAX_RETENTION_DAYS, DEFAULT_SNAPSHOT_MAX_RETENTION_DAYS));
    // Restore device info from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<unknown>(["deviceInfo", "lastSeen", "appKeys"]);
      this.deviceInfo = (stored.get("deviceInfo") as DeviceInfo | undefined) || null;
      this.lastSeen = (stored.get("lastSeen") as number | undefined) || 0;
      this.appKeys = (stored.get("appKeys") as Record<string, StoredAppKey> | undefined) || {};
      if (Date.now() - this.lastSeen < LAST_SEEN_WRITE_INTERVAL + 60_000) {
        this.startupGraceUntil = Date.now() + PICKUP_GRACE;
      }
    });
  }

  /**
   * Route incoming requests to handlers
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.baseUrl = request.headers.get("X-Relay-Base-URL") || `${url.protocol}//${url.host}`;
    
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[1] || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return this.corsResponse(new Response(null, { status: 204 }));
    }

    // Device-only endpoints require the device secret (see authenticateDevice)
    if (["poll", "response", "pong", "status", "snapshot", "bye"].includes(action)) {
      const authError = await this.authenticateDevice(
        request, action === "status" || action === "snapshot" || action === "bye");
      if (authError) return authError;
    }

    // Route to handlers
    switch (action) {
      case "register":
        return request.method === "POST"
          ? this.handleRegister(request)
          : this.methodNotAllowed();

      case "poll":
        return request.method === "GET"
          ? this.handlePoll(request)
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
        // Streamable HTTP: this relay offers no standalone GET stream and no
        // session deletion, so GET/DELETE get 405 with an Allow header.
        return request.method === "POST"
          ? this.handleMCPRequest(request)
          : this.methodNotAllowed("POST");

      case "status":
        return request.method === "GET"
          ? this.handleStatus()
          : this.methodNotAllowed();

      case "bye":
        // The reader is about to sleep or stop its server
        if (request.method !== "POST") return this.methodNotAllowed();
        if (!this.deviceInfo) return this.jsonError("Not registered", "NOT_REGISTERED", 410);
        await this.markLeft();
        return this.jsonResponse({ ok: true });

      case "snapshot":
        if (request.method === "PUT") {
          const response = await this.handleSnapshotPut(request);
          // The reader says this is its last word before it sleeps or stops
          // (whether or not the snapshot itself was accepted)
          if (request.headers.get("X-Reader-Leaving") === "1") await this.markLeft();
          return response;
        }
        if (request.method === "GET") return this.handleSnapshotGet();
        if (request.method === "DELETE") return this.handleSnapshotDelete();
        return this.methodNotAllowed("GET, PUT, DELETE");

      // Internal endpoints (reached only from the Worker, never routed from outside)
      case "app-key":
        if (request.method === "POST") return this.handleAppKeyAdd(request);
        if (request.method === "DELETE") return this.handleAppKeyRemove(request);
        return this.methodNotAllowed();

      case "device-auth":
        return request.method === "POST"
          ? this.handleDeviceAuth(request)
          : this.methodNotAllowed();

      case "verify-passcode":
        return request.method === "POST"
          ? this.handleVerifyPasscode(request)
          : this.methodNotAllowed();

      case "notify":
        return request.method === "POST"
          ? this.handleNotify(request)
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

    const normalizedDeviceId = body.deviceId.toLowerCase();

    const isReconnection = !!this.deviceInfo;

    // The secret travels as `Authorization: Device <secret>`, so it must be a
    // single header-safe token
    if (body.deviceSecret !== undefined &&
        (typeof body.deviceSecret !== "string" || !/^[A-Za-z0-9._~+\/=-]{32,256}$/.test(body.deviceSecret))) {
      return this.jsonError(
        "deviceSecret must be 32-256 characters of A-Z, a-z, 0-9 or ._~+/=-", "INVALID_DEVICE_SECRET", 400);
    }
    const providedSecretHash = body.deviceSecret ? await hashPasscode(body.deviceSecret) : undefined;

    if (body.passcodeHash !== undefined && typeof body.passcodeHash !== "string") {
      return this.jsonError("passcodeHash must be a string", "INVALID_PASSCODE_HASH", 400);
    }

    // On first registration, passcodeHash is required
    if (!isReconnection && !body.passcodeHash) {
      return this.jsonError("passcodeHash is required for first registration", "MISSING_PASSCODE_HASH", 400);
    }

    // With enforcement on, a device that has no secret could register but never
    // poll, so refuse it here instead of reporting success
    if (this.requireDeviceSecret && !providedSecretHash && !this.deviceInfo?.deviceSecretHash) {
      return this.jsonError(
        "This relay requires a device secret; update the KOReader plugin", "DEVICE_SECRET_REQUIRED", 401);
    }

    if (isReconnection && this.deviceInfo) {
      if (this.deviceInfo.deviceSecretHash) {
        // Device has a secret: re-registration must prove it
        if (!providedSecretHash || !timingSafeEqual(providedSecretHash, this.deviceInfo.deviceSecretHash)) {
          return this.jsonError("Device secret mismatch", "INVALID_DEVICE_SECRET", 401);
        }
      } else if (this.deviceInfo.passcodeHash) {
        // Legacy device without a secret: the passcode hash must be present and match
        // (an absent hash used to be accepted, which let anyone re-register the device).
        // A 6-digit passcode's hash is guessable, so this shares the login lockout.
        const lockout = await this.checkPasscodeLockout();
        if (lockout) {
          if (!providedSecretHash) {
            // A plain legacy reconnect during a lockout: answer as registered
            // without checking or changing anything. Old plugins only start
            // polling after a successful registration, and their polls aren't
            // authenticated anyway, so this keeps an attacker's wrong guesses
            // from taking the device offline. The same answer for every hash
            // reveals nothing; secret upgrades stay throttled below.
            return this.jsonResponse({
              type: "registered",
              deviceId: normalizedDeviceId,
              relayUrl: `${this.baseUrl}/mcp`,
              tokenEndpoint: `${this.baseUrl}/oauth/token`,
              deviceSecretRegistered: false,
            });
          }
          return lockout;
        }
        if (!body.passcodeHash || !timingSafeEqual(body.passcodeHash, this.deviceInfo.passcodeHash)) {
          await this.recordPasscodeFailure();
          return this.jsonError("Passcode hash mismatch", "INVALID_PASSCODE", 401);
        }
        await this.clearPasscodeFailures();
      }
      // Passcode can't be changed by re-registration
      if (body.passcodeHash && this.deviceInfo.passcodeHash &&
          !timingSafeEqual(body.passcodeHash, this.deviceInfo.passcodeHash)) {
        return this.jsonError("Passcode hash mismatch", "INVALID_PASSCODE", 401);
      }
    }

    // Store or update device info
    const passcodeHash = body.passcodeHash || this.deviceInfo?.passcodeHash;
    // A legacy device upgrades by sending a secret once (after proving the passcode above)
    const deviceSecretHash = this.deviceInfo?.deviceSecretHash || providedSecretHash;
    if (deviceSecretHash && !this.deviceInfo?.deviceSecretHash) {
      // Long polls opened before the secret existed were admitted without one:
      // release them (as a normal empty poll) so no request reaches them
      this.releasePollWaiters();
    }

    this.deviceInfo = {
      deviceId: normalizedDeviceId,
      deviceName: body.deviceName || this.deviceInfo?.deviceName,
      connectedAt: this.deviceInfo?.connectedAt || Date.now(),
      lastActivity: Date.now(),
      version: body.version,
      passcodeHash,
      deviceSecretHash,
      pairingCodes: this.deviceInfo?.pairingCodes,
      registeredAt: this.deviceInfo?.registeredAt || Date.now(),
    };
    this.lastPollTime = Date.now();

    await this.state.storage.put("deviceInfo", this.deviceInfo);
    this.touchContact();
    await this.storeManifest(body.manifest);

    // One structured line per registration, so Workers Logs can count devices
    // that still connect without a secret (see README: REQUIRE_DEVICE_SECRET)
    console.log(JSON.stringify({
      event: "register",
      deviceId: normalizedDeviceId,
      firstTime: !isReconnection,
      hasSecret: !!deviceSecretHash,
      sentSecret: !!providedSecretHash,
      pluginVersion: typeof body.version === "string" ? body.version.slice(0, 32) : null,
      userAgent: (request.headers.get("User-Agent") || "").slice(0, 100),
    }));

    const response: Record<string, unknown> = {
      type: "registered",
      deviceId: normalizedDeviceId,
      relayUrl: `${this.baseUrl}/mcp`,
      tokenEndpoint: `${this.baseUrl}/oauth/token`,
    };
    
    response.deviceSecretRegistered = !!deviceSecretHash;
    // Tells the plugin it can offer "Connect an AI app" (one-time codes)
    response.pairingCodesSupported = true;
    // Tells the plugin it can offer offline memory, and within which limits
    if (this.snapshotMaxBytes > 0) {
      response.offlineMemory = {
        maxBytes: this.snapshotMaxBytes,
        maxRetentionDays: this.snapshotMaxRetentionDays,
      };
    }
    if (!isReconnection) {
      response.message = "Device registered successfully. Use the passcode you generated to authenticate MCP clients.";
    }

    return this.jsonResponse(response);
  }

  /**
   * Authenticate a device-only request (/poll, /response, /pong, /status)
   *
   * The device proves itself with `Authorization: Device <secret>`, where the
   * secret is a random value it generated and sent once at registration.
   * Devices registered before secrets existed are let through unless
   * REQUIRE_DEVICE_SECRET is set (or `alwaysRequire` is true), until they
   * upgrade by re-registering with a secret.
   *
   * @returns an error response, or null if the request may proceed
   */
  private async authenticateDevice(request: Request, alwaysRequire = false): Promise<Response | null> {
    if (!this.deviceInfo) {
      // Nothing to protect yet; handlers answer with NOT_REGISTERED
      return null;
    }

    const auth = request.headers.get("Authorization") || "";
    const match = auth.match(/^Device\s+(\S+)$/i);

    if (!this.deviceInfo.deviceSecretHash) {
      if (this.requireDeviceSecret || alwaysRequire) {
        return this.jsonError(
          "This device has no device secret. Update the KOReader MCP plugin and reconnect.",
          "DEVICE_SECRET_REQUIRED", 401);
      }
      return null;
    }

    if (!match) {
      return this.jsonError("Device authentication required", "DEVICE_AUTH_REQUIRED", 401);
    }
    const providedHash = await hashPasscode(match[1]);
    if (!timingSafeEqual(providedHash, this.deviceInfo.deviceSecretHash)) {
      return this.jsonError("Invalid device secret", "INVALID_DEVICE_SECRET", 401);
    }
    return null;
  }

  /**
   * POST /verify-passcode - Internal endpoint for OAuth authorization
   * Called by the auth handler to verify device passcode during OAuth flow
   * Returns 200 OK if valid, 401 if invalid
   */
  private async handleVerifyPasscode(request: Request): Promise<Response> {
    let body: { passcode: string };
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse({ valid: false, error: "Invalid JSON" }, 400);
    }

    if (!this.deviceInfo) {
      return this.jsonResponse({ valid: false, error: "Device not registered" }, 401);
    }

    if (!this.deviceInfo.passcodeHash) {
      return this.jsonResponse({ valid: false, error: "Device has no credentials" }, 401);
    }

    // Devices that pair with one-time codes no longer accept the permanent passcode
    if (this.deviceInfo.pairingCodes) {
      return this.jsonResponse({
        valid: false,
        error: "This reader uses pairing codes. On the reader, open MCP server > Connect an AI app and enter the code it shows.",
      }, 401);
    }

    // Brute-force protection: after a few failures, lock out with exponential backoff
    const lockout = await this.checkPasscodeLockout();
    if (lockout) {
      const body = await lockout.json() as { error: string };
      return this.jsonResponse({ valid: false, error: body.error }, 429);
    }

    // Verify the provided passcode by hashing and comparing
    const valid = typeof body.passcode === "string" &&
      await verifyPasscode(body.passcode, this.deviceInfo.passcodeHash);
    if (!valid) {
      await this.recordPasscodeFailure();
      return this.jsonResponse({ valid: false, error: "Invalid passcode" }, 401);
    }

    await this.clearPasscodeFailures();
    return this.jsonResponse({ valid: true });
  }

  /**
   * POST /device-auth - Internal: authenticate a device request for the Worker
   * (pairing codes, connected apps). Always requires the device secret.
   * Body: { enablePairingCodes?: boolean } turns off passcode login for good.
   */
  private async handleDeviceAuth(request: Request): Promise<Response> {
    if (!this.deviceInfo) {
      return this.jsonError("Not registered", "NOT_REGISTERED", 410);
    }
    const authError = await this.authenticateDevice(request, true);
    if (authError) return authError;

    let body: { enablePairingCodes?: boolean } = {};
    try {
      body = await request.json();
    } catch {
      // empty body is fine
    }
    if (body.enablePairingCodes && !this.deviceInfo.pairingCodes) {
      this.deviceInfo.pairingCodes = true;
      await this.state.storage.put("deviceInfo", this.deviceInfo);
    }
    return this.jsonResponse({ ok: true, deviceId: this.deviceInfo.deviceId });
  }

  // ============================================
  // Passcode lockout (shared by OAuth login and legacy re-registration)
  // ============================================

  /** @returns a 429 response while locked out, or null */
  private async checkPasscodeLockout(): Promise<Response | null> {
    const attempts = await this.state.storage.get<PasscodeAttempts>("passcodeAttempts");
    const now = Date.now();
    if (attempts && attempts.lockedUntil > now) {
      const minutes = Math.ceil((attempts.lockedUntil - now) / 60_000);
      return this.jsonError(
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        "TOO_MANY_ATTEMPTS", 429);
    }
    return null;
  }

  private async recordPasscodeFailure(): Promise<void> {
    const attempts = (await this.state.storage.get<PasscodeAttempts>("passcodeAttempts")) || { failures: 0, lockedUntil: 0 };
    attempts.failures += 1;
    if (attempts.failures >= MAX_FREE_PASSCODE_ATTEMPTS) {
      const exponent = attempts.failures - MAX_FREE_PASSCODE_ATTEMPTS;
      attempts.lockedUntil = Date.now() + Math.min(PASSCODE_LOCKOUT_BASE_MS * 2 ** exponent, PASSCODE_LOCKOUT_MAX_MS);
    }
    await this.state.storage.put("passcodeAttempts", attempts);
  }

  private async clearPasscodeFailures(): Promise<void> {
    await this.state.storage.delete("passcodeAttempts");
  }

  /** End all pending long polls with no request (the device polls again) */
  private releasePollWaiters(): void {
    const waiters = this.pollWaiters;
    this.pollWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(null);
    }
  }

  /**
   * GET /poll - Device long-polls for requests
   */
  private async handlePoll(pollRequest: Request): Promise<Response> {
    if (!this.deviceInfo) {
      return this.jsonError("Not registered", "NOT_REGISTERED", 410);
    }

    // Update activity timestamps
    this.lastPollTime = Date.now();
    this.deviceInfo.lastActivity = Date.now();
    this.touchContact();

    // Immediate return if an event or request is queued
    const now = Date.now();
    this.eventQueue = this.eventQueue.filter(e => now - e.createdAt < EVENT_TTL_MS);
    const queuedEvent = this.eventQueue.shift();
    if (queuedEvent) {
      return this.pollMessageResponse({ kind: "event", ...queuedEvent });
    }
    const queued = this.requestQueue.shift();
    if (queued) {
      return this.pollMessageResponse({ kind: "request", request: queued });
    }

    // Long-poll: wait for a request or event
    let closedByDevice = false;
    const result = await new Promise<PollMessage | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(resolve);
        resolve(null);
      }, POLL_TIMEOUT);

      this.pollWaiters.push({ resolve, timeout });

      // The reader closed the connection (it went to sleep, or stopped
      // the server): stop waiting, so no request is handed to a poll
      // nobody reads. A reader that is still there polls again.
      pollRequest.signal?.addEventListener("abort", () => {
        closedByDevice = true;
        clearTimeout(timeout);
        this.removeWaiter(resolve);
        resolve(null);
      }, { once: true });
    });

    if (closedByDevice) {
      // A request handed over just as the connection closed went nowhere
      const lost = result?.kind === "request" ? this.pendingRequests.get(result.request.requestId) : undefined;
      if (result?.kind === "request" && lost) {
        clearTimeout(lost.timeout);
        this.pendingRequests.delete(result.request.requestId);
        lost.reject(new DeviceSilent(false));
      }
      return this.jsonResponse({ type: "ping" });
    }
    // The device is expected back within PICKUP_GRACE of this moment,
    // unless this poll ended because the device said it is leaving
    if (!this.left) this.touchContact();

    if (result) {
      return this.pollMessageResponse(result);
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

    // Authenticate again now that the body is in: a secret may have been
    // installed while it was being sent, and a legacy device's response
    // admitted before that must not resolve a request
    const authError = await this.authenticateDevice(request);
    if (authError) return authError;

    this.touchContact();
    this.inFlight.delete(body.requestId);

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
    this.touchContact();
    return this.jsonResponse({ success: true });
  }

  // ============================================
  // Client Endpoints
  // ============================================

  /**
   * POST /mcp - MCP client sends request to device
   * 
   * Authentication is handled by the OAuthProvider in index.ts.
   * Requests that reach this handler are already authenticated.
   *
   * When the device can't answer, the Worker gets an offline frame instead
   * (see offlineResponse) and answers the client itself.
   */
  private async handleMCPRequest(request: Request): Promise<Response> {
    // Check if this request was pre-authenticated by the OAuthProvider
    const oauthAuthenticated = request.headers.get("X-OAuth-Authenticated") === "true";
    
    // If the device has credentials configured, require OAuth authentication
    if (this.deviceInfo?.passcodeHash && !oauthAuthenticated) {
      // Return 401 with WWW-Authenticate header per RFC 9728
      return this.unauthorizedResponse(
        "Bearer token required",
        `${this.baseUrl}/.well-known/oauth-protected-resource/mcp`
      );
    }

    // The calling app's key for offline memory (set by the Worker from the
    // app's grant; never taken from an unauthenticated request)
    const appKeyId = oauthAuthenticated ? await this.noteAppKey(request) : null;

    if (!this.deviceReachable()) {
      return this.offlineResponse(oauthAuthenticated, appKeyId, false);
    }

    const body = await request.text();
    const requestId = generateRequestId();

    const queuedRequest: QueuedRequest = {
      requestId,
      method: request.method,
      path: "/mcp",
      // Only protocol-relevant headers; never the client's Authorization header
      headers: pickHeaders(request.headers, FORWARDED_REQUEST_HEADERS),
      body,
      createdAt: Date.now(),
    };

    // Set up response promise. It rejects with DeviceSilent when the device
    // turns out to be away, and with a plain Error on other failures.
    let pickupTimer: ReturnType<typeof setTimeout> | undefined;
    const responsePromise = new Promise<ResponseMessage>((resolve, reject) => {
      const giveUp = (reason: Error) => {
        this.pendingRequests.delete(requestId);
        this.inFlight.delete(requestId);
        // Drop it from the queue too, so a reader that reconnects later
        // doesn't receive a request nobody is waiting for
        this.requestQueue = this.requestQueue.filter(q => q.requestId !== requestId);
        reject(reason);
      };

      const timeout = setTimeout(() => {
        // Handed to the device but never answered: it most likely went to
        // sleep with the connection open. Still queued: it never came back.
        giveUp(new DeviceSilent(this.inFlight.has(requestId)));
      }, REQUEST_TIMEOUT);

      // A request nobody picks up is answered as offline well before the
      // full timeout, unless the device shows signs of life
      const checkPickup = () => {
        if (!this.requestQueue.some(q => q.requestId === requestId)) return;
        if (this.deviceReachable()) {
          pickupTimer = setTimeout(checkPickup, PICKUP_RECHECK);
          return;
        }
        clearTimeout(timeout);
        giveUp(new DeviceSilent(false));
      };

      this.pendingRequests.set(requestId, { resolve, reject, timeout, createdAt: Date.now() });

      // Deliver to waiting poll or queue
      if (!this.deliverToWaiter({ kind: "request", request: queuedRequest })) {
        this.requestQueue.push(queuedRequest);
        pickupTimer = setTimeout(checkPickup, PICKUP_RECHECK);
      }
    });

    // Wait for response
    try {
      const response = await responsePromise;
      const status = Number.isInteger(response.status) && response.status >= 200 && response.status <= 599
        ? response.status
        : 502;
      const headers = pickHeaders(response.headers, FORWARDED_RESPONSE_HEADERS);
      const hasBody = !NULL_BODY_STATUSES.has(status) && status !== 202 && !!response.body;
      if (hasBody && !headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
      return this.corsResponse(new Response(hasBody ? response.body : null, {
        status,
        headers,
      }));
    } catch (error) {
      if (error instanceof DeviceSilent) {
        return this.offlineResponse(oauthAuthenticated, appKeyId, error.unresponsive);
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return this.jsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Relay error: ${message}` },
        id: null,
      }, 504);
    } finally {
      if (pickupTimer !== undefined) clearTimeout(pickupTimer);
    }
  }

  /**
   * Answer for a request the device can't serve right now.
   *
   * The Worker (the only caller that is OAuth-authenticated) gets an offline
   * frame: what is known about the device, plus the stored snapshot's
   * ciphertext if the calling app has a key for it. The Worker decrypts it
   * with the app's private key and answers the MCP request itself. This
   * object never sees that key or the snapshot's plaintext at this point.
   */
  private async offlineResponse(
    forWorker: boolean, appKeyId: string | null, unresponsive: boolean,
  ): Promise<Response> {
    if (!forWorker) {
      return this.jsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Device is offline" },
        id: null,
      }, 503);
    }

    // Keep "last seen" across eviction, now that the device is known to be away
    if (this.lastContact > this.lastSeen) {
      this.lastSeen = this.lastContact;
      await this.state.storage.put("lastSeen", this.lastSeen);
    }

    const info: OfflineInfo = {
      lastSeen: Math.max(this.lastSeen, this.lastContact) || null,
      unresponsive,
      deviceName: this.deviceInfo?.deviceName,
      manifest: (await this.state.storage.get<Manifest>("manifest")) || null,
      memory: "none",
    };

    let ciphertext: ArrayBuffer | undefined;
    const snapshot = await this.loadSnapshot();
    if (snapshot) {
      const wrap = appKeyId ? snapshot.wraps[appKeyId] : undefined;
      if (wrap) {
        info.memory = "sealed";
        info.snapshot = {
          receivedAt: snapshot.receivedAt,
          expiresAt: snapshot.expiresAt,
          bytes: snapshot.bytes,
          scope: snapshot.scope,
          eph: snapshot.eph,
          iv: snapshot.iv,
          wrap,
        };
        ciphertext = snapshot.ct;
      } else {
        info.memory = "locked";
      }
    }

    return new Response(encodeOfflineFrame(info, ciphertext), {
      status: 503,
      headers: { "Content-Type": "application/octet-stream", [OFFLINE_FRAME_HEADER]: "1" },
    });
  }

  /**
   * POST /notify (internal) - Pass an event to the device on its next poll.
   * Not stored: an event for a device that isn't polling within
   * EVENT_TTL_MS is dropped.
   */
  private async handleNotify(request: Request): Promise<Response> {
    let event: DeviceEvent;
    try {
      event = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }
    if (!event || typeof event.event !== "string") {
      return this.jsonError("event is required", "INVALID_EVENT", 400);
    }
    if (!this.deviceInfo) {
      return this.jsonResponse({ delivered: false });
    }
    const createdAt = Date.now();
    if (this.deliverToWaiter({ kind: "event", event, createdAt })) {
      return this.jsonResponse({ delivered: true });
    }
    this.eventQueue.push({ event, createdAt });
    if (this.eventQueue.length > MAX_QUEUED_EVENTS) this.eventQueue.shift();
    return this.jsonResponse({ delivered: false, queued: true });
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
  // Offline memory (device endpoints)
  // ============================================

  /**
   * PUT /snapshot - Device stores a snapshot of what is being read
   *
   * The body is the snapshot JSON (see README: Offline memory). It is
   * encrypted for the device's paired apps before it is stored; the relay
   * keeps no readable copy.
   */
  private async handleSnapshotPut(request: Request): Promise<Response> {
    if (!this.deviceInfo) {
      return this.jsonError("Not registered", "NOT_REGISTERED", 410);
    }
    if (this.snapshotMaxBytes <= 0) {
      return this.jsonError("Offline memory is turned off on this relay", "OFFLINE_MEMORY_DISABLED", 403);
    }
    const tooLarge = () => this.jsonError(
      `Snapshot is larger than ${this.snapshotMaxBytes} bytes`, "SNAPSHOT_TOO_LARGE", 413);
    if (Number(request.headers.get("Content-Length") || 0) > this.snapshotMaxBytes) return tooLarge();

    const now = Date.now();
    if (now - this.lastSnapshotAt < MIN_SNAPSHOT_INTERVAL) {
      const response = this.jsonError("Snapshots are being sent too often", "TOO_MANY_SNAPSHOTS", 429);
      response.headers.set("Retry-After", String(Math.ceil((MIN_SNAPSHOT_INTERVAL - (now - this.lastSnapshotAt)) / 1000)));
      return response;
    }

    const plaintext = await request.arrayBuffer();
    if (plaintext.byteLength > this.snapshotMaxBytes) return tooLarge();

    // Only the shape is checked here; the content is read again (and
    // validated) when an app asks for it
    let parsed: { v?: unknown; scope?: unknown; retention_days?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext));
    } catch {
      return this.jsonError("Snapshot must be UTF-8 JSON", "PARSE_ERROR", 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== 1) {
      return this.jsonError("Unsupported snapshot format", "UNSUPPORTED_SNAPSHOT", 400);
    }

    this.lastSnapshotAt = now;
    await this.pruneAppKeys(now);
    const recipients: Record<string, JsonWebKey> = {};
    for (const [id, key] of Object.entries(this.appKeys)) recipients[id] = key.jwk;

    // With no paired app there is nobody who could ever read it
    if (Object.keys(recipients).length === 0) {
      await this.state.storage.delete("snapshot");
      return this.jsonResponse({ stored: false, reason: "NO_PAIRED_APPS", apps: 0 });
    }

    const requestedDays = typeof parsed.retention_days === "number" && parsed.retention_days > 0
      ? parsed.retention_days : this.snapshotMaxRetentionDays;
    const retentionDays = Math.min(requestedDays, this.snapshotMaxRetentionDays);
    const sealed = await sealSnapshot(plaintext, recipients);
    const snapshot: StoredSnapshot = {
      receivedAt: now,
      expiresAt: now + Math.round(retentionDays * DAY_MS),
      bytes: plaintext.byteLength,
      scope: typeof parsed.scope === "string" ? parsed.scope.slice(0, 32) : undefined,
      ...sealed,
    };
    await this.state.storage.put("snapshot", snapshot);

    // Expiry: one alarm, set when there is none or it would fire too late
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null || alarm > snapshot.expiresAt) {
      await this.state.storage.setAlarm(snapshot.expiresAt);
    }

    return this.jsonResponse({
      stored: true,
      apps: Object.keys(sealed.wraps).length,
      bytes: snapshot.bytes,
      expiresAt: snapshot.expiresAt,
    });
  }

  /** GET /snapshot - Device asks what is stored (never the content) */
  private async handleSnapshotGet(): Promise<Response> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot) return this.jsonResponse({ stored: false });
    return this.jsonResponse({
      stored: true,
      receivedAt: snapshot.receivedAt,
      expiresAt: snapshot.expiresAt,
      bytes: snapshot.bytes,
      scope: snapshot.scope,
      apps: Object.keys(snapshot.wraps).length,
    });
  }

  /** DELETE /snapshot - Device removes its stored snapshot */
  private async handleSnapshotDelete(): Promise<Response> {
    const existed = await this.state.storage.delete("snapshot");
    return this.jsonResponse({ ok: true, deleted: existed });
  }

  /** Alarm: delete the snapshot once it has expired */
  async alarm(): Promise<void> {
    await this.loadSnapshot();
  }

  /** The stored snapshot, unless it has expired (then it is deleted) */
  private async loadSnapshot(): Promise<StoredSnapshot | null> {
    const snapshot = await this.state.storage.get<StoredSnapshot>("snapshot");
    if (!snapshot) return null;
    if (Date.now() >= snapshot.expiresAt) {
      await this.state.storage.delete("snapshot");
      return null;
    }
    // Make sure something deletes it even if nobody asks again
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(snapshot.expiresAt);
    }
    return snapshot;
  }

  // ============================================
  // Offline memory (paired apps' public keys)
  // ============================================

  /**
   * Remember the calling app's public key, so the next snapshot is also
   * encrypted for it. The Worker sends it with every authenticated request.
   * @returns the app's key ID, or null if the request carries none
   */
  private async noteAppKey(request: Request): Promise<string | null> {
    const id = request.headers.get("X-Memory-Key-Id") || "";
    if (!APP_KEY_ID_PATTERN.test(id)) return null;
    const now = Date.now();
    const known = this.appKeys[id];
    if (known) {
      if (now - known.lastUsed > APP_KEY_TOUCH_INTERVAL) {
        known.lastUsed = now;
        await this.state.storage.put("appKeys", this.appKeys);
      }
      return id;
    }
    let jwk: JsonWebKey | null = null;
    try {
      jwk = parsePublicJwk(JSON.parse(request.headers.get("X-Memory-Public-Key") || "null"));
    } catch {
      // not JSON: treated as no key
    }
    if (!jwk) return null;
    await this.addAppKey(id, jwk, now);
    return id;
  }

  private async addAppKey(id: string, jwk: JsonWebKey, now: number): Promise<void> {
    this.appKeys[id] = { jwk, addedAt: this.appKeys[id]?.addedAt || now, lastUsed: now };
    // Over the cap, the app that has been quiet longest loses its place
    const ids = Object.keys(this.appKeys);
    if (ids.length > MAX_APP_KEYS) {
      ids.sort((a, b) => this.appKeys[a].lastUsed - this.appKeys[b].lastUsed);
      for (const stale of ids.slice(0, ids.length - MAX_APP_KEYS)) delete this.appKeys[stale];
    }
    await this.state.storage.put("appKeys", this.appKeys);
  }

  /** Forget public keys of apps that haven't called for a long time */
  private async pruneAppKeys(now: number): Promise<void> {
    let changed = false;
    for (const [id, key] of Object.entries(this.appKeys)) {
      if (now - key.lastUsed > APP_KEY_IDLE_LIMIT) {
        delete this.appKeys[id];
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("appKeys", this.appKeys);
  }

  /** POST /app-key - Internal: a newly paired app's public key. Body: { id, jwk } */
  private async handleAppKeyAdd(request: Request): Promise<Response> {
    let body: { id?: unknown; jwk?: unknown };
    try {
      body = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }
    const jwk = parsePublicJwk(body.jwk);
    if (typeof body.id !== "string" || !APP_KEY_ID_PATTERN.test(body.id) || !jwk) {
      return this.jsonError("Invalid app key", "INVALID_APP_KEY", 400);
    }
    await this.addAppKey(body.id, jwk, Date.now());
    return this.jsonResponse({ ok: true });
  }

  /**
   * DELETE /app-key - Internal: a disconnected app's key. Body: { id }
   * Its wrapped copy of the snapshot key goes too.
   */
  private async handleAppKeyRemove(request: Request): Promise<Response> {
    let body: { id?: unknown };
    try {
      body = await request.json();
    } catch {
      return this.jsonError("Invalid JSON", "PARSE_ERROR", 400);
    }
    if (typeof body.id !== "string") return this.jsonError("Invalid app key", "INVALID_APP_KEY", 400);
    if (this.appKeys[body.id]) {
      delete this.appKeys[body.id];
      await this.state.storage.put("appKeys", this.appKeys);
    }
    const snapshot = await this.state.storage.get<StoredSnapshot>("snapshot");
    if (snapshot?.wraps[body.id]) {
      delete snapshot.wraps[body.id];
      if (Object.keys(snapshot.wraps).length === 0) {
        await this.state.storage.delete("snapshot");
      } else {
        await this.state.storage.put("snapshot", snapshot);
      }
    }
    return this.jsonResponse({ ok: true });
  }

  /** Keep the plugin's manifest from a registration, if it sent a usable one */
  private async storeManifest(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    const manifest: Manifest = {};
    const isList = (v: unknown): v is unknown[] =>
      Array.isArray(v) && v.length <= 64 && v.every(item => item && typeof item === "object" && !Array.isArray(item));
    if (isList(input.tools)) manifest.tools = input.tools;
    if (isList(input.prompts)) manifest.prompts = input.prompts;
    if (typeof input.instructions === "string") manifest.instructions = input.instructions.slice(0, 4000);
    const info = input.serverInfo as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      const pick = (v: unknown) => typeof v === "string" ? v.slice(0, 100) : undefined;
      manifest.serverInfo = { name: pick(info.name), title: pick(info.title), version: pick(info.version) };
    }
    const encoded = JSON.stringify(manifest);
    if (encoded.length > MAX_MANIFEST_BYTES) return;
    // Registrations repeat on every reconnect; write only what changed
    if (JSON.stringify(await this.state.storage.get<Manifest>("manifest")) === encoded) return;
    await this.state.storage.put("manifest", manifest);
  }

  // ============================================
  // Helpers
  // ============================================

  private isDeviceOnline(): boolean {
    if (!this.deviceInfo || this.lastPollTime === 0) return false;
    return (Date.now() - this.lastPollTime) < SESSION_TIMEOUT;
  }

  /**
   * Can the device be expected to pick up a request soon? Yes if it is
   * waiting in a long poll, is working on a request, or was heard from
   * within the last PICKUP_GRACE.
   */
  private deviceReachable(): boolean {
    if (!this.deviceInfo) return false;
    return this.pollWaiters.length > 0
      || this.inFlight.size > 0
      || (Date.now() - this.lastContact) < PICKUP_GRACE
      || Date.now() < this.startupGraceUntil;
  }

  /**
   * The device announced that it is going away: from now on requests get
   * the offline answer at once, until it polls or registers again.
   */
  private async markLeft(): Promise<void> {
    this.left = true;
    this.lastSeen = Date.now();
    this.lastContact = 0;
    this.startupGraceUntil = 0;
    this.releasePollWaiters();
    await this.state.storage.put("lastSeen", this.lastSeen);
  }

  /** Note a sign of life from the device */
  private touchContact(): void {
    const now = Date.now();
    this.left = false;
    this.lastContact = now;
    if (now - this.lastSeen > LAST_SEEN_WRITE_INTERVAL) {
      this.lastSeen = now;
      // Not awaited: the output gate holds responses until it is durable
      void this.state.storage.put("lastSeen", now);
    }
  }

  /** Hand a message to a waiting poll; false if none is waiting */
  private deliverToWaiter(message: PollMessage): boolean {
    const waiter = this.pollWaiters.shift();
    if (!waiter) return false;
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
    return true;
  }

  private pollMessageResponse(message: PollMessage): Response {
    if (message.kind === "event") {
      return this.jsonResponse({ type: "event", ...message.event });
    }
    const { requestId, method, path, headers, body } = message.request;
    // Only requests somebody still waits for count as being worked on
    if (this.pendingRequests.has(requestId)) this.inFlight.add(requestId);
    return this.jsonResponse({ type: "request", requestId, method, path, headers, body });
  }

  private removeWaiter(resolve: (message: PollMessage | null) => void): void {
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

  private methodNotAllowed(allow?: string): Response {
    const response = this.jsonError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
    if (allow) response.headers.set("Allow", allow);
    return response;
  }

  private corsResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, X-Device-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID");
    headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Allow");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
