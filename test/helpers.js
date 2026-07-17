import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FirecrawlClient } from '../src/client.js';
import { PreviewLedger } from '../src/ledger.js';
import { FirecrawlService } from '../src/service.js';

export const GRANT = 'portal-grant-' + 'g'.repeat(64);
export const ACCESS_TOKEN = 'standalone-access-' + 'a'.repeat(64);
export const USER = 'user-firecrawl-test';
export const KEY = 'fc-test-key-' + 'k'.repeat(40);

export const makeConfig = (overrides = {}) => ({
  mode: 'portal',
  host: '127.0.0.1',
  port: 0,
  portalGrantToken: GRANT,
  accessToken: null,
  providerExecutionEnabled: false,
  maxOperationCredits: 25,
  dailyCreditLimit: 50,
  maxInFlightPaid: 1,
  previewTtlSeconds: 300,
  ledgerPath: '/tmp/unused-firecrawl-ledger.json',
  requestBodyMaxBytes: 131072,
  toolOutputMaxBytes: 49152,
  providerResponseMaxBytes: 1048576,
  providerTimeoutMs: 30000,
  providerOrigin: 'https://api.firecrawl.dev',
  buildSha: '1'.repeat(40),
  sourceFingerprint: '2'.repeat(64),
  imageReference: 'ghcr.io/madpanda3d/firecrawl-mcp-server@sha256:' + '3'.repeat(64),
  catalogVersion: '2026-07-17.1',
  ...overrides,
});

export const publicLookup = async () => [
  { address: '8.8.8.8', family: 4 },
  { address: '2606:4700:4700::1111', family: 6 },
];

export const makeContext = (overrides = {}) => ({
  readUserId: () => USER,
  readApiKey: () => KEY,
  readOperationBudget: () => undefined,
  readDailyBudget: () => undefined,
  ...overrides,
});

export const jsonResponse = (payload, options = {}) => new Response(JSON.stringify(payload), {
  status: options.status || 200,
  headers: {
    'content-type': 'application/json',
    'x-request-id': options.requestId || 'provider-request',
    ...(options.headers || {}),
  },
});

export const makeHarness = async ({
  config: configOverrides = {},
  fetchFn = async () => jsonResponse({ success: true }),
  lookupFn = publicLookup,
  now,
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'firecrawl-mcp-test-'));
  const config = makeConfig({
    providerExecutionEnabled: true,
    ledgerPath: join(directory, 'ledger.json'),
    ...configOverrides,
  });
  const ledger = await new PreviewLedger({
    path: config.ledgerPath,
    maxInFlight: config.maxInFlightPaid,
    ...(now ? { now } : {}),
  }).init();
  const client = new FirecrawlClient({ config, fetchFn });
  const service = new FirecrawlService({ config, client, ledger, lookupFn });
  return { directory, config, ledger, client, service };
};

export const preview = async (service, name, args, context = makeContext()) => {
  const result = await service.execute(name, args, context);
  if (!result.ok) throw new Error('Preview failed: ' + result.error.code + ' ' + result.error.message);
  return result.data.previewToken;
};
