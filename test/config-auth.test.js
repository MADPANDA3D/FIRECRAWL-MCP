import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  fingerprint,
  isAccessTokenValid,
  isPortalGrantValid,
  normalizeFirecrawlApiKey,
  normalizeUserId,
} from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { ACCESS_TOKEN, GRANT } from './helpers.js';

const baseEnv = {
  MCP_PORTAL_GRANT_TOKEN: GRANT,
  MCP_BUILD_SHA: '1'.repeat(40),
  MCP_SOURCE_FINGERPRINT: '2'.repeat(64),
  MCP_IMAGE_REFERENCE: 'ghcr.io/madpanda3d/firecrawl-mcp-server@sha256:' + '3'.repeat(64),
};

test('provider execution defaults false and safety ceilings are fixed', () => {
  const config = readConfig(baseEnv);
  assert.equal(config.mode, 'portal');
  assert.equal(config.providerExecutionEnabled, false);
  assert.equal(config.maxOperationCredits, 25);
  assert.equal(config.dailyCreditLimit, 50);
  assert.equal(config.maxInFlightPaid, 1);
  assert.equal(config.previewTtlSeconds, 300);
});

test('configuration cannot raise ceilings, TTL, concurrency, or response size', () => {
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_MAX_OPERATION_CREDITS: '26' }));
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_DAILY_CREDIT_LIMIT: '51' }));
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_MAX_IN_FLIGHT_PAID: '2' }));
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_PREVIEW_TTL_SECONDS: '301' }));
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_RESPONSE_MAX_BYTES: '1048577' }));
});

test('strict booleans and required grant fail closed', () => {
  assert.throws(() => readConfig({ ...baseEnv, FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'yes' }));
  assert.throws(() => readConfig({ ...baseEnv, MCP_PORTAL_GRANT_TOKEN: 'short' }));
});

test('access modes require only their own inbound secret and reject unknown modes', () => {
  const standalone = readConfig({ MCP_MODE: 'standalone', MCP_ACCESS_TOKEN: ACCESS_TOKEN });
  assert.equal(standalone.mode, 'standalone');
  assert.equal(standalone.host, '127.0.0.1');
  assert.equal(standalone.portalGrantToken, null);
  assert.equal(standalone.accessToken, ACCESS_TOKEN);
  assert.throws(() => readConfig({ MCP_MODE: 'standalone', MCP_ACCESS_TOKEN: 'short' }));
  assert.throws(() => readConfig({ MCP_MODE: 'standalone', MCP_ACCESS_TOKEN: 'x'.repeat(40) + ':invalid' }));
  assert.throws(() => readConfig({ MCP_MODE: 'public', MCP_ACCESS_TOKEN: ACCESS_TOKEN }));
  assert.throws(() => readConfig({ MCP_MODE: 'portal', MCP_ACCESS_TOKEN: ACCESS_TOKEN }));
});

test('release provenance accepts only exact hashes/digests or explicit development sentinels', () => {
  for (const entry of [
    { MCP_BUILD_SHA: 'evil\nleak' },
    { MCP_BUILD_SHA: 'a'.repeat(39) },
    { MCP_SOURCE_FINGERPRINT: 'secret' },
    { MCP_IMAGE_REFERENCE: 'firecrawl-mcp:latest' },
    { MCP_IMAGE_REFERENCE: 'https://evil.example/image' },
    { MCP_CATALOG_VERSION: 'bad version' },
    { MCP_CATALOG_VERSION: 'x'.repeat(101) },
  ]) assert.throws(() => readConfig({ ...baseEnv, ...entry }));
  const development = readConfig({ MCP_PORTAL_GRANT_TOKEN: GRANT });
  assert.equal(development.buildSha, 'development');
  assert.equal(development.sourceFingerprint, 'development');
  assert.equal(development.imageReference, 'development');
});

test('provider activation requires complete immutable release provenance', () => {
  const active = readConfig({ ...baseEnv, FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'true' });
  assert.equal(active.providerExecutionEnabled, true);
  for (const entry of [
    { MCP_BUILD_SHA: 'development' },
    { MCP_SOURCE_FINGERPRINT: 'development' },
    { MCP_IMAGE_REFERENCE: 'development' },
    { MCP_CATALOG_VERSION: 'development' },
  ]) {
    assert.throws(
      () => readConfig({ ...baseEnv, FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'true', ...entry }),
      /requires immutable release provenance/iu,
    );
  }
  assert.doesNotThrow(() => readConfig({ MCP_PORTAL_GRANT_TOKEN: GRANT, FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'false' }));
  assert.doesNotThrow(() => readConfig({
    MCP_MODE: 'standalone',
    MCP_ACCESS_TOKEN: ACCESS_TOKEN,
    FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'true',
  }));
});

test('server startup fails closed before ledger or network setup when activation provenance is development', () => {
  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      MCP_PORTAL_GRANT_TOKEN: GRANT,
      FIRECRAWL_PROVIDER_EXECUTION_ENABLED: 'true',
      MCP_BUILD_SHA: 'development',
      MCP_SOURCE_FINGERPRINT: 'development',
      MCP_IMAGE_REFERENCE: 'development',
      MCP_CATALOG_VERSION: 'development',
    },
  });
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.match(output, /requires immutable release provenance/iu);
  assert.ok(!output.includes(GRANT));
  assert.ok(!output.includes('firecrawl-mcp listening'));
});

test('grant comparison, request-scoped key, and identity normalization do not echo values', () => {
  assert.equal(isPortalGrantValid(GRANT, GRANT), true);
  assert.equal(isPortalGrantValid(GRANT + 'x', GRANT), false);
  assert.equal(isAccessTokenValid('Bearer ' + ACCESS_TOKEN, ACCESS_TOKEN), true);
  assert.equal(isAccessTokenValid('bearer ' + ACCESS_TOKEN, ACCESS_TOKEN), false);
  assert.equal(isAccessTokenValid('Bearer ' + ACCESS_TOKEN + 'x', ACCESS_TOKEN), false);
  assert.equal(isAccessTokenValid('Bearer ' + ACCESS_TOKEN + ', Bearer ' + ACCESS_TOKEN, ACCESS_TOKEN), false);
  assert.equal(isAccessTokenValid(['Bearer ' + ACCESS_TOKEN], ACCESS_TOKEN), false);
  assert.equal(normalizeFirecrawlApiKey(' fc-12345678 '), 'fc-12345678');
  assert.equal(normalizeFirecrawlApiKey('short'), null);
  assert.equal(normalizeUserId(' user_123 '), 'user_123');
  assert.equal(normalizeUserId('bad user'), null);
  assert.equal(fingerprint('value').length, 64);
});
