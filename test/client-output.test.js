import assert from 'node:assert/strict';
import test from 'node:test';

import { FirecrawlClient } from '../src/client.js';
import { normalizeSearchResult, redactUntrustedText, sanitizeResultUrl } from '../src/output.js';
import { jsonResponse, KEY, makeConfig } from './helpers.js';

test('client rejects every method/path outside the five fixed routes before fetch', async () => {
  let calls = 0;
  const client = new FirecrawlClient({ config: makeConfig(), fetchFn: async () => { calls += 1; return jsonResponse({}); } });
  const blocked = [
    ['GET', '/v2/team/activity'],
    ['POST', '/v2/crawl'],
    ['DELETE', '/v2/scrape'],
    ['POST', '/v2/scrape/../../team/credit-usage'],
    ['GET', 'https://evil.example/v2/team/credit-usage'],
  ];
  for (const [method, path] of blocked) {
    await assert.rejects(() => client.request({ method, path, apiKey: KEY }), /allowlisted|fixed/iu);
  }
  assert.equal(calls, 0);
});

test('client performs exactly one attempt, disables redirects, bounds response, and does not expose auth', async () => {
  const seen = [];
  const client = new FirecrawlClient({
    config: makeConfig({ providerResponseMaxBytes: 64 }),
    fetchFn: async (url, options) => {
      seen.push({ url, options });
      return new Response(JSON.stringify({ data: 'x'.repeat(100) }), { status: 200 });
    },
  });
  await assert.rejects(
    () => client.request({ method: 'GET', path: '/v2/team/credit-usage', apiKey: KEY }),
    /more data/iu,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.redirect, 'error');
});

test('provider request IDs are omitted entirely because no safe format is pinned', async () => {
  for (const requestId of [
    'Bearer-' + KEY,
    'AKIA' + 'A'.repeat(16),
    'sk_live_' + 'a'.repeat(24),
    'AIza' + 'A'.repeat(35),
  ]) {
    const client = new FirecrawlClient({
      config: makeConfig(),
      fetchFn: async () => jsonResponse({
        success: true,
        data: { remainingCredits: 1, planCredits: 2 },
      }, { headers: { 'x-request-id': requestId } }),
    });
    const result = await client.request({ method: 'GET', path: '/v2/team/credit-usage', apiKey: KEY });
    assert.equal(Object.hasOwn(result.meta, 'provider_request_id'), false);
    assert.ok(!JSON.stringify(result).includes(requestId));
  }
});

test('client requires success=true and the exact fixed-endpoint response shape', async () => {
  const valid = new Map([
    ['/v2/team/credit-usage', { success: true, data: { remainingCredits: 1, planCredits: 2 } }],
    ['/v2/team/queue-status', { success: true, jobsInQueue: 0, activeJobsInQueue: 0, waitingJobsInQueue: 0, maxConcurrency: 1 }],
    ['/v2/scrape', { success: true, data: { markdown: 'ok' } }],
    ['/v2/search', { success: true, creditsUsed: 2, data: { web: [] } }],
    ['/v2/map', { success: true, links: [] }],
  ]);
  for (const [path, payload] of valid) {
    const client = new FirecrawlClient({ config: makeConfig(), fetchFn: async () => jsonResponse(payload) });
    const result = await client.request({
      method: path.startsWith('/v2/team/') ? 'GET' : 'POST',
      path,
      apiKey: KEY,
      paid: !path.startsWith('/v2/team/'),
    });
    assert.equal(result.payload.success, true, path);
  }

  const invalid = [
    ['/v2/team/credit-usage', {}, 'provider_invalid_response'],
    ['/v2/team/credit-usage', [], 'provider_invalid_response'],
    ['/v2/team/credit-usage', { success: true, data: {} }, 'provider_invalid_response'],
    ['/v2/team/queue-status', { success: true, jobsInQueue: -1 }, 'provider_invalid_response'],
    ['/v2/scrape', { success: true, data: {} }, 'provider_credit_usage_unknown'],
    ['/v2/search', { success: true, creditsUsed: 2, data: {} }, 'provider_invalid_response'],
    ['/v2/map', { success: true, links: 'not-an-array' }, 'provider_credit_usage_unknown'],
  ];
  for (const [path, payload, code] of invalid) {
    const client = new FirecrawlClient({ config: makeConfig(), fetchFn: async () => jsonResponse(payload) });
    await assert.rejects(
      () => client.request({
        method: path.startsWith('/v2/team/') ? 'GET' : 'POST',
        path,
        apiKey: KEY,
        paid: !path.startsWith('/v2/team/'),
      }),
      (error) => error.code === code && error.retryable === false,
      path,
    );
  }
});

test('provider-reported failure and empty paid 2xx bodies are sanitized and non-retryable', async () => {
  const providerSecret = 'sk_live_' + 's'.repeat(24);
  const failed = new FirecrawlClient({
    config: makeConfig(),
    fetchFn: async () => jsonResponse({ success: false, error: providerSecret }),
  });
  await assert.rejects(
    () => failed.request({ method: 'POST', path: '/v2/map', apiKey: KEY, paid: true }),
    (error) => error.code === 'provider_reported_failure'
      && error.retryable === false
      && !JSON.stringify(error).includes(providerSecret),
  );

  const empty = new FirecrawlClient({
    config: makeConfig(),
    fetchFn: async () => new Response(null, { status: 204 }),
  });
  await assert.rejects(
    () => empty.request({ method: 'POST', path: '/v2/search', apiKey: KEY, paid: true }),
    (error) => error.code === 'provider_credit_usage_unknown'
      && error.retryable === false
      && error.outcomeUnknown === true,
  );
});

test('untrusted text and result URLs redact defined secret and PII patterns', () => {
  const text = redactUntrustedText([
    'a@example.com 123-45-6789 api_key=abcd1234 Bearer abcdefghijklmnop fc-abcdefghijkl',
    'AKIA' + 'A'.repeat(16),
    'AIza' + 'B'.repeat(30),
    'sk_live_' + 'c'.repeat(24),
    'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----', // gitleaks:allow synthetic redaction fixture
  ].join(' '));
  for (const forbidden of [
    'a@example.com', '123-45-6789', 'abcd1234', 'abcdefghijklm', 'fc-abcdefghijkl',
    'AKIAAAAA', 'AIzaBBBB', 'sk_live_', 'eyJaaaaaaaa', 'PRIVATE KEY-----',
  ]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  const url = sanitizeResultUrl('https://user:pass@example.com/path?token=secret&email=a%40example.com&phone=555&ok=1#frag');
  assert.equal(url, 'https://example.com/path');
  assert.equal(sanitizeResultUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeResultUrl('data:text/plain,secret'), null);
});

test('result URLs drop queries, unsafe hosts, credential paths, and overlong percent-encoded paths', () => {
  for (const value of [
    'http://127.0.0.1/path',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://localhost/path',
    'http://service.internal/path',
  ]) assert.equal(sanitizeResultUrl(value), null, value);

  assert.equal(sanitizeResultUrl('https://example.com/path?q=AKIA' + 'A'.repeat(16)), 'https://example.com/path');
  for (const segment of [
    'sk_live_' + 'a'.repeat(24),
    'fc-' + 'a'.repeat(24),
    'Bearer%20' + 'a'.repeat(24),
    'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    'sk_live_%2561%2561%2561%2561%2561%2561%2561%2561',
  ]) {
    const sanitized = sanitizeResultUrl('https://example.com/' + segment);
    assert.ok(sanitized.includes('[redacted]'), segment);
    assert.ok(!sanitized.includes('sk_live_') && !sanitized.includes('Bearer'), segment);
  }
  assert.equal(sanitizeResultUrl('https://example.com/' + '%F0%9F%98%80'.repeat(400), 640), null);
});

test('redaction preserves Markdown newlines and tabs while removing disallowed controls', () => {
  assert.equal(redactUntrustedText('one\r\ntwo\tthree\u0000four\u001ffive'), 'one\ntwo\tthree four five');
});

test('search output is metadata-only, result-count bounded, and character-budget bounded', () => {
  const payload = {
    creditsUsed: 2,
    data: {
      web: Array.from({ length: 20 }, (_, index) => ({
        title: 't'.repeat(500),
        description: 'd'.repeat(2000),
        url: 'https://example.com/' + index,
        markdown: 'raw markdown',
        html: '<html>',
        screenshot: 'data:image/png;base64,secret',
      })),
      images: [{ imageUrl: 'secret' }],
      news: [{ title: 'secret' }],
    },
  };
  const output = normalizeSearchResult(payload, 10, 1000);
  assert.equal(output.results.length, 10);
  const textLength = output.results.reduce((sum, row) => sum + (row.title?.length || 0) + (row.description?.length || 0), 0);
  assert.ok(textLength <= 1000);
  const serialized = JSON.stringify(output);
  for (const forbidden of ['raw markdown', '<html>', 'data:image', 'imageUrl', 'news']) assert.ok(!serialized.includes(forbidden));
});
