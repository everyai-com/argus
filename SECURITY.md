# Security

Argus controls real browser sessions and may store authenticated browser state.
Treat every deployment as security-sensitive.

## Reporting a vulnerability

Do not open a public issue. Report vulnerabilities privately to the repository
owners through GitHub's private vulnerability reporting feature.

## Deployment requirements

- Configure `ARGUS_TOKEN` with `wrangler secret put ARGUS_TOKEN` before exposing a deployment.
- Never commit `.dev.vars`, `.argus/config.json`, browser storage state, or API tokens.
- Use separate tenant tokens for separate projects or teams.
- Restrict Cloudflare and GitHub credentials to the minimum required permissions.
- Rotate a token immediately if it may have appeared in logs or source control.
