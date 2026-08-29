# cf-knowbase-api

Cloudflare Worker providing a secure, unified semantic search and vector management API for personal knowledge bases powered by Cloudflare Workers AI, Vectorize, and KV.

## Features

- **Workers AI Embedding**: Direct on-edge text & query vectorization using `@cf/baai/bge-m3` (1024 dimensions, multilingual optimized) or custom models.
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
  "source": "notes"
}
```

### 2. `POST /vectors/upsert`
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

### 3. `POST /vectors/delete`
Delete vectors by ID list.

- **Request Body**:
```json
{
  "ids": ["notes:docs/architecture.md:0"]
}
```

### 4. `GET /sync-state/:source` & `PUT /sync-state/:source`
Get or save incremental synchronization state for a source.

### 5. `GET /health`
Healthcheck endpoint.

---

## Connecting to ChatGPT (Web & Mobile App Setup)

You can connect your knowledge base to **ChatGPT Web** and the **ChatGPT Mobile App (iOS / Android)** using a Custom GPT Action with OAuth 2.0 authentication. Configuring it once on Web will automatically sync and enable it on your mobile devices.

### Step 1: Create a Custom GPT on Web
1. Open [chatgpt.com](https://chatgpt.com) on your computer.
2. Click **Explore GPTs** in the sidebar, then click **+ Create**.
3. Go to the **Configure** tab and fill in basic details:
   - **Name**: `Personal Knowledge Base`
   - **Description**: `Semantic search assistant for notes and technical documents`
   - **Instructions** (Recommended Prompt):
     ```text
     You are my personal knowledge base assistant. When answering technical questions, researching past projects, or retrieving documentation, call the searchKnowledgeBase tool to look up context.
     Synthesize answers clearly based on retrieved content and cite document titles or paths when relevant.
     ```

### Step 2: Add Knowledge Base Action
1. Scroll down to the **Actions** section and click **Create new action**.
2. Above the **Schema** box, click **Import from URL** and enter:
   ```text
   https://knowbase-api.tenfy.cn/openapi.json
   ```
3. Click **Import**. ChatGPT will parse the `searchKnowledgeBase` action.

### Step 3: Configure OAuth 2.0 Authentication
1. Click the gear icon under **Authentication**:
   - **Auth Type**: `OAuth`
   - **Client ID**: `chatgpt`
   - **Client Secret**: any string (e.g. `secret123`)
   - **Authorization URL**:
     ```text
     https://knowbase-api.tenfy.cn/oauth/authorize
     ```
   - **Token URL**:
     ```text
     https://knowbase-api.tenfy.cn/oauth/token
     ```
   - **Scope**: `read`
   - **Token Exchange Method**: `Default (POST request)`
2. Click **Save**.

### Step 4: Authorize and Save
1. In the Action preview area or Action list, click **Connect**.
2. An authorization page will open. Enter your `API_TOKEN` and click **Authorize & Connect**.
3. Once authorized, return to the GPT editor and click **Save / Update** in the top right:
   - **Publish to**: Select **`Only me`** to ensure your knowledge base remains strictly private.

### Step 5: Use on Mobile App (iOS / Android)
1. Open the **ChatGPT App** on your phone (logged into the same account).
2. Open the sidebar and select your **`Personal Knowledge Base`** GPT.
3. Ask questions directly from your phone (e.g., *"Search notes for architecture designs"*).
4. Tap **Allow** on the first Action invocation.

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
