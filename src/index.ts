import { Hono, type Context } from "hono";
import { z } from "zod";

export interface Bindings {
  API_TOKEN: string;
  AI_MODEL?: string;
  AI: {
    run: (model: string, input: { text: string[] }) => Promise<{
      data?: number[][];
      shape?: number[];
    }>;
  };
  VECTORIZE: {
    query: (
      vector: number[],
      options?: {
        topK?: number;
        returnMetadata?: "all" | "indexed" | "none" | boolean;
        filter?: Record<string, string>;
      }
    ) => Promise<{
      count: number;
      matches: Array<{
        id: string;
        score: number;
        metadata?: Record<string, unknown>;
      }>;
    }>;
    upsert: (
      vectors: Array<{
        id: string;
        values: number[];
        metadata?: Record<string, unknown>;
      }>
    ) => Promise<{ count: number }>;
    deleteByIds: (ids: string[]) => Promise<{ count?: number }>;
  };
  KV: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list: (options?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{
      keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
      list_complete?: boolean;
      cursor?: string;
    }>;
  };
}

export const UpsertChunkItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.string().min(1),
  path: z.string().min(1),
  title: z.string().optional(),
  chunkIndex: z.number().int().min(0).default(0),
  url: z.string().optional()
});

export const UpsertRequestSchema = z.object({
  items: z.array(UpsertChunkItemSchema)
});

export const DeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1))
});

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(50).default(5),
  source: z.string().optional()
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export interface SearchResultItem {
  id: string;
  score: number;
  text: string;
  source: string;
  path: string;
  title?: string;
  chunkIndex: number;
  url?: string;
}

export interface SearchResponse {
  query: string;
  count: number;
  results: SearchResultItem[];
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="bookGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <linearGradient id="pageGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bookGrad)"/>
  <path d="M 32 46 C 26 42 16 42 14 43 L 14 20 C 18 19 26 19 32 23 Z" fill="url(#pageGrad)" opacity="0.95"/>
  <path d="M 32 46 C 38 42 48 42 50 43 L 50 20 C 46 19 38 19 32 23 Z" fill="url(#pageGrad)" opacity="0.95"/>
  <path d="M 32 23 L 32 46" stroke="#2563eb" stroke-width="2" stroke-linecap="round"/>
  <path d="M 18 26 C 22 25 26 25 28 27 M 18 31 C 22 30 26 30 28 32 M 18 36 C 22 35 26 35 28 37" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M 36 27 C 38 25 42 25 46 26 M 36 32 C 38 30 42 30 46 31 M 36 37 C 38 35 42 35 46 36" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const app = new Hono<{ Bindings: Bindings }>();

// Auth helper
function isAuthorized(c: Context<{ Bindings: Bindings }>): boolean {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  return token === c.env.API_TOKEN;
}

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Favicon endpoints
app.get("/favicon.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(FAVICON_SVG);
});

app.get("/favicon.ico", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(FAVICON_SVG);
});

// KV Sync State endpoints
app.get("/sync-state/:source", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const source = c.req.param("source");
  const key = `sync_state:${encodeURIComponent(source)}`;
  const raw = await c.env.KV.get(key);

  if (!raw) {
    return c.json({ files: {} });
  }

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if ("files" in data) {
      return c.json(data);
    }
    return c.json({ files: data });
  } catch {
    return c.json({ files: {} });
  }
});

app.put("/sync-state/:source", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const source = c.req.param("source");
  const key = `sync_state:${encodeURIComponent(source)}`;
  const body = await c.req.text();

  await c.env.KV.put(key, body);
  return c.json({ success: true });
});

// Vector Upsert endpoint
app.post("/vectors/upsert", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad Request: Invalid JSON" }, 400);
  }

  const parseResult = UpsertRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: "Bad Request", details: parseResult.error.format() }, 400);
  }

  const { items } = parseResult.data;
  if (items.length === 0) {
    return c.json({ success: true, count: 0 });
  }

  const model = c.env.AI_MODEL || "@cf/baai/bge-m3";
  const batchSize = 25;
  let totalUpserted = 0;

  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const rawBatch = items.slice(i, i + batchSize);
      const validBatch = rawBatch.filter((item) => {
        const cleaned = item.text.replace(/\0/g, "").trim();
        return cleaned.length > 0;
      });

      if (validBatch.length === 0) continue;

      const texts = validBatch.map((item) => {
        const cleaned = item.text.replace(/\0/g, "").trim();
        return cleaned.length > 2000 ? cleaned.slice(0, 2000) : cleaned;
      });

      let batchVectors: Array<{
        id: string;
        values: number[];
        metadata: Record<string, unknown>;
      }> = [];

      try {
        const aiRes = await c.env.AI.run(model, { text: texts });
        const embeddings = aiRes.data;

        if (embeddings && embeddings.length === validBatch.length) {
          batchVectors = validBatch.map((item, idx) => ({
            id: item.id,
            values: embeddings[idx],
            metadata: {
              text: item.text.length > 2000 ? `${item.text.slice(0, 2000)}...` : item.text,
              source: item.source,
              path: item.path,
              title: item.title,
              chunkIndex: item.chunkIndex,
              url: item.url
            }
          }));
        }
      } catch {
        for (const item of validBatch) {
          const text = item.text.replace(/\0/g, "").trim().slice(0, 2000);
          try {
            const singleRes = await c.env.AI.run(model, { text: [text] });
            if (singleRes.data?.[0]) {
              batchVectors.push({
                id: item.id,
                values: singleRes.data[0],
                metadata: {
                  text: item.text.length > 2000 ? `${item.text.slice(0, 2000)}...` : item.text,
                  source: item.source,
                  path: item.path,
                  title: item.title,
                  chunkIndex: item.chunkIndex,
                  url: item.url
                }
              });
            }
          } catch {
            // ignore
          }
        }
      }

      if (batchVectors.length > 0) {
        let attempts = 0;
        while (attempts < 5) {
          try {
            await c.env.VECTORIZE.upsert(batchVectors);
            totalUpserted += batchVectors.length;
            break;
          } catch (upsertErr) {
            attempts++;
            const errMsg = String(upsertErr);
            if (
              attempts < 5 &&
              (errMsg.includes("40041") ||
                errMsg.includes("Too Many Requests") ||
                errMsg.includes("rate") ||
                errMsg.includes("429"))
            ) {
              await new Promise((resolve) => setTimeout(resolve, attempts * 1500));
            } else {
              throw upsertErr;
            }
          }
        }
      }
    }

    return c.json({ success: true, count: totalUpserted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Vector upsert failed", message }, 500);
  }
});

// Vector Delete endpoint
app.post("/vectors/delete", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad Request: Invalid JSON" }, 400);
  }

  const parseResult = DeleteRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: "Bad Request", details: parseResult.error.format() }, 400);
  }

  const { ids } = parseResult.data;
  if (ids.length > 0) {
    await c.env.VECTORIZE.deleteByIds(ids);
  }

  return c.json({ success: true, count: ids.length });
});

function computeHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) - hash + content.charCodeAt(i);
    hash |= 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return hex.repeat(4);
}

function generateVectorId(sourceName: string, filePath: string, chunkIndex: number): string {
  const sanitizedPath = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sanitizedSource = sourceName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
  return `${sanitizedSource}:${computeHash(filePath).slice(0, 32)}:${chunkIndex}`;
}

// Vector Clear endpoint
app.post("/vectors/clear", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const listRes = await c.env.KV.list({ prefix: "sync_state:" });
    const keys = (listRes.keys || []).map((k) => k.name);

    let totalDeleted = 0;
    const clearedSources: string[] = [];

    for (const key of keys) {
      const sourceName = decodeURIComponent(key.slice("sync_state:".length));
      clearedSources.push(sourceName);

      const raw = await c.env.KV.get(key);
      if (raw) {
        try {
          const data = JSON.parse(raw) as { files?: Record<string, { chunkCount?: number }> };
          const files = data.files || (data as Record<string, { chunkCount?: number }>);
          const idsToDelete: string[] = [];

          for (const [filePath, fileInfo] of Object.entries(files)) {
            const count = fileInfo.chunkCount || 0;
            for (let i = 0; i < count; i++) {
              idsToDelete.push(generateVectorId(sourceName, filePath, i));
            }
          }

          if (idsToDelete.length > 0) {
            const batchSize = 500;
            for (let b = 0; b < idsToDelete.length; b += batchSize) {
              const batch = idsToDelete.slice(b, b + batchSize);
              await c.env.VECTORIZE.deleteByIds(batch);
              totalDeleted += batch.length;
            }
          }
        } catch {
          // ignore
        }
      }

      await c.env.KV.delete(key);
    }

    return c.json({
      success: true,
      deletedVectorsCount: totalDeleted,
      clearedSources
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Vector clear failed", message }, 500);
  }
});

// OpenAI Plugin manifest
app.get("/.well-known/ai-plugin.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    schema_version: "v1",
    name_for_human: "Cloudflare Knowledge Base",
    name_for_model: "knowbase",
    description_for_human: "Semantic search over your personal notes, documents, and web content.",
    description_for_model:
      "Plugin for semantically searching and retrieving personal notes, obsidian documents, code repositories, and articles stored in Cloudflare Vectorize.",
    auth: {
      type: "oauth",
      client_url: `${origin}/oauth/authorize`,
      scope: "read",
      authorization_url: `${origin}/oauth/token`,
      authorization_content_type: "application/json"
    },
    api: {
      type: "openapi",
      url: "/openapi.json"
    },
    logo_url: `${origin}/favicon.svg`,
    contact_email: "tenfy@tenfy.cn",
    legal_info_url: origin
  });
});

// OpenAPI 3.1.0 Specification
app.get("/openapi.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Cloudflare Knowledge Base Search API",
      description: "Semantic search and vector management API powered by Cloudflare Workers AI and Vectorize.",
      version: "0.1.0"
    },
    servers: [{ url: origin }],
    paths: {
      "/search": {
        post: {
          summary: "Search Knowledge Base",
          description: "Perform semantic similarity search over personal documents and notes.",
          operationId: "searchKnowledgeBase",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    topK: { type: "integer", default: 5 },
                    source: { type: "string" }
                  },
                  required: ["query"]
                }
              }
            }
          },
          responses: {
            "200": { description: "Successful search results" },
            "400": { description: "Bad Request" },
            "401": { description: "Unauthorized" }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      }
    }
  });
});

// OAuth Authorize endpoint
app.all("/oauth/authorize", async (c) => {
  const url = new URL(c.req.url);
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  const providedToken =
    url.searchParams.get("token") || (await c.req.parseBody().then((b) => b["token"] as string).catch(() => ""));

  if (!redirectUri) {
    return c.text("Missing required query parameter: redirect_uri", 400);
  }

  if (providedToken && providedToken.trim() === c.env.API_TOKEN) {
    const codePayload = {
      t: c.env.API_TOKEN,
      exp: Date.now() + 600000
    };
    const code = btoa(JSON.stringify(codePayload));
    const targetUrl = new URL(redirectUri);
    targetUrl.searchParams.set("code", code);
    if (state) {
      targetUrl.searchParams.set("state", state);
    }
    return c.redirect(targetUrl.toString(), 302);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Knowledge Base Connection</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.1); width: 100%; max-width: 420px; text-align: center; }
    .icon { width: 64px; height: 64px; margin: 0 auto 16px; }
    h2 { margin: 0 0 8px; color: #0f172a; font-size: 22px; }
    p { font-size: 14px; color: #64748b; line-height: 1.5; margin: 0 0 24px; }
    label { display: block; text-align: left; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px; margin-bottom: 20px; }
    button { width: 100%; background: #2563eb; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: 500; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${FAVICON_SVG}</div>
    <h2>Authorize Connection</h2>
    <p>Connect your personal Knowledge Base to ChatGPT or Codex.</p>
    <form method="POST" action="${url.pathname}${url.search}">
      <label for="token">API Secret Token</label>
      <input type="password" id="token" name="token" placeholder="Enter your API_TOKEN" required autofocus />
      <button type="submit">Authorize & Connect</button>
    </form>
  </div>
</body>
</html>`;

  return c.html(html);
});

// OAuth Token exchange endpoint
app.post("/oauth/token", async (c) => {
  let body: Record<string, unknown> = {};
  const contentType = c.req.header("Content-Type") || "";

  if (contentType.includes("application/json")) {
    body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  } else {
    body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  }

  const code = (body["code"] as string) || c.req.query("code") || "";
  if (!code) {
    return c.json({ error: "invalid_request", error_description: "Missing authorization code" }, 400);
  }

  try {
    const decoded = JSON.parse(atob(code)) as { t?: string; exp?: number };
    if (!decoded.t || decoded.t !== c.env.API_TOKEN) {
      return c.json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
    }
    if (decoded.exp && decoded.exp < Date.now()) {
      return c.json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
    }

    return c.json({
      access_token: c.env.API_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000
    });
  } catch {
    return c.json({ error: "invalid_grant", error_description: "Malformed authorization code" }, 400);
  }
});

// OAuth Token verification endpoint
app.get("/oauth/verify", (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({ valid: true, scope: "read" });
});

// Search endpoint
app.post("/search", async (c) => {
  if (!isAuthorized(c)) {
    return c.json({ error: "Unauthorized: Missing or invalid Bearer token" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Bad Request: Invalid JSON body" }, 400);
  }

  const parseResult = SearchRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: "Bad Request", details: parseResult.error.format() }, 400);
  }

  const { query, topK, source } = parseResult.data;
  const model = c.env.AI_MODEL || "@cf/baai/bge-m3";

  try {
    const embeddingResponse = await c.env.AI.run(model, { text: [query] });
    const queryVector = embeddingResponse.data?.[0];
    if (!queryVector) {
      return c.json({ error: "Internal Error: Failed to generate query embedding" }, 500);
    }

    const fetchLimit = source ? Math.max(topK * 4, 30) : topK;
    const searchMatches = await c.env.VECTORIZE.query(queryVector, {
      topK: fetchLimit,
      returnMetadata: "all"
    });

    let results: SearchResultItem[] = (searchMatches.matches || []).map((match) => {
      const meta = match.metadata || {};
      return {
        id: match.id,
        score: match.score,
        text: typeof meta.text === "string" ? meta.text : "",
        source: typeof meta.source === "string" ? meta.source : "",
        path: typeof meta.path === "string" ? meta.path : "",
        title: typeof meta.title === "string" ? meta.title : undefined,
        chunkIndex: typeof meta.chunkIndex === "number" ? meta.chunkIndex : 0,
        url: typeof meta.url === "string" ? meta.url : undefined
      };
    });

    if (source) {
      results = results.filter((r) => r.source === source);
    }

    results = results.slice(0, topK);
    const response: SearchResponse = {
      query,
      count: results.length,
      results
    };

    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Search failed", message }, 500);
  }
});

export default app;
