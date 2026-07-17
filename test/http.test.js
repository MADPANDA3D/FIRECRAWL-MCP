import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

import { createHttpHandler } from '../src/http.js';
import { ACCESS_TOKEN, GRANT, KEY, makeHarness, USER, jsonResponse } from './helpers.js';

const start = async (overrides = {}, options = {}) => {
  const harness = await makeHarness({
    ...options,
    config: { providerExecutionEnabled: false, ...overrides, ...(options.config || {}) },
  });
  const server = createServer(createHttpHandler({ config: harness.config, service: harness.service }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    ...harness,
    server,
    base: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const rpc = async (base, payload, headers = {}) => fetch(base + '/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-madpanda-portal-grant': GRANT,
    ...headers,
  },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

const rawRpc = async (base, body, headers = {}) => {
  const parsed = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: parsed.hostname,
      port: parsed.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-madpanda-portal-grant': GRANT,
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(body);
  });
};

test('health is secret-free and reports exact live tool count and release identity', async (t) => {
  const app = await start();
  t.after(app.close);
  const response = await fetch(app.base + '/health');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, 'healthy');
  assert.equal(health.tool_count, 9);
  assert.equal(health.provider_execution_enabled, false);
  assert.equal(health.immutable_provenance_configured, true);
  const serialized = JSON.stringify(health);
  assert.ok(!serialized.includes(GRANT));
  assert.ok(!serialized.includes('api-key'));
});

test('canonical MCP route, method, and exact JSON media type are enforced', async (t) => {
  const app = await start();
  t.after(app.close);
  assert.equal((await fetch(app.base + '/not-mcp')).status, 404);
  assert.equal((await fetch(app.base + '/mcp?anything=1')).status, 404);
  assert.equal((await fetch(app.base + '/health?anything=1')).status, 404);
  assert.equal((await fetch(app.base + '/mcp')).status, 405);
  const jsonp = await fetch(app.base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/jsonp',
      'x-madpanda-portal-grant': GRANT,
    },
    body: '{}',
  });
  assert.equal(jsonp.status, 415);
  const charset = await fetch(app.base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-madpanda-portal-grant': GRANT,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(charset.status, 200);

  const parsed = new URL(app.base);
  const absoluteStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: parsed.hostname,
      port: parsed.port,
      method: 'GET',
      path: 'http://attacker.example/mcp',
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(absoluteStatus, 404);
});

test('all browser Origin requests fail closed before route, auth, or body parsing', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const path of ['/health', '/mcp', '/not-mcp']) {
    const response = await fetch(app.base + path, {
      method: path === '/mcp' ? 'POST' : 'GET',
      headers: { origin: 'https://browser.example' },
      ...(path === '/mcp' ? { body: '{invalid' } : {}),
    });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error, 'origin_forbidden');
  }
  const emptyOrigin = await fetch(app.base + '/health', { headers: { origin: '' } });
  assert.equal(emptyOrigin.status, 403);
});

test('MCP protocol header accepts only implemented Streamable HTTP versions', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const version of ['2024-11-05', '2099-01-01', '']) {
    const response = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'ping' }, {
      'mcp-protocol-version': version,
    });
    assert.equal(response.status, 400, version);
    assert.equal((await response.json()).error, 'unsupported_protocol_version');
  }
  const accepted = await rpc(app.base, { jsonrpc: '2.0', id: 2, method: 'ping' }, {
    'mcp-protocol-version': '2025-03-26',
  });
  assert.equal(accepted.status, 200);
  const absentCompatibility = await rpc(app.base, { jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal(absentCompatibility.status, 200);
});

test('missing or incorrect grant fails before content type and body parsing', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const grant of [undefined, 'wrong-grant-' + 'x'.repeat(40)]) {
    const headers = { 'content-type': 'text/plain' };
    if (grant) headers['x-madpanda-portal-grant'] = grant;
    const response = await fetch(app.base + '/mcp', {
      method: 'POST',
      headers,
      body: '{ definitely invalid json ' + 'x'.repeat(200000),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: 'unauthorized',
      message: 'A valid MAD MCP Portal grant is required.',
    });
  }
});

test('standalone mode requires exact Bearer auth and ignores Portal credentials', async (t) => {
  const app = await start({
    mode: 'standalone',
    portalGrantToken: null,
    accessToken: ACCESS_TOKEN,
  });
  t.after(app.close);
  const healthResponse = await fetch(app.base + '/health');
  const health = await healthResponse.json();
  assert.equal(health.access_mode, 'standalone');
  assert.equal(health.access_control_configured, true);
  assert.ok(!JSON.stringify(health).includes(ACCESS_TOKEN));
  for (const authorization of [
    undefined,
    'bearer ' + ACCESS_TOKEN,
    'Bearer short',
    'Bearer ' + ACCESS_TOKEN + 'x',
    'Bearer ' + ACCESS_TOKEN + ' trailing',
  ]) {
    const headers = {
      'content-type': 'text/plain',
      'x-madpanda-portal-grant': GRANT,
    };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(app.base + '/mcp', {
      method: 'POST',
      headers,
      body: '{invalid-json-' + 'x'.repeat(20000),
    });
    assert.equal(response.status, 401, String(authorization));
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="firecrawl-mcp"');
    const body = await response.text();
    assert.ok(!body.includes(ACCESS_TOKEN));
  }
  const accepted = await fetch(app.base + '/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + ACCESS_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(accepted.status, 200);
});

test('standalone mode derives a stable identity and never reflects access credentials', async (t) => {
  const app = await start({
    mode: 'standalone',
    portalGrantToken: null,
    accessToken: ACCESS_TOKEN,
    providerExecutionEnabled: true,
  }, {
    fetchFn: async () => jsonResponse({ success: true, creditsUsed: 2, data: { web: [] } }),
  });
  t.after(app.close);
  const call = async (id, args, spoofedUserId) => {
    const response = await fetch(app.base + '/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + ACCESS_TOKEN,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'x-firecrawl-api-key': KEY,
        'x-madpanda-user-id': spoofedUserId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'firecrawl_search_public_web', arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const preview = await call(1, { query: 'safe public query' }, 'spoof-one');
  const token = preview.result.structuredContent.data.previewToken;
  const executed = await call(2, {
    query: 'safe public query',
    previewToken: token,
    confirm: true,
  }, 'spoof-two');
  assert.equal(executed.result.structuredContent.ok, true);
  const serialized = JSON.stringify([preview, executed]);
  assert.ok(!serialized.includes(ACCESS_TOKEN));
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes('spoof-one'));
  assert.ok(!serialized.includes('spoof-two'));
});

test('authorized parse, shape, and size failures are bounded', async (t) => {
  const app = await start({ requestBodyMaxBytes: 16384 });
  t.after(app.close);
  assert.equal((await rpc(app.base, '{bad')).status, 400);
  assert.equal((await rpc(app.base, { nope: true })).status, 400);
  const oversized = await rpc(app.base, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    padding: 'x'.repeat(20000),
  }));
  assert.equal(oversized.status, 413);
});

test('initialize, ping, tools/list, notification, and unknown method follow MCP JSON-RPC contract', async (t) => {
  const app = await start();
  t.after(app.close);
  const initialize = await rpc(app.base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  });
  const initialized = await initialize.json();
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'MADPANDA Firecrawl MCP');

  const ping = await rpc(app.base, { jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual((await ping.json()).result, {});

  const listedResponse = await rpc(app.base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, {
    'mcp-protocol-version': '2025-06-18',
  });
  const listed = await listedResponse.json();
  assert.equal(listed.result.tools.length, 9);
  assert.ok(listed.result.tools.every(({ outputSchema }) => outputSchema.type === 'object'));

  const notification = await rpc(app.base, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');

  const unknown = await rpc(app.base, { jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal((await unknown.json()).error.code, -32601);
});

test('initialize requires supported protocol, capabilities, and complete clientInfo', async (t) => {
  const app = await start();
  t.after(app.close);
  const invalidParams = [
    {},
    { protocolVersion: '2025-06-18' },
    { protocolVersion: '2025-06-18', capabilities: {} },
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'client' } },
  ];
  for (const params of invalidParams) {
    const response = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32602);
  }
  const negotiated = await rpc(app.base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'client', version: '1' },
    },
  }, { 'mcp-protocol-version': '2025-03-26' });
  assert.equal(negotiated.status, 200);
  assert.equal((await negotiated.json()).result.protocolVersion, '2025-06-18');
});

test('no-id JSON-RPC messages never execute methods or receive response bodies', async (t) => {
  const app = await start();
  t.after(app.close);
  let executions = 0;
  const originalExecute = app.service.execute.bind(app.service);
  app.service.execute = (...args) => {
    executions += 1;
    return originalExecute(...args);
  };
  for (const method of ['tools/call', 'ping', 'initialize', 'notifications/initialized', 'unknown/notification']) {
    const response = await rpc(app.base, {
      jsonrpc: '2.0',
      method,
      params: method === 'tools/call' ? { name: 'check_configuration', arguments: {} } : {},
    });
    assert.equal(response.status, 202, method);
    assert.equal(await response.text(), '', method);
  }
  assert.equal(executions, 0);
});

test('only valid request-shaped notifications receive 202', async (t) => {
  const app = await start();
  t.after(app.close);
  let executions = 0;
  app.service.execute = async () => {
    executions += 1;
    throw new Error('invalid notification must not dispatch');
  };
  const invalid = [
    { jsonrpc: '1.0', method: 'ping' },
    { jsonrpc: '2.0' },
    { jsonrpc: '2.0', method: 7 },
    { jsonrpc: '2.0', result: {} },
    { jsonrpc: '2.0', method: 'ping', result: {} },
  ];
  for (const payload of invalid) {
    const response = await rpc(app.base, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    const body = await response.json();
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32600);
  }
  const valid = await rpc(app.base, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.equal(valid.status, 202);
  assert.equal(await valid.text(), '');
  assert.equal(executions, 0);
});

test('invalid UTF-8 request bytes fail as a JSON-RPC parse error', async (t) => {
  const app = await start();
  t.after(app.close);
  const body = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":1,"method":"', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('"}', 'utf8'),
  ]);
  const response = await rawRpc(app.base, body);
  assert.equal(response.status, 400);
  assert.ok(!response.body.toString('hex').includes('efbfbd'));
  const parsed = JSON.parse(response.body.toString('utf8'));
  assert.equal(parsed.id, null);
  assert.equal(parsed.error.code, -32700);
});

test('tool discovery and calls use protocol-specific 2025-03 and 2025-06 result forms', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const version of [undefined, '2025-03-26']) {
    const headers = version ? { 'mcp-protocol-version': version } : {};
    const listed = await rpc(app.base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers);
    const listBody = await listed.json();
    assert.equal(listBody.result.tools.length, 9);
    assert.ok(listBody.result.tools.every((tool) => !Object.hasOwn(tool, 'outputSchema')));

    const called = await rpc(app.base, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'check_configuration', arguments: {} },
    }, headers);
    const bytes = Buffer.from(await called.arrayBuffer());
    assert.ok(bytes.byteLength <= 49152);
    const callBody = JSON.parse(bytes.toString('utf8'));
    assert.equal(Object.hasOwn(callBody.result, 'structuredContent'), false);
    const envelope = JSON.parse(callBody.result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.provider_execution_enabled, false);
  }

  const headers = { 'mcp-protocol-version': '2025-06-18' };
  const listed = await rpc(app.base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, headers);
  const listBody = await listed.json();
  assert.ok(listBody.result.tools.every((tool) => tool.outputSchema?.type === 'object'));
  const called = await rpc(app.base, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'check_configuration', arguments: {} },
  }, headers);
  const callBody = await called.json();
  assert.equal(callBody.result.structuredContent.ok, true);
  assert.match(callBody.result.content[0].text, /structuredContent/u);
});

test('tool calls return structured and text envelopes while provider default stays closed', async (t) => {
  const app = await start();
  t.after(app.close);
  const configurationResponse = await rpc(app.base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'check_configuration', arguments: {} },
  }, { 'mcp-protocol-version': '2025-06-18' });
  const configuration = await configurationResponse.json();
  assert.equal(configuration.result.isError, false);
  assert.equal(configuration.result.structuredContent.data.provider_execution_enabled, false);
  assert.match(configuration.result.content[0].text, /structuredContent/u);

  const providerResponse = await rpc(app.base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'firecrawl_get_credit_usage', arguments: {} },
  }, { 'mcp-protocol-version': '2025-06-18' });
  const provider = await providerResponse.json();
  assert.equal(provider.result.isError, true);
  assert.equal(provider.result.structuredContent.error.code, 'provider_execution_disabled');
});

test('JSON-RPC IDs, methods, and tool names are bounded before dispatch or reflection', async (t) => {
  const app = await start();
  t.after(app.close);
  const huge = 'x'.repeat(100000);
  for (const payload of [
    { jsonrpc: '2.0', id: huge, method: 'm'.repeat(101) },
    { jsonrpc: '2.0', id: { nested: huge }, method: 'm'.repeat(101) },
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { jsonrpc: '2.0', id: true, method: 'ping' },
    { jsonrpc: '2.0', id: [], method: 'ping' },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER + 1, method: 'ping' },
    { jsonrpc: '2.0', id: 'line\nbreak', method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: huge, arguments: {} } },
  ]) {
    const response = await rpc(app.base, payload);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body, 'utf8') <= 49152);
    assert.ok(!body.includes(huge));
    const parsed = JSON.parse(body);
    if (!['string', 'number'].includes(typeof payload.id) || payload.id === huge || !Number.isSafeInteger(payload.id)) {
      assert.equal(parsed.id, null);
    }
  }

  const maximumId = 'i'.repeat(128);
  const accepted = await rpc(app.base, { jsonrpc: '2.0', id: maximumId, method: 'ping' });
  assert.equal((await accepted.json()).id, maximumId);

  const notification = await rpc(app.base, { jsonrpc: '2.0', method: huge });
  assert.equal(notification.status, 400);
  assert.equal((await notification.json()).error.code, -32600);
});

test('complete MCP wire responses remain below 48 KiB for descriptors and worst-case provider strings', async (t) => {
  const hostile = '\u0000\n"\\😀漢'.repeat(600);
  const hostileLong = '\u0000\n"\\😀漢'.repeat(8000);
  const longUrl = 'https://example.com/' + '%F0%9F%98%80'.repeat(400);
  const app = await start({ providerExecutionEnabled: true }, {
    fetchFn: async (url) => {
      if (url.endsWith('/credit-usage')) {
        return jsonResponse({
          success: true,
          data: {
            remainingCredits: 50,
            planCredits: 100,
            billingPeriodStart: hostile,
            billingPeriodEnd: hostile,
          },
        });
      }
      if (url.endsWith('/scrape')) {
        return jsonResponse({
          success: true,
          creditsUsed: 5,
          data: {
            markdown: hostileLong,
            metadata: {
              title: hostile,
              description: hostile,
              sourceURL: longUrl,
              url: longUrl,
              contentType: hostile,
              statusCode: 200,
            },
          },
        });
      }
      if (url.endsWith('/search')) {
        return jsonResponse({
          success: true,
          creditsUsed: 2,
          warning: hostile,
          data: {
            web: Array.from({ length: 10 }, () => ({ title: hostile, description: hostile, url: longUrl })),
          },
        });
      }
      if (url.endsWith('/map')) {
        return jsonResponse({
          success: true,
          creditsUsed: 1,
          links: Array.from({ length: 25 }, () => ({ title: hostile, description: hostile, url: longUrl })),
        });
      }
      throw new Error('unexpected fixed route');
    },
  });
  t.after(app.close);
  const providerHeaders = {
    'x-madpanda-user-id': USER,
    'x-firecrawl-api-key': KEY,
  };
  const envelopeFor = (payload) => (
    payload.result.structuredContent || JSON.parse(payload.result.content[0].text)
  );
  const call = async (name, args, protocolVersion, id = 'i'.repeat(128)) => {
    const response = await rpc(app.base, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }, { ...providerHeaders, 'mcp-protocol-version': protocolVersion });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.byteLength <= 49152, name + ' returned ' + bytes.byteLength + ' bytes');
    return JSON.parse(bytes.toString('utf8'));
  };
  const paid = async (name, args, protocolVersion) => {
    const previewResponse = await call(name, args, protocolVersion);
    const previewEnvelope = envelopeFor(previewResponse);
    assert.equal(previewEnvelope.ok, true, name + ' preview');
    const previewToken = previewEnvelope.data.previewToken;
    const executed = await call(name, { ...args, previewToken, confirm: true }, protocolVersion);
    const executedEnvelope = envelopeFor(executed);
    assert.equal(executedEnvelope.ok, true, name + ' execution');
    assert.notEqual(executedEnvelope.error?.code, 'tool_output_too_large');
    return executed;
  };

  for (const protocolVersion of ['2025-03-26', '2025-06-18']) {
    const capabilities = await call('list_capabilities', { includeDescriptors: true }, protocolVersion);
    assert.equal(envelopeFor(capabilities).data.tool_manifest.tools.length, 9);
    const read = await call('firecrawl_get_credit_usage', {}, protocolVersion);
    assert.equal(envelopeFor(read).ok, true);
    await paid('firecrawl_scrape_public_page', {
      url: 'https://example.com',
      maxPdfPages: 5,
      maxCharacters: 32000,
    }, protocolVersion);
    await paid('firecrawl_search_public_web', {
      query: 'wire-size regression ' + protocolVersion,
      limit: 10,
      maxCharacters: 32000,
    }, protocolVersion);
    await paid('firecrawl_map_public_site', {
      url: 'https://example.com/' + protocolVersion,
      limit: 25,
      maxCharacters: 32000,
    }, protocolVersion);
  }
});
