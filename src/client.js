import { FIRECRAWL_ORIGIN, FIRECRAWL_ROUTES } from './constants.js';
import { ServiceError } from './errors.js';
import { isPlainObject } from './util.js';

const allowedRoutes = new Set(Object.values(FIRECRAWL_ROUTES).map(({ method, path }) => method + ' ' + path));

const readBoundedBody = async (response, maximumBytes, signal) => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      void resolve;
      onAbort = () => reject(new ServiceError('provider_response_timeout', 'Firecrawl response body timed out.', {
        statusCode: 502,
        retryable: true,
      }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), aborted]);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      void reader.cancel().catch(() => {});
      throw new ServiceError('provider_response_too_large', 'Firecrawl returned more data than this service permits.', { statusCode: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ServiceError('provider_invalid_response', 'Firecrawl returned invalid UTF-8.', { statusCode: 502 });
  }
};

const parsePayload = (text) => {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError('provider_invalid_response', 'Firecrawl returned a non-JSON response.', { statusCode: 502 });
  }
};

const providerError = (status, headers) => {
  const details = { status_code: status };
  void headers;
  if ([400, 422].includes(status)) return new ServiceError('provider_validation_error', 'Firecrawl rejected one or more bounded parameters.', { statusCode: 400, details });
  if (status === 401) return new ServiceError('provider_auth_error', 'Firecrawl rejected the supplied API key.', { statusCode: 401, details });
  if (status === 402) return new ServiceError('insufficient_credits', 'The Firecrawl account has insufficient credits.', { statusCode: 402, details });
  if (status === 403) return new ServiceError('provider_forbidden', 'Firecrawl denied this operation.', { statusCode: 403, details });
  if (status === 404) return new ServiceError('provider_not_found', 'Firecrawl could not find the requested resource.', { statusCode: 404, details });
  if (status === 408) return new ServiceError('provider_timeout', 'Firecrawl timed out processing the request.', { statusCode: 502, details });
  if (status === 429) return new ServiceError('provider_rate_limited', 'Firecrawl rate-limited this request.', { statusCode: 429, retryable: true, details });
  if (status >= 500) return new ServiceError('provider_unavailable', 'Firecrawl did not provide a conclusive paid-operation outcome.', {
    statusCode: 502,
    retryable: false,
    outcomeUnknown: true,
    details,
  });
  return new ServiceError('provider_error', 'Firecrawl rejected the request.', { statusCode: 502, details });
};

const indeterminate = () => new ServiceError(
  'provider_outcome_unknown',
  'Firecrawl did not conclusively report the paid-operation outcome. The preview token and reserved credits are consumed; inspect Firecrawl before trying again.',
  { statusCode: 502, retryable: false, outcomeUnknown: true },
);

const creditUsageUnknown = () => new ServiceError(
  'provider_credit_usage_unknown',
  'Firecrawl did not return trustworthy integer credit usage for this paid operation. The configured daily allowance is conservatively exhausted.',
  { statusCode: 502, retryable: false, outcomeUnknown: true },
);

const validateSuccessEnvelope = (payload, path) => {
  const paidPath = ['/v2/scrape', '/v2/search', '/v2/map'].includes(path);
  if (isPlainObject(payload) && payload.success === false) {
    throw new ServiceError('provider_reported_failure', 'Firecrawl reported that the operation did not succeed.', {
      statusCode: 502,
      retryable: false,
    });
  }
  if (!isPlainObject(payload) || payload.success !== true) {
    if (paidPath) throw creditUsageUnknown();
    throw new ServiceError('provider_invalid_response', 'Firecrawl returned an invalid success envelope.', { statusCode: 502 });
  }
  const hasCreditsUsed = Object.hasOwn(payload, 'creditsUsed');
  const validCreditsUsed = Number.isSafeInteger(payload.creditsUsed) && payload.creditsUsed >= 0;
  const creditsRequired = path === '/v2/search';
  const creditsOptional = path === '/v2/scrape' || path === '/v2/map';
  if ((creditsRequired && !validCreditsUsed) || (creditsOptional && hasCreditsUsed && !validCreditsUsed)) {
    throw creditUsageUnknown();
  }
  const valid = (
    (path === '/v2/team/credit-usage' && isPlainObject(payload.data)
      && Number.isFinite(payload.data.remainingCredits) && Number.isFinite(payload.data.planCredits))
    || (path === '/v2/team/queue-status'
      && [payload.jobsInQueue, payload.activeJobsInQueue, payload.waitingJobsInQueue, payload.maxConcurrency]
        .every((value) => Number.isFinite(value) && value >= 0))
    || (path === '/v2/scrape' && isPlainObject(payload.data) && typeof payload.data.markdown === 'string')
    || (path === '/v2/search' && isPlainObject(payload.data) && Array.isArray(payload.data.web))
    || (path === '/v2/map' && Array.isArray(payload.links))
  );
  if (!valid) {
    if (paidPath && !validCreditsUsed) throw creditUsageUnknown();
    throw new ServiceError('provider_invalid_response', 'Firecrawl returned an unexpected result shape for the fixed endpoint.', {
      statusCode: 502,
      retryable: false,
      details: paidPath ? { actual_credits: payload.creditsUsed } : {},
    });
  }
};

export class FirecrawlClient {
  constructor({ config, fetchFn = globalThis.fetch }) {
    if (typeof fetchFn !== 'function') throw new Error('A fetch implementation is required');
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async request({ method, path, body, apiKey, paid = false }) {
    const normalizedMethod = String(method).toUpperCase();
    if (!allowedRoutes.has(normalizedMethod + ' ' + path)) {
      throw new ServiceError('blocked_provider_route', 'The provider method and route are not allowlisted.');
    }
    const url = new URL(path, FIRECRAWL_ORIGIN);
    if (url.origin !== FIRECRAWL_ORIGIN || url.hostname !== 'api.firecrawl.dev' || url.port || url.search || url.hash) {
      throw new ServiceError('blocked_provider_target', 'The provider target is not the fixed Firecrawl API origin.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.providerTimeoutMs);
    let response;
    try {
      response = await this.fetchFn(url.toString(), {
        method: normalizedMethod,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + apiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (paid) throw indeterminate();
      throw new ServiceError('provider_unavailable', 'Firecrawl could not be reached.', { statusCode: 502, retryable: true });
    }
    let payload;
    try {
      payload = parsePayload(await readBoundedBody(response, this.config.providerResponseMaxBytes, controller.signal));
    } catch (error) {
      if (paid && response.ok) throw creditUsageUnknown();
      if (paid) throw indeterminate();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const error = providerError(response.status, response.headers);
      if (paid && (response.status === 408 || response.status >= 500)) throw indeterminate();
      if (paid) error.retryable = false;
      throw error;
    }
    try {
      validateSuccessEnvelope(payload, path);
    } catch (error) {
      if (paid && error.code === 'provider_invalid_response') error.retryable = false;
      throw error;
    }
    return {
      payload,
      meta: {
        status_code: response.status,
        attempts: 1,
      },
    };
  }
}
