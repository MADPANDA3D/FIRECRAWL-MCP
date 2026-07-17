# Security model

## Trust boundaries

1. The unauthenticated network may reach `/health` only.
2. The selected startup mode gates `/mcp` before request-body parsing:
   - `standalone` requires `Authorization: Bearer <MCP_ACCESS_TOKEN>`.
   - `portal` requires `X-MADPANDA-PORTAL-GRANT` matching
     `MCP_PORTAL_GRANT_TOKEN`.
3. The Firecrawl API key is a separate request-scoped
   `x-firecrawl-api-key` header. It is never accepted from the service
   environment, persisted, returned, or logged.
4. Portal mode additionally accepts a stable `x-madpanda-user-id` for
   per-user accounting. Standalone mode uses one fixed local deployment
   identity and does not require that header, so its daily ceiling is shared
   by all clients of that deployment.
5. The local preview ledger stores hashes and accounting state, never access
   tokens, user IDs, API keys, URLs, arguments, or preview tokens.
6. Firecrawl is the only outbound provider. Public target URLs are sent to
   Firecrawl; this service never fetches them directly.
7. Returned provider material is untrusted external content.

`MCP_MODE` is read at startup and accepts only `standalone` or `portal`.
Changing modes requires a restart. There is no runtime mode-switch tool and no
unauthenticated mode.

MCP 2025-06-18 calls use `structuredContent` plus concise `TextContent`.
Explicit 2025-03-26 calls and requests without a protocol header use a
JSON-envelope `TextContent` response. Complete wire responses are bounded in
either representation.

## Provider-execution gate

`FIRECRAWL_PROVIDER_EXECUTION_ENABLED` defaults to `false` in the application.
Every provider tool checks the gate first. Disabled requests do not read the
provider key, resolve target DNS, issue or consume a preview, mutate the
ledger, or contact Firecrawl. The four local navigation tools remain usable.

Standalone mode permits an explicitly enabled local source deployment. Portal
mode additionally requires immutable release provenance before provider
execution can start.

## Service and provider credentials

The service access credential and Firecrawl API key solve different problems:

- `MCP_ACCESS_TOKEN` or `MCP_PORTAL_GRANT_TOKEN` controls who may call the MCP
  endpoint.
- `x-firecrawl-api-key` authorizes an individual Firecrawl request.

All secrets are compared or normalized without reflecting their values.
Authentication errors are intentionally generic. Browser-origin requests are
rejected, and the fixed provider request never follows redirects.

## Public-target controls

Scrape and map accept only absolute HTTP(S) URLs with DNS hostnames.
Credentials, fragments, IP literals, non-80/443 ports, special-use names,
invalid names, and empty DNS results fail closed. Every A/AAAA answer must be
public. Rejected ranges include loopback, link-local, RFC1918, carrier-grade
NAT, documentation, benchmark, multicast/reserved, IPv6
ULA/link-local/multicast/documentation, IPv4-mapped IPv6, NAT64, Teredo, and
6to4.

Sensitive query keys, credential-looking query values, and
credential-looking decoded path segments fail before DNS or provider
execution. Preview and execution perform independent local DNS preflights. The
canonical sorted local answer set is bound into the one-use token, and any
change fails before provider fetch.

The wrapper cannot pin those local IP answers into Firecrawl's remote request.
Firecrawl independently resolves the submitted hostname, so its provider-side
SSRF and DNS controls remain part of the trust boundary. The local preflight
reduces obvious target risk and detects local drift; it is not a cryptographic
guarantee about the provider's later resolution.

## Credit and confirmation controls

- Projected per-operation admission ceiling: 25 credits.
- Projected per-identity daily admission ceiling: 50 credits.
- Request headers in either mode may lower but never raise those local
  admission ceilings.
- Preview-token lifetime: exactly 300 seconds.
- One paid request may be in flight per API-key fingerprint.
- Consume/reserve state is persisted before provider fetch.
- Paid calls receive one outbound attempt and no automatic retry.
- Ambiguous outcomes are terminal, counted conservatively, and returned with
  `outcome_unknown=true`.
- A paid 2xx response without trustworthy credit usage exhausts the configured
  daily allowance for that identity/day.
- Startup converts crash residue from an active paid request into an
  indeterminate spent outcome.
- Malformed, inconsistent, or oversized ledger state fails startup closed.

These ceilings gate locally projected cost before provider execution; they
cannot impose a hard cap on third-party billing after Firecrawl accepts a
request. If Firecrawl reports actual usage above the projection, the runtime
records the actual charge, returns `provider_credit_drift`, and applies that
charge to subsequent admission decisions. One provider-pricing drift event
can therefore exceed its local projection before later calls are blocked.

These confirmation and accounting guarantees require exactly one runtime
process or replica per ledger. The file ledger serializes writes inside one
process but does not provide a distributed lock or transactional coordination
between processes. Do not share it between replicas or scale this runtime
horizontally. A future multi-replica deployment must replace it with a shared
transactional store that preserves one-use tokens, reservations, and daily
budgets atomically.

## Output controls

Provider responses are streamed into a 1 MiB ceiling. Results then pass
through tool-specific field whitelists and a 48 KiB ceiling for the complete
serialized MCP tool response, including JSON-RPC framing.

Returned Markdown, titles, and descriptions redact defined credential,
authorization, email, SSN, and payment-number patterns. Returned URL queries
are stripped entirely. Unsafe, special, overlong, or non-HTTP(S) URLs become
`null`, and credential-looking path segments are redacted.

Dedicated provider HTML/raw-HTML fields, screenshots, base64 media, audio,
video, headers, cookies, and unfiltered provider payloads are never returned.
The bounded scrape result does contain provider-produced Markdown, which may
include markup. Every provider-derived success is marked
`untrusted_external_content=true` and attributed to the Firecrawl API.

No general-purpose redactor can prove arbitrary public text contains no
personal data. Callers must treat provider-derived material as untrusted and
must not use it as instructions.

## Reporting a vulnerability

Do not publish a suspected vulnerability, credential, exploit, or sensitive
response in a GitHub issue. Follow the private process in
[`SECURITY.md`](../SECURITY.md).
