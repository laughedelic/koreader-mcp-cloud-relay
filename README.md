# MCP Relay for Cloudflare Workers

A lightweight WebSocket relay that enables remote access to KOReader MCP servers from anywhere. This service bridges the gap between your e-reader (behind NAT/firewall) and MCP clients like Claude Desktop or Claude Mobile.

## How It Works

```
┌─────────────────┐    WebSocket     ┌─────────────┐    HTTPS    ┌───────────────┐
│  E-Reader       │ ───────────────► │  MCP Relay  │ ◄────────── │ Claude/Client │
│  (KOReader)     │ ◄─────────────── │ (Cloudflare)│ ──────────► │               │
└─────────────────┘                  └─────────────┘             └───────────────┘
```

1. Your e-reader connects to the relay via WebSocket (outbound connection)
2. The relay assigns a unique URL for your device
3. MCP clients send HTTP requests to that URL
4. The relay forwards requests to your device and returns responses

## Deployment

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works!)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Deploy to Cloudflare

```bash
# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Deploy
npx wrangler deploy
```

Your relay will be available at: `https://mcp-relay.<your-subdomain>.workers.dev/`

### Local Development

```bash
# Run locally with Wrangler
npm run dev
```

## API Endpoints

### `GET /`
Returns relay info and available endpoints.

### `WebSocket /{deviceId}/ws`
WebSocket endpoint for device connections. The e-reader connects here to register and receive forwarded requests.

### `POST /{deviceId}/mcp`
Forward an MCP request to the connected device. This is the URL you give to Claude Desktop or other MCP clients.

### `GET /{deviceId}/status`
Check if a device is online and get connection info.

## Protocol

### Device → Relay (WebSocket)

**Register:**
```json
{
  "type": "register",
  "deviceId": "optional-existing-id",
  "deviceName": "My Kindle"
}
```

**Response to MCP request:**
```json
{
  "type": "response",
  "requestId": "req-123",
  "status": 200,
  "body": "{\"jsonrpc\":\"2.0\",\"result\":{...}}"
}
```

**Pong (keep-alive):**
```json
{"type": "pong"}
```

### Relay → Device (WebSocket)

**Registration confirmed:**
```json
{
  "type": "registered",
  "deviceId": "abc123xyz",
  "relayUrl": "https://mcp-relay.workers.dev/abc123xyz/mcp"
}
```

**Forward MCP request:**
```json
{
  "type": "request",
  "requestId": "req-123",
  "method": "POST",
  "path": "/mcp",
  "headers": {...},
  "body": "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\"}"
}
```

**Ping (keep-alive):**
```json
{"type": "ping"}
```

## Configuration

### Custom Domain (Optional)

To use a custom domain like `mcp.koreader.dev`:

1. Add your domain to Cloudflare
2. Uncomment and update the route in `wrangler.toml`:
   ```toml
   [[routes]]
   pattern = "mcp.yourdomain.com/*"
   custom_domain = true
   ```
3. Redeploy: `npx wrangler deploy`

## Security

- **Device ID as secret**: The 12-character device ID acts as a bearer token. Anyone with the ID can send requests to your device.
- **All traffic encrypted**: HTTPS for HTTP requests, WSS for WebSocket connections.
- **No stored data**: The relay doesn't store MCP request/response content, only connection state.

### Recommendations

- Don't share your relay URL publicly
- Use KOReader's MCP server password feature for additional protection
- Regenerate your device ID if you suspect it's compromised

## Cost Estimation (Cloudflare Free Tier)

| Resource                | Free Tier Limit | Expected Usage |
| ----------------------- | --------------- | -------------- |
| Worker Requests         | 100,000/day     | ~1,000/day     |
| Durable Object Requests | 1,000,000/month | ~10,000/month  |
| Durable Object Storage  | 1 GB            | ~1 MB          |
| WebSocket Messages      | Included        | ~10,000/day    |

## License

MIT
