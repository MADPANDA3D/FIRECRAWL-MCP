# Contributing

Thanks for improving MADPANDA Firecrawl MCP.

## Before coding

- Search existing issues and open one before a large or behavior-changing
  contribution.
- Keep the nine-tool contract stable unless the change explicitly proposes and
  documents a scope expansion.
- Do not add provider endpoints without updating
  [`docs/endpoint-coverage.md`](docs/endpoint-coverage.md), descriptors,
  annotations, output bounds, and tests.
- Never add real credentials, production domains, host paths, tickets, agent
  memory, operator evidence, or private topology.

## Development

Node.js 22.22+ or 24.17+ is supported.

```sh
npm ci --ignore-scripts
npm run check:conformance
npm audit --omit=dev
```

Tests must inject provider and DNS behavior; they must not contact Firecrawl.
Use synthetic secrets only.

Prefer the smallest change that preserves the existing security boundaries.
Use semantic commits such as:

```text
fix(auth): reject malformed bearer credentials
docs(deploy): clarify standalone proxy setup
test(ledger): cover expired preview rejection
```

## Pull requests

A pull request should state what changed, why it is needed, and the exact
verification run. Confirm that:

- both access modes fail closed as documented
- every tool keeps accurate MCP annotations
- paid tools retain preview, budget, one-attempt, and accounting controls
- output remains whitelisted, redacted, and bounded
- `.env.example`, README, and coverage docs match any configuration or contract
  change
- no secret, private operational file, or generated runtime state is included

Security reports belong in the private process described in
[`SECURITY.md`](SECURITY.md), not in a pull request or public issue.
