import { createOAuthStore } from "./test/oauth-store-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app, { type Bindings } from "./index.js";
import {
  accessEnv,
  accessToken,
  approveAuthorization,
  authorizationUrl,
  mockAccessKeys
} from "./test/access-fixture.js";

const env = { OAUTH_STORE: createOAuthStore(), ...accessEnv } as Bindings;

describe("Cloudflare Access OAuth login", () => {
  beforeEach(async () => {
    await mockAccessKeys();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the verified identity and a consent form without a password", async () => {
    const res = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("user@example.org");
    expect(html).toContain('name="consent"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("former-admin-secret");
  });

  it("keeps browser form redirects to external OAuth callbacks available", async () => {
    const token = await accessToken();
    const page = await app.request(
      authorizationUrl,
      {
        headers: { "Cf-Access-Jwt-Assertion": token }
      },
      env
    );
    // Chromium applies form-action to redirects after consent POST as well.
    // OAuth callbacks can be external HTTPS hosts or dynamic loopback ports.
    const policy = page.headers.get("Content-Security-Policy") || "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/(?:^|;)\s*form-action\b/);
    const result = await approveAuthorization(authorizationUrl, env, token);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.get("Location")!).origin).toBe(
      "https://chatgpt.com"
    );
  });

  it("issues a code after authenticated consent and preserves state and issuer", async () => {
    const res = await approveAuthorization(authorizationUrl, env);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("code")).toMatch(/^kb_code_/);
    expect(location.searchParams.get("state")).toBe("state123");
    expect(location.searchParams.get("iss")).toBe(
      "https://knowbase.example.org"
    );
  });

  it.each([
    "user@example.com",
    "user@sub.example.org",
    "user@evilexample.org",
    "user@example.org.evil.com",
    "@example.org",
    "user@@example.org",
    " user@example.org",
    "user@example.org\n"
  ])("rejects email %j", async (email) => {
    const res = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": await accessToken({ email }) } },
      env
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("accepts case-insensitive email domains", async () => {
    const res = await approveAuthorization(
      authorizationUrl,
      env,
      await accessToken({ email: "User@EXAMPLE.ORG" })
    );
    expect(res.status).toBe(302);
  });

  it("uses the deployment's configured email domain", async () => {
    const config = { ...env, ACCESS_EMAIL_DOMAIN: "other.example.org" };
    const accepted = await approveAuthorization(
      authorizationUrl,
      config,
      await accessToken({ email: "User@OTHER.EXAMPLE.ORG" })
    );
    expect(accepted.status).toBe(302);
    const rejected = await approveAuthorization(authorizationUrl, config);
    expect(rejected.status).toBe(403);
  });

  it.each([
    { iss: "https://attacker.cloudflareaccess.com" },
    { aud: ["other-application"] },
    { exp: 1 },
    { exp: undefined },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { sub: undefined },
    { email: undefined },
    { type: "org" }
  ])("rejects invalid identity claims %j", async (claims) => {
    const res = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": await accessToken(claims) } },
      env
    );
    expect(res.status).toBe(401);
  });

  it.each(["GET", "POST"])(
    "rejects %s without a JWT even with a forged email and admin password",
    async (method) => {
      const res = await app.request(
        authorizationUrl,
        {
          method,
          headers: {
            "Cf-Access-Authenticated-User-Email": "user@example.org",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          ...(method === "POST"
            ? {
                body: new URLSearchParams({
                  token: "former-admin-secret"
                }).toString()
              }
            : {})
        },
        env
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("Location")).toBeNull();
      expect(await res.text()).not.toContain('type="password"');
    }
  );

  it.each(["malformed", "tampered", "unsigned"])(
    "rejects a %s JWT",
    async (kind) => {
      const valid = await accessToken();
      const [header, payload, signature] = valid.split(".");
      const token =
        kind === "malformed"
          ? "not-a-jwt"
          : kind === "unsigned"
            ? `${btoa('{"alg":"none"}')}.${payload}.`
            : `${header}.${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
      const res = await app.request(
        authorizationUrl,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        env
      );
      expect(res.status).toBe(401);
    }
  );

  it.each([
    { ACCESS_TEAM_DOMAIN: undefined },
    { ACCESS_AUD: undefined },
    { ACCESS_EMAIL_DOMAIN: undefined },
    { ACCESS_EMAIL_DOMAIN: "" },
    { ACCESS_EMAIL_DOMAIN: "@example.org" },
    { ACCESS_EMAIL_DOMAIN: "example.org,other.org" },
    { ACCESS_EMAIL_DOMAIN: "example.org\n" },
    { ACCESS_EMAIL_DOMAIN: "example..org" },
    { ACCESS_TEAM_DOMAIN: "attacker.example.com" }
  ])("fails closed for missing or invalid configuration %j", async (config) => {
    const res = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
      { ...env, ...config }
    );
    expect(res.status).toBe(503);
  });

  it("fails closed when the key service is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    const issuer = "https://unavailable.cloudflareaccess.com";
    const res = await app.request(
      authorizationUrl,
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken({ iss: issuer })
        }
      },
      { ...env, ACCESS_TEAM_DOMAIN: "unavailable.cloudflareaccess.com" }
    );
    expect(res.status).toBe(401);
  });

  it("caches trusted public keys across repeated authorization requests", async () => {
    const fetchMock = await mockAccessKeys();
    const config = {
      ...env,
      ACCESS_TEAM_DOMAIN: "cache-test.cloudflareaccess.com"
    };
    const token = await accessToken({
      iss: "https://cache-test.cloudflareaccess.com"
    });
    for (let index = 0; index < 3; index++) {
      const res = await app.request(
        authorizationUrl,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        config
      );
      expect(res.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://cache-test.cloudflareaccess.com/cdn-cgi/access/certs"
    );
  });

  it("rejects unknown signing keys and reloads keys after the cooldown", async () => {
    vi.useFakeTimers();
    const config = {
      ...env,
      ACCESS_TEAM_DOMAIN: "rotation-test.cloudflareaccess.com"
    };
    const claims = { iss: "https://rotation-test.cloudflareaccess.com" };
    const original = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": await accessToken(claims) } },
      config
    );
    expect(original.status).toBe(200);
    const rotatedToken = await accessToken(claims, "rotated-key");
    const rotatedKeys = await mockAccessKeys("rotated-key");
    const denied = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": rotatedToken } },
      config
    );
    expect(denied.status).toBe(401);
    expect(rotatedKeys).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 31 * 1000);
    const accepted = await app.request(
      authorizationUrl,
      { headers: { "Cf-Access-Jwt-Assertion": rotatedToken } },
      config
    );
    expect(accepted.status).toBe(200);
    expect(rotatedKeys).toHaveBeenCalledTimes(1);
  });

  it("rejects authenticated POST without valid consent", async () => {
    const res = await app.request(
      authorizationUrl,
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "token=admin-secret&consent=forged"
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it.each(["identity", "parameters", "expired"])(
    "binds consent to %s",
    async (change) => {
      const token = await accessToken();
      const page = await app.request(
        authorizationUrl,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        env
      );
      const consent =
        (await page.text()).match(/name="consent" value="([^"]+)"/)?.[1] || "";
      if (change === "expired") {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      }
      const res = await app.request(
        change === "parameters"
          ? authorizationUrl + "&scope=read"
          : authorizationUrl,
        {
          method: "POST",
          headers: {
            "Cf-Access-Jwt-Assertion":
              change === "identity"
                ? await accessToken({ sub: "another-user" })
                : token,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ consent }).toString()
        },
        env
      );
      expect(res.status).toBe(403);
    }
  );
});
