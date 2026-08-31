# Contributing

Thank you for contributing to `cf-knowbase-api`.

## Prerequisites

- Node.js 22
- pnpm 10
- A Cloudflare account for Worker integration testing or deployment

## Development Setup

Install the locked dependencies:

```bash
pnpm install --frozen-lockfile
```

Start the local Worker development server:

```bash
pnpm run dev
```

## Testing

Run the unit tests and TypeScript type checking before submitting a change:

```bash
pnpm test
pnpm run typecheck
```

For changes to Worker configuration or deployment behavior, also validate the deployment without publishing it:

```bash
pnpm exec wrangler deploy --dry-run
```

Use the project's test framework for reusable unit tests. For functionality, bug fixes, refactoring, and behavior changes, write a test that fails for the expected reason before implementing the minimal production change that makes it pass.

GitHub Actions runs the test suite and TypeScript type checking for every pull request and every push to `main`.

## Commits and Pull Requests

- Create a dedicated branch from the latest `main`.
- Write commit messages, pull request titles, and pull request descriptions in English.
- Sign off every commit with `git commit -s`.
- Keep documentation synchronized with behavior changes.
- Include tests for behavior changes and describe the verification performed in the pull request.

## Production Releases

Pushing a version tag matching `v*` runs the GitHub Actions deployment workflow. The workflow installs locked dependencies, runs tests and type checking, and then deploys the Worker configured in `wrangler.toml`.

Before creating a release tag, configure the `CLOUDFLARE_API_TOKEN` GitHub Actions repository secret. Create the token from Cloudflare's **Edit Cloudflare Workers** template and restrict it to the account configured by the deployment workflow.

After the release commit is on `main`, create and push a signed release tag:

```bash
git tag -s v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

The deployment is recorded in the GitHub `production` environment and uses the Worker name and routes defined in `wrangler.toml`.
