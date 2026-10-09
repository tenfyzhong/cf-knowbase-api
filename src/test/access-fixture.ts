import { vi } from "vitest";
import app, { type Bindings } from "../index.js";

export const accessEnv = {
  ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
  ACCESS_AUD: "test-access-application",
  ACCESS_EMAIL_DOMAIN: "example.org"
};

const keyPair = crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
) as Promise<CryptoKeyPair>;

function encode(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function accessToken(
  claims: Record<string, unknown> = {},
  kid = "access-key"
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${accessEnv.ACCESS_TEAM_DOMAIN}`,
    aud: [accessEnv.ACCESS_AUD],
    sub: "access-user-id",
    email: "user@example.org",
    type: "app",
    iat: now,
    exp: now + 3600,
    ...claims
  };
  const input = `${encode(JSON.stringify({ alg: "RS256", kid }))}.${encode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (await keyPair).privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${encode(new Uint8Array(signature))}`;
}

export async function mockAccessKeys(kid = "access-key") {
  const publicKey = await crypto.subtle.exportKey(
    "jwk",
    (await keyPair).publicKey
  );
  const fetchMock = vi.fn().mockImplementation(async () =>
    Response.json({
      keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }]
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const authorizationUrl =
  "https://knowbase.example.org/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=https%3A%2F%2Fchatgpt.com%2Faip%2Fcallback&state=state123";

export async function approveAuthorization(
  url: string,
  env: Bindings,
  token?: string
): Promise<Response> {
  const headers = { "Cf-Access-Jwt-Assertion": token || (await accessToken()) };
  const page = await app.request(url, { headers }, env);
  const consent =
    (await page.text()).match(/name="consent" value="([^"]+)"/)?.[1] || "";
  return app.request(
    url,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ consent }).toString()
    },
    env
  );
}
