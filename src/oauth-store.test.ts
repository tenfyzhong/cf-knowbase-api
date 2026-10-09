import { describe, expect, it } from "vitest";
import app, { type Bindings } from "./index.js";
import { createOAuthStore } from "./test/oauth-store-fixture.js";

describe("Opaque OAuth credential storage", () => {
  it("registers an opaque OAuth client without a deployment signing secret", async () => {
    const res = await app.request(
      "/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"]
        })
      },
      { OAUTH_STORE: createOAuthStore() } as Bindings
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { client_id: string };
    expect(json.client_id).toMatch(/^kb_client_[A-Za-z0-9_-]{43}$/);
  });

  it("atomically consumes a credential once across concurrent requests", async () => {
    const store = createOAuthStore().getByName("test-credential");
    const value = { sub: "access-user", expiresAt: Date.now() + 600000 };
    await store.fetch("https://store/", {
      method: "PUT",
      body: JSON.stringify(value)
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.fetch("https://store/", { method: "DELETE" })
      )
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 404)).toHaveLength(9);
    expect(await results.find((res) => res.status === 200)!.json()).toEqual(
      value
    );
  });

  it("rejects expired credentials even before alarm cleanup", async () => {
    const store = createOAuthStore().getByName("expired");
    await store.fetch("https://store/", {
      method: "PUT",
      body: JSON.stringify({ expiresAt: Date.now() - 1 })
    });
    expect((await store.fetch("https://store/")).status).toBe(404);
    expect(
      (await store.fetch("https://store/", { method: "DELETE" })).status
    ).toBe(404);
  });
});
