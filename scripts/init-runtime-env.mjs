import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';

const path = new URL('../.env', import.meta.url);
if (existsSync(path)) {
  process.stdout.write('Runtime environment already exists; no values changed.\n');
  process.exit(0);
}
const content = [
  'MCP_MODE=standalone',
  'MCP_ACCESS_TOKEN=' + randomBytes(48).toString('base64url'),
  'MCP_PORTAL_GRANT_TOKEN=',
  'MCP_RUNTIME_IMAGE=firecrawl-mcp:local-source',
  'MCP_IMAGE_REFERENCE=development',
  'MCP_BUILD_SHA=development',
  'MCP_SOURCE_FINGERPRINT=development',
  'MCP_CATALOG_VERSION=2026-07-17.1',
  'MCP_HOST_PORT=8080',
  'FIRECRAWL_PROVIDER_EXECUTION_ENABLED=true',
  'FIRECRAWL_MAX_OPERATION_CREDITS=25',
  'FIRECRAWL_DAILY_CREDIT_LIMIT=50',
  'FIRECRAWL_MAX_IN_FLIGHT_PAID=1',
  'FIRECRAWL_PREVIEW_TTL_SECONDS=300',
  'FIRECRAWL_LEDGER_PATH=/data/firecrawl-ledger.json',
  'FIRECRAWL_REQUEST_TIMEOUT_MS=30000',
  'FIRECRAWL_RESPONSE_MAX_BYTES=1048576',
  'MCP_REQUEST_BODY_MAX_BYTES=131072',
  'MCP_TOOL_OUTPUT_MAX_BYTES=49152',
  '',
].join('\n');
writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
chmodSync(path, 0o600);
process.stdout.write('Created ignored mode-0600 standalone environment with a new access token; no value was printed.\n');
