# Tool catalog

The server exposes exactly nine tools. There are no aliases.

Every call requires the service credential for the active startup mode.
Provider tools additionally require `x-firecrawl-api-key`; Portal mode also
requires `x-madpanda-user-id`.

## Navigation

Navigation tools are local, read-only, non-destructive, closed-world, and
idempotent. They never contact Firecrawl.

- `check_configuration` reports safe setup, mode, limit, and release metadata.
  It never returns header or credential values.
- `list_capabilities` lists all nine tools and can include the complete bounded
  ToolManifest when `includeDescriptors=true`.
- `get_endpoint_coverage` filters the complete 50-operation coverage ledger.
- `get_tool_usage` returns one exact descriptor. Fuzzy names and aliases are
  rejected.

## Provider reads

- `firecrawl_get_credit_usage` uses `GET /v2/team/credit-usage` and returns
  only remaining credits, plan credits, and billing-period timestamps.
- `firecrawl_get_queue_status` uses `GET /v2/team/queue-status` and returns
  only queue counts, maximum concurrency, and recent-success timestamp.

Both are read-only, non-destructive, open-world, and idempotent. This service
does not retry them.

## Paid provider tools

All three paid tools are non-read-only, destructive because they spend
credits, open-world, and non-idempotent. Each requires an exact two-step
preview-and-confirm flow. Known provider credit usage is reconciled to the
hash-only ledger. If a paid 2xx response does not contain trustworthy integer
usage, the configured daily allowance is exhausted for that identity/day.

### `firecrawl_scrape_public_page`

Input: public URL, `maxPdfPages` 1–25 (default 5), `maxCharacters` 1,000–32,000
(default 16,000), then optional `previewToken` and `confirm` pair.

Projected cost equals `maxPdfPages`. Fixed provider options are:

- Markdown format and main content only
- basic proxy, no cache, TLS verification enabled
- ads and base64 images removed
- 30-second timeout
- PDF fast mode capped by `maxPdfPages`

### `firecrawl_search_public_web`

Input: nonblank query up to 500 characters, `limit` 1–10, up to 10 normalized
`includeDomains` or `excludeDomains` entries (never both),
`maxCharacters` 1,000–32,000, then optional preview/confirmation pair.

Projected cost is 2. The provider request uses only web sources with a
30-second timeout. Scrape options, images, news, research, headers, cookies,
actions, and arbitrary provider options are absent.

### `firecrawl_map_public_site`

Input: public URL, optional search up to 200 characters, `sitemap` set to
`skip`, `include`, or `only`, `limit` 1–25, `maxCharacters` 1,000–32,000,
then optional preview/confirmation pair.

Projected cost is 1. Fixed provider options disable subdomains, deduplicate
query parameters, permit cached sitemap data, and cap timeout at 30 seconds.
