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

  const model = c.env.AI_MODEL || "@cf/baai/bge-base-en-v1.5";
  const batchSize = 25;
  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const texts = batch.map((item) => item.text);

    const aiRes = await c.env.AI.run(model, { text: texts });
    const embeddings = aiRes.data;
    if (!embeddings || embeddings.length !== batch.length) {
      return c.json({ error: "Embedding generation failed" }, 500);
    }

    const vectors = batch.map((item, idx) => ({
      id: item.id,
      values: embeddings[idx],
      metadata: {
        text: item.text,
        source: item.source,
        path: item.path,
        title: item.title,
        chunkIndex: item.chunkIndex,
        url: item.url
      }
    }));

    await c.env.VECTORIZE.upsert(vectors);
    totalUpserted += vectors.length;
  }

  return c.json({ success: true, count: totalUpserted });
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

// OpenAI Plugin manifest
app.get("/.well-known/ai-plugin.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    schema_version: "v1",
    name_for_human: "Cloudflare Knowledge Base",
    name_for_model: "cloudflare_kb",
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
    logo_url: "https://raw.githubusercontent.com/tenfyzhong/agent-plugins-hub/main/picture/logo.png",
    contact_email: "tenfy@tenfy.cn",
    legal_info_url: "https://github.com/tenfyzhong/cf-kb-api"
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
            "401": { description: "Unauthorized" },
            "400": { description: "Bad Request" }
          }
        }
      },
      "/vectors/upsert": {
        post: {
          summary: "Upsert Vectors",
          description: "Generate embeddings and upsert document text chunks into Vectorize.",
          operationId: "upsertVectors",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          text: { type: "string" },
                          source: { type: "string" },
                          path: { type: "string" },
                          title: { type: "string" },
                          chunkIndex: { type: "integer" },
                          url: { type: "string" }
                        },
                        required: ["id", "text", "source", "path"]
                      }
                    }
                  },
                  required: ["items"]
                }
              }
            }
          },
          responses: {
            "200": { description: "Vectors upserted successfully" },
            "401": { description: "Unauthorized" }
          }
        }
      },
      "/vectors/delete": {
        post: {
          summary: "Delete Vectors",
          description: "Delete vectors by ID list from Vectorize.",
          operationId: "deleteVectors",
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ids: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["ids"]
                }
              }
            }
          },
          responses: {
            "200": { description: "Vectors deleted successfully" },
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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); width: 100%; max-width: 420px; }
    h2 { margin-top: 0; color: #0f172a; font-size: 22px; }
    p { font-size: 14px; color: #64748b; line-height: 1.5; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 15px; margin: 12px 0 20px; }
    button { width: 100%; background: #2563eb; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 16px; font-weight: 500; cursor: pointer; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Authorize Connection</h2>
    <p>Connect your personal Cloudflare Knowledge Base to ChatGPT or Codex.</p>
    <form method="POST" action="${url.pathname}${url.search}">
      <label for="token"><strong>API Secret Token:</strong></label>
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
  const model = c.env.AI_MODEL || "@cf/baai/bge-base-en-v1.5";

  try {
    const embeddingResponse = await c.env.AI.run(model, { text: [query] });
    const queryVector = embeddingResponse.data?.[0];
    if (!queryVector) {
      return c.json({ error: "Internal Error: Failed to generate query embedding" }, 500);
    }

    const filter = source ? { source } : undefined;
    const searchMatches = await c.env.VECTORIZE.query(queryVector, {
      topK,
      returnMetadata: "all",
      filter
    });

    const results: SearchResultItem[] = (searchMatches.matches || []).map((match) => {
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
