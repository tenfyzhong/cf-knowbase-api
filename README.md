# cf-kb-api

Cloudflare Worker providing a secure, high-performance semantic search API for personal knowledge bases powered by Cloudflare Workers AI and Vectorize.

## Features

- **Workers AI Embedding**: Direct on-edge query vectorization using `@cf/baai/bge-base-en-v1.5` (768 dimensions) or custom models.
- **Vectorize Similarity Search**: Fast vector similarity search with metadata retrieval and optional source filtering.
- **Bearer Token Authentication**: Protects the search endpoint using Cloudflare Worker secret `API_TOKEN`.
- **Hono Framework**: Lightweight, typed edge routing.

## Endpoints

### 1. `GET /health`
Healthcheck endpoint.
- **Response**: `200 OK`
```json
{ "status": "ok" }
```

### 2. `POST /search`
Semantic search endpoint.

- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <API_TOKEN>`

- **Request Body**:
```json
{
  "query": "how to configure cloudflare vectorize?",
  "topK": 5,
  "source": "obsidian-notes"
}
```

- **Response**: `200 OK`
```json
{
  "query": "how to configure cloudflare vectorize?",
  "count": 1,
  "results": [
    {
      "id": "obsidian-notes:notes/cloudflare.md:0",
      "score": 0.895,
      "text": "Cloudflare Vectorize is a globally distributed vector database...",
      "source": "obsidian-notes",
      "path": "notes/cloudflare.md",
      "title": "Cloudflare Vectorize Guide",
      "chunkIndex": 0,
      "url": null
    }
  ]
}
```

## Deployment

### 1. Create Vectorize Index

```bash
npx wrangler vectorize create kb-index --dimensions=768 --metric=cosine
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
