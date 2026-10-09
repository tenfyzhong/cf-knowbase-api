import { createRemoteJWKSet, jwtVerify } from "jose";

interface AccessConfig {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_EMAIL_DOMAIN?: string;
}

export function accessEmailDomain(config: AccessConfig): string | null {
  const domain = config.ACCESS_EMAIL_DOMAIN;
  if (
    !domain ||
    domain !== domain.trim() ||
    domain.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      domain
    )
  ) {
    return null;
  }
  return domain.toLowerCase();
}

// One configured team per Worker isolate. jose caches keys and bounds fetches.
let keySet:
  | { issuer: string; resolve: ReturnType<typeof createRemoteJWKSet> }
  | undefined;

export function accessIssuer(config: AccessConfig): string | null {
  const domain = config.ACCESS_TEAM_DOMAIN;
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain) ||
    !config.ACCESS_AUD?.trim()
  ) {
    return null;
  }
  return `https://${domain}`;
}

export async function verifyAccessIdentity(
  token: string,
  config: AccessConfig
): Promise<{ sub: string; email: string } | null> {
  const issuer = accessIssuer(config);
  if (!issuer) return null;

  try {
    if (keySet?.issuer !== issuer) {
      keySet = {
        issuer,
        resolve: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
          timeoutDuration: 5000,
          cooldownDuration: 30000,
          cacheMaxAge: 5 * 60 * 1000
        })
      };
    }
    const { payload } = await jwtVerify(token, keySet.resolve, {
      issuer,
      audience: config.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email", "type"]
    });
    if (
      payload.type !== "app" ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.email !== "string"
    ) {
      return null;
    }
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
