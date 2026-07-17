# Deployment and operator runbook

This runbook uses public-safe placeholders. Keep real domains, host paths,
tokens, API keys, proxy configuration, and incident evidence outside the
repository.

## Verify the checkout

```sh
npm ci --ignore-scripts
npm run check:conformance
npm audit --omit=dev
```

Tests inject DNS and fetch behavior and do not contact Firecrawl.

## Initialize standalone mode

```sh
node scripts/init-runtime-env.mjs
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/health
docker compose exec firecrawl-mcp node /app/scripts/runtime-smoke.mjs
```

The initializer creates an ignored mode-`0600` `.env` and prints no secret.
Provider keys remain in the MCP client's secret store and arrive only through
`x-firecrawl-api-key`.

Expected container posture:

- loopback-only host binding by default
- non-root UID/GID 1000
- read-only root filesystem
- all Linux capabilities dropped
- `no-new-privileges`
- PID limit 128
- exactly one runtime process or replica for the ledger
- writable named volume only at `/data`
- `/health` reports the selected mode and exactly nine tools

## Scaling boundary

Run exactly one server process or replica for each ledger. The file ledger
coordinates atomic reservations inside one process, but it has no distributed
lock and must not be shared by multiple containers or Node processes. Do not
use a multi-replica orchestrator deployment until the ledger is replaced by a
shared transactional store with equivalent one-use and budget guarantees.

## Remote standalone access

Keep the application on loopback or a private container network and put a TLS
reverse proxy in front of it. The proxy must preserve `Authorization`, reject
oversized requests, and apply reasonable connection and rate limits. Never
create an unauthenticated route to `/mcp`.

Verify the following from the real client path:

1. `/health` returns 200 without secrets.
2. Missing or incorrect bearer token returns 401.
3. `tools/list` returns nine unique tools with a correct token.
4. `check_configuration` succeeds without a Firecrawl key.
5. A provider tool fails clearly without `x-firecrawl-api-key`.
6. A safe read-only provider tool succeeds with an owner-supplied key.

## Portal mode

Use [`portal-compat.md`](portal-compat.md). Portal provider activation is a
separate security boundary and requires immutable release metadata. Record the
exact release commit, source fingerprint, and OCI image digest in the private
deployment environment before setting
`FIRECRAWL_PROVIDER_EXECUTION_ENABLED=true`.

## Upgrade

Read [CHANGELOG.md](../CHANGELOG.md), back up the persistent ledger volume
according to your container platform, then rebuild the exact release:

```sh
git fetch --tags
git checkout <verified-release-tag>
npm ci --ignore-scripts
npm run check:conformance
docker compose up -d --build
docker compose ps
docker compose exec firecrawl-mcp node /app/scripts/runtime-smoke.mjs
```

Do not rotate service credentials or discard the ledger as part of a routine
upgrade.

## Rollback

Keep the prior verified tag or immutable image reference before upgrading.
Restore that release while retaining the same `.env` and ledger volume, then
repeat the runtime smoke. Confirm both unauthorized rejection and an
authenticated navigation call after rollback.

Do not retry a paid operation whose result was ambiguous before rollback. The
preview token is one-use and the ledger conservatively accounts uncertain
provider outcomes.

## Troubleshooting

```sh
docker compose ps
docker compose logs --tail=100 firecrawl-mcp
curl --fail http://127.0.0.1:8080/health
```

Common causes are an invalid `MCP_MODE`, a missing mode-specific service token,
an unwritable ledger volume, malformed release provenance in Portal mode, or a
proxy that strips the authorization header. Never paste `.env`, request
headers, provider output, or raw logs containing sensitive material into a
public issue.
