import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import app, { type Bindings } from "./index.js";
import {
  accessEnv,
  accessToken,
  mockAccessKeys
} from "./test/access-fixture.js";

const paths = [
  ["GET", "/sync-state/test", undefined],
  ["PUT", "/sync-state/test", { files: {} }],
  ["POST", "/vectors/upsert", { items: [] }],
  ["POST", "/vectors/delete", { ids: [] }],
  ["POST", "/vectors/clear", undefined]
] as const;

describe("Administrative Cloudflare Access authentication", () => {
  const env = {
    ...accessEnv,
    KV: {
      get: vi.fn(async () => null),
      put: vi.fn(),
      list: vi.fn(async () => ({ keys: [] }))
    },
    VECTORIZE: { upsert: vi.fn(), deleteByIds: vi.fn() }
  } as unknown as Bindings;
  beforeEach(async () => {
    await mockAccessKeys();
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(paths)(
    "accepts a verified allowed identity for %s %s",
    async (method, path, body) => {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            "Cf-Access-Jwt-Assertion": await accessToken(),
            "Content-Type": "application/json"
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        },
        env
      );
      expect(res.status).toBe(200);
    }
  );

  it.each(paths)(
    "rejects %s %s without an Access identity",
    async (method, path, body) => {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            Authorization: "Bearer former-admin-secret",
            "Content-Type": "application/json"
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        },
        env
      );
      expect(res.status).toBe(401);
      expect(env.KV.get).not.toHaveBeenCalled();
      expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ email: "user@outside.example" }, 403],
    [{ aud: ["another-app"] }, 401],
    [{ exp: 1 }, 401]
  ])(
    "rejects untrusted administrative identities %j",
    async (claims, status) => {
      const res = await app.request(
        "/sync-state/test",
        {
          headers: { "Cf-Access-Jwt-Assertion": await accessToken(claims) }
        },
        env
      );
      expect(res.status).toBe(status);
      expect(env.KV.get).not.toHaveBeenCalled();
    }
  );
  it("rejects cross-origin browser writes despite a valid Access session", async () => {
    const res = await app.request(
      "https://knowbase.example.org/vectors/delete",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(),
          Origin: "https://attacker.example",
          "Content-Type": "text/plain"
        },
        body: JSON.stringify({ ids: ["important-vector"] })
      },
      env
    );
    expect(res.status).toBe(403);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });
});
