/**
 * Simplified types for HTTP Long-Polling only
 * 
 * This is a proposed simplified version that removes WebSocket-related types.
 * To use: rename to types.ts
 */

// ============================================
// Device → Relay Messages
// ============================================

export interface RegisterMessage {
  type?: "register";      // Optional since it's implied by endpoint
  deviceId?: string;      // Reuse previous ID for reconnection
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
}
