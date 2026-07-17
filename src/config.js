import { FIRECRAWL_ORIGIN } from './constants.js';

const boundedInteger = (value, fallback, minimum, maximum, name) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
};

const requiredSecret = (value, name) => {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must contain 32 to 4096 safe characters`);
  }
  return value;
};

const requiredBearerToken = (value) => {
  const token = requiredSecret(value, 'MCP_ACCESS_TOKEN');
  if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) {
    throw new Error('MCP_ACCESS_TOKEN must be a valid Bearer token value');
  }
  return token;
};

const accessMode = (value) => {
  const candidate = value || 'portal';
  if (!['portal', 'standalone'].includes(candidate)) {
    throw new Error('MCP_MODE must be portal or standalone');
  }
  return candidate;
};

const strictBoolean = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

const buildSha = (value) => {
  const candidate = value || 'development';
  if (candidate !== 'development' && !/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error('MCP_BUILD_SHA must be development or a full lowercase Git SHA');
  }
  return candidate;
};

const sourceFingerprint = (value) => {
  const candidate = value || 'development';
  if (candidate !== 'development' && !/^[a-f0-9]{64}$/u.test(candidate)) {
    throw new Error('MCP_SOURCE_FINGERPRINT must be development or a lowercase SHA-256');
  }
  return candidate;
};

const imageReference = (value) => {
  const candidate = value || 'development';
  if (candidate !== 'development' && !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u.test(candidate)) {
    throw new Error('MCP_IMAGE_REFERENCE must be development or an immutable lowercase digest reference');
  }
  return candidate;
};

const catalogVersion = (value) => {
  const candidate = value || '2026-07-17.1';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(candidate)) {
    throw new Error('MCP_CATALOG_VERSION must be a bounded safe identifier');
  }
  return candidate;
};

export const readConfig = (env = process.env) => {
  const mode = accessMode(env.MCP_MODE);
  const config = {
    mode,
    host: env.HOST || (mode === 'standalone' ? '127.0.0.1' : '0.0.0.0'),
    port: boundedInteger(env.PORT, 8080, 1, 65535, 'PORT'),
    portalGrantToken: mode === 'portal'
      ? requiredSecret(env.MCP_PORTAL_GRANT_TOKEN, 'MCP_PORTAL_GRANT_TOKEN')
      : null,
    accessToken: mode === 'standalone'
      ? requiredBearerToken(env.MCP_ACCESS_TOKEN)
      : null,
    providerExecutionEnabled: strictBoolean(env.FIRECRAWL_PROVIDER_EXECUTION_ENABLED, false, 'FIRECRAWL_PROVIDER_EXECUTION_ENABLED'),
    maxOperationCredits: boundedInteger(env.FIRECRAWL_MAX_OPERATION_CREDITS, 25, 1, 25, 'FIRECRAWL_MAX_OPERATION_CREDITS'),
    dailyCreditLimit: boundedInteger(env.FIRECRAWL_DAILY_CREDIT_LIMIT, 50, 1, 50, 'FIRECRAWL_DAILY_CREDIT_LIMIT'),
    maxInFlightPaid: boundedInteger(env.FIRECRAWL_MAX_IN_FLIGHT_PAID, 1, 1, 1, 'FIRECRAWL_MAX_IN_FLIGHT_PAID'),
    previewTtlSeconds: boundedInteger(env.FIRECRAWL_PREVIEW_TTL_SECONDS, 300, 300, 300, 'FIRECRAWL_PREVIEW_TTL_SECONDS'),
    ledgerPath: env.FIRECRAWL_LEDGER_PATH || '/data/firecrawl-ledger.json',
    requestBodyMaxBytes: boundedInteger(env.MCP_REQUEST_BODY_MAX_BYTES, 131072, 16384, 524288, 'MCP_REQUEST_BODY_MAX_BYTES'),
    toolOutputMaxBytes: boundedInteger(env.MCP_TOOL_OUTPUT_MAX_BYTES, 49152, 8192, 49152, 'MCP_TOOL_OUTPUT_MAX_BYTES'),
    providerResponseMaxBytes: boundedInteger(env.FIRECRAWL_RESPONSE_MAX_BYTES, 1048576, 65536, 1048576, 'FIRECRAWL_RESPONSE_MAX_BYTES'),
    providerTimeoutMs: boundedInteger(env.FIRECRAWL_REQUEST_TIMEOUT_MS, 30000, 1000, 30000, 'FIRECRAWL_REQUEST_TIMEOUT_MS'),
    providerOrigin: FIRECRAWL_ORIGIN,
    buildSha: buildSha(env.MCP_BUILD_SHA),
    sourceFingerprint: sourceFingerprint(env.MCP_SOURCE_FINGERPRINT),
    imageReference: imageReference(env.MCP_IMAGE_REFERENCE),
    catalogVersion: catalogVersion(env.MCP_CATALOG_VERSION),
  };
  const immutableProvenance = (
    /^[a-f0-9]{40}$/u.test(config.buildSha)
    && /^[a-f0-9]{64}$/u.test(config.sourceFingerprint)
    && /@sha256:[a-f0-9]{64}$/u.test(config.imageReference)
    && config.catalogVersion !== 'development'
  );
  if (config.mode === 'portal' && config.providerExecutionEnabled && !immutableProvenance) {
    throw new Error('FIRECRAWL_PROVIDER_EXECUTION_ENABLED=true requires immutable release provenance');
  }
  return Object.freeze(config);
};
