import { describe, it, expect, vi } from "vitest";
import app, { type SearchResponse } from "./index.js";

describe("Search API Worker", () => {
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
      })
    }
  };

  it("should respond 200 OK on GET /health", async () => {
    const res = await app.request("/health", {}, mockEnv);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });

  it("should reject unauthorized requests to POST /search", async () => {
    const resNoAuth = await app.request(
      "/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" })
      },
      mockEnv
    );
    expect(resNoAuth.status).toBe(401);

    const resBadToken = await app.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong_token"
        },
        body: JSON.stringify({ query: "test" })
      },
      mockEnv
    );
    expect(resBadToken.status).toBe(401);
  });

  it("should reject invalid search payload", async () => {
    const res = await app.request(
      "/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_secret_token_123"
        },
        body: JSON.stringify({ query: "" })
      },
      mockEnv
    );
    expect(res.status).toBe(400);
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
    expect(json.results[0]).toEqual({
      id: "obsidian:notes/arch.md:0",
      score: 0.92,
      text: "System architecture notes.",
      source: "obsidian",
      path: "notes/arch.md",
      title: "Architecture",
      chunkIndex: 0,
      url: undefined
    });
  });
});
