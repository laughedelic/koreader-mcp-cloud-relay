# MCP Relay for Cloudflare Workers

A secure HTTP long-polling relay that enables remote access to KOReader MCP servers from anywhere. This service bridges the gap between your e-reader and MCP clients like Claude Desktop or Claude Mobile.

## Features

- **OAuth 2.1 Authentication (Authorization Code + PKCE)**: Pair an AI app with a one-time 6-digit code shown on the reader
- **MCP Authorization Compliant**: Implements RFC 9728 Protected Resource Metadata
- **HTTP Long-Polling**: Works with any HTTP client (no WebSocket required)
- **Cloudflare Durable Objects**: Persistent device state and request queuing
- **Device-Based IDs**: IDs derived from your device model (e.g., `KoboClara-abc1`)
- **Zero-Knowledge Passcode**: Passcode is generated and hashed on-device, never sent in plaintext
- **Offline answers**: When the reader is asleep or away, AI apps get a clear "reader offline" answer instead of an error
- **Offline memory (optional)**: The reader can save an encrypted copy of what is being read, so paired AI apps can still discuss it while the reader is offline

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

The passcode hash only anchors the device's identity for older plugins; current plugins pair with one-time codes instead (below).

### 2. Pairing an AI app

MCP clients authenticate using OAuth 2.1 Authorization Code flow with PKCE. The sign-in page (`/authorize`) asks for a **one-time pairing code**:

1. On the reader, the user opens **MCP server → Connect an AI app**. The plugin calls `POST /pairing-code` (authenticated with the device secret) and shows the 6-digit code it gets back.
2. The user enters the code on the sign-in page. The relay looks it up, deletes it, and issues the OAuth grant for that device.

A code is single use, expires after 10 minutes, and a device has at most one live code (asking again replaces it). Since the code alone picks the device, wrong codes are limited to 10 per IP and 100 relay-wide per 10 minutes. The code is only a pairing token: the lasting credential is the client's OAuth token, which the user can revoke from the reader (**Connected apps**).

Once a device has requested a pairing code, its permanent passcode stops working for new sign-ins. Older plugins keep using the device ID and passcode form (under "Older plugin?" on the sign-in page).

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

### Demo reader (optional)

Set a secret pairing code of 8 to 16 digits to enable a built-in demo reader:

```bash
bun run wrangler secret put DEMO_PAIRING_CODE
```

Signing in with that code connects the AI app to `demo-reader`, which the Worker answers itself with the plugin's tools, resources and prompts over a public-domain sample book (*Alice's Adventures in Wonderland*, chapters I to III). It exists so connector directory reviewers can try every tool without an e-reader. Page turns and highlights live only in the Worker's memory, separately for each sign-in. The demo code counts against the same wrong-guess limits as pairing codes, and removing the secret turns the demo off, including for apps already signed in. It speaks MCP 2025-03-26 to 2025-11-25. The tool definitions come from the plugin (`src/demo-data.json`); regenerate them when the plugin's tools change.

## When the reader is offline

An e-reader sleeps, turns WiFi off and stops its MCP server to save battery, so it is often away when an AI app calls. The relay then answers the MCP request itself instead of failing.

A reader counts as reachable while it waits in a long poll, works on a request, or was heard from in the last 15 seconds. A request that arrives outside that window, or that nobody picks up, gets an offline answer:

- `initialize`, `tools/list`, `prompts/list` and the resource lists still work, so the app keeps its tools. They use the tool list the plugin sent with its last `/register` (`manifest`), or the bundled definitions if it sent none.
- Tool calls return a normal tool result that starts with `[Reader offline]`, says when the reader was last seen and tells the model how the user can bring it back. Tools that change something (`goto_page`, `annotate`) say that nothing was done.
- Every result carries `structuredContent.reader` (`online: false`, `last_seen`, `source`).

A reader that vanishes with its long poll open (WiFi dropped) can't be told apart from one that is slow, so the first request after that waits the full 30 second request timeout before it gets the offline answer (worded as "did not answer in time"). Later requests are answered at once. Two things shorten that wait when the reader leaves in an orderly way: a reader that calls `POST /bye` (or sends `X-Reader-Leaving: 1` with its last `PUT /snapshot`) is offline from that moment, and `wrangler.toml` sets the `enable_request_signal` compatibility flag so the relay can end a poll whose connection the reader closed. The second one is not reported by local `wrangler dev`, so it has not been tested there.

Without offline memory this stores nothing about the book. The relay keeps the time it last heard from the reader and the plugin's tool list.

### Offline memory

Offline memory is optional and off unless the user turns it on in the plugin. The reader then sends a snapshot of the open book with `PUT /snapshot`, and while the reader is offline the relay answers the read-only tools (`get_reading_context`, `get_book_metadata`, `read_pages`, `search_book`) and the `book://` resources from it. Each answer starts with `[Reader offline: answering from a saved copy]`, says when the copy was saved and which pages it holds, and never pretends to cover the rest of the book. As soon as the reader is back, requests go to the reader again and the saved copy is not used.

There is one snapshot per device (the book that was open last). A new one replaces the old one.

**Snapshot format** (JSON, UTF-8, at most `SNAPSHOT_MAX_BYTES`):

```jsonc
{
  "v": 1,
  "taken_at": 1796000000,          // Unix seconds, on the reader
  "scope": "pages",                // label chosen by the plugin, e.g. "position" or "pages"
  "retention_days": 30,            // capped by SNAPSHOT_MAX_RETENTION_DAYS
  "book": { "title": "", "authors": "", "language": "", "series": "", "keywords": "",
            "description": "", "format": "epub", "total_pages": 300 },
  "position": { "page": 118, "percent_finished": 0.39,
                "chapter": { "name": "", "index": 7, "start_page": 110, "end_page": 131 } },
  "toc": [{ "index": 1, "title": "", "page": 1, "depth": 1 }],
  "annotations": [{ "text": "", "note": "", "note_format": "", "page": 40, "chapter": "",
                    "datetime": "2026-11-20 10:00:00", "color": "", "style": "" }],
  "pages": [{ "number": 118, "text": "" }]   // may be empty
}
```

A reader that is about to sleep or stop adds the header `X-Reader-Leaving: 1` to its last snapshot.

`PUT /snapshot` answers `{stored: true, apps, bytes, expiresAt}`, or `{stored: false, reason: "NO_PAIRED_APPS"}` when no paired app could read it (nothing is kept then). Errors: `413 SNAPSHOT_TOO_LARGE`, `429 TOO_MANY_SNAPSHOTS` (at most one every 15 seconds, with `Retry-After`), `400 UNSUPPORTED_SNAPSHOT`, `403 OFFLINE_MEMORY_DISABLED`. `/register` reports `offlineMemory: {maxBytes, maxRetentionDays}` when the relay offers it.

**Encryption.** The relay can't read a stored snapshot on its own:

- Every paired AI app (OAuth grant) gets an ECDH P-256 key pair when it pairs. The private key lives only in the grant's `props`, which the OAuth provider encrypts with the app's token as key material. The device's Durable Object only ever holds the public key.
- A snapshot is encrypted with a fresh AES-256-GCM key as soon as it arrives. That key is wrapped for each paired app's public key (ephemeral ECDH, HKDF-SHA256, AES-GCM) and then dropped. Only the ciphertext is stored.
- When a paired app calls with a valid token while the reader is offline, the Worker takes the private key from the decrypted grant, unwraps the content key and reads the snapshot for that one request.

So reading a snapshot takes a live token of an app the user paired. A copy of the storage alone is not enough, and neither is the device ID. The plaintext passes through the Worker's memory when it is saved and when a paired app reads it, so this protects data at rest, not against a relay operator who changes the code.

An app paired before this feature existed gets its key at its next token refresh. An app paired after a snapshot was saved can't read that one ("locked"), only the next. Disconnecting an app deletes its grant, its key and its wrapped copy of the snapshot key.

**Deletion.** A snapshot is deleted when it expires (a Durable Object alarm, at most `SNAPSHOT_MAX_RETENTION_DAYS` after it was saved), when the reader sends `DELETE /snapshot`, when the last app that could read it is disconnected, or when a newer one replaces it.

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
| `/pairing-code` | POST | Get a one-time pairing code (`{code, expiresAt, expiresIn, relayUrl}`) |
| `/connected-apps` | GET | List authorized AI apps (`{apps: [{id, name, connectedAt}]}`, `connectedAt` in Unix seconds) |
| `/connected-apps/{id}` | DELETE | Disconnect an AI app (revokes its grant and tokens) |
| `/bye` | POST | The reader is about to sleep or stop: requests get the offline answer at once until it polls again |
| `/snapshot` | PUT | Save a snapshot of what is being read (see [Offline memory](#offline-memory)) |
| `/snapshot` | GET | What is saved (`{stored, receivedAt, expiresAt, bytes, scope, apps}`), never the content |
| `/snapshot` | DELETE | Delete the saved snapshot |

All device endpoints require the `X-Device-Id` header (except `/register`, which includes `deviceId` in the JSON body).

`/poll`, `/response`, `/pong`, `/status`, `/bye`, `/pairing-code`, `/connected-apps` and `/snapshot` also require `Authorization: Device <deviceSecret>`, using the secret the device sent at registration. Re-registering a device that has a secret requires the same secret. `/status`, `/bye`, `/pairing-code`, `/connected-apps` and `/snapshot` always require the secret.

While `REQUIRE_DEVICE_SECRET` is `"false"` (the default, for compatibility), any registration without `deviceSecret` is accepted, new or old, and that device's `/poll`, `/response` and `/pong` calls are not authenticated. Such a device upgrades by re-registering with a secret and its passcode hash. Set `REQUIRE_DEVICE_SECRET = "true"` in `wrangler.toml` to reject secretless registrations and unauthenticated device calls.

### Client Endpoints (used by Claude/MCP clients)

| Endpoint  | Method | Description                                                                    |
| --------- | ------ | ------------------------------------------------------------------------------ |
| `/mcp`    | POST   | Send MCP request (requires Bearer token)                                       |

Only protocol headers (`Accept`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`, `Last-Event-ID`, `User-Agent`) are forwarded to the device. The client's `Authorization` header and cookies never leave the relay.

## Security

### Pairing Code Security

- **Single use, 10 minutes**: a code is deleted when redeemed or replaced, and expires on its own
- **Guessing capped relay-wide**: 10 wrong codes per IP and 100 in total per 10 minutes
- **Minted only by the device**: requesting a code requires the device secret
- **Stored hashed**: the relay keys codes by their SHA-256 hash

### Legacy Passcode Security

- **Device-generated**: Passcode is generated and displayed only on the device
- **Zero-knowledge**: Relay only receives and stores the SHA-256 hash
- **Never transmitted in plaintext**: The actual passcode never leaves the device
- **Re-registration verification**: Reconnections must provide the matching device secret (or, for legacy devices, the matching passcode hash)
- **Brute-force protection**: After 5 wrong passcodes, the device is locked for 1 minute, doubling with each further failure up to 1 hour

### Device Security

- **Device secret**: A random secret generated on the device authenticates its polling, so knowing a device ID is not enough to receive its requests
- **Header allowlist**: Client credentials are never forwarded to the device

### Offline Memory Security

- **Opt-in**: nothing from the book is stored unless the user turns offline memory on in the plugin
- **Encrypted for paired apps**: a stored snapshot can only be opened with a paired app's live token (see [Offline memory](#offline-memory))
- **Written only by the device**: saving, inspecting and deleting a snapshot require the device secret
- **Bounded**: one snapshot per device, capped in size, deleted after its retention time

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

Settings in `wrangler.toml` (`[vars]`):

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `REQUIRE_DEVICE_SECRET` | `"false"` | Reject devices that register without a device secret |
| `SNAPSHOT_MAX_BYTES` | `"262144"` | Largest snapshot the relay accepts (256 KB keeps an offline answer well inside the free plan's 10 ms of CPU time). `"0"` turns offline memory off, and 1 MB (`"1048576"`) is the most it can be |
| `SNAPSHOT_MAX_RETENTION_DAYS` | `"30"` | Longest time a snapshot is kept |

## Testing

`test/e2e.mjs` plays a reader and two AI apps against a local relay: pairing, live requests, snapshots, offline answers for every tool, a second app, token refresh, disconnecting an app, forgetting the saved copy and the size limits. It needs Node 20 or newer and takes about a minute.

```bash
bun run dev          # in one terminal
bun run test:e2e     # in another
```

## Cost Estimation (Cloudflare Free Tier)

| Resource                | Free Tier Limit | Expected Usage |
| ----------------------- | --------------- | -------------- |
| Worker Requests         | 100,000/day     | ~1,000/day     |
| Durable Object Requests | 1,000,000/month | ~10,000/month  |
| Durable Object Storage  | 5 GB            | ~1 MB, plus up to 256 KB per device that uses offline memory |
| Durable Object rows written | 100,000/day | 1 per saved snapshot (at most 4 a minute per device) |
