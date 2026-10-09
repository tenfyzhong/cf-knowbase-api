// One Durable Object per hashed credential; reads and consumption are consistent.
export class OAuthStore {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "PUT") {
      const grant = (await request.json()) as { expiresAt?: number };
      await this.state.storage.transaction(async (storage) => {
        await storage.put("grant", grant);
        if (grant.expiresAt) await storage.setAlarm(grant.expiresAt);
      });
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      return new Response(null, { status: 405 });
    }
    const grant = await this.state.storage.transaction(async (storage) => {
      const value = await storage.get<{ expiresAt?: number }>("grant");
      if (
        !value ||
        (value.expiresAt !== undefined && value.expiresAt <= Date.now())
      ) {
        await storage.delete("grant");
        return null;
      }
      if (request.method === "DELETE") await storage.delete("grant");
      return value;
    });
    return grant ? Response.json(grant) : new Response(null, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

async function credentialObject(
  namespace: DurableObjectNamespace,
  token: string
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  const name = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return namespace.getByName(name);
}

export async function storeOAuthValue<T>(
  namespace: DurableObjectNamespace,
  prefix: string,
  value: T
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    prefix +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const result = await (
    await credentialObject(namespace, token)
  ).fetch("https://oauth-store/", {
    method: "PUT",
    body: JSON.stringify(value)
  });
  if (!result.ok) throw new Error("OAuth credential storage failed");
  return token;
}

export async function readOAuthValue<T>(
  namespace: DurableObjectNamespace,
  prefix: string,
  token: string,
  consume = false
): Promise<T | null> {
  if (
    !token.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length))
  )
    return null;
  const result = await (
    await credentialObject(namespace, token)
  ).fetch("https://oauth-store/", {
    method: consume ? "DELETE" : "GET"
  });
  if (result.status === 404) return null;
  if (!result.ok) throw new Error("OAuth credential storage unavailable");
  return (await result.json()) as T;
}
