# MCP Relay for Cloudflare Workers

A secure HTTP long-polling relay that enables remote access to KOReader MCP servers from anywhere. This service bridges the gap between your e-reader and MCP clients like Claude Desktop or Claude Mobile.

## Features

- **OAuth 2.0 Authentication**: Secure access with device-generated passcodes
- **MCP Authorization Compliant**: Implements RFC 9728 Protected Resource Metadata
- **HTTP Long-Polling**: Works with any HTTP client (no WebSocket required)
- **Cloudflare Durable Objects**: Persistent device state and request queuing
- **Device-Based IDs**: IDs derived from your device model (e.g., `KoboClara-abc1`)
- **Zero-Knowledge Passcode**: Passcode is generated and hashed on-device, never sent in plaintext

## How It Works

```mermaid
sequenceDiagram
  participant D as E-Reader (KOReader)
  participant R as MCP Relay (Cloudflare)
  participant C as Client (Claude / MCP)

  Note over D: Generate deviceId + passcode locally
  Note over D: Hash passcode with SHA-256

  Note over D,R: 1) Device registration
  D->>R: POST /{deviceId}/register (passcodeHash)
  R-->>D: 200 OK (relayUrl, tokenEndpoint)
  Note over D: Display passcode to user

  Note over C,R: 2) Client gets access token
  C->>R: POST /oauth/token (username=deviceId, password=passcode)
  R->>R: Hash passcode & compare
  R-->>C: 200 OK (access_token)

  Note over D,R: 3) Device polls for requests
  loop Long-poll cycle
    D->>R: GET /{deviceId}/poll
    alt Request available
      C->>R: POST /{deviceId}/mcp (Authorization: Bearer token)
      R->>R: Validate JWT token
      R-->>D: 200 OK ({type:request})
      Note over D: Process request locally
      D->>R: POST /{deviceId}/response
      R-->>C: 200 OK (MCP response)
    else Timeout
      R-->>D: 200 OK ({type:ping})
    end
  end
```

## Authentication Flow

### 1. Device Registration

When a device registers, it **generates credentials locally** (deviceId from device model + suffix, random 6-digit passcode) and sends only the SHA-256 hash of the passcode to the relay:

```bash
# Device generates: deviceId="KoboClara-abc1", passcode="123456"
# Device computes: passcodeHash=SHA256("123456")

curl -X POST https://mcp-relay.example.com/KoboClara-abc1/register \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "KoboClara-abc1",
    "deviceName": "My Kobo",
    "passcodeHash": "8d969eef6ecad3c29a3a629280e686cf...",
    "version": "2.0.0"
  }'

# Response:
{
  "type": "registered",
  "deviceId": "KoboClara-abc1",
  "relayUrl": "https://mcp-relay.example.com/KoboClara-abc1/mcp",
  "tokenEndpoint": "https://mcp-relay.example.com/oauth/token"
}
```

The passcode is displayed to the user on their device. They need to enter it in their MCP client (Claude Desktop, etc.) for authentication.

### 2. Getting an Access Token

MCP clients authenticate using the OAuth 2.0 password grant:

```bash
curl -X POST https://mcp-relay.example.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&username=KoboClara-abc1&password=123456"

# Response:
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "mcp:access"
}
```

### 3. Making Authenticated MCP Requests

Include the access token in the `Authorization` header:

```bash
curl -X POST https://mcp-relay.example.com/KoboClara-abc1/mcp \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "resources/list", "id": 1}'
```

### OAuth Metadata Endpoints

The relay implements RFC 9728 Protected Resource Metadata:

- `/.well-known/oauth-protected-resource` - Global resource metadata
- `/.well-known/oauth-authorization-server` - Authorization server metadata
- `/{deviceId}/.well-known/oauth-protected-resource` - Device-specific metadata

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

3. (Optional) Set a JWT secret for token signing
    ```bash
    bun run wrangler secret put JWT_SECRET
    # Enter a random string when prompted
    ```

4. Deploy
    ```bash
    bun run wrangler deploy
    ```

Your relay will be available at: `https://mcp-relay.<your-subdomain>.workers.dev/`

## API Endpoints

### OAuth Endpoints

| Endpoint                                  | Method | Description                     |
| ----------------------------------------- | ------ | ------------------------------- |
| `/.well-known/oauth-protected-resource`   | GET    | Protected Resource Metadata     |
| `/.well-known/oauth-authorization-server` | GET    | Authorization Server Metadata   |
| `/oauth/token`                            | POST   | Token endpoint (password grant) |

### Device Endpoints (used by KOReader)

| Endpoint               | Method | Description                          |
| ---------------------- | ------ | ------------------------------------ |
| `/{deviceId}/register` | POST   | Register device with passcode hash   |
| `/{deviceId}/poll`     | GET    | Long-poll for incoming MCP requests  |
| `/{deviceId}/response` | POST   | Send response to a forwarded request |
| `/{deviceId}/pong`     | POST   | Keep-alive heartbeat (optional)      |

### Client Endpoints (used by Claude/MCP clients)

| Endpoint             | Method | Description                              |
| -------------------- | ------ | ---------------------------------------- |
| `/{deviceId}/mcp`    | POST   | Send MCP request (requires Bearer token) |
| `/{deviceId}/status` | GET    | Check if device is online                |

## Security

### Passcode Security

- **Device-generated**: Passcode is generated and displayed only on the device
- **Zero-knowledge**: Relay only receives and stores the SHA-256 hash
- **Never transmitted in plaintext**: The actual passcode never leaves the device
- **Re-registration verification**: Reconnections must provide matching passcode hash

### Token Security

- **Industry-standard JWT**: Uses the [jose](https://github.com/panva/jose) library for JWT handling
- **Short-lived tokens**: Access tokens expire in 1 hour
- **Audience validation**: Tokens are bound to specific device endpoints
- **HMAC-SHA256 signing**: Tokens are cryptographically signed

### Best Practices

Following [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices.md):

- ✅ HTTPS for all communication
- ✅ Token audience validation
- ✅ No token passthrough
- ✅ Proper `WWW-Authenticate` challenges with `resource_metadata`
- ✅ Short-lived access tokens
- ✅ Secure credential storage (hashed passcodes)

## Configuration

| Parameter        | Value          | Description                                      |
| ---------------- | -------------- | ------------------------------------------------ |
| Poll timeout     | 30s            | How long the relay waits before returning `ping` |
| Request timeout  | 30s            | How long client waits for device response        |
| Session timeout  | 2min           | Device considered offline after no activity      |
| Token expiry     | 1 hour         | How long access tokens are valid                 |
| Device ID format | `{model}-xxxx` | Device model + 4-char random suffix              |
| Passcode format  | 6 digits       | Random numeric passcode                          |

## Cost Estimation (Cloudflare Free Tier)

| Resource                | Free Tier Limit | Expected Usage |
| ----------------------- | --------------- | -------------- |
| Worker Requests         | 100,000/day     | ~1,000/day     |
| Durable Object Requests | 1,000,000/month | ~10,000/month  |
| Durable Object Storage  | 1 GB            | ~1 MB          |
