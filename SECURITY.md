# Security policy

## Supported versions

Security fixes are made against the latest release and the current `main`
branch. Older releases may not receive backports.

## Report privately

Use **Security → Report a vulnerability** in this GitHub repository. Include:

- affected version or commit
- deployment mode (`standalone` or `portal`)
- a minimal reproduction with synthetic credentials
- expected and observed behavior
- practical impact and any suggested mitigation

If private vulnerability reporting is unavailable, open a minimal issue asking
the maintainers to provide a private contact channel. Do not include the
vulnerability, exploit, credential, target URL, or sensitive response in that
issue.

Particularly important reports include authentication bypass, SSRF or DNS
re-binding bypass, credential exposure, output-bound or redaction bypass,
preview-token replay, credit-accounting errors, and a route outside the fixed
provider allowlist.

## Safe research

- Use your own Firecrawl account and synthetic data.
- Do not test against systems you do not own or have permission to assess.
- Do not perform destructive, high-volume, or paid-provider testing against a
  public deployment.
- Never submit a real access token or Firecrawl key.
- Tests in this repository must use injected DNS/fetch behavior and must not
  contact Firecrawl.

If you discover an exposed credential, revoke or rotate it immediately, then
report the source and affected version privately. Deleting a file or repository
does not revoke a secret.

## Disclosure

Please allow maintainers time to reproduce, fix, test, and release a correction
before public disclosure. We will coordinate disclosure based on severity and
the availability of a verified fix; no fixed response-time SLA is promised.
