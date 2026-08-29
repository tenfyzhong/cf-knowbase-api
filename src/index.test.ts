import { describe, it, expect, vi, beforeEach } from "vitest";
import app, { type SearchResponse } from "./index.js";

describe("Search & Indexing API Worker", () => {
  const kvStore = new Map<string, string>();

  const mockEnv = {
    API_TOKEN: "valid_secret_token_123",
    AI_MODEL: "@cf/baai/bge-base-en-v1.5",
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
      })
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    kvStore.clear();
  });

  it("should respond 200 OK on GET /health", async () => {
    const res = await app.request("/health", {}, mockEnv);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
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
      "@cf/baai/bge-base-en-v1.5",
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

  it("should serve OpenAI plugin manifest at GET /.well-known/ai-plugin.json", async () => {
    const res = await app.request("/.well-known/ai-plugin.json", {}, mockEnv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      schema_version: string;
      name_for_model: string;
      auth: { type: string };
      api: { url: string };
    };
    expect(json.schema_version).toBe("v1");
    expect(json.name_for_model).toBe("cf_knowbase");
    expect(json.auth.type).toBe("oauth");
    expect(json.api.url).toBe("/openapi.json");
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
    expect(json.paths["/vectors/upsert"]).toBeDefined();
    expect(json.paths["/vectors/delete"]).toBeDefined();
  });

  it("should handle OAuth authorization code flow", async () => {
    const authRes = await app.request(
      "/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=https%3A%2F%2Fchatgpt.com%2Faip%2Fcallback&state=state123&token=valid_secret_token_123",
      {},
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
    expect(tokenJson.access_token).toBe("valid_secret_token_123");
    expect(tokenJson.token_type).toBe("Bearer");
  });

  it("should verify token via GET /oauth/verify", async () => {
    const res = await app.request(
      "/oauth/verify",
      {
        headers: { Authorization: "Bearer valid_secret_token_123" }
      },
      mockEnv
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ valid: true, scope: "read" });
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
    const res = await app.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
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
      "@cf/baai/bge-base-en-v1.5",
      { text: ["how does architecture work?"] }
    );

    expect(mockEnv.VECTORIZE.query).toHaveBeenCalledWith(
      [0.11, 0.22, 0.33],
      expect.objectContaining({
        topK: 5,
        returnMetadata: "all"
      })
    );

    expect(json.query).toBe("how does architecture work?");
    expect(json.count).toBe(2);
    expect(json.results).toHaveLength(2);
  });
});
