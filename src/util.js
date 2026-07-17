import { createHash, randomUUID } from 'node:crypto';

import { ServiceError } from './errors.js';

export const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
);

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export const newRequestId = () => `req_${randomUUID().replaceAll('-', '')}`;

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const canonicalJson = (value) => JSON.stringify(stableValue(value));
export const truncateText = (value, maximum) => {
  if (typeof value !== 'string') return null;
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
};

export const truncateUtf8 = (value, maximumCharacters, maximumBytes) => {
  if (typeof value !== 'string') return null;
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 0) return '';
  if (!Number.isInteger(maximumBytes) || maximumBytes < 0) return '';
  const output = [];
  let bytes = 0;
  for (const character of value) {
    if (output.length >= maximumCharacters) break;
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    output.push(character);
    bytes += characterBytes;
  }
  return output.join('');
};

// Budget the bytes that a string consumes inside JSON, not only its raw UTF-8
// representation. Quotes, backslashes, and control characters expand when
// serialized and therefore need to count against the public response ceiling.
export const truncateJsonStringUtf8 = (value, maximumCharacters, maximumEncodedBytes) => {
  if (typeof value !== 'string') return null;
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 0) return '';
  if (!Number.isInteger(maximumEncodedBytes) || maximumEncodedBytes < 0) return '';
  const output = [];
  let encodedBytes = 0;
  for (const character of value) {
    if (output.length >= maximumCharacters) break;
    const encoded = JSON.stringify(character).slice(1, -1);
    const nestedEncoded = JSON.stringify(encoded).slice(1, -1);
    const characterBytes = Buffer.byteLength(nestedEncoded, 'utf8');
    if (encodedBytes + characterBytes > maximumEncodedBytes) break;
    output.push(character);
    encodedBytes += characterBytes;
  }
  return output.join('');
};

export const jsonStringEncodedByteLength = (value) => (
  typeof value === 'string'
    ? Buffer.byteLength(JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1), 'utf8')
    : 0
);

export const containsCredentialMaterial = (value) => {
  if (typeof value !== 'string') return false;
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value)
    || /\bAIza[0-9A-Za-z_-]{20,}\b/u.test(value)
    || /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/iu.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/iu.test(value)
    || /\b(?:fc|sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]{4,}/iu.test(value)
  );
};

export const decodeUrlComponentBounded = (value, maximumRounds = 4) => {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let decoded = value;
  for (let attempts = 0; attempts < maximumRounds; attempts += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return null;
    }
  }
  return null;
};

export const pathSegmentContainsCredential = (segment) => {
  const decoded = decodeUrlComponentBounded(segment);
  return decoded === null || containsCredentialMaterial(decoded);
};

export const isSensitiveQueryKey = (value) => {
  if (typeof value !== 'string') return false;
  const canonical = value.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return new Set([
    'apikey', 'key', 'code', 'credential', 'credentials', 'session', 'sessionid',
    'token', 'accesstoken', 'refreshtoken', 'auth', 'authorization', 'password',
    'passwd', 'secret', 'signature', 'sig', 'cookie', 'email', 'phone', 'ssn',
  ]).has(canonical);
};

export const successEnvelope = ({ data, tool, requestId, endpoint = null, meta = {} }) => ({
  ok: true,
  data,
  error: null,
  meta: { request_id: requestId, tool, endpoint, ...meta },
});

export const errorEnvelope = ({ error, tool, requestId, endpoint = null }) => ({
  ok: false,
  data: null,
  error: {
    code: error.code,
    message: error.message,
    retryable: Boolean(error.retryable),
    outcome_unknown: Boolean(error.outcomeUnknown),
    details: error.details,
  },
  meta: { request_id: requestId, tool, endpoint },
});

export const assertBoundedJson = (value, maximumBytes) => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new ServiceError('tool_output_too_large', 'The bounded tool result exceeded the service output limit.', { statusCode: 502 });
  }
  return serialized;
};
