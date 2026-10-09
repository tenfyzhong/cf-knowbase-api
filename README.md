# cf-knowbase-api

Cloudflare Worker providing a secure, unified semantic search and vector management API for personal knowledge bases powered by Cloudflare Workers AI, Vectorize, and KV.

## Features

- **Workers AI Embedding**: Direct on-edge text & query vectorization using `@cf/baai/bge-m3` (1024 dimensions, multilingual optimized) or custom models.
- **Vector Management**: Full CRUD support for Vectorize (`/vectors/upsert`, `/vectors/delete`, `/search`) directly via Worker APIs.
- **KV Sync State Persistence**: Tracks incremental sync states and Git commit hashes (`/sync-state/:source`).
- **Remote MCP Server**: Stateless Streamable HTTP-compatible MCP endpoint at `/mcp` for ChatGPT Web plugins.
- **MCP OAuth 2.1**: Protected-resource and authorization-server discovery, dynamic client registration, PKCE S256, short-lived access tokens, and refresh tokens.
- **OpenAPI 3.1 Compatibility**: Keeps the Custom GPT Action integration available for existing clients.
- **Scoped Bearer Authentication**: Cloudflare Access restricts OAuth authorization to identities from the deployment's configured email domain. The deployment `API_TOKEN` protects administrative endpoints and signs OAuth credentials, while search and MCP endpoints accept only OAuth-issued access tokens.

## Endpoints

### 1. `POST /mcp`
Stateless remote MCP endpoint exposing the authenticated `search_knowledge_base` tool. Every request, including MCP initialization, requires an OAuth-issued bearer access token; unauthenticated requests receive an HTTP 401 OAuth challenge.

### 2. `POST /search`
Semantic search endpoint. Requires an OAuth-issued bearer access token; the deployment `API_TOKEN` is rejected.

- **Request Body**:
```json
{
  "query": "how to configure cloudflare vectorize?",
  "topK": 5,
  "source": "notes"
}
```

`topK` accepts values from 1 to 50. Source-scoped searches may over-fetch
candidates before applying the exact source match, but the Vectorize query is
capped at 50 when returning full metadata.

### 3. `POST /vectors/upsert`
Generate embeddings and upsert document text chunks into Vectorize.

- **Request Body**:
```json
{
  "items": [
    {
      "id": "notes:docs/architecture.md:0",
      "text": "Cloudflare Vectorize is a globally distributed vector database...",
      "source": "notes",
      "path": "docs/architecture.md",
      "title": "Architecture Overview",
      "chunkIndex": 0
    }
  ]
}
```

### 4. `POST /vectors/delete`
Delete vectors by ID list.

- **Request Body**:
```json
{
  "ids": ["notes:docs/architecture.md:0"]
}
```

### 5. `POST /vectors/clear`

Delete indexed vectors and synchronization state. Omit `source` to clear every source, or provide an exact source name to clear only that source:

```text
POST /vectors/clear?source=personal-notes
```

This administrative endpoint requires the deployment `API_TOKEN`.

### 6. `GET /sync-state/:source` & `PUT /sync-state/:source`
Get or save incremental synchronization state for a source.

### 7. OAuth discovery and authorization

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET|POST /oauth/authorize`
- `POST /oauth/token`

Cloudflare Zero Trust (Access) authenticates the user before showing the authorization page. Only a verified Access application JWT with an email address matching `ACCESS_EMAIL_DOMAIN` can approve a connection. The page shows the signed-in email and asks for confirmation without a password, then issues an independent HMAC-signed one-hour OAuth access token plus a refresh token. Each successful refresh rotates the refresh token and starts a new 30-day validity window. The original `API_TOKEN` is never returned to the MCP client and cannot be used directly against `/search`, `/mcp`, or `/oauth/verify`. Rotating it revokes all previously issued OAuth credentials.

Dynamic client registration accepts HTTPS callbacks and native-client loopback callbacks on `http://localhost`, `http://127.0.0.1`, or `http://[::1]`. Loopback callback ports may vary between registration and authorization, which supports ephemeral local listeners used by command-line MCP clients.

### 8. `GET /health`
Healthcheck endpoint.

---

## Connecting from ChatGPT Web

1. Deploy the Worker on a public HTTPS domain.
2. Enable **Developer mode** under **ChatGPT Settings > Security and login**.
3. Open **ChatGPT Plugins**, add an MCP server, and enter:
   ```text
   https://knowbase.example.com/mcp
   ```
4. Review the discovered `search_knowledge_base` tool.
5. Click **Connect**, or call the tool for the first time.
6. Enter the deployment `API_TOKEN` on the Knowbase authorization page.

ChatGPT discovers OAuth through the two `.well-known` endpoints, dynamically registers a public client, performs authorization code + PKCE, and stores only the issued OAuth tokens.

## Connecting MCP Clients Directly

The remote endpoint can be used without installing a Knowbase plugin. Configure the deployment URL in each MCP client and complete its OAuth flow. Do not put the deployment `API_TOKEN` in MCP configuration or send it as a bearer token: sign in through Cloudflare Access on the Knowbase authorization page. The client stores the issued OAuth access and refresh tokens.

### Codex

Add the MCP URL for the deployment, then authenticate it:

```bash
codex mcp add knowbase --url https://your-knowbase.example.com/mcp
codex mcp login knowbase
```

Codex dynamically registers a public OAuth client and opens the Knowbase authorization page. Sign in through Cloudflare Access with an email address matching `ACCESS_EMAIL_DOMAIN` and confirm the connection. Codex receives only the issued OAuth access and refresh tokens; its local loopback callback can use an ephemeral port.

### Claude Code

Add the remote HTTP MCP server at user scope, authenticate it, and verify the connection:

```bash
claude mcp add --transport http --scope user \
  knowbase https://your-knowbase.example.com/mcp
claude mcp login knowbase
claude mcp get knowbase
```

### Oh My Pi

Add the following user-level configuration to `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "knowbase": {
      "type": "http",
      "url": "https://your-knowbase.example.com/mcp"
    }
  }
}
```

Reload the configuration, authenticate, and test the server from an OMP session:

```text
/mcp reload
/mcp reauth knowbase
/mcp test knowbase
```

Knowbase challenges the initial anonymous MCP connection with HTTP 401, allowing OMP to discover the OAuth endpoints during `/mcp reauth`.

### Pi

Pi does not include a native MCP client. Install the general-purpose MCP adapter instead of the Knowbase plugin:

```bash
pi install npm:pi-mcp-adapter
```

Add the following user-level configuration to `~/.config/mcp/mcp.json`:

```json
{
  "mcpServers": {
    "knowbase": {
      "url": "https://your-knowbase.example.com/mcp",
      "auth": "oauth"
    }
  }
}
```

Restart Pi, then authenticate and connect:

```text
/mcp-auth knowbase
/mcp reconnect knowbase
```

Each successful refresh rotates the refresh token and starts a new 30-day validity window, so normal inactivity does not require reconnecting. Authenticate again only if the refresh token expires or is revoked, the deployment `API_TOKEN` is rotated, or the client's stored credential is removed.

---

## Deployment

### 1. Create Vectorize Index & KV Namespace

```bash
npx wrangler vectorize create knowbase-index --dimensions=1024 --metric=cosine
npx wrangler kv namespace create knowbase-kv-namespace
```

Copy the new KV namespace ID into `wrangler.toml`. Set your Worker name, account ID and optional custom-domain route for your deployment; the checked-in configuration contains no account-specific values.

### 2. Set Secret Token

```bash
npx wrangler secret put API_TOKEN
```

### 3. Configure Cloudflare Zero Trust login

Each deployment must configure its own Access application, team domain, application audience and allowed email domain. The repository does not provide a default login domain.

1. Open **Cloudflare Zero Trust** for the same account. If necessary, set up the organization and choose a team name. The **team domain** is its login hostname, such as `your-team.cloudflareaccess.com`; it is separate from the Worker domain `knowbase.example.com`.
2. In **Access → Applications**, create a **Self-hosted** application for `knowbase.example.com` with the path `/oauth/authorize`. Protect this path only: OAuth discovery, `/oauth/register`, `/oauth/token`, and `/mcp` must remain reachable by MCP clients without an Access browser session.
3. Add an **Allow** policy with **Include → Emails ending in → your allowed email domain** (for example, `example.com`). Use an identity provider or enable **One-time PIN** to verify ownership of the email address. Do not add an Everyone, Bypass, or service-token policy to this application.
4. Copy the application's **Application Audience (AUD) tag** and your team domain. Configure all three values using one of the deployment methods below.

For **GitHub Actions deployment**, open **Settings → Secrets and variables → Actions** in your repository and add these names under **Variables** or **Secrets**:

| Name | Value |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Your team hostname, such as `your-team.cloudflareaccess.com`, without `https://` or a trailing slash |
| `ACCESS_AUD` | Your Access application's Application Audience (AUD) tag |
| `ACCESS_EMAIL_DOMAIN` | Your allowed email domain, such as `example.com`, without `@` |

The workflow also supports these names in the GitHub **production** Environment. For each name, a non-empty Secret takes precedence over a Variable. Deployment validates that all three values are present, then binds them to the Worker as secrets through Wrangler Action. You do not need to put their values in `wrangler.toml` or commit them to the repository. Missing or whitespace-only values stop the workflow before deployment. The existing version-tag trigger remains unchanged.

For **manual deployment**, store the same values as Worker secrets:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put ACCESS_AUD
pnpm exec wrangler secret put ACCESS_EMAIL_DOMAIN
```

Enter each value when prompted, then run `pnpm run deploy`. Avoid defining the same names as plaintext variables in `wrangler.toml`, which would conflict with secret bindings.

The Worker validates the Access JWT signature using the team's public keys, checks the issuer, audience, expiration and application-token identity, and independently enforces the exact domain in `ACCESS_EMAIL_DOMAIN` (case-insensitive; subdomains are not implicitly allowed). Use the same email domain in the Access policy and Worker variable, without a leading `@`. Missing or invalid configuration fails closed with HTTP 503; missing or invalid JWTs receive HTTP 401 and other email domains receive HTTP 403. Direct requests to a Worker URL cannot authorize a connection using a password or a forged email header. See [Cloudflare's JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

`API_TOKEN` is still required for administrative API authentication and signing OAuth credentials, but it is never entered on the authorization page. Existing issued OAuth access and refresh tokens retain their validity; rotate `API_TOKEN` if you also need to revoke previously issued credentials.

### 4. Deploy Worker

```bash
pnpm run deploy
```

For local development, testing, contribution guidelines, and the release process, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](LICENSE).
