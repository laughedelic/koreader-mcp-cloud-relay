// ============================================
// Device → Relay Messages
// ============================================

export interface RegisterMessage {
  type?: "register";      // Optional since it's implied by endpoint
  deviceId: string;       // Device-generated ID (required)
  passcodeHash: string;   // SHA-256 hash of the passcode (required for first registration)
  deviceName?: string;    // Human-readable name (e.g., "My Kindle")
  version?: string;       // Plugin version
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

export interface TokenRequest {
  grant_type: "password";
  username: string;       // Device ID
  password: string;       // Numeric passcode
  scope?: string;         // Optional scopes (default: mcp:access)
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface TokenPayload {
  sub: string;            // Device ID
  aud: string;            // Relay URL
  iat: number;            // Issued at
  exp: number;            // Expires at
  scope: string;          // Granted scopes
}

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
  registeredAt?: number;
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
  // JWT signing secret (should be configured in Cloudflare Workers secrets)
  JWT_SECRET?: string;
}
