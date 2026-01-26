# MCP Relay for Cloudflare Workers

A lightweight HTTP long-polling relay that enables remote access to KOReader MCP servers from anywhere. This service bridges the gap between your e-reader and MCP clients like Claude Desktop or Claude Mobile.

## How It Works

1. Your e-reader registers with the relay and receives a public URL
2. The device polls for incoming MCP requests (long-polling with 30s timeout)
3. MCP clients (Claude, etc.) send HTTP requests to the device's public URL
4. The relay queues requests and delivers them when the device polls
5. The device processes requests locally and sends responses back

```mermaid
sequenceDiagram
  participant D as E-Reader (KOReader)
  participant R as MCP Relay (Cloudflare)
  participant C as Client (Claude / MCP)

  Note over D,R: 1) Device registers → gets public URL
  D->>R: POST /{deviceId}/register
  R-->>D: 200 OK (relayUrl, deviceId)

  Note over D,R: 2) Device opens long-poll (30s)
  loop Long-poll cycle
    D->>R: GET /{deviceId}/poll (long-poll, 30s)
    alt Request available
      C->>R: POST /{deviceId}/mcp (MCP request)
      R-->>D: 200 OK ({type:request,requestId,method,body})
      Note over D: Process request locally
      D->>R: POST /{deviceId}/response ({requestId,status,body})
      R-->>C: 200 OK (MCP response)
      R-->>D: 200 OK (ack)
    else Timeout / no requests
      R-->>D: 200 OK ({type:ping})
    end
  end

  Note over D,R: Optional keep-alive
  D->>R: POST /{deviceId}/pong (update last activity)

  Note over C,R: Client checks device status
  C->>R: GET /{deviceId}/status
  R-->>C: 200 OK (online/offline)
```

### Why HTTP Long-Polling?

KOReader uses LuaSocket which doesn't have native WebSocket support. HTTP long-polling provides:
- **Compatibility**: Works with any HTTP client
- **Simplicity**: No complex connection state management
- **Battery efficiency**: Adaptive polling intervals (0.5s - 5s)
- **Reliability**: Automatic reconnection on network issues

## Deployment

### Prerequisites

- npm/bun
- Cloudflare account (_free tier_ works!)

### Deploy to Cloudflare

1. Install dependencies
    ```bash
    bun install
    ```

2. Login to Cloudflare
    ```bash
    bun run wrangler login
    ```

3. Deploy
    ```bash
    bun run wrangler deploy
    ```

Your relay will be available at: `https://mcp-relay.<your-subdomain>.workers.dev/`

## API Endpoints

### `GET /`
Returns relay info and available endpoints.

### Device Endpoints (used by KOReader)

| Endpoint               | Method | Description                          |
| ---------------------- | ------ | ------------------------------------ |
| `/{deviceId}/register` | POST   | Register device and get public URL   |
| `/{deviceId}/poll`     | GET    | Long-poll for incoming MCP requests  |
| `/{deviceId}/response` | POST   | Send response to a forwarded request |
| `/{deviceId}/pong`     | POST   | Keep-alive heartbeat (optional)      |

### Client Endpoints (used by Claude/MCP clients)

| Endpoint             | Method | Description                |
| -------------------- | ------ | -------------------------- |
| `/{deviceId}/mcp`    | POST   | Send MCP request to device |
| `/{deviceId}/status` | GET    | Check if device is online  |

## Protocol

### Device Registration

```mermaid
sequenceDiagram
  participant D as Device (KOReader)
  participant R as Relay

  D->>R: POST /{deviceId}/register
  Note over D,R: {"deviceId": "abc123xyz456",<br/>"deviceName": "My Kindle",<br/>"version": "1.0.0"}
  R-->>D: 200 OK
  Note over D,R: {"type": "registered",<br/>"deviceId": "abc123xyz456",<br/>"relayUrl": "https://..."}
```

### Polling for Requests

```mermaid
sequenceDiagram
  participant D as Device (KOReader)
  participant R as Relay
  participant C as Client (Claude)

  D->>R: GET /{deviceId}/poll
  Note over D,R: Long-poll connection (30s timeout)
  
  alt Request available
    C->>R: POST /{deviceId}/mcp (MCP request)
    R-->>D: 200 OK
    Note over D,R: {"type": "request",<br/>"requestId": "req-...",<br/>"method": "POST",<br/>"body": "..."}
  else Timeout (no requests)
    R-->>D: 200 OK
    Note over D,R: {"type": "ping"}
  end
```

### Sending Response

```mermaid
sequenceDiagram
  participant D as Device (KOReader)
  participant R as Relay
  participant C as Client (Claude)

  C->>R: POST /{deviceId}/mcp (MCP request)
  Note over R: Request queued
  D->>R: GET /{deviceId}/poll
  R-->>D: Request details
  Note over D: Process MCP request
  D->>R: POST /{deviceId}/response
  Note over D,R: {"type": "response",<br/>"requestId": "req-...",<br/>"status": 200,<br/>"body": "..."}
  R-->>D: 200 OK
  R-->>C: 200 OK (MCP response)
```

### Keep-Alive (Optional)

**Request:** `POST /{deviceId}/pong`

The device can send pong to update its last activity timestamp without waiting for a full poll cycle.

## Timeouts and Configuration

| Parameter        | Value    | Description                                      |
| ---------------- | -------- | ------------------------------------------------ |
| Poll timeout     | 30s      | How long the relay waits before returning `ping` |
| Request timeout  | 30s      | How long client waits for device response        |
| Session timeout  | 2min     | Device considered offline after no activity      |
| Device ID length | 12 chars | Alphanumeric, lowercase                          |

### Client-side (KOReader) Adaptive Polling

The KOReader client uses adaptive polling intervals:
- **Active**: 0.5s between polls (when recently handling requests)
- **Idle**: Up to 5s between polls (battery saving mode)

## Custom Domain (Optional)

To use a custom domain like `mcp.yourdomain.com`:

1. Add your domain to Cloudflare
2. Update the route in `wrangler.toml`:
   ```toml
   [[routes]]
   pattern = "mcp.yourdomain.com/*"
   custom_domain = true
   ```
3. Redeploy: `npx wrangler deploy`

## Security

- **Device ID as secret**: The 12-character device ID acts as a bearer token. Anyone with the ID can send requests to your device.
- **All traffic encrypted**: HTTPS for all communication.
- **No stored content**: The relay doesn't persist MCP request/response content, only device registration data.

## Cost Estimation (Cloudflare Free Tier)

Casual usage should fit within Cloudflare's free tier limits:

| Resource                | Free Tier Limit | Expected Usage |
| ----------------------- | --------------- | -------------- |
| Worker Requests         | 100,000/day     | ~1,000/day     |
| Durable Object Requests | 1,000,000/month | ~10,000/month  |
| Durable Object Storage  | 1 GB            | ~1 MB          |
