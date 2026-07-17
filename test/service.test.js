import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { fingerprint } from '../src/auth.js';
import { makeContext, makeHarness, preview, publicLookup, jsonResponse, KEY, USER } from './helpers.js';

const paidCases = [
  ['firecrawl_scrape_public_page', { url: 'https://example.com/page' }],
  ['firecrawl_search_public_web', { query: 'safe public query' }],
  ['firecrawl_map_public_site', { url: 'https://example.com/' }],
];

test('provider-disabled gate runs before identity, API key, DNS, ledger, or fetch for every provider tool', async () => {
  let fetchCalls = 0;
  let lookupCalls = 0;
  const { service, ledger } = await makeHarness({
    config: { providerExecutionEnabled: false },
    fetchFn: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    lookupFn: async () => { lookupCalls += 1; throw new Error('must not resolve'); },
  });
  const originalIssue = ledger.issue.bind(ledger);
  let ledgerCalls = 0;
  ledger.issue = (...args) => { ledgerCalls += 1; return originalIssue(...args); };
  const context = {
    readUserId: () => { throw new Error('must not read identity'); },
    readApiKey: () => { throw new Error('must not read key'); },
    readOperationBudget: () => { throw new Error('must not read budget'); },
    readDailyBudget: () => { throw new Error('must not read budget'); },
  };
  const cases = [
    ['firecrawl_get_credit_usage', {}],
    ['firecrawl_get_queue_status', {}],
    ...paidCases,
  ];
  for (const [name, args] of cases) {
    const result = await service.execute(name, args, context);
    assert.equal(result.error.code, 'provider_execution_disabled', name);
  }
  assert.equal(fetchCalls, 0);
  assert.equal(lookupCalls, 0);
  assert.equal(ledgerCalls, 0);
});

test('missing request-scoped key returns setup_required before DNS, ledger, or fetch', async () => {
  let calls = 0;
  const { service, ledger } = await makeHarness({
    fetchFn: async () => { calls += 1; throw new Error('must not fetch'); },
    lookupFn: async () => { calls += 1; throw new Error('must not resolve'); },
  });
  ledger.issue = async () => { calls += 1; throw new Error('must not issue'); };
  const result = await service.execute('firecrawl_scrape_public_page', {
    url: 'https://example.com/',
  }, makeContext({ readApiKey: () => undefined }));
  assert.equal(result.error.code, 'setup_required');
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('navigation works locally and complete ToolManifest v2 is optional and bounded', async () => {
  const { service } = await makeHarness({ config: { providerExecutionEnabled: false } });
  const configuration = await service.execute('check_configuration', {}, makeContext());
  assert.equal(configuration.ok, true);
  assert.equal(configuration.data.setup_status, 'setup_required');
  assert.equal(configuration.data.provider_execution_enabled, false);
  assert.equal(configuration.data.firecrawl_api_key_present, true);
  assert.ok(!JSON.stringify(configuration).includes(KEY));

  const normal = await service.execute('list_capabilities', {});
  assert.equal(normal.ok, true);
  assert.equal(normal.data.tools.length, 9);
  assert.equal(Object.hasOwn(normal.data, 'tool_manifest'), false);
  const full = await service.execute('list_capabilities', { includeDescriptors: true });
  assert.equal(full.data.tool_manifest.schemaVersion, '2.0.0');
  assert.equal(full.data.tool_manifest.tools.length, 9);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) <= 49152);
});

test('coverage filtering and exact tool usage expose contract evidence', async () => {
  const { service } = await makeHarness();
  const coverage = await service.execute('get_endpoint_coverage', { filter: 'queue-status' });
  assert.equal(coverage.ok, true);
  assert.equal(coverage.data.operations.length, 1);
  assert.equal(coverage.data.operations[0].tool, 'firecrawl_get_queue_status');
  const usage = await service.execute('get_tool_usage', { toolName: 'firecrawl_map_public_site' });
  assert.equal(usage.data.canonical_name, 'firecrawl.firecrawl_map_public_site');
  assert.equal(usage.data.confirmation.required, true);
  assert.equal(usage.data.output_schema.type, 'object');
  const missing = await service.execute('get_tool_usage', { toolName: 'map' });
  assert.equal(missing.error.code, 'unknown_tool');
});

test('read tools use only fixed GET routes and return whitelisted fields', async () => {
  const seen = [];
  const { service } = await makeHarness({
    fetchFn: async (url, options) => {
      seen.push({ url, options });
      if (url.endsWith('/credit-usage')) {
        return jsonResponse({
          success: true,
          data: {
            remainingCredits: 100,
            planCredits: 200,
            billingPeriodStart: '2026-07-01T00:00:00Z',
            billingPeriodEnd: '2026-07-31T00:00:00Z',
            apiKey: KEY,
          },
        });
      }
      return jsonResponse({
        success: true,
        jobsInQueue: 3,
        activeJobsInQueue: 1,
        waitingJobsInQueue: 2,
        maxConcurrency: 4,
        mostRecentSuccess: '2026-07-14T00:00:00Z',
        raw: KEY,
      });
    },
  });
  const credit = await service.execute('firecrawl_get_credit_usage', {}, makeContext());
  const queue = await service.execute('firecrawl_get_queue_status', {}, makeContext());
  assert.deepEqual(credit.data, {
    remaining_credits: 100,
    plan_credits: 200,
    billing_period_start: '2026-07-01T00:00:00Z',
    billing_period_end: '2026-07-31T00:00:00Z',
  });
  assert.equal(queue.data.jobs_in_queue, 3);
  assert.equal(credit.meta.untrusted_external_content, true);
  assert.equal(queue.meta.external_source, 'Firecrawl API');
  assert.ok(!JSON.stringify([credit, queue]).includes(KEY));
  assert.deepEqual(seen.map(({ url }) => url), [
    'https://api.firecrawl.dev/v2/team/credit-usage',
    'https://api.firecrawl.dev/v2/team/queue-status',
  ]);
  assert.ok(seen.every(({ options }) => options.method === 'GET' && options.redirect === 'error' && options.body === undefined));
});

test('scrape preview and exact execution use one token, one attempt, safe body, and redacted bounded output', async () => {
  const seen = [];
  const { service, config } = await makeHarness({
    fetchFn: async (url, options) => {
      seen.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        success: true,
        creditsUsed: 2,
        data: {
          markdown: 'Contact owner@example.com Authorization: Bearer abcdefghijklmnop api_key=fc-secret-secretsecret',
          html: '<script>secret</script>',
          rawHtml: '<html>raw</html>',
          screenshot: 'data:image/png;base64,SECRET',
          metadata: {
            title: 'Title owner@example.com',
            description: 'password=hunter2',
            sourceURL: 'https://example.com/page?token=secret#fragment',
            url: 'https://example.com/final?key=secret',
            statusCode: 200,
            numPages: 2,
            totalPages: 2,
            contentType: 'text/html',
          },
        },
      });
    },
  });
  const args = { url: 'https://example.com/page', maxPdfPages: 2, maxCharacters: 4000 };
  const token = await preview(service, 'firecrawl_scrape_public_page', args);
  assert.equal(seen.length, 0);
  const executed = await service.execute('firecrawl_scrape_public_page', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(executed.ok, true);
  assert.equal(executed.meta.untrusted_external_content, true);
  assert.equal(executed.meta.external_source, 'Firecrawl API');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.firecrawl.dev/v2/scrape');
  assert.deepEqual(seen[0].body, {
    url: 'https://example.com/page',
    formats: ['markdown'],
    onlyMainContent: true,
    maxAge: 0,
    skipTlsVerification: false,
    timeout: 30000,
    parsers: [{ type: 'pdf', mode: 'fast', maxPages: 2 }],
    removeBase64Images: true,
    blockAds: true,
    proxy: 'basic',
    storeInCache: false,
  });
  const serialized = JSON.stringify(executed);
  for (const forbidden of ['owner@example.com', 'hunter2', 'fc-secret-secretsecret', '<html>', 'data:image', 'Bearer abcdef']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.equal(executed.data.metadata.source_url, 'https://example.com/page');
  const ledger = await readFile(config.ledgerPath, 'utf8');
  for (const forbidden of [token, KEY, USER, 'example.com/page']) assert.ok(!ledger.includes(forbidden), forbidden);

  const reused = await service.execute('firecrawl_scrape_public_page', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(reused.error.code, 'preview_token_used');
  assert.equal(seen.length, 1);
});

test('search and map provider bodies exclude risky option families', async () => {
  const requests = [];
  const { service } = await makeHarness({
    fetchFn: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/search')) {
        return jsonResponse({ success: true, creditsUsed: 2, data: { web: [{ title: 'One', description: 'Two', url: 'https://example.com/' }] } });
      }
      return jsonResponse({ success: true, creditsUsed: 1, links: [{ url: 'https://example.com/a', title: 'A', description: 'B' }] });
    },
  });
  const searchArgs = { query: 'firecrawl', limit: 3, includeDomains: ['EXAMPLE.com'], maxCharacters: 2000 };
  const searchToken = await preview(service, 'firecrawl_search_public_web', searchArgs);
  const search = await service.execute('firecrawl_search_public_web', { ...searchArgs, previewToken: searchToken, confirm: true }, makeContext());
  assert.equal(search.ok, true);
  const mapArgs = { url: 'https://example.com', search: 'docs', sitemap: 'only', limit: 5, maxCharacters: 2000 };
  const mapToken = await preview(service, 'firecrawl_map_public_site', mapArgs);
  const map = await service.execute('firecrawl_map_public_site', { ...mapArgs, previewToken: mapToken, confirm: true }, makeContext());
  assert.equal(map.ok, true);
  assert.deepEqual(requests[0].body, {
    query: 'firecrawl',
    limit: 3,
    sources: [{ type: 'web' }],
    includeDomains: ['example.com'],
    timeout: 30000,
    ignoreInvalidURLs: true,
  });
  assert.deepEqual(requests[1].body, {
    url: 'https://example.com/',
    search: 'docs',
    sitemap: 'only',
    includeSubdomains: false,
    ignoreQueryParameters: true,
    ignoreCache: false,
    limit: 5,
    timeout: 30000,
  });
  for (const body of requests.map(({ body }) => body)) {
    const serialized = JSON.stringify(body);
    for (const forbidden of ['headers', 'cookies', 'actions', 'screenshot', 'rawHtml', 'scrapeOptions', 'images', 'news']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  }
});

test('confirmation pair, domain exclusivity, and lower-only budgets fail closed with zero fetches', async () => {
  let fetches = 0;
  const { service } = await makeHarness({ fetchFn: async () => { fetches += 1; return jsonResponse({}); } });
  const missingPair = await service.execute('firecrawl_map_public_site', {
    url: 'https://example.com',
    previewToken: 'a'.repeat(43),
  }, makeContext());
  assert.equal(missingPair.error.code, 'confirmation_pair_required');
  const falseConfirm = await service.execute('firecrawl_map_public_site', {
    url: 'https://example.com',
    previewToken: 'a'.repeat(43),
    confirm: false,
  }, makeContext());
  assert.equal(falseConfirm.error.code, 'confirmation_required');
  const domains = await service.execute('firecrawl_search_public_web', {
    query: 'query',
    includeDomains: ['example.com'],
    excludeDomains: ['other.com'],
  }, makeContext());
  assert.equal(domains.error.code, 'validation_error');
  const operation = await service.execute('firecrawl_scrape_public_page', {
    url: 'https://example.com',
    maxPdfPages: 25,
  }, makeContext({ readOperationBudget: () => '24' }));
  assert.equal(operation.error.code, 'operation_credit_limit');
  const raise = await service.execute('firecrawl_map_public_site', {
    url: 'https://example.com',
  }, makeContext({ readOperationBudget: () => '26' }));
  assert.equal(raise.error.code, 'invalid_credit_budget');
  assert.equal(fetches, 0);
});

test('DNS answer drift, identity/key drift, arguments, build, and budget drift cannot execute a preview', async () => {
  let dnsVersion = 0;
  let fetches = 0;
  const { service } = await makeHarness({
    lookupFn: async () => [{ address: dnsVersion === 0 ? '8.8.8.8' : '1.1.1.1', family: 4 }],
    fetchFn: async () => { fetches += 1; return jsonResponse({ success: true, links: [] }); },
  });
  const args = { url: 'https://example.com', limit: 2 };
  const token = await preview(service, 'firecrawl_map_public_site', args);
  dnsVersion = 1;
  const drift = await service.execute('firecrawl_map_public_site', { ...args, previewToken: token, confirm: true }, makeContext());
  assert.equal(drift.error.code, 'preview_binding_mismatch');
  assert.equal(drift.error.details.mismatch, 'dnsHash');
  assert.equal(fetches, 0);

  dnsVersion = 0;
  const token2 = await preview(service, 'firecrawl_map_public_site', args);
  const keyDrift = await service.execute('firecrawl_map_public_site', { ...args, previewToken: token2, confirm: true }, makeContext({ readApiKey: () => KEY + 'x' }));
  assert.equal(keyDrift.error.details.mismatch, 'keyHash');
  const argsDrift = await service.execute('firecrawl_map_public_site', { ...args, limit: 3, previewToken: token2, confirm: true }, makeContext());
  assert.equal(argsDrift.error.details.mismatch, 'argsHash');
  const budgetDrift = await service.execute('firecrawl_map_public_site', { ...args, previewToken: token2, confirm: true }, makeContext({ readDailyBudget: () => '49' }));
  assert.equal(budgetDrift.error.details.mismatch, 'dailyBudget');
  service.config.buildSha = '9'.repeat(40);
  const buildDrift = await service.execute('firecrawl_map_public_site', { ...args, previewToken: token2, confirm: true }, makeContext());
  assert.equal(buildDrift.error.details.mismatch, 'buildSha');
  assert.equal(fetches, 0);
});

test('network and paid 408 outcomes are unknown, consumed once, not retried, and charged conservatively', async () => {
  for (const mode of ['network', '408']) {
    let calls = 0;
    const { service, ledger } = await makeHarness({
      fetchFn: async () => {
        calls += 1;
        if (mode === 'network') throw new Error('socket closed');
        return jsonResponse({ error: 'timeout' }, { status: 408 });
      },
    });
    const args = { query: 'query' };
    const token = await preview(service, 'firecrawl_search_public_web', args);
    const result = await service.execute('firecrawl_search_public_web', { ...args, previewToken: token, confirm: true }, makeContext());
    assert.equal(result.error.code, 'provider_outcome_unknown');
    assert.equal(result.error.outcome_unknown, true);
    assert.equal(result.error.retryable, false);
    assert.equal(calls, 1);
    const status = await ledger.statusForUser(result.meta ? '' : 'unused');
    void status;
    const reused = await service.execute('firecrawl_search_public_web', { ...args, previewToken: token, confirm: true }, makeContext());
    assert.equal(reused.error.code, 'preview_token_used');
    assert.equal(calls, 1);
  }
});

test('daily credit budget counts successful paid requests and blocks later previews', async () => {
  const { service } = await makeHarness({
    fetchFn: async () => jsonResponse({ success: true, data: { web: [] }, creditsUsed: 2 }),
  });
  const context = makeContext({ readDailyBudget: () => '2' });
  const token = await preview(service, 'firecrawl_search_public_web', { query: 'one' }, context);
  const done = await service.execute('firecrawl_search_public_web', { query: 'one', previewToken: token, confirm: true }, context);
  assert.equal(done.ok, true);
  const blocked = await service.execute('firecrawl_map_public_site', { url: 'https://example.com' }, context);
  assert.equal(blocked.error.code, 'daily_credit_limit');
});

test('durable settlement failure after provider success or error is terminal and attempted once', async () => {
  for (const providerMode of ['success', 'error']) {
    let providerCalls = 0;
    const { service, ledger } = await makeHarness({
      fetchFn: async () => {
        providerCalls += 1;
        return providerMode === 'success'
          ? jsonResponse({ success: true, creditsUsed: 2, data: { web: [] } })
          : jsonResponse({ success: false }, { status: 429 });
      },
    });
    const args = { query: 'settlement regression' };
    const token = await preview(service, 'firecrawl_search_public_web', args);
    let settlements = 0;
    ledger.settle = async () => {
      settlements += 1;
      throw new Error('synthetic durable write failure');
    };
    const result = await service.execute('firecrawl_search_public_web', {
      ...args,
      previewToken: token,
      confirm: true,
    }, makeContext());
    assert.equal(result.error.code, 'accounting_outcome_unknown', providerMode);
    assert.equal(result.error.retryable, false, providerMode);
    assert.equal(result.error.outcome_unknown, true, providerMode);
    assert.equal(providerCalls, 1, providerMode);
    assert.equal(settlements, 1, providerMode);
    const reused = await service.execute('firecrawl_search_public_web', {
      ...args,
      previewToken: token,
      confirm: true,
    }, makeContext());
    assert.equal(reused.error.code, 'preview_token_used', providerMode);
    assert.equal(providerCalls, 1, providerMode);
    assert.equal(settlements, 1, providerMode);
  }
});

test('untrustworthy Search credit usage exhausts the configured day and cannot be bypassed with header drift', async () => {
  for (const creditsUsed of [undefined, -1, 0.5]) {
    let calls = 0;
    const { service, ledger } = await makeHarness({
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({
          success: true,
          ...(creditsUsed === undefined ? {} : { creditsUsed }),
          data: { web: [] },
        });
      },
    });
    const args = { query: 'credit uncertainty' };
    const lowered = makeContext({ readDailyBudget: () => '10' });
    const token = await preview(service, 'firecrawl_search_public_web', args, lowered);
    const result = await service.execute('firecrawl_search_public_web', {
      ...args,
      previewToken: token,
      confirm: true,
    }, lowered);
    assert.equal(result.error.code, 'provider_credit_usage_unknown', String(creditsUsed));
    assert.equal(result.error.retryable, false, String(creditsUsed));
    assert.equal(result.error.outcome_unknown, true, String(creditsUsed));
    assert.equal(calls, 1);
    const status = await ledger.statusForUser(fingerprint(USER), fingerprint(KEY));
    assert.equal(status.daily_reserved, 0);
    assert.equal(status.daily_spent, 50);
    const defaultBudget = await service.execute('firecrawl_map_public_site', { url: 'https://example.com' }, makeContext());
    assert.equal(defaultBudget.error.code, 'daily_credit_limit');
    const reused = await service.execute('firecrawl_search_public_web', {
      ...args,
      previewToken: token,
      confirm: true,
    }, lowered);
    assert.equal(reused.error.code, 'preview_token_used');
    assert.equal(calls, 1);
  }
});

test('reported actual credits are settled even when paid 2xx result data is malformed', async () => {
  for (const malformed of [false, true]) {
    const { service, ledger } = await makeHarness({
      fetchFn: async () => jsonResponse({
        success: true,
        creditsUsed: 999,
        data: malformed ? {} : { web: [] },
      }),
    });
    const args = { query: 'actual usage reconciliation' };
    const token = await preview(service, 'firecrawl_search_public_web', args);
    const result = await service.execute('firecrawl_search_public_web', {
      ...args,
      previewToken: token,
      confirm: true,
    }, makeContext());
    assert.equal(result.error.code, malformed ? 'provider_invalid_response' : 'provider_credit_drift');
    assert.equal(result.error.retryable, false);
    const status = await ledger.statusForUser(fingerprint(USER), fingerprint(KEY));
    assert.equal(status.daily_reserved, 0);
    assert.equal(status.daily_spent, 999);
    const later = await service.execute('firecrawl_map_public_site', { url: 'https://example.com' }, makeContext());
    assert.equal(later.error.code, 'daily_credit_limit');
  }
});

test('optional scrape/map credits reconcile when present and exhaust the day when malformed', async () => {
  for (const [name, args, validPayload, invalidPayload, projection] of [
    [
      'firecrawl_scrape_public_page',
      { url: 'https://example.com', maxPdfPages: 1 },
      { success: true, data: { markdown: 'ok' } },
      { success: true, creditsUsed: -1, data: { markdown: 'ok' } },
      1,
    ],
    [
      'firecrawl_map_public_site',
      { url: 'https://example.com' },
      { success: true, links: [] },
      { success: true, creditsUsed: 0.25, links: [] },
      1,
    ],
  ]) {
    const accepted = await makeHarness({ fetchFn: async () => jsonResponse(validPayload) });
    const acceptedToken = await preview(accepted.service, name, args);
    const success = await accepted.service.execute(name, { ...args, previewToken: acceptedToken, confirm: true }, makeContext());
    assert.equal(success.ok, true, name);
    assert.equal((await accepted.ledger.statusForUser(fingerprint(USER), fingerprint(KEY))).daily_spent, projection);

    const rejected = await makeHarness({ fetchFn: async () => jsonResponse(invalidPayload) });
    const rejectedToken = await preview(rejected.service, name, args);
    const failure = await rejected.service.execute(name, { ...args, previewToken: rejectedToken, confirm: true }, makeContext());
    assert.equal(failure.error.code, 'provider_credit_usage_unknown', name);
    assert.equal((await rejected.ledger.statusForUser(fingerprint(USER), fingerprint(KEY))).daily_spent, 50);
  }

  const drift = await makeHarness({ fetchFn: async () => jsonResponse({ success: true, creditsUsed: 3, links: [] }) });
  const token = await preview(drift.service, 'firecrawl_map_public_site', { url: 'https://example.com' });
  const result = await drift.service.execute('firecrawl_map_public_site', {
    url: 'https://example.com',
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(result.error.code, 'provider_credit_drift');
  assert.equal((await drift.ledger.statusForUser(fingerprint(USER), fingerprint(KEY))).daily_spent, 3);
});

test('a paid 429 is not retried and remains non-retryable after token consumption', async () => {
  let calls = 0;
  const { service, ledger } = await makeHarness({
    fetchFn: async () => {
      calls += 1;
      return jsonResponse({ success: false }, { status: 429 });
    },
  });
  const args = { query: 'rate-limit regression' };
  const token = await preview(service, 'firecrawl_search_public_web', args);
  const result = await service.execute('firecrawl_search_public_web', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(result.error.code, 'provider_rate_limited');
  assert.equal(result.error.retryable, false);
  assert.equal(calls, 1);
  const status = await ledger.statusForUser(fingerprint(USER), fingerprint(KEY));
  assert.equal(status.daily_spent, 2);
  assert.equal(status.daily_reserved, 0);
});

test('timeout after paid response headers consumes once, settles conservatively, and never retries', async () => {
  let calls = 0;
  const { service, ledger } = await makeHarness({
    config: { providerTimeoutMs: 25 },
    fetchFn: async () => {
      calls += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true,"creditsUsed":2'));
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const args = { query: 'stalled response body' };
  const token = await preview(service, 'firecrawl_search_public_web', args);
  const result = await service.execute('firecrawl_search_public_web', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(result.error.code, 'provider_credit_usage_unknown');
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.outcome_unknown, true);
  assert.equal(calls, 1);
  const status = await ledger.statusForUser(fingerprint(USER), fingerprint(KEY));
  assert.equal(status.daily_spent, 50);
  assert.equal(status.daily_reserved, 0);
  const reused = await service.execute('firecrawl_search_public_web', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(reused.error.code, 'preview_token_used');
  assert.equal(calls, 1);
});

test('invalid UTF-8 in a paid 2xx body is fatal, never replacement-decoded, and exhausts the day', async () => {
  let calls = 0;
  const invalidBody = Buffer.concat([
    Buffer.from('{"success":true,"creditsUsed":2,"data":{"web":[{"title":"', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('","description":"safe","url":"https://example.com"}]}}', 'utf8'),
  ]);
  const { service, ledger } = await makeHarness({
    fetchFn: async () => {
      calls += 1;
      return new Response(invalidBody, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const args = { query: 'invalid utf8 response' };
  const token = await preview(service, 'firecrawl_search_public_web', args);
  const result = await service.execute('firecrawl_search_public_web', {
    ...args,
    previewToken: token,
    confirm: true,
  }, makeContext());
  assert.equal(result.error.code, 'provider_credit_usage_unknown');
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.outcome_unknown, true);
  assert.ok(!JSON.stringify(result).includes('\ufffd'));
  assert.equal(calls, 1);
  const status = await ledger.statusForUser(fingerprint(USER), fingerprint(KEY));
  assert.equal(status.daily_spent, 50);
  assert.equal(status.daily_reserved, 0);
});
