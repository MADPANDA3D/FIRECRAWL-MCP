import assert from 'node:assert/strict';

const mode = process.env.MCP_MODE || 'portal';
assert.ok(['portal', 'standalone'].includes(mode));
const credential = mode === 'portal' ? process.env.MCP_PORTAL_GRANT_TOKEN : process.env.MCP_ACCESS_TOKEN;
assert.ok(credential);
const endpoint = 'http://127.0.0.1:8080';
const authHeaders = mode === 'portal'
  ? { 'x-madpanda-portal-grant': credential }
  : { authorization: 'Bearer ' + credential };

const healthResponse = await fetch(endpoint + '/health');
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.status, 'healthy');
assert.equal(health.tool_count, 9);
assert.equal(health.access_mode, mode);

const missingCredential = await fetch(endpoint + '/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
assert.equal(missingCredential.status, 401);

const call = async (id, method, params) => {
  const response = await fetch(endpoint + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...authHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
};

const listed = await call(2, 'tools/list', {});
assert.equal(listed.result.tools.length, 9);
assert.equal(new Set(listed.result.tools.map(({ name }) => name)).size, 9);

const configuration = await call(3, 'tools/call', { name: 'check_configuration', arguments: {} });
assert.equal(configuration.result.structuredContent.ok, true);
assert.equal(configuration.result.structuredContent.data.provider_execution_enabled, health.provider_execution_enabled);

const disabled = await call(4, 'tools/call', {
  name: 'firecrawl_get_credit_usage',
  arguments: {},
});
const expectedGate = health.provider_execution_enabled ? 'setup_required' : 'provider_execution_disabled';
assert.equal(disabled.result.structuredContent.error.code, expectedGate);
assert.equal(disabled.result.structuredContent.error.outcome_unknown, false);

process.stdout.write('Runtime smoke passed: ' + mode + ' auth, nine-tool catalog, navigation, and provider gate.\n');
