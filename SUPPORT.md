# Support

## Where to ask

- Use GitHub Issues for reproducible bugs, documentation errors, and feature
  proposals in this repository.
- Use Firecrawl's official support channels for Firecrawl accounts, billing,
  quotas, provider outages, or API behavior outside this adapter.
- Report suspected vulnerabilities privately through
  [`SECURITY.md`](SECURITY.md).

## Include

- repository version or full commit SHA
- `standalone` or `portal` mode
- Node and Docker/Compose versions
- expected and observed behavior
- minimal reproduction using placeholders
- the failing tool or health field
- relevant redacted error code

Before filing, run:

```sh
npm ci --ignore-scripts
npm run check:conformance
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

Never include `.env`, access tokens, Firecrawl keys, authorization headers,
preview tokens, private URLs, user identifiers, raw provider responses, or
unredacted logs. Maintainers cannot recover or rotate third-party Firecrawl
credentials on your behalf.
