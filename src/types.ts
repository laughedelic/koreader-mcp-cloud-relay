// ============================================
// Device → Relay Messages
// ============================================

export interface RegisterMessage {
  type?: "register";      // Optional since it's implied by endpoint
  deviceId: string;       // Device-generated ID (required)
  passcodeHash: string;   // SHA-256 hash of the passcode (required for first registration)
  deviceName?: string;    // Human-readable name (e.g., "My Kindle")
  version?: string;       // Plugin version
  deviceSecret?: string;  // Random device-generated secret; required on /poll, /response, /pong once registered
  manifest?: unknown;     // The plugin's tool list and server info, for answers while the device is offline
}

export interface ResponseMessage {
  type?: "response";      // Optional since it's implied by endpoint
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body: string;           // JSON string (the MCP response)
}

// ============================================
// OAuth Types
// ============================================

export interface OAuthError {
  error: string;
  error_description?: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

// ============================================
// Relay → Device Messages
// ============================================

export interface RegisteredMessage {
  type: "registered";
  deviceId: string;
  relayUrl: string;       // Full URL for MCP clients
}

export interface RequestMessage {
  type: "request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;           // JSON string (the MCP request)
}

export interface PingMessage {
  type: "ping";
}

// ============================================
// Internal Types
// ============================================

export interface PendingRequest {
  resolve: (response: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  connectedAt: number;
  lastActivity: number;
  version?: string;
  // OAuth credentials (device sends hash during registration)
  passcodeHash?: string;
  // SHA-256 of the device secret that authenticates /poll, /response, /pong
  deviceSecretHash?: string;
  // True once the device has used one-time pairing codes; the permanent
  // passcode then no longer signs in new clients
  pairingCodes?: boolean;
  registeredAt?: number;
}

// ============================================
// Offline answers and offline memory
// ============================================

/**
 * What the plugin tells the relay about itself at registration, so the relay
 * can answer `initialize`, `tools/list` and `prompts/list` exactly as the
 * device would while it is offline. It holds no user content.
 */
export interface Manifest {
  tools?: unknown[];
  prompts?: unknown[];
  instructions?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
}

/** A paired app's public key, as known to the device's Durable Object */
export interface StoredAppKey {
  jwk: JsonWebKey;
  addedAt: number;
  lastUsed: number;
}

/** Facts about a stored snapshot that are not content */
export interface SnapshotMeta {
  receivedAt: number;      // relay clock, ms
  expiresAt: number;       // relay clock, ms
  bytes: number;           // size of the snapshot JSON before encryption
  scope?: string;          // preset chosen on the reader
}

/** The stored snapshot: metadata plus ciphertext (see memory-crypto.ts) */
export interface StoredSnapshot extends SnapshotMeta {
  eph: JsonWebKey;
  iv: string;
  wraps: Record<string, { iv: string; key: string }>;
  ct: ArrayBuffer;
}

/**
 * What the Durable Object hands the Worker when the device can't answer.
 * It travels as a binary frame (see encodeOfflineFrame), followed by the
 * snapshot ciphertext when the calling app has a key for it.
 */
export interface OfflineInfo {
  // Last time the device talked to the relay (ms), if known
  lastSeen: number | null;
  // True when a request reached the device but got no answer in time
  unresponsive: boolean;
  deviceName?: string;
  manifest: Manifest | null;
  // "none": nothing stored; "locked": stored, but not readable by this app
  memory: "none" | "locked" | "sealed";
  snapshot?: SnapshotMeta & { eph: JsonWebKey; iv: string; wrap: { iv: string; key: string } };
}

// ============================================
// HTTP API Types
// ============================================

export interface StatusResponse {
  deviceId: string;
  online: boolean;
  deviceName?: string;
  connectedAt?: number;
  lastActivity?: number;
}

export interface ErrorResponse {
  error: string;
  code: string;
}

// ============================================
// Environment
// ============================================

export interface Env {
  MCP_RELAY: DurableObjectNamespace;
  // Single global instance mapping one-time pairing codes to device IDs
  PAIRING_INDEX: DurableObjectNamespace;
  // KV namespace for OAuth state (tokens, clients, authorization codes)
  OAUTH_KV: KVNamespace;
  // "true" to reject devices that never registered a device secret
  REQUIRE_DEVICE_SECRET?: string;
  // Secret pairing code (8+ digits) that signs in to the built-in demo reader;
  // unset means no demo. Set with: wrangler secret put DEMO_PAIRING_CODE
  DEMO_PAIRING_CODE?: string;
  // Offline memory: largest snapshot a reader may store, in bytes
  // (default 1048576). "0" turns offline memory off on this relay.
  SNAPSHOT_MAX_BYTES?: string;
  // Offline memory: longest time a snapshot is kept, in days (default 30)
  SNAPSHOT_MAX_RETENTION_DAYS?: string;
}
