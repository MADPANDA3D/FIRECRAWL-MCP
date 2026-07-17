<div align="center">
<h1>🐼 MADPANDA Firecrawl MCP</h1>
<pre>
╔══════════════════════════════════════════════════════════╗
║       M A D P A N D A  //  F I R E C R A W L           ║
║         BOUNDED WEB INTELLIGENCE OVER MCP                ║
╚══════════════════════════════════════════════════════════╝
</pre>
<p>A security-first, bring-your-own-key MCP server for bounded Firecrawl<br>
scraping, search, site mapping, credit visibility, and queue status.</p>
<p>
<a href="https://github.com/MADPANDA3D/FIRECRAWL-MCP/actions/workflows/ci.yml"><img alt="Verify" src="https://github.com/MADPANDA3D/FIRECRAWL-MCP/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-ff2d55.svg"></a>
<img alt="Node.js 22.22+ and 24.17+" src="https://img.shields.io/badge/node-22.22%2B%20%7C%2024.17%2B-339933?logo=nodedotjs&amp;logoColor=white">
<img alt="MCP tools: 9" src="https://img.shields.io/badge/MCP%20tools-9-111827">
<img alt="Production dependencies: 0" src="https://img.shields.io/badge/runtime%20dependencies-0-22c55e">
</p>
</div>

## What this server does

This project exposes nine carefully bounded MCP tools over HTTP:

- Four local navigation tools explain configuration, capabilities, endpoint
  coverage, and exact tool usage.
- Two read-only tools return whitelisted Firecrawl team credit and queue data.
- Three paid tools scrape one public page, search the public web, or map one
  public site through a preview-and-confirm flow.

It intentionally implements five Firecrawl v2 provider operations. All 50
operations in the reviewed v1 baseline are mapped in
[`docs/endpoint-coverage.md`](docs/endpoint-coverage.md): five are implemented
and 45 are explicitly excluded. “Covered” means accounted for, not fully
implemented.

The production runtime uses only Node.js built-ins. No Firecrawl key is stored
by the service, and tests never contact Firecrawl.

## Choose an access mode

`MCP_MODE` is selected at startup. Changing it requires a restart; no MCP tool
can change the mode while the server is running.

| Mode | Use it when | Service access | Firecrawl credential |
|---|---|---|---|
| `standalone` | You are self-hosting this repository | `Authorization: Bearer <MCP_ACCESS_TOKEN>` | `x-firecrawl-api-key` per request |
| `portal` | The service is behind MAD MCP Portal | `X-MADPANDA-PORTAL-GRANT` matching `MCP_PORTAL_GRANT_TOKEN` | Portal forwards `x-firecrawl-api-key` per authorized user request |

There is no unauthenticated “public mode.” Publishing the source does not make
a deployed endpoint open to the internet.

## Five-minute standalone deployment

You need Docker Engine with Compose, Git, Node.js 22.22+ or 24.17+ for the
initializer, and a Firecrawl API key. The default Compose deployment builds the
checked-out source and binds the server only to `127.0.0.1:8080`.

```sh
git clone https://github.com/MADPANDA3D/FIRECRAWL-MCP.git
cd FIRECRAWL-MCP
node scripts/init-runtime-env.mjs
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

The initializer creates an ignored `.env` with mode `0600`, generates a strong
standalone access token without printing it, and leaves real provider keys out
of the file. Open `.env` locally to place the generated `MCP_ACCESS_TOKEN` into
your MCP client's secret store. Do not commit or paste that token into issues,
logs, screenshots, or shared configuration.

This standalone initializer enables provider execution because the endpoint is
already bearer-authenticated. Portal deployments should begin with provider
execution disabled until their broker, user-key storage, budgets, route, and
immutable release identity have been admitted.

Expected health fields include:

```json
{
  "status": "healthy",
  "service": "firecrawl-mcp",
  "tool_count": 9,
  "access_mode": "standalone"
}
```

`/health` reports readiness and release metadata, never credential values.

## Connect an MCP client

Use the remote HTTP endpoint `http://127.0.0.1:8080/mcp`. Client configuration
formats vary, but the logical shape is:

```json
{
  "mcpServers": {
    "firecrawl": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_ACCESS_TOKEN}",
        "x-firecrawl-api-key": "${FIRECRAWL_API_KEY}"
      }
    }
  }
}
```

`${...}` above means “load this value from your client's secret or environment
facility”; it is not guaranteed interpolation syntax for every client. Never
commit the resolved values.

Navigation calls need only the service access header. Provider tools also need
`x-firecrawl-api-key`. In `portal` mode, the broker additionally supplies a
stable `x-madpanda-user-id`. Either mode may lower the server's projected
credit-admission limits with the documented budget headers.

| Header | Standalone | Portal |
|---|---|---|
| `Authorization: Bearer …` | Required for every `/mcp` request | Not used |
| `X-MADPANDA-PORTAL-GRANT` | Not used | Required for every `/mcp` request |
| `x-firecrawl-api-key` | Required for provider tools | Required for provider tools |
| `x-madpanda-user-id` | Not used | Required for provider tools |
| `x-firecrawl-max-operation-credits` | Optional lower limit | Optional lower limit |
| `x-firecrawl-daily-credit-limit` | Optional lower limit | Optional lower limit |

### Paid-call confirmation

The three paid tools always require two calls:

1. Call the tool with its normal arguments. The service validates the request
   locally and returns a one-use preview token without contacting Firecrawl.
2. Repeat the exact arguments within 300 seconds with that `previewToken` and
   `confirm: true`.

Changing the arguments, credentials, deployment identity, local DNS answer
set, or credit limits invalidates the preview. Paid calls receive one outbound
attempt and are never retried automatically.

Credit limits gate the server's projected cost before a call; they cannot cap
third-party billing after Firecrawl accepts it. If Firecrawl reports actual
usage above the projection, the service records the actual charge, returns
`provider_credit_drift`, and blocks later calls as the updated daily accounting
requires. A single provider-pricing drift event can therefore exceed its local
projection.

## Tools

| Tool | Provider route | Behavior |
|---|---|---|
| `check_configuration` | Local | Reports safe setup and limit metadata without values |
| `list_capabilities` | Local | Lists all nine tools and optional descriptors |
| `get_endpoint_coverage` | Local | Searches the 50-operation coverage ledger |
| `get_tool_usage` | Local | Returns one exact tool contract |
| `firecrawl_get_credit_usage` | `GET /v2/team/credit-usage` | Bounded, read-only team credit totals |
| `firecrawl_get_queue_status` | `GET /v2/team/queue-status` | Bounded, read-only queue and concurrency status |
| `firecrawl_scrape_public_page` | `POST /v2/scrape` | Paid, single public page, Markdown/main-content only |
| `firecrawl_search_public_web` | `POST /v2/search` | Paid, web metadata only, at most 10 results |
| `firecrawl_map_public_site` | `POST /v2/map` | Paid, at most 25 public links |

There are no tool aliases. Every descriptor includes bounded input and output
schemas plus `readOnlyHint`, `destructiveHint`, `openWorldHint`, and
`idempotentHint` where true.

## Configuration

Start with [`.env.example`](.env.example). The principal settings are:

| Variable | Required | Purpose |
|---|---|---|
| `MCP_MODE` | Yes | Startup access mode: `standalone` or `portal` |
| `MCP_ACCESS_TOKEN` | Standalone | Service access token; 32–4096 safe characters |
| `MCP_PORTAL_GRANT_TOKEN` | Portal | Portal-to-service grant; separate from provider credentials |
| `MCP_HOST_PORT` | No | Loopback host port for Compose; default 8080 |
| `FIRECRAWL_PROVIDER_EXECUTION_ENABLED` | No | Enables provider tools; navigation remains local when false |
| `FIRECRAWL_MAX_OPERATION_CREDITS` | No | Projected per-call admission ceiling, 1–25 |
| `FIRECRAWL_DAILY_CREDIT_LIMIT` | No | Projected daily admission ceiling, 1–50 |
| `FIRECRAWL_LEDGER_PATH` | No | Hash-only preview/accounting ledger path |
| `FIRECRAWL_REQUEST_TIMEOUT_MS` | No | Provider timeout, capped at 30 seconds |
| `FIRECRAWL_RESPONSE_MAX_BYTES` | No | Provider response ceiling, capped at 1 MiB |
| `MCP_REQUEST_BODY_MAX_BYTES` | No | MCP request body ceiling |
| `MCP_TOOL_OUTPUT_MAX_BYTES` | No | Complete MCP tool-response ceiling, capped at 48 KiB |

The Firecrawl API key deliberately has no supported server environment
variable. Supply `x-firecrawl-api-key` through your MCP client's secret-backed
HTTP headers; the service never persists or returns its value.

## Production deployment

The default loopback binding is appropriate for a local client or a reverse
proxy running on the same host. For remote access:

1. Keep the application behind TLS.
2. Preserve the `Authorization` header at the proxy.
3. Restrict direct access to port 8080; do not expose the container as an
   unauthenticated public service.
4. Store `.env` with mode `0600` and keep the ledger volume persistent.
5. Run exactly one server process or replica for a ledger. Do not share the
   file ledger between replicas or scale this runtime horizontally.
6. Apply reasonable connection and request-rate limits at the proxy.
7. Verify `/health`, authentication failure, `tools/list`, and one local
   navigation tool before enabling provider execution.

Portal deployment and broker headers are documented with placeholders in
[`docs/portal-compat.md`](docs/portal-compat.md). Production operations and
rollback are covered in [`docs/operator-runbook.md`](docs/operator-runbook.md).

### Release containers

Stable tags publish a scanned, provenance-attested `linux/amd64` image to:

```text
ghcr.io/madpanda3d/firecrawl-mcp-server
```

For a release deployment, set `MCP_RUNTIME_IMAGE` in `.env` to the immutable
digest recorded in that GitHub Release, then run:

```sh
docker compose pull
docker compose up -d --no-build
```

Prefer `@sha256:<digest>` over a mutable tag for production and Portal use.

## Security boundary

- The Firecrawl origin is fixed to `https://api.firecrawl.dev:443`.
- Only five exact method/path pairs may reach the provider.
- Public URL tools reject credentials, fragments, IP literals, unsafe ports,
  local/special-use names, private or mixed DNS answers, DNS changes between
  local preview and execution checks, and IPv6 transition/tunnel forms.
- Firecrawl resolves the submitted hostname independently; its provider-side
  SSRF and DNS protections remain part of the deployment trust boundary.
- Provider responses are capped at 1 MiB, whitelisted by tool, redacted, and
  capped again inside a complete 48 KiB MCP response.
- Provider HTML/raw-HTML fields, screenshots, base64 media, audio, video,
  headers, cookies, and unfiltered provider payloads are never returned.
- The ledger stores hashes and accounting state, not API keys, user IDs, URLs,
  arguments, or preview tokens.
- Ledger coordination is process-local. One-use previews and credit accounting
  require exactly one runtime process per ledger.
- Provider-derived content is marked `untrusted_external_content=true` and
  must never be treated as instructions.

The bounded scrape result contains provider-produced Markdown. That text may
include markup and remains untrusted even after credential-pattern redaction.

Redaction is defense in depth, not a guarantee that arbitrary public pages
contain no personal information. See [`docs/security-model.md`](docs/security-model.md)
and [the security policy](SECURITY.md).

## Run from source

Node.js 22.22+ or 24.17+ is supported.

```sh
npm ci --ignore-scripts
mkdir -p data
node scripts/init-runtime-env.mjs
node --env-file=.env src/server.js
```

For a source run, set `FIRECRAWL_LEDGER_PATH=./data/firecrawl-ledger.json` in
`.env`. The application listens on the configured `HOST` and `PORT`; the
default Compose mapping remains loopback-only at `127.0.0.1:8080`.

## Verification

```sh
npm ci --ignore-scripts
npm run check:conformance
npm audit --omit=dev
node scripts/init-runtime-env.mjs
docker compose config --quiet
```

The suite injects DNS and fetch implementations and makes no live Firecrawl
requests.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 unauthorized` | The access header must match the selected startup mode and configured service token |
| `provider_execution_disabled` | Set `FIRECRAWL_PROVIDER_EXECUTION_ENABLED=true`, then restart |
| `setup_required` | Supply `x-firecrawl-api-key`; Portal mode also requires `x-madpanda-user-id` |
| `preview_mismatch` or expired token | Repeat preview with the same arguments, headers, budgets, and current DNS |
| `blocked_public_target` | Use a public HTTP(S) hostname; private, local, literal-IP, or credential-bearing targets are rejected |
| Container unhealthy | Run `docker compose logs --tail=100 firecrawl-mcp` and confirm `/health` reports nine tools |
| Port 8080 is already in use | Set an unused `MCP_HOST_PORT` in `.env`, restart, and use that port in the client URL |
| Remote client cannot connect | Confirm TLS/proxy routing while leaving the application bound to loopback or a private container network |

Do not include access tokens, Firecrawl keys, request headers, or unredacted
provider output in a support report.

## Documentation

- [Tool catalog](docs/tool-catalog.md)
- [Endpoint coverage](docs/endpoint-coverage.md)
- [Security model](docs/security-model.md)
- [Deployment and operations](docs/operator-runbook.md)
- [Optional Portal integration](docs/portal-compat.md)
- [Source and release provenance](docs/provenance.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)

## License and trademark

The code is available under the [MIT License](LICENSE). See [NOTICE](NOTICE)
for clean-room and upstream-reference provenance.

Firecrawl is a trademark of its respective owner. This independent project is
not an official Firecrawl product, distribution, or endorsement.
