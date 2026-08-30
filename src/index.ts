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
    put: (
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ) => Promise<void>;
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

const MCP_SCOPE = "search:read";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;

interface OAuthClient {
  id: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthorizationCodeGrant {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge?: string;
  expiresAt: number;
}

interface OAuthTokenGrant {
  id: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

function parseOAuthRedirectUri(value: string): URL | null {
  try {
    const redirectUri = new URL(value);
    if (
      redirectUri.username ||
      redirectUri.password ||
      redirectUri.hash ||
      (redirectUri.protocol !== "https:" &&
        !isLoopbackRedirectUri(redirectUri))
    ) {
      return null;
    }
    return redirectUri;
  } catch {
    return null;
  }
}

function isLoopbackRedirectUri(redirectUri: URL): boolean {
  return (
    redirectUri.protocol === "http:" &&
    (redirectUri.hostname === "127.0.0.1" ||
      redirectUri.hostname === "[::1]")
  );
}

function redirectUriMatches(registeredValue: string, requestedValue: string): boolean {
  if (registeredValue === requestedValue) {
    return true;
  }

  const registered = parseOAuthRedirectUri(registeredValue);
  const requested = parseOAuthRedirectUri(requestedValue);
  if (
    !registered ||
    !requested ||
    !isLoopbackRedirectUri(registered) ||
    !isLoopbackRedirectUri(requested)
  ) {
    return false;
  }

  return (
    registered.protocol === requested.protocol &&
    registered.hostname === requested.hostname &&
    registered.pathname === requested.pathname &&
    registered.search === requested.search
  );
}

function getBearerToken(c: Context<{ Bindings: Bindings }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7).trim() || null;
}

function isApiTokenAuthorized(c: Context<{ Bindings: Bindings }>): boolean {
  return getBearerToken(c) === c.env.API_TOKEN;
}

async function getOAuthTokenGrant(
  c: Context<{ Bindings: Bindings }>,
  expectedResource?: string
): Promise<OAuthTokenGrant | null> {
  const token = getBearerToken(c);
  if (!token) {
    return null;
  }

  if (token === c.env.API_TOKEN) {
    return {
      id: "api-token",
      clientId: "api-token",
      scope: "read write",
      resource: expectedResource || "",
      expiresAt: Number.MAX_SAFE_INTEGER
    };
  }

  const grant = await verifyOAuthValue<OAuthTokenGrant>(
    c.env.API_TOKEN,
    "kb_at_",
    token
  );
  if (!grant || grant.expiresAt <= Date.now()) {
    return null;
  }
  if (expectedResource && grant.resource !== expectedResource) {
    return null;
  }
  if (!grant.scope.split(/\s+/).some((scope) => scope === MCP_SCOPE || scope === "read")) {
    return null;
  }
  return grant;
}

function base64Url(bytes: ArrayBufferLike): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlText(value: string): string {
  return base64Url(new TextEncoder().encode(value).buffer);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signOAuthValue<T>(
  secret: string,
  prefix: string,
  value: T
): Promise<string> {
  const payload = base64UrlText(JSON.stringify(value));
  const signedValue = `${prefix}${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signedValue)
  );
  return `${signedValue}.${base64Url(signature)}`;
}

async function verifyOAuthValue<T>(
  secret: string,
  prefix: string,
  value: string
): Promise<T | null> {
  if (!value.startsWith(prefix)) {
    return null;
  }
  const separator = value.lastIndexOf(".");
  if (separator <= prefix.length) {
    return null;
  }

  const signedValue = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signature),
      new TextEncoder().encode(signedValue)
    );
    if (!valid) {
      return null;
    }
    const payload = signedValue.slice(prefix.length);
    return JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload))
    ) as T;
  } catch {
    return null;
  }
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(digest);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  if (!isApiTokenAuthorized(c)) {
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
  if (!isApiTokenAuthorized(c)) {
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
  if (!isApiTokenAuthorized(c)) {
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
  if (!isApiTokenAuthorized(c)) {
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
  if (!isApiTokenAuthorized(c)) {
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

app.get("/.well-known/oauth-protected-resource", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    resource_documentation: origin
  });
});

app.get("/.well-known/oauth-authorization-server", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true
  });
});

app.post("/oauth/register", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "Registration body must be valid JSON"
      },
      400
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => {
        return typeof value === "string" && Boolean(parseOAuthRedirectUri(value));
      })
    : [];

  if (redirectUris.length === 0) {
    return c.json(
      {
        error: "invalid_redirect_uri",
        error_description: "At least one HTTPS redirect URI is required"
      },
      400
    );
  }
  if (
    body.token_endpoint_auth_method &&
    body.token_endpoint_auth_method !== "none"
  ) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "Only public PKCE clients are supported"
      },
      400
    );
  }

  const client: OAuthClient = {
    id: crypto.randomUUID(),
    redirectUris,
    createdAt: Date.now()
  };
  const clientId = await signOAuthValue(
    c.env.API_TOKEN,
    "kb_client_",
    client
  );

  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name:
        typeof body.client_name === "string" ? body.client_name : "Knowbase",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    },
    201
  );
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
  const origin = url.origin;
  const responseType = url.searchParams.get("response_type") || "";
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  const requestedScope = url.searchParams.get("scope") || "";
  const resource = url.searchParams.get("resource") || `${origin}/mcp`;
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") || "";
  const providedToken =
    c.req.method === "POST"
      ? await c.req
          .parseBody()
          .then((body) => body["token"] as string)
          .catch(() => "")
      : "";

  if (responseType !== "code" || !clientId || !redirectUri) {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "response_type=code, client_id, and redirect_uri are required"
      },
      400
    );
  }

  const isLegacyClient = clientId === "chatgpt";
  let clientIsValid = false;
  if (isLegacyClient) {
    try {
      const redirect = new URL(redirectUri);
      clientIsValid =
        redirect.protocol === "https:" &&
        (redirect.hostname === "chatgpt.com" ||
          redirect.hostname === "chat.openai.com");
    } catch {
      clientIsValid = false;
    }
  } else {
    const client = await verifyOAuthValue<OAuthClient>(
      c.env.API_TOKEN,
      "kb_client_",
      clientId
    );
    clientIsValid = Boolean(
      client?.redirectUris.some((registeredRedirectUri) =>
        redirectUriMatches(registeredRedirectUri, redirectUri)
      )
    );
  }

  if (!clientIsValid) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Unknown client or redirect URI"
      },
      400
    );
  }
  if (!isLegacyClient && resource !== `${origin}/mcp`) {
    return c.json(
      {
        error: "invalid_target",
        error_description: "The resource must identify this MCP server"
      },
      400
    );
  }
  if (
    !isLegacyClient &&
    (!codeChallenge || codeChallengeMethod !== "S256")
  ) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "PKCE with code_challenge_method=S256 is required"
      },
      400
    );
  }
  if (
    !isLegacyClient &&
    requestedScope &&
    requestedScope.split(/\s+/).some((scope) => scope !== MCP_SCOPE)
  ) {
    return c.json(
      {
        error: "invalid_scope",
        error_description: `Only ${MCP_SCOPE} is supported`
      },
      400
    );
  }

  if (providedToken && providedToken.trim() === c.env.API_TOKEN) {
    const scope = requestedScope || (isLegacyClient ? "read" : MCP_SCOPE);
    const grant: AuthorizationCodeGrant = {
      id: crypto.randomUUID(),
      clientId,
      redirectUri,
      scope,
      resource,
      codeChallenge: codeChallenge || undefined,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000
    };
    const code = await signOAuthValue(
      c.env.API_TOKEN,
      "kb_code_",
      grant
    );

    const targetUrl = new URL(redirectUri);
    targetUrl.searchParams.set("code", code);
    if (state) {
      targetUrl.searchParams.set("state", state);
    }
    targetUrl.searchParams.set("iss", origin);
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
    <form method="POST" action="${htmlEscape(url.pathname + url.search)}">
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
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  let body: Record<string, unknown> = {};
  const contentType = c.req.header("Content-Type") || "";

  if (contentType.includes("application/json")) {
    body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  } else {
    body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  }

  const grantType =
    (body["grant_type"] as string) ||
    c.req.query("grant_type") ||
    "authorization_code";
  const clientId =
    (body["client_id"] as string) || c.req.query("client_id") || "";
  const resource =
    (body["resource"] as string) || c.req.query("resource") || "";

  if (grantType === "refresh_token") {
    const refreshToken =
      (body["refresh_token"] as string) ||
      c.req.query("refresh_token") ||
      "";
    const refreshGrant = await verifyOAuthValue<OAuthTokenGrant>(
      c.env.API_TOKEN,
      "kb_rt_",
      refreshToken
    );
    if (
      !refreshGrant ||
      refreshGrant.expiresAt <= Date.now() ||
      (refreshGrant.clientId !== "chatgpt" && (!clientId || !resource)) ||
      (clientId && refreshGrant.clientId !== clientId) ||
      (resource && refreshGrant.resource !== resource)
    ) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "Invalid or expired refresh token"
        },
        400
      );
    }

    const now = Date.now();
    const accessGrant: OAuthTokenGrant = {
      ...refreshGrant,
      id: crypto.randomUUID(),
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000
    };
    const rotatedRefreshGrant: OAuthTokenGrant = {
      ...refreshGrant,
      id: crypto.randomUUID(),
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000
    };
    const [accessToken, rotatedRefreshToken] = await Promise.all([
      signOAuthValue(c.env.API_TOKEN, "kb_at_", accessGrant),
      signOAuthValue(c.env.API_TOKEN, "kb_rt_", rotatedRefreshGrant)
    ]);
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotatedRefreshToken,
      scope: refreshGrant.scope
    });
  }

  if (grantType !== "authorization_code") {
    return c.json(
      {
        error: "unsupported_grant_type",
        error_description:
          "Only authorization_code and refresh_token are supported"
      },
      400
    );
  }

  const code = (body["code"] as string) || c.req.query("code") || "";
  const redirectUri =
    (body["redirect_uri"] as string) || c.req.query("redirect_uri") || "";
  const codeVerifier =
    (body["code_verifier"] as string) || c.req.query("code_verifier") || "";
  const grant = await verifyOAuthValue<AuthorizationCodeGrant>(
    c.env.API_TOKEN,
    "kb_code_",
    code
  );
  if (
    !grant ||
    grant.expiresAt <= Date.now() ||
    (grant.clientId !== "chatgpt" && (!clientId || !resource)) ||
    (clientId && grant.clientId !== clientId) ||
    grant.redirectUri !== redirectUri ||
    (resource && grant.resource !== resource)
  ) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "Invalid or expired authorization code"
      },
      400
    );
  }
  if (grant.codeChallenge) {
    const actualChallenge = codeVerifier
      ? await createPkceChallenge(codeVerifier)
      : "";
    if (actualChallenge !== grant.codeChallenge) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "PKCE verification failed"
        },
        400
      );
    }
  }

  const now = Date.now();
  const accessGrant: OAuthTokenGrant = {
    id: crypto.randomUUID(),
    clientId: grant.clientId,
    scope: grant.scope,
    resource: grant.resource,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000
  };
  const refreshGrant: OAuthTokenGrant = {
    id: crypto.randomUUID(),
    clientId: grant.clientId,
    scope: grant.scope,
    resource: grant.resource,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000
  };
  const [accessToken, refreshToken] = await Promise.all([
    signOAuthValue(c.env.API_TOKEN, "kb_at_", accessGrant),
    signOAuthValue(c.env.API_TOKEN, "kb_rt_", refreshGrant)
  ]);

  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: grant.scope
  });
});

// OAuth Token verification endpoint
app.get("/oauth/verify", async (c) => {
  const grant = await getOAuthTokenGrant(c);
  if (!grant) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (grant.clientId === "api-token") {
    return c.json({ valid: true, scope: "read" });
  }
  return c.json({
    valid: true,
    scope: grant.scope,
    resource: grant.resource
  });
});

async function searchKnowledgeBase(
  env: Bindings,
  request: SearchRequest
): Promise<SearchResponse> {
  const { query, topK, source } = request;
  const model = env.AI_MODEL || "@cf/baai/bge-m3";
  const embeddingResponse = await env.AI.run(model, { text: [query] });
  const queryVector = embeddingResponse.data?.[0];
  if (!queryVector) {
    throw new Error("Failed to generate query embedding");
  }

  const fetchLimit = source ? Math.max(topK * 4, 30) : topK;
  const searchMatches = await env.VECTORIZE.query(queryVector, {
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
    results = results.filter((result) => result.source === source);
  }

  results = results.slice(0, topK);
  return {
    query,
    count: results.length,
    results
  };
}

// Search endpoint
app.post("/search", async (c) => {
  if (!(await getOAuthTokenGrant(c))) {
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

  try {
    return c.json(await searchKnowledgeBase(c.env, parseResult.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Search failed", message }, 500);
  }
});

const SEARCH_TOOL = {
  name: "search_knowledge_base",
  title: "Search Knowledge Base",
  description:
    "Semantically search personal notes, documentation, repositories, and articles stored in the knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language semantic search query"
      },
      topK: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 5,
        description: "Maximum number of results"
      },
      source: {
        type: "string",
        description: "Optional exact source filter"
      }
    },
    required: ["query"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer" },
      results: { type: "array", items: { type: "object" } }
    },
    required: ["query", "count", "results"]
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }],
  _meta: {
    securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }]
  }
};

function oauthChallenge(origin: string, description: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`;
}

app.post("/mcp", async (c) => {
  let message: {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    message = (await c.req.json()) as typeof message;
  } catch {
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    });
  }

  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || !message.method) {
    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" }
    });
  }

  if (message.method.startsWith("notifications/")) {
    return c.body(null, 202);
  }

  if (message.method === "initialize") {
    const params = message.params || {};
    const protocolVersion =
      typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : "2025-06-18";
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "knowbase", version: "0.2.0" },
        instructions:
          "Use search_knowledge_base for semantic retrieval from the user's private knowledge base."
      }
    });
  }

  if (message.method === "ping") {
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (message.method === "tools/list") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: { tools: [SEARCH_TOOL] }
    });
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    if (params.name !== SEARCH_TOOL.name) {
      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Unknown tool" }
      });
    }

    const origin = new URL(c.req.url).origin;
    const grant = await getOAuthTokenGrant(c, `${origin}/mcp`);
    if (!grant) {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: "Authentication required: connect Knowbase to continue."
            }
          ],
          _meta: {
            "mcp/www_authenticate": [
              oauthChallenge(origin, "Connect Knowbase to search private data")
            ]
          },
          isError: true
        }
      });
    }

    const parsedArguments = SearchRequestSchema.safeParse(params.arguments || {});
    if (!parsedArguments.success) {
      return c.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid tool arguments",
          data: parsedArguments.error.format()
        }
      });
    }

    try {
      const response = await searchKnowledgeBase(c.env, parsedArguments.data);
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(response)
            }
          ],
          structuredContent: response,
          isError: false
        }
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Search failed: ${messageText}` }],
          isError: true
        }
      });
    }
  }

  return c.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" }
  });
});

app.on(["GET", "DELETE"], "/mcp", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "Method Not Allowed" }, 405);
});

export default app;
