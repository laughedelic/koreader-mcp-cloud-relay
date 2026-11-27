# MCP Relay for Cloudflare Workers

A secure HTTP long-polling relay that enables remote access to KOReader MCP servers from anywhere. This service bridges the gap between your e-reader and MCP clients like Claude Desktop or Claude Mobile.

## Features

- **OAuth 2.1 Authentication (Authorization Code + PKCE)**: Secure access with device-generated passcodes
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
  D->>R: POST /register (passcodeHash)
  R-->>D: 200 OK (relayUrl, tokenEndpoint)
  Note over D: Display passcode to user

  Note over C,R: 2) Client authenticates via OAuth
  C->>R: GET /authorize (login UI)
  C->>R: POST /oauth/token (auth code exchange)
  R-->>C: 200 OK (access_token)

  Note over D,R: 3) Device polls for requests
  loop Long-poll cycle
    D->>R: GET /poll
    alt Request available
      C->>R: POST /mcp (Authorization: Bearer token)
      R->>R: Validate access token
      R-->>D: 200 OK ({type:request})
      Note over D: Process request locally
      D->>R: POST /response
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

curl -X POST https://mcp-relay.example.com/register \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "KoboClara-abc1",
    "deviceName": "My Kobo",
    "passcodeHash": "8d969eef6ecad3c29a3a629280e686cf...",
    "deviceSecret": "<64 random hex chars, generated on the device>",
    "version": "2.0.0"
  }'

# Response:
{
  "type": "registered",
  "deviceId": "KoboClara-abc1",
  "relayUrl": "https://mcp-relay.example.com/mcp",
  "tokenEndpoint": "https://mcp-relay.example.com/oauth/token",
  "deviceSecretRegistered": true
}
```

The passcode is displayed to the user on their device. They need to enter it in their MCP client (Claude Desktop, etc.) for authentication.

### 2. Getting an Access Token

MCP clients authenticate using OAuth 2.1 Authorization Code flow with PKCE.

### 3. Making Authenticated MCP Requests

Include the access token in the `Authorization` header:

```bash
curl -X POST https://mcp-relay.example.com/mcp \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "resources/list", "id": 1}'
```

### OAuth Metadata Endpoints

The relay implements RFC 9728 Protected Resource Metadata:

- `/mcp/.well-known/oauth-protected-resource` - Protected resource metadata
- `/.well-known/oauth-authorization-server` - Authorization server metadata

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

### `GET /`

Returns relay info and available endpoints.

### OAuth Endpoints

| Endpoint                                  | Method | Description                         |
| ----------------------------------------- | ------ | ----------------------------------- |
| `/authorize`                              | GET    | Authorization endpoint (login)      |
| `/.well-known/oauth-protected-resource`   | GET    | Protected Resource Metadata         |
| `/.well-known/oauth-authorization-server` | GET    | Authorization Server Metadata       |
| `/oauth/token`                            | POST   | Token endpoint (auth code exchange) |

### Device Endpoints (used by KOReader)

| Endpoint    | Method | Description                          |
| ----------- | ------ | ------------------------------------ |
| `/register` | POST   | Register device with passcode hash   |
| `/poll`     | GET    | Long-poll for incoming MCP requests  |
| `/response` | POST   | Send response to a forwarded request |
| `/pong`     | POST   | Keep-alive heartbeat (optional)      |
| `/status`   | GET    | Check if the device is online        |

All device endpoints require the `X-Device-Id` header (except `/register`, which includes `deviceId` in the JSON body).

`/poll`, `/response`, `/pong` and `/status` also require `Authorization: Device <deviceSecret>`, using the secret the device sent at registration. Re-registering a device that has a secret requires the same secret. `/status` always requires the secret.

While `REQUIRE_DEVICE_SECRET` is `"false"` (the default, for compatibility), any registration without `deviceSecret` is accepted, new or old, and that device's `/poll`, `/response` and `/pong` calls are not authenticated. Such a device upgrades by re-registering with a secret and its passcode hash. Set `REQUIRE_DEVICE_SECRET = "true"` in `wrangler.toml` to reject secretless registrations and unauthenticated device calls.

### Client Endpoints (used by Claude/MCP clients)

| Endpoint  | Method | Description                                                                    |
| --------- | ------ | ------------------------------------------------------------------------------ |
| `/mcp`    | POST   | Send MCP request (requires Bearer token)                                       |

Only protocol headers (`Accept`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`, `Last-Event-ID`, `User-Agent`) are forwarded to the device. The client's `Authorization` header and cookies never leave the relay.

## Security

### Passcode Security

- **Device-generated**: Passcode is generated and displayed only on the device
- **Zero-knowledge**: Relay only receives and stores the SHA-256 hash
- **Never transmitted in plaintext**: The actual passcode never leaves the device
- **Re-registration verification**: Reconnections must provide the matching device secret (or, for legacy devices, the matching passcode hash)
- **Brute-force protection**: After 5 wrong passcodes, the device is locked for 1 minute, doubling with each further failure up to 1 hour

### Device Security

- **Device secret**: A random secret generated on the device authenticates its polling, so knowing a device ID is not enough to receive its requests
- **Header allowlist**: Client credentials are never forwarded to the device

### Token Security

- **Short-lived tokens**: Access tokens expire in 1 hour
- **Audience validation**: Tokens are bound to the relay resource

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
