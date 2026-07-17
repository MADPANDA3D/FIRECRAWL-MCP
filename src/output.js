import {
  decodeUrlComponentBounded,
  isPlainObject,
  jsonStringEncodedByteLength,
  pathSegmentContainsCredential,
  truncateJsonStringUtf8,
} from './util.js';
import { normalizePublicDomainFilter } from './url-safety.js';

const objectData = (payload) => (isPlainObject(payload?.data) ? payload.data : payload);
const safeNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const safeInteger = (value) => (Number.isInteger(value) ? value : null);

export const redactUntrustedText = (value) => {
  if (typeof value !== 'string') return null;
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,10000}?-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted-private-key]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted-private-key-marker]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[redacted-aws-key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, '[redacted-google-key]')
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/gu, '[redacted-stripe-key]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[redacted-jwt]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted-email]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '[redacted-ssn]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/gu, '[redacted-payment-number]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*\b/giu, '[redacted-authorization]')
    .replace(/\b(?:fc|sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]{4,}/giu, '$1=[redacted]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, ' ');
};

const safeString = (value, maximumCharacters = 1000, maximumBytes = maximumCharacters * 3) => (
  truncateJsonStringUtf8(redactUntrustedText(value), maximumCharacters, maximumBytes)
);

export const sanitizeResultUrl = (value, maximum = 2048) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    try {
      normalizePublicDomainFilter(url.hostname);
    } catch {
      return null;
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    const segments = url.pathname.split('/').map((segment) => {
      const decoded = decodeUrlComponentBounded(segment);
      return pathSegmentContainsCredential(segment) || redactUntrustedText(decoded) !== decoded ? '[redacted]' : segment;
    });
    url.pathname = segments.join('/');
    const serialized = url.toString();
    if (Array.from(serialized).length > maximum || jsonStringEncodedByteLength(serialized) > maximum) return null;
    return serialized;
  } catch {
    return null;
  }
};

export const normalizeCreditUsage = (payload) => {
  const data = objectData(payload) || {};
  return {
    remaining_credits: safeNumber(data.remainingCredits),
    plan_credits: safeNumber(data.planCredits),
    billing_period_start: safeString(data.billingPeriodStart, 100, 300),
    billing_period_end: safeString(data.billingPeriodEnd, 100, 300),
  };
};

export const normalizeQueueStatus = (payload) => {
  const data = objectData(payload) || {};
  return {
    jobs_in_queue: safeNumber(data.jobsInQueue),
    active_jobs_in_queue: safeNumber(data.activeJobsInQueue),
    waiting_jobs_in_queue: safeNumber(data.waitingJobsInQueue),
    max_concurrency: safeNumber(data.maxConcurrency),
    most_recent_success: safeString(data.mostRecentSuccess, 100, 300),
  };
};

const publicMetadata = (metadata) => {
  const source = isPlainObject(metadata) ? metadata : {};
  return {
    title: safeString(Array.isArray(source.title) ? source.title[0] : source.title, 500, 1500),
    description: safeString(Array.isArray(source.description) ? source.description[0] : source.description, 1000, 3000),
    language: safeString(Array.isArray(source.language) ? source.language[0] : source.language, 50, 150),
    source_url: sanitizeResultUrl(source.sourceURL),
    final_url: sanitizeResultUrl(source.url),
    status_code: safeInteger(source.statusCode),
    content_type: safeString(source.contentType, 200, 600),
    parsed_pages: safeInteger(source.numPages),
    total_pages: safeInteger(source.totalPages),
  };
};

export const normalizeScrapeResult = (payload, maximumCharacters) => {
  const data = objectData(payload) || {};
  return {
    markdown: safeString(data.markdown, Math.min(32000, maximumCharacters), 30000),
    metadata: publicMetadata(data.metadata),
    credits_used: safeInteger(payload?.creditsUsed),
  };
};

const boundedTextBudget = (maximumCharacters, maximumBytes) => {
  let remainingCharacters = maximumCharacters;
  let remainingBytes = maximumBytes;
  return (value, perFieldMaximum) => {
    const characterLimit = Math.max(0, Math.min(remainingCharacters, perFieldMaximum));
    if (characterLimit === 0 || remainingBytes === 0) return null;
    const text = safeString(value, characterLimit, remainingBytes);
    remainingCharacters = Math.max(0, remainingCharacters - Array.from(text || '').length);
    remainingBytes = Math.max(0, remainingBytes - jsonStringEncodedByteLength(text || ''));
    return text;
  };
};

const boundedUrlBudget = (maximumBytes, maximumPerUrl) => {
  let remainingBytes = maximumBytes;
  return (value) => {
    if (remainingBytes === 0) return null;
    const url = sanitizeResultUrl(value, Math.min(maximumPerUrl, remainingBytes));
    const encodedBytes = jsonStringEncodedByteLength(url || '');
    remainingBytes = Math.max(0, remainingBytes - encodedBytes);
    return url;
  };
};

export const normalizeSearchResult = (payload, limit, maximumCharacters) => {
  const data = isPlainObject(payload?.data) ? payload.data : {};
  const rows = Array.isArray(data.web) ? data.web.slice(0, limit) : [];
  const take = boundedTextBudget(maximumCharacters, 16000);
  const takeUrl = boundedUrlBudget(12000, 1200);
  return {
    results: rows.map((row) => ({
      title: take(row?.title, 500),
      description: take(row?.description, 2000),
      url: takeUrl(row?.url),
    })),
    result_count: rows.length,
    credits_used: safeInteger(payload?.creditsUsed),
    warning: safeString(payload?.warning, 500, 1500),
  };
};

export const normalizeMapResult = (payload, limit, maximumCharacters) => {
  const rows = Array.isArray(payload?.links) ? payload.links.slice(0, limit) : [];
  const take = boundedTextBudget(maximumCharacters, 10000);
  const takeUrl = boundedUrlBudget(16000, 640);
  return {
    links: rows.map((row) => (
      typeof row === 'string'
        ? { url: takeUrl(row), title: null, description: null }
        : {
            url: takeUrl(row?.url),
            title: take(row?.title, 500),
            description: take(row?.description, 1000),
          }
    )),
    link_count: rows.length,
    credits_used: safeInteger(payload?.creditsUsed),
  };
};
