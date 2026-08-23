# Argus GitHub App

The GitHub App is Argus's zero-install platform entry point. A repository owner
installs it on selected repositories; Argus then publishes an `Argus
Verification` Check Run for every opened, reopened, synchronized, or
ready-for-review pull request.

## Repository setup

Commit `.argus/platform.json`:

```json
{
  "targetUrl": "https://preview.example.com",
  "project": "my-web-app",
  "checks": ["smoke", "audit", "flows"],
  "viewports": ["mobile", "desktop"],
  "colorSchemes": ["light"],
  "flowConcurrency": 3
}
```

Only the target and check policy belong in this file. Do not put credentials,
API tokens, passwords, or cookies in the repository. Authenticated checks use a
tenant-scoped `authProfile` saved in Argus.

Committed flows under `.argus/flows/*.json` are loaded at the pull request's
head SHA and replayed against `targetUrl`. Argus re-homes each flow to that
origin, so flows do not need environment-specific URLs.

## GitHub App registration

Create a GitHub App with:

- Webhook URL: `https://<argus-host>/platform/github/webhook`
- Webhook secret: a new random value
- Repository permissions:
  - Checks: read and write
  - Contents: read
  - Metadata: read
  - Pull requests: read
- Events:
  - Pull request
  - Check run

No user OAuth authorization is required for the first version. Installation
access is restricted to the repositories selected by the owner.

Configure the Worker:

```bash
wrangler secret put ARGUS_GITHUB_PRIVATE_KEY
wrangler secret put ARGUS_GITHUB_WEBHOOK_SECRET
wrangler secret put ARGUS_GITHUB_APP_ID
wrangler secret put ARGUS_GITHUB_APP_SLUG
wrangler secret put ARGUS_PUBLIC_URL
```

`ARGUS_GITHUB_PRIVATE_KEY` accepts the PKCS#1 PEM downloaded by GitHub or a
PKCS#8 PEM. Secrets are never returned by the status endpoint or written to
R2. The Worker uses the private key only to mint a short-lived installation
token for the repository that triggered the signed webhook.

## Runtime behavior

1. Verify the exact raw webhook body with `X-Hub-Signature-256`.
2. Deduplicate the `X-GitHub-Delivery` identifier.
3. Mint a short-lived installation access token.
4. Read configuration and flows at the pull request head SHA.
5. Run the selected suites using a per-installation Argus tenant.
6. Complete the GitHub Check with a verdict, findings, dashboard link, and a
   **Rerun** action.

The webhook returns `202` before browser work finishes. Errors are recorded
without credentials under `platform/github/errors/` for operational triage.

## Next platform increment

Static `targetUrl` is the first end-to-end contract. The next increment listens
for successful GitHub `deployment_status` events and uses their
`environment_url`, allowing Vercel, Cloudflare Pages, Netlify, and custom
preview deployments to be tested without changing repository configuration.
