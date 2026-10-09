import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("OAuth Durable Object in the Worker runtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "knowbase-oauth-runtime-"));
  let runtime: Miniflare;
  beforeAll(async () => {
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--outdir", directory],
      {
        env: {
          ...process.env,
          WRANGLER_HIDE_BANNER: "true",
          WRANGLER_SEND_METRICS: "false"
        },
        stdio: "pipe"
      }
    );
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: "knowbase-test",
        modules: true,
        script: readFileSync(join(directory, "worker.js"), "utf8"),
        compatibilityDate: "2024-09-23",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          OAUTH_STORE: { className: "OAuthStore", useSQLite: true }
        }
      })
    );
    await runtime.ready;
  }, 30000);
  afterAll(async () => {
    await runtime?.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists client registration without a signing secret", async () => {
    const registered = await runtime.dispatchFetch(
      "https://knowbase.example/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"]
        })
      }
    );
    expect(registered.status).toBe(201);
    const json = (await registered.json()) as { client_id: string };
    expect(json.client_id).toMatch(/^kb_client_[A-Za-z0-9_-]{43}$/);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: json.client_id,
      redirect_uri: "https://client.example/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256"
    });
    const authorize = await runtime.dispatchFetch(
      `https://knowbase.example/oauth/authorize?${query}`
    );
    // Registration was found; authorization now fails closed on missing Access config.
    expect(authorize.status).toBe(503);
  });

  it("allows exactly one concurrent consumption in real SQLite storage", async () => {
    const namespace = await runtime.getDurableObjectNamespace("OAUTH_STORE");
    const store = namespace.get(namespace.idFromName("runtime-consumption"));
    await store.fetch("https://store/", {
      method: "PUT",
      body: JSON.stringify({ expiresAt: Date.now() + 600000 })
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.fetch("https://store/", { method: "DELETE" })
      )
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 404)).toHaveLength(9);
  });
});
