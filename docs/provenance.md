# Provenance

## Official Firecrawl MCP reference

- Repository: https://github.com/firecrawl/firecrawl-mcp-server
- Commit: 3eb1115b1f2883ff2fb74e61b5c4acf5a9ac0fb0
- Tree: e8d0b344b8f27920714a995f87a2433e90b1140d
- Package: firecrawl-mcp@3.22.3
- Archive SHA-256:
  9015b8846d36ae6bf1f3bbcfdf83e36c908f20721ab20912cbee64c0b13ccd82
- License: MIT

This reference established provider terminology and current MCP availability.
Its 26-tool surface is not copied into this nine-tool service.

## OpenAPI reference

- Repository: https://github.com/firecrawl/firecrawl-docs
- File: api-reference/v2-openapi.json
- Baseline commit:
  c4621cb28a9961bb6ecd268b1d8c8a838d84deb8
- Baseline snapshot SHA-256:
  bc340bd919cacac333812f42187b1fd419ac5cb983ad2bc8f89affb80cc20ca5
- Current review snapshot SHA-256:
  e6f3805fdfb8a927769e84463cc75ea4316b25d4d48bdb64ac27cb824db7b6ed
- Reviewed operations: 50
- Review date: 2026-07-14

The two hashes are intentionally both recorded as drift evidence.

## Clean-room statement

Implementation uses only Node.js built-ins and MADPANDA-authored source. It does
not vendor or copy Firecrawl's AGPL API core. The service has no production
package dependencies.

## Release identity

Each release records:

- full Git commit
- git-archive source fingerprint
- immutable OCI image digest
- runtime image selector
- ToolManifest descriptor hash

MCP_IMAGE_REFERENCE is injected at deployment after the actual immutable digest
is known. The image does not claim to embed its own final digest in an OCI
label.
