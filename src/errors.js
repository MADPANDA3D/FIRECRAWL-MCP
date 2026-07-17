export class ServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export const asServiceError = (error) => (
  error instanceof ServiceError
    ? error
    : new ServiceError('internal_error', 'Firecrawl MCP could not complete the request.')
);
