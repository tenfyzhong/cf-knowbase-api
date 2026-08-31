import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import app, { type SearchResponse } from "./index.js";

describe("Search & Indexing API Worker", () => {
  const kvStore = new Map<string, string>();

  async function createPkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function decodeOAuthTokenGrant(token: string, prefix: string): {
    expiresAt: number;
  } {
    const encodedPayload = token.slice(prefix.length).split(".")[0];
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    return JSON.parse(atob(padded)) as { expiresAt: number };
  }

  const mockEnv = {
    API_TOKEN: "valid_secret_token_123",
    AI_MODEL: "@cf/baai/bge-m3",
    AI: {
      run: vi.fn().mockResolvedValue({
        data: [[0.11, 0.22, 0.33]]
      })
    },
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({
        count: 2,
        matches: [
          {
            id: "obsidian:notes/arch.md:0",
            score: 0.92,
            metadata: {
              text: "System architecture notes.",
              source: "obsidian",
              path: "notes/arch.md",
              title: "Architecture",
              chunkIndex: 0
            }
          },
          {
            id: "blog:post-1.html:0",
            score: 0.85,
            metadata: {
              text: "Blog post content about cloudflare.",
              source: "blog",
              path: "https://example.com/post-1",
              title: "Cloudflare Post",
              chunkIndex: 0,
              url: "https://example.com/post-1"
            }
          }
        ]
      }),
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
      deleteByIds: vi.fn().mockResolvedValue({ count: 1 })
    },
    KV: {
      get: vi.fn().mockImplementation(async (key: string) => kvStore.get(key) || null),
      put: vi.fn().mockImplementation(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn().mockImplementation(async (key: string) => {
        kvStore.delete(key);
      }),
      list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => {
        const keys = Array.from(kvStore.keys())
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((name) => ({ name }));
        return { keys };
      })
    }
  };

  async function issueOAuthAccessToken(): Promise<string> {
    const redirectUri = "https://chatgpt.com/aip/callback";
    const authRes = await app.request(
      `/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=${encodeURIComponent(redirectUri)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: mockEnv.API_TOKEN }).toString()
      },
      mockEnv
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("Location") || "").searchParams.get(
      "code"
    );
    expect(code).toBeTruthy();

    const tokenRes = await app.request(
      "/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri
        })
      },
      mockEnv
    );
    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as { access_token: string };
    return tokenJson.access_token;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    kvStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should respond 200 OK on GET /health", async () => {
    const res = await app.request("/health", {}, mockEnv);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });
  it("should serve open book favicon at /favicon.svg and /favicon.ico", async () => {
    const resSvg = await app.request("/favicon.svg", {}, mockEnv);
    expect(resSvg.status).toBe(200);
    expect(resSvg.headers.get("Content-Type")).toContain("image/svg+xml");
    const svgText = await resSvg.text();
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("path");

    const resIco = await app.request("/favicon.ico", {}, mockEnv);
    expect(resIco.status).toBe(200);
    expect(resIco.headers.get("Content-Type")).toContain("image/svg+xml");
  });

  it("should get and put sync state via /sync-state/:source", async () => {
    // 1. GET non-existent sync state
    const resEmpty = await app.request(
      "/sync-state/obsidian",
      {
        headers: { Authorization: "Bearer valid_secret_token_123" }
      },
      mockEnv
    );
    expect(resEmpty.status).toBe(200);
    expect(await resEmpty.json()).toEqual({ files: {} });

    // 2. PUT new sync state
    const statePayload = {
      lastCommit: "commit_123",
      files: {
        "notes/arch.md": { hash: "hash123", chunkCount: 2 }
      }
    };

    const resPut = await app.request(
      "/sync-state/obsidian",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify(statePayload)
      },
      mockEnv
    );
    expect(resPut.status).toBe(200);
    expect(await resPut.json()).toEqual({ success: true });

    // 3. GET stored sync state
    const resGet = await app.request(
      "/sync-state/obsidian",
      {
        headers: { Authorization: "Bearer valid_secret_token_123" }
      },
      mockEnv
    );
    expect(resGet.status).toBe(200);
    expect(await resGet.json()).toEqual(statePayload);
  });

  it("should upsert vector chunks via POST /vectors/upsert with edge embedding", async () => {
    const chunksPayload = {
      items: [
        {
          id: "obsidian:notes/arch.md:0",
          text: "System architecture overview",
          source: "obsidian",
          path: "notes/arch.md",
          title: "Architecture",
          chunkIndex: 0
        }
      ]
    };

    const res = await app.request(
      "/vectors/upsert",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify(chunksPayload)
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; count: number };
    expect(json.success).toBe(true);
    expect(json.count).toBe(1);

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      "@cf/baai/bge-m3",
      { text: ["System architecture overview"] }
    );

    expect(mockEnv.VECTORIZE.upsert).toHaveBeenCalledWith([
      {
        id: "obsidian:notes/arch.md:0",
        values: [0.11, 0.22, 0.33],
        metadata: {
          text: "System architecture overview",
          source: "obsidian",
          path: "notes/arch.md",
          title: "Architecture",
          chunkIndex: 0,
          url: undefined
        }
      }
    ]);
  });

  it("should delete vectors via POST /vectors/delete", async () => {
    const res = await app.request(
      "/vectors/delete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify({
          ids: ["obsidian:notes/arch.md:0", "obsidian:notes/arch.md:1"]
        })
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; count: number };
    expect(json.success).toBe(true);
    expect(json.count).toBe(2);

    expect(mockEnv.VECTORIZE.deleteByIds).toHaveBeenCalledWith([
      "obsidian:notes/arch.md:0",
      "obsidian:notes/arch.md:1"
    ]);
  });
  it("should clear all vectors and sync states via POST /vectors/clear", async () => {
    kvStore.set(
      "sync_state:obsidian",
      JSON.stringify({
        files: {
          "doc1.md": { hash: "h1", chunkCount: 2 }
        }
      })
    );

    const res = await app.request(
      "/vectors/clear",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid_secret_token_123"
        }
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; deletedVectorsCount: number; clearedSources: string[] };
    expect(json.success).toBe(true);
    expect(json.deletedVectorsCount).toBe(2);
    expect(json.clearedSources).toEqual(["obsidian"]);
    expect(mockEnv.VECTORIZE.deleteByIds).toHaveBeenCalled();
    expect(kvStore.has("sync_state:obsidian")).toBe(false);
  });

  it("should clear vectors and sync state for only the requested source", async () => {
    kvStore.set(
      "sync_state:obsidian",
      JSON.stringify({
        files: {
          "doc1.md": { hash: "h1", chunkCount: 2 }
        }
      })
    );
    kvStore.set(
      "sync_state:blog",
      JSON.stringify({
        files: {
          "post1.md": { hash: "h2", chunkCount: 1 }
        }
      })
    );

    const res = await app.request(
      "/vectors/clear?source=obsidian",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid_secret_token_123"
        }
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      deletedVectorsCount: number;
      clearedSources: string[];
    };
    expect(json.success).toBe(true);
    expect(json.deletedVectorsCount).toBe(2);
    expect(json.clearedSources).toEqual(["obsidian"]);
    expect(kvStore.has("sync_state:obsidian")).toBe(false);
    expect(kvStore.has("sync_state:blog")).toBe(true);
  });

  it("should not serve the legacy OpenAI plugin manifest", async () => {
    const res = await app.request("/.well-known/ai-plugin.json", {}, mockEnv);
    expect(res.status).toBe(404);
  });

  it("should serve OpenAPI 3.1 schema at GET /openapi.json", async () => {
    const res = await app.request("/openapi.json", {}, mockEnv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(json.openapi).toMatch(/^3\./);
    expect(json.paths["/search"]).toBeDefined();
    expect(json.paths["/vectors/upsert"]).toBeUndefined();
    expect(json.paths["/vectors/delete"]).toBeUndefined();
    expect(json.paths["/vectors/clear"]).toBeUndefined();
    expect(Object.keys(json.paths)).toEqual(["/search"]);
  });

  it("should publish MCP OAuth protected resource and authorization server metadata", async () => {
    const resourceRes = await app.request(
      "https://knowbase-api.tenfy.cn/.well-known/oauth-protected-resource",
      {},
      mockEnv
    );
    expect(resourceRes.status).toBe(200);
    expect(await resourceRes.json()).toEqual({
      resource: "https://knowbase-api.tenfy.cn/mcp",
      authorization_servers: ["https://knowbase-api.tenfy.cn"],
      scopes_supported: ["search:read"],
      resource_documentation: "https://knowbase-api.tenfy.cn"
    });

    const oauthRes = await app.request(
      "https://knowbase-api.tenfy.cn/.well-known/oauth-authorization-server",
      {},
      mockEnv
    );
    expect(oauthRes.status).toBe(200);
    expect(await oauthRes.json()).toEqual(
      expect.objectContaining({
        issuer: "https://knowbase-api.tenfy.cn",
        authorization_endpoint:
          "https://knowbase-api.tenfy.cn/oauth/authorize",
        token_endpoint: "https://knowbase-api.tenfy.cn/oauth/token",
        registration_endpoint: "https://knowbase-api.tenfy.cn/oauth/register",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["search:read"]
      })
    );
  });

  it("should register an OAuth client and exchange a PKCE code for independent tokens", async () => {
    const initialTime = new Date("2026-08-31T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(initialTime);
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const resource = "https://knowbase-api.tenfy.cn/mcp";
    const verifier = "pkce-verifier-with-at-least-forty-three-characters-123456";
    const challenge = await createPkceChallenge(verifier);

    const registerRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT Knowbase",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"]
        })
      },
      mockEnv
    );
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { client_id: string };
    expect(registered.client_id).toMatch(/^kb_client_/);

    const authorizeUrl = new URL(
      "https://knowbase-api.tenfy.cn/oauth/authorize"
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "state123");
    authorizeUrl.searchParams.set("scope", "search:read");
    authorizeUrl.searchParams.set("resource", resource);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authRes = await app.request(
      authorizeUrl.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "valid_secret_token_123"
        }).toString()
      },
      mockEnv
    );
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("Location") || "");
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("state")).toBe("state123");
    expect(location.searchParams.get("iss")).toBe(
      "https://knowbase-api.tenfy.cn"
    );
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const wrongVerifierRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code || "",
          client_id: registered.client_id,
          redirect_uri: redirectUri,
          resource,
          code_verifier: `${verifier}-wrong`
        }).toString()
      },
      mockEnv
    );
    expect(wrongVerifierRes.status).toBe(400);
    expect(await wrongVerifierRes.json()).toEqual(
      expect.objectContaining({ error: "invalid_grant" })
    );

    const tokenRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code || "",
          client_id: registered.client_id,
          redirect_uri: redirectUri,
          resource,
          code_verifier: verifier
        }).toString()
      },
      mockEnv
    );
    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenJson.access_token).toMatch(/^kb_at_/);
    expect(tokenJson.access_token).not.toBe(mockEnv.API_TOKEN);
    expect(tokenJson.refresh_token).toMatch(/^kb_rt_/);
    expect(tokenJson.expires_in).toBe(3600);
    expect(tokenJson.scope).toBe("search:read");

    const verifyRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/verify",
      {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` }
      },
      mockEnv
    );
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({
      valid: true,
      scope: "search:read",
      resource
    });

    const mcpCallRes = await app.request(
      "https://knowbase-api.tenfy.cn/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenJson.access_token}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "search_knowledge_base",
            arguments: { query: "architecture", topK: 1 }
          }
        })
      },
      mockEnv
    );
    expect(mcpCallRes.status).toBe(200);
    const mcpCallJson = (await mcpCallRes.json()) as {
      result: {
        isError: boolean;
        structuredContent: SearchResponse;
      };
    };
    expect(mcpCallJson.result.isError).toBe(false);
    expect(mcpCallJson.result.structuredContent.count).toBe(1);

    vi.setSystemTime(new Date(initialTime.getTime() + 24 * 60 * 60 * 1000));
    const refreshRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenJson.refresh_token,
          client_id: registered.client_id,
          resource
        }).toString()
      },
      mockEnv
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).toMatch(/^kb_at_/);
    expect(refreshed.access_token).not.toBe(tokenJson.access_token);
    expect(refreshed.refresh_token).toMatch(/^kb_rt_/);
    expect(refreshed.refresh_token).not.toBe(tokenJson.refresh_token);
    const originalRefreshGrant = decodeOAuthTokenGrant(
      tokenJson.refresh_token,
      "kb_rt_"
    );
    const rotatedRefreshGrant = decodeOAuthTokenGrant(
      refreshed.refresh_token,
      "kb_rt_"
    );
    expect(rotatedRefreshGrant.expiresAt).toBe(
      originalRefreshGrant.expiresAt + 24 * 60 * 60 * 1000
    );

    const writeRes = await app.request(
      "https://knowbase-api.tenfy.cn/vectors/delete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenJson.access_token}`
        },
        body: JSON.stringify({ ids: [] })
      },
      mockEnv
    );
    expect(writeRes.status).toBe(401);
  });

  it("should accept Codex loopback redirects with dynamic ports", async () => {
    const registeredRedirect = "http://127.0.0.1/callback/codex-server-id";
    const activeRedirect =
      "http://127.0.0.1:49152/callback/codex-server-id";
    const resource = "https://knowbase-api.tenfy.cn/mcp";
    const verifier = "pkce-verifier-with-at-least-forty-three-characters-123456";
    const challenge = await createPkceChallenge(verifier);

    const registerRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Codex Knowbase",
          redirect_uris: [registeredRedirect],
          token_endpoint_auth_method: "none"
        })
      },
      mockEnv
    );
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { client_id: string };

    const authorizeUrl = new URL(
      "https://knowbase-api.tenfy.cn/oauth/authorize"
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", activeRedirect);
    authorizeUrl.searchParams.set("scope", "search:read");
    authorizeUrl.searchParams.set("resource", resource);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authRes = await app.request(
      authorizeUrl.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "valid_secret_token_123"
        }).toString()
      },
      mockEnv
    );
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("Location") || "");
    expect(location.origin + location.pathname).toBe(activeRedirect);

    const tokenRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: location.searchParams.get("code") || "",
          client_id: registered.client_id,
          redirect_uri: activeRedirect,
          resource,
          code_verifier: verifier
        }).toString()
      },
      mockEnv
    );
    expect(tokenRes.status).toBe(200);
  });

  it("should accept localhost OAuth redirects with dynamic ports", async () => {
    const registeredRedirect = "http://localhost/callback";
    const activeRedirect = "http://localhost:3000/callback";
    const registerRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [registeredRedirect],
          token_endpoint_auth_method: "none"
        })
      },
      mockEnv
    );

    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { client_id: string };
    const authorizeUrl = new URL(
      "https://knowbase-api.tenfy.cn/oauth/authorize"
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", activeRedirect);
    authorizeUrl.searchParams.set("scope", "search:read");
    authorizeUrl.searchParams.set(
      "resource",
      "https://knowbase-api.tenfy.cn/mcp"
    );
    authorizeUrl.searchParams.set(
      "code_challenge",
      "pkce-challenge-with-at-least-forty-three-characters"
    );
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await app.request(
      authorizeUrl.toString(),
      undefined,
      mockEnv
    );
    expect(authorizeRes.status).toBe(200);
  });

  it("should reject non-loopback HTTP OAuth redirects", async () => {
    const registerRes = await app.request(
      "https://knowbase-api.tenfy.cn/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://example.com/callback"],
          token_endpoint_auth_method: "none"
        })
      },
      mockEnv
    );

    expect(registerRes.status).toBe(400);
    expect(await registerRes.json()).toEqual(
      expect.objectContaining({ error: "invalid_redirect_uri" })
    );
  });

  it("should expose a stateless MCP search tool and trigger OAuth when unauthenticated", async () => {
    const initializeRes = await app.request(
      "https://knowbase-api.tenfy.cn/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        })
      },
      mockEnv
    );
    expect(initializeRes.status).toBe(200);
    expect(await initializeRes.json()).toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "knowbase", version: "0.2.0" }
        })
      })
    );

    const toolsRes = await app.request(
      "https://knowbase-api.tenfy.cn/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        })
      },
      mockEnv
    );
    const toolsJson = (await toolsRes.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    expect(toolsJson.result.tools).toHaveLength(1);
    expect(toolsJson.result.tools[0]).toEqual(
      expect.objectContaining({
        name: "search_knowledge_base",
        securitySchemes: [{ type: "oauth2", scopes: ["search:read"] }]
      })
    );

    const callRes = await app.request(
      "https://knowbase-api.tenfy.cn/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "search_knowledge_base",
            arguments: { query: "architecture" }
          }
        })
      },
      mockEnv
    );
    expect(callRes.status).toBe(200);
    const callJson = (await callRes.json()) as {
      result: {
        isError: boolean;
        _meta: Record<string, string[]>;
      };
    };
    expect(callJson.result.isError).toBe(true);
    expect(callJson.result._meta["mcp/www_authenticate"][0]).toContain(
      'resource_metadata="https://knowbase-api.tenfy.cn/.well-known/oauth-protected-resource"'
    );
  });

  it("should handle OAuth authorization code flow", async () => {
    const authRes = await app.request(
      "/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=https%3A%2F%2Fchatgpt.com%2Faip%2Fcallback&state=state123",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "valid_secret_token_123"
        }).toString()
      },
      mockEnv
    );
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("Location") || "";
    expect(location).toContain("https://chatgpt.com/aip/callback");
    expect(location).toContain("code=");
    expect(location).toContain("state=state123");

    const parsedCode = new URL(location).searchParams.get("code");
    expect(parsedCode).toBeTruthy();

    const tokenRes = await app.request(
      "/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: parsedCode,
          redirect_uri: "https://chatgpt.com/aip/callback"
        })
      },
      mockEnv
    );

    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
    };
    expect(tokenJson.access_token).toMatch(/^kb_at_/);
    expect(tokenJson.access_token).not.toBe("valid_secret_token_123");
    expect(tokenJson.token_type).toBe("Bearer");
  });

  it("should reject the deployment API token on OAuth-protected endpoints", async () => {
    const verifyRes = await app.request(
      "/oauth/verify",
      {
        headers: { Authorization: "Bearer valid_secret_token_123" }
      },
      mockEnv
    );
    expect(verifyRes.status).toBe(401);

    const searchRes = await app.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify({ query: "test" })
      },
      mockEnv
    );
    expect(searchRes.status).toBe(401);

    const mcpRes = await app.request(
      "https://knowbase-api.tenfy.cn/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_knowledge_base",
            arguments: { query: "test" }
          }
        })
      },
      mockEnv
    );
    expect(mcpRes.status).toBe(200);
    expect(await mcpRes.json()).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ isError: true })
      })
    );
  });

  it("should reject unauthorized requests to protected endpoints", async () => {
    const endpoints = [
      { path: "/search", method: "POST", body: { query: "test" } },
      { path: "/sync-state/obsidian", method: "GET" },
      { path: "/sync-state/obsidian", method: "PUT", body: { files: {} } },
      { path: "/vectors/upsert", method: "POST", body: { items: [] } },
      { path: "/vectors/delete", method: "POST", body: { ids: [] } }
    ];

    for (const ep of endpoints) {
      const res = await app.request(
        ep.path,
        {
          method: ep.method,
          headers: { "Content-Type": "application/json" },
          body: ep.body ? JSON.stringify(ep.body) : undefined
        },
        mockEnv
      );
      expect(res.status).toBe(401);
    }
  });

  it("should execute embedding and query Vectorize for valid search", async () => {
    const accessToken = await issueOAuthAccessToken();
    const res = await app.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          query: "how does architecture work?",
          topK: 5,
          source: "obsidian"
        })
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResponse;

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      "@cf/baai/bge-m3",
      { text: ["how does architecture work?"] }
    );

    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      [0.11, 0.22, 0.33],
      expect.objectContaining({
        topK: 30,
        returnMetadata: "all"
      })
    );

    expect(json.query).toBe("how does architecture work?");
    expect(json.count).toBe(1);
    expect(json.results).toHaveLength(1);
    expect(json.results[0].source).toBe("obsidian");
  });
});
