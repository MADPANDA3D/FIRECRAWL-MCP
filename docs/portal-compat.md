# Optional MAD MCP Portal integration

Portal integration is optional. Self-hosters should use `MCP_MODE=standalone`.
This document contains placeholders only; real domains, deployment paths,
credentials, assignments, and operator state do not belong in the public
repository.

## Service configuration

Start the server with:

```dotenv
MCP_MODE=portal
MCP_PORTAL_GRANT_TOKEN=<unique-portal-to-service-grant>
FIRECRAWL_PROVIDER_EXECUTION_ENABLED=false
MCP_BUILD_SHA=<full-release-git-sha>
MCP_SOURCE_FINGERPRINT=<release-source-sha256>
MCP_IMAGE_REFERENCE=<registry>/<owner>/firecrawl-mcp-server@sha256:<image-digest>
MCP_CATALOG_VERSION=<approved-catalog-version>
```

Generate a unique grant for this service. Do not reuse a Firecrawl key, user
credential, or grant from another MCP. Portal provider activation requires
immutable release provenance.

## Broker headers

| Header | Required | Purpose |
|---|---|---|
| `X-MADPANDA-PORTAL-GRANT` | Every `/mcp` request | Service-only access grant |
| `x-madpanda-user-id` | Provider tools | Stable Portal-scoped accounting identity |
| `x-firecrawl-api-key` | Provider tools | Owner-scoped Firecrawl credential |
| `x-firecrawl-max-operation-credits` | Optional | Lowers the server's per-operation ceiling |
| `x-firecrawl-daily-credit-limit` | Optional | Lowers the server's daily ceiling |

The service grant and provider key are independent credentials. The broker
must not expose either value in public configuration, tool output, logs, or
errors. Public configuration may report only presence booleans such as
`hasFirecrawlApiKey`.

## Registry example

Use deployment-specific values rather than copying a production topology into
this repository:

```text
service slug: firecrawl
display name: Firecrawl
locked MCP URL: https://<mcp-host.example>/mcp
health URL: https://<mcp-host.example>/health
tool count: 9
container URL: http://<container-name>:8080/mcp
```

Recommended owner-facing fields are:

- `mcpUrl`: locked service URL
- `firecrawlApiKey`: encrypted owner-scoped provider key
- `maxOperationCredits`: integer, default 25, may lower only
- `dailyCreditLimit`: integer, default 50, may lower only

## Admission checklist

Before enabling provider execution:

- The locked URL terminates TLS and reaches the expected `/mcp` route.
- Exactly one runtime process or replica owns the persistent file ledger.
- Missing or incorrect Portal grant fails before request parsing.
- Per-user provider secrets are encrypted at rest and forwarded only for an
  authorized request.
- `/health`, broker `tools/list`, and registry metadata all report nine tools.
- A navigation call succeeds through the broker without a provider key.
- Provider calls remain disabled until an approved test account, budgets, and
  immutable release identity are in place.
- A safe read-only provider call is verified before any paid tool.

Private ticket history, agent assignments, deployment paths, proxy topology,
smoke evidence, and production credentials must remain in the operator's
private control plane.
