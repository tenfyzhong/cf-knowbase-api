# cf-knowbase-api

Cloudflare Worker providing a secure, unified semantic search and vector management API for personal knowledge bases powered by Cloudflare Workers AI, Vectorize, and KV.

## Features

- **Workers AI Embedding**: Direct on-edge text & query vectorization using `@cf/baai/bge-m3` (1024 dimensions, multilingual optimized) or custom models.
- **Vector Management**: Full CRUD support for Vectorize (`/vectors/upsert`, `/vectors/delete`, `/search`) directly via Worker APIs.
- **KV Sync State Persistence**: Tracks incremental sync states and Git commit hashes (`/sync-state/:source`).
- **Remote MCP Server**: Stateless Streamable HTTP-compatible MCP endpoint at `/mcp` for ChatGPT Web plugins.
- **MCP OAuth 2.1**: Protected-resource and authorization-server discovery, dynamic client registration, PKCE S256, short-lived access tokens, and refresh tokens.
- **OpenAPI 3.1 Compatibility**: Keeps the Custom GPT Action integration available for existing clients.
- **Scoped Bearer Authentication**: Cloudflare Access restricts OAuth authorization to identities from the deployment's configured email domain. The same Access identity check protects administrative endpoints, while search and MCP endpoints accept only OAuth-issued access tokens.

## Endpoints

### 1. `POST /mcp`
Stateless remote MCP endpoint exposing the authenticated `search_knowledge_base` tool. Every request, including MCP initialization, requires an OAuth-issued bearer access token; unauthenticated requests receive an HTTP 401 OAuth challenge.

### 2. `POST /search`
Semantic search endpoint. Requires an OAuth-issued bearer access token.

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

Administrative endpoints require a verified Cloudflare Access application identity from the configured email domain. Passwords and static bearer credentials are not accepted.

### 6. `GET /sync-state/:source` & `PUT /sync-state/:source`
Get or save incremental synchronization state for a source.

### 7. OAuth discovery and authorization

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET|POST /oauth/authorize`
- `POST /oauth/token`

Cloudflare Zero Trust (Access) authenticates the user before showing the authorization page. Only a verified Access application JWT with an email address matching `ACCESS_EMAIL_DOMAIN` can approve a connection. The page shows the signed-in email and asks for confirmation without a password, then issues a random, opaque one-hour OAuth access token plus a refresh token, bound to the verified identity. Each successful refresh rotates the refresh token and starts a new 30-day validity window. OAuth clients, consent challenges, authorization codes and tokens are stored in the `OAUTH_STORE` Durable Object namespace. Credential object IDs use SHA-256 hashes of 256-bit random values. Authorization codes, consent challenges and refresh tokens are consumed atomically; expired credentials are rejected and removed by alarms. No application signing secret is required.

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
6. Sign in through Cloudflare Access with an email from the deployment's allowed domain, then confirm the connection on the Knowbase authorization page.

ChatGPT discovers OAuth through the two `.well-known` endpoints, dynamically registers a public client, performs authorization code + PKCE, and stores only the issued OAuth tokens.

## Connecting MCP Clients Directly

The remote endpoint can be used without installing a Knowbase plugin. Configure the deployment URL in each MCP client, sign in through Cloudflare Access, and confirm the connection on the Knowbase authorization page. The client stores the issued OAuth access and refresh tokens.

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

Each successful refresh rotates the refresh token and starts a new 30-day validity window, so normal inactivity does not require reconnecting. Authenticate again only if the refresh token expires or is revoked, the client's stored credential is removed.

---

## Deployment

The repository supports deployment through GitHub Actions or the local Wrangler CLI. Each fork supplies its own Cloudflare resources and Access configuration; no personal account IDs, domains or Access values are provided by default.

### 1. Prepare your fork and Cloudflare account

1. Fork this repository and clone your fork.
2. Install Node.js 22 and pnpm 10, then install the locked dependencies:

   ```bash
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   ```

3. Choose the Worker name and public hostname for your deployment. In `wrangler.toml`, set `name`, replace the KV namespace placeholder after step 2, and optionally set your `account_id` and custom-domain `routes`. The Access application in step 3 must use this same public hostname.

For a custom domain, replace the commented example route with your own hostname. Without a custom route, use the Worker's `workers.dev` hostname for the Access application and MCP client configuration.

### 2. Create the Vectorize index and KV namespace

```bash
pnpm exec wrangler vectorize create knowbase-index --dimensions=1024 --metric=cosine
pnpm exec wrangler kv namespace create knowbase-kv-namespace
```

Copy the generated KV namespace ID into `[[kv_namespaces]].id` in `wrangler.toml`. If you choose another Vectorize index name, update `[[vectorize]].index_name` to match. Keep the binding names `KV`, `VECTORIZE`, `AI` and `OAUTH_STORE` unchanged because the Worker uses them. `OAUTH_STORE` uses SQLite-backed Durable Objects; Wrangler creates the namespace from the included `oauth-store-v1` migration during the first deployment. Do not remove the migration after deployment.

Commit your fork's Worker/resource configuration before releasing it so GitHub Actions deploys the correct Worker and resources. Account and resource IDs identify your deployment; keep tokens and other secret values out of Git.

### 3. Create the Cloudflare Access application

1. Open **Cloudflare Zero Trust** for your deployment account. Set up the organization if needed and note its **team domain**, such as `your-team.cloudflareaccess.com`. This is the Access login hostname, separate from your Worker hostname.
2. In **Access → Applications**, create a **Self-hosted** application for your Worker hostname with the path `/oauth/authorize`. Add the administrative paths `/sync-state/*` and `/vectors/*` to this same application so they share the configured AUD and Allow policy. Keep OAuth discovery, `/oauth/register`, `/oauth/token`, and `/mcp` outside Access browser protection so MCP clients can complete OAuth normally.
3. Add an **Allow** policy with **Include → Emails ending in → your allowed email domain**, such as `example.com`. Enable an identity provider or **One-time PIN** to verify email ownership. Do not add an Everyone, Bypass, or service-token policy to this application.
4. Copy the application's **Application Audience (AUD) tag**. You will configure this value, the team domain, and the allowed email domain in step 4.

The Worker verifies the JWT signature, issuer, audience, expiry and application identity, then independently checks the exact email domain (case-insensitive; subdomains are not implicitly allowed). Use the same domain in the Access policy and `ACCESS_EMAIL_DOMAIN`, without a leading `@`. Missing or invalid Worker configuration returns HTTP 503, missing or invalid JWTs return HTTP 401, and other email domains return HTTP 403. See [Cloudflare's JWT validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

### 4. Configure every GitHub Actions deployment input

In your fork, open **Settings → Secrets and variables → Actions**. Add all five entries below. The two Cloudflare authentication entries must be **Secrets**; the three Access entries can be **Variables** or **Secrets**.

| Name | Required | GitHub storage | Value and where to obtain it |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | Secret | A Cloudflare API token authorized to deploy your Worker and manage its secrets. Create it under **Cloudflare → My Profile → API Tokens**, using the **Edit Cloudflare Workers** template and restricting it to your deployment account and applicable resources. |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Secret | The account ID for the account containing your Worker, KV namespace and Vectorize index; copy it from the Cloudflare account/Worker overview. |
| `ACCESS_TEAM_DOMAIN` | Yes | Variable or Secret | Your Zero Trust team hostname, for example `your-team.cloudflareaccess.com`. Do not include `https://` or a trailing slash. |
| `ACCESS_AUD` | Yes | Variable or Secret | The **Application Audience (AUD) tag** from the Access application protecting this Worker's `/oauth/authorize` path. |
| `ACCESS_EMAIL_DOMAIN` | Yes | Variable or Secret | The email domain from your Access Allow policy, for example `example.com`. Do not include `@`; configure a single domain. |

Alternatively, configure these names in **Settings → Environments → production**. The deployment job uses the GitHub `production` Environment, so its protection/approval rules apply.

For each Access name, a non-empty same-named **Secret takes precedence over a Variable**. The workflow checks that all three Access values are present and not whitespace-only before deployment, then uploads them as **Worker secrets** using Wrangler Action. They are available to the Worker under the same names, regardless of whether their GitHub source was a Variable or Secret. Do not add empty or same-named plaintext variables to `wrangler.toml`.

The workflow does not read `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` from Variables. The Cloudflare API credential is used only by the deployment workflow; it is not an application login credential. There is no application-level token or signing secret to provision.

### 5. Deploy with GitHub Actions

1. Push your fork's deployment configuration to its default branch and enable GitHub Actions for the fork if needed.
2. Ensure the release commit includes the configuration and code you want to deploy.
3. Create and push an unused version tag **starting with a digit**, for example:

   ```bash
   git tag -s 0.3.0 -m "Release 0.3.0"
   git push origin 0.3.0
   ```

4. Open **Actions → Deploy** and inspect the run. If your `production` Environment requires approval, approve that deployment through GitHub.

The workflow installs locked dependencies, runs unit tests and type checking, validates the Access inputs, uploads the Access secrets, and deploys the Worker and its Durable Object migration. Tags prefixed with `v` do not match the current `[0-9]*` trigger. Pull requests and pushes to `main` run CI but do not trigger production deployment.

After deployment, open an OAuth authorization request through an MCP client. Confirm that it redirects to Cloudflare Access, allows an email from your configured domain, and shows the signed-in email plus a connection confirmation without a password field. Check that a different email domain is denied and the client's OAuth token exchange succeeds.

### Administrative API clients

Sign in to the protected Worker hostname through Cloudflare Access. Browser sessions use the Access authorization cookie; Cloudflare forwards the verified application JWT in `Cf-Access-Jwt-Assertion`. CLI/indexing clients must obtain an Access application JWT through user login and send it via an Access cookie/session. The Worker independently validates the forwarded JWT and allowed email domain before any administrative read or write.

### Migration from the previous authentication scheme

Previously issued signed OAuth credentials and registered client IDs are incompatible with opaque credentials. After upgrading, reconnect MCP clients so they register and authorize again through Access. Update indexing clients to use Access login for administrative calls. Remove the old application token from Worker secrets and client configuration; it is no longer read or accepted.

### Manual deployment alternative

After steps 1–3, store the three Access values directly as Worker secrets instead of configuring GitHub Actions:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put ACCESS_AUD
pnpm exec wrangler secret put ACCESS_EMAIL_DOMAIN
pnpm run deploy
```

Enter each value when prompted. For local development, testing, contribution guidelines, and the release process, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](LICENSE).
