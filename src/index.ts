import { Hono } from "hono";
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
  };
}

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

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Search endpoint
app.post("/search", async (c) => {
  const authHeader = c.req.header("Authorization");
  const expectedToken = c.env.API_TOKEN;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized: Missing or malformed Bearer token" }, 401);
  }

  const token = authHeader.slice(7).trim();
  if (token !== expectedToken) {
    return c.json({ error: "Unauthorized: Invalid API token" }, 401);
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
    // 1. Generate embedding for query text
    const embeddingResponse = await c.env.AI.run(model, {
      text: [query]
    });

    const queryVector = embeddingResponse.data?.[0];
    if (!queryVector) {
      return c.json({ error: "Internal Error: Failed to generate query embedding" }, 500);
    }

    // 2. Query Vectorize
    const filter = source ? { source } : undefined;
    const searchMatches = await c.env.VECTORIZE.query(queryVector, {
      topK,
      returnMetadata: "all",
      filter
    });

    // 3. Format response results
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
