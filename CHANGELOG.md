# Changelog

## 1.1.1 — 2026-10-22

- Pinned the container runtime to Node.js 24.22.1 and updated CI to fixed Node.js 22/24 releases.
- Preserved the nine-tool contract, disabled provider execution, and deployment controls.

## 1.1.0 — 2026-07-17

- Added startup-selected `portal` and `standalone` access modes.
- Added authenticated loopback Docker deployment for independent use.
- Preserved request-scoped Firecrawl keys, credit controls, confirmations, SSRF
  defenses, bounded outputs, and the exact nine-tool surface.
- Added public-safe deployment, security, contribution, and support guidance.

## 1.0.0 — 2026-07-14

- Added the exact nine-tool v1 contract and ToolManifest v2.
- Accounted for all 50 reviewed Firecrawl v2 operations.
- Added fixed-origin provider reads plus three bounded paid operations.
- Added provider-disabled default, request-scoped credentials, projected credit
  admission limits, local DNS preflight/drift binding, one-use previews,
  single-process atomic accounting, and no-retry paid execution.
- Added secret/PII redaction, provider-output whitelists, untrusted-content
  attribution, hardened Docker deployment, tests, and release automation.
