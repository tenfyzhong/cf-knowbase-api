# cf-knowbase-api

Cloudflare Worker providing a secure, unified semantic search and vector management API for personal knowledge bases powered by Cloudflare Workers AI, Vectorize, and KV.

## Features

- **Workers AI Embedding**: Direct on-edge text & query vectorization using `@cf/baai/bge-m3` (1024 dimensions, multilingual optimized) or custom models.
- **Vector Management**: Full CRUD support for Vectorize (`/vectors/upsert`, `/vectors/delete`, `/search`) directly via Worker APIs.
- **KV Sync State Persistence**: Tracks incremental sync states and Git commit hashes (`/sync-state/:source`).
- **Remote MCP Server**: Stateless Streamable HTTP-compatible MCP endpoint at `/mcp` for ChatGPT Web plugins.
- **MCP OAuth 2.1**: Protected-resource and authorization-server discovery, dynamic client registration, PKCE S256, short-lived access tokens, and refresh tokens.
- **OpenAPI 3.1 Compatibility**: Keeps the Custom GPT Action integration available for existing clients.
- **Scoped Bearer Authentication**: The deployment `API_TOKEN` protects administrative endpoints and approves OAuth grants, while search and MCP endpoints accept only OAuth-issued access tokens.

## Endpoints

### 1. `POST /mcp`
Stateless remote MCP endpoint exposing the authenticated `search_knowledge_base` tool.

### 2. `POST /search`
Semantic search endpoint. Requires an OAuth-issued bearer access token; the deployment `API_TOKEN` is rejected.

- **Request Body**:
```json
{
  "query": "how to configure cloudflare vectorize?",
  "topK": 5,
  "source": "notes"
}
```

### 3. `POST /vectors/upsert`
Generate embeddings and upsert document text chunks into Vectorize.

- **Request Body**:
```json
{
  "items": [
    {
      "id": "notes:docs/architecture.md:0",
      "text": "Cloudflare Vectorize is a globally distributed vector database...",
      "source": "notes",
      "path": "docs/architecture.md",
      "title": "Architecture Overview",
      "chunkIndex": 0
    }
  ]
}
```

### 4. `POST /vectors/delete`
Delete vectors by ID list.

- **Request Body**:
```json
{
  "ids": ["notes:docs/architecture.md:0"]
}
```

### 5. `GET /sync-state/:source` & `PUT /sync-state/:source`
Get or save incremental synchronization state for a source.

### 6. OAuth discovery and authorization

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET|POST /oauth/authorize`
- `POST /oauth/token`

The authorization page asks the user for the deployment `API_TOKEN` only to approve the OAuth grant, then issues an independent HMAC-signed one-hour OAuth access token plus a refresh token. Each successful refresh rotates the refresh token and starts a new 30-day validity window. The original `API_TOKEN` is never returned to the MCP client and cannot be used directly against `/search`, `/mcp`, or `/oauth/verify`. Rotating it revokes all previously issued OAuth credentials.

Dynamic client registration accepts HTTPS callbacks and native-client loopback callbacks on `http://127.0.0.1` or `http://[::1]`. Loopback callback ports may vary between registration and authorization, which supports the ephemeral local listener used by Codex.

### 7. `GET /health`
Healthcheck endpoint.

---

## Connecting as a ChatGPT Web Plugin

1. Deploy the Worker on a public HTTPS domain.
2. Enable **Developer mode** under **ChatGPT Settings > Security and login**.
3. Open **ChatGPT Plugins**, add an MCP server, and enter:
   ```text
   https://knowbase.example.com/mcp
   ```
4. Review the discovered `search_knowledge_base` tool.
5. Click **Connect**, or call the tool for the first time.
6. Enter the deployment `API_TOKEN` on the Knowbase authorization page.

ChatGPT discovers OAuth through the two `.well-known` endpoints, dynamically registers a public client, performs authorization code + PKCE, and stores only the issued OAuth tokens.

## Connecting from Codex to the Remote MCP Server

Add the MCP URL for the deployment, then authenticate it:

```bash
codex mcp add knowbase --url https://your-knowbase.example.com/mcp
codex mcp login knowbase
```

Codex dynamically registers a public OAuth client and opens the Knowbase authorization page. Enter the deployment `API_TOKEN` there. Codex receives only the issued OAuth access and refresh tokens; its local loopback callback can use an ephemeral port.

---

## Deployment

### 1. Create Vectorize Index & KV Namespace

```bash
npx wrangler vectorize create knowbase-index --dimensions=1024 --metric=cosine
npx wrangler kv namespace create knowbase-kv-namespace
```

### 2. Set Secret Token

```bash
npx wrangler secret put API_TOKEN
```

### 3. Deploy Worker

```bash
pnpm run deploy
```

For local development, testing, contribution guidelines, and the release process, see [CONTRIBUTING.md](CONTRIBUTING.md).
