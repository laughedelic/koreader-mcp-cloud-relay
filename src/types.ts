// Shared types for MCP Relay protocol

// ============================================
// Device → Relay (WebSocket Messages)
// ============================================

export interface RegisterMessage {
  type: "register";
  deviceId?: string;    // Optional: reuse previous ID for reconnection
  deviceName?: string;  // Optional: human-readable name (e.g., "My Kindle")
  version?: string;     // Plugin version for compatibility checking
}

export interface ResponseMessage {
  type: "response";
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body: string;  // JSON string (the MCP response)
}

export interface PongMessage {
  type: "pong";
}

export type DeviceMessage = RegisterMessage | ResponseMessage | PongMessage;

// ============================================
// Relay → Device (WebSocket Messages)
// ============================================

export interface RegisteredMessage {
  type: "registered";
  deviceId: string;
  relayUrl: string;  // Full URL for MCP clients to use
}

export interface RequestMessage {
  type: "request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;  // JSON string (the MCP request)
}

export interface PingMessage {
  type: "ping";
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type RelayMessage = RegisteredMessage | RequestMessage | PingMessage | ErrorMessage;

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
// Environment bindings
// ============================================

export interface Env {
  MCP_RELAY: DurableObjectNamespace;
}
