# cf-knowbase-api

Cloudflare Worker providing a secure, unified semantic search and vector management API for personal knowledge bases powered by Cloudflare Workers AI, Vectorize, and KV.

## Features

- **Workers AI Embedding**: Direct on-edge text & query vectorization using `@cf/baai/bge-base-en-v1.5` (768 dimensions) or custom models.
- **Vector Management**: Full CRUD support for Vectorize (`/vectors/upsert`, `/vectors/delete`, `/search`) directly via Worker APIs.
- **KV Sync State Persistence**: Tracks incremental sync states and Git commit hashes (`/sync-state/:source`).
- **OAuth 2.0 & OpenAPI 3.1 Support**: Built-in OAuth authorization flow and `.well-known/ai-plugin.json` for ChatGPT (Web & Mobile) and Codex integration.
- **Bearer Token Authentication**: Protects all mutating and search endpoints using Cloudflare Worker secret `API_TOKEN`.

## Endpoints

### 1. `POST /search`
Semantic search endpoint.

- **Request Body**:
```json
{
  "query": "how to configure cloudflare vectorize?",
  "topK": 5,
  "source": "obsidian-notes"
}
```

### 2. `POST /vectors/upsert`
Generate embeddings and upsert document text chunks into Vectorize.

- **Request Body**:
```json
{
  "items": [
    {
      "id": "obsidian-notes:notes/cloudflare.md:0",
      "text": "Cloudflare Vectorize is a globally distributed vector database...",
      "source": "obsidian-notes",
      "path": "notes/cloudflare.md",
      "title": "Cloudflare Vectorize Guide",
      "chunkIndex": 0
    }
  ]
}
```

### 3. `POST /vectors/delete`
Delete vectors by ID list.

- **Request Body**:
```json
{
  "ids": ["obsidian-notes:notes/cloudflare.md:0"]
}
```

### 4. `GET /sync-state/:source` & `PUT /sync-state/:source`
Get or save incremental synchronization state for a source.

### 5. `GET /health`
Healthcheck endpoint.

---

## Deployment

### 1. Create Vectorize Index & KV Namespace

```bash
npx wrangler vectorize create knowbase-index --dimensions=768 --metric=cosine
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

## Local Development & Testing

```bash
# Install dependencies
pnpm install

# Run unit tests
pnpm test

# Run type checking
pnpm run typecheck

# Start local worker dev server
pnpm run dev
```
