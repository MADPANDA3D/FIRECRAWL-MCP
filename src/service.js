import { fingerprint, normalizeFirecrawlApiKey, normalizeUserId } from './auth.js';
import { COVERAGE_SUMMARY, ENDPOINT_COVERAGE } from './coverage.js';
import { FIRECRAWL_ROUTES, OFFICIAL_MCP_PROVENANCE, OPENAPI_PROVENANCE } from './constants.js';
import { ServiceError, asServiceError } from './errors.js';
import { buildToolManifest, TOOL_BY_NAME, TOOLS } from './manifest.js';
import {
  normalizeCreditUsage,
  normalizeMapResult,
  normalizeQueueStatus,
  normalizeScrapeResult,
  normalizeSearchResult,
} from './output.js';
import { inspectPublicUrl, normalizePublicDomainFilter } from './url-safety.js';
import {
  canonicalJson,
  errorEnvelope,
  newRequestId,
  sha256,
  successEnvelope,
} from './util.js';
import { validateAgainstSchema } from './validation.js';

const parseLowerBudget = (value, configuredMaximum, headerName) => {
  if (value === undefined || value === null || value === '') return configuredMaximum;
  if (Array.isArray(value) || !/^[1-9][0-9]*$/u.test(String(value))) {
    throw new ServiceError('invalid_credit_budget', headerName + ' must be a positive integer.', { statusCode: 400 });
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed > configuredMaximum) {
    throw new ServiceError('invalid_credit_budget', headerName + ' may only lower the configured maximum of ' + configuredMaximum + '.', {
      statusCode: 400,
      details: { configured_maximum: configuredMaximum },
    });
  }
  return parsed;
};

const requiredRequestIdentity = (context, mode) => {
  const userId = normalizeUserId(context.readUserId());
  if (!userId) {
    const message = mode === 'portal'
      ? 'A valid x-madpanda-user-id header is required for Firecrawl provider tools.'
      : 'An authenticated standalone identity is required for Firecrawl provider tools.';
    throw new ServiceError('setup_required', message, { statusCode: 400 });
  }
  const apiKey = normalizeFirecrawlApiKey(context.readApiKey());
  if (!apiKey) {
    const message = mode === 'portal'
      ? 'Configure a Firecrawl API key in the MAD MCP Portal before using provider tools.'
      : 'Provide a Firecrawl API key in the x-firecrawl-api-key header before using provider tools.';
    throw new ServiceError('setup_required', message, { statusCode: 400 });
  }
  return { userId, apiKey, userHash: fingerprint(userId), keyHash: fingerprint(apiKey) };
};

const assertProviderExecution = (config) => {
  if (!config.providerExecutionEnabled) {
    throw new ServiceError(
      'provider_execution_disabled',
      'Firecrawl provider execution is not enabled for this deployment. Navigation tools remain available; complete the separately approved activation step first.',
      { statusCode: 503 },
    );
  }
};

const pairState = (args) => {
  const hasToken = Object.hasOwn(args, 'previewToken');
  const hasConfirm = Object.hasOwn(args, 'confirm');
  if (hasToken !== hasConfirm) {
    throw new ServiceError('confirmation_pair_required', 'previewToken and confirm must both be omitted for preview or both be supplied for execution.', { statusCode: 400 });
  }
  if (hasConfirm && args.confirm !== true) {
    throw new ServiceError('confirmation_required', 'confirm must be exactly true when previewToken is supplied.', { statusCode: 400 });
  }
  return hasToken ? 'execute' : 'preview';
};

const normalizeSearchDomains = (values) => (
  values === undefined ? undefined : values.map(normalizePublicDomainFilter)
);

const canonicalPaidArguments = async (toolName, args, lookupFn) => {
  if (toolName === 'firecrawl_scrape_public_page') {
    const target = await inspectPublicUrl(args.url, lookupFn);
    return {
      canonical: {
        url: target.url,
        maxPdfPages: args.maxPdfPages ?? 5,
        maxCharacters: args.maxCharacters ?? 16000,
      },
      dnsHash: target.dnsHash,
      dnsAnswerCount: target.answerCount,
      cost: args.maxPdfPages ?? 5,
    };
  }
  if (toolName === 'firecrawl_search_public_web') {
    if (!args.query.trim()) {
      throw new ServiceError('validation_error', 'arguments.query must contain non-whitespace text.', { statusCode: 400 });
    }
    if (args.includeDomains && args.excludeDomains) {
      throw new ServiceError('validation_error', 'includeDomains and excludeDomains cannot be used together.', { statusCode: 400 });
    }
    const includeDomains = normalizeSearchDomains(args.includeDomains);
    const excludeDomains = normalizeSearchDomains(args.excludeDomains);
    const canonical = {
      query: args.query,
      limit: args.limit ?? 10,
      maxCharacters: args.maxCharacters ?? 16000,
      ...(includeDomains ? { includeDomains } : {}),
      ...(excludeDomains ? { excludeDomains } : {}),
    };
    return {
      canonical,
      dnsHash: sha256('no_direct_public_target_url:' + canonicalJson({ includeDomains, excludeDomains })),
      dnsAnswerCount: 0,
      cost: 2,
    };
  }
  if (toolName === 'firecrawl_map_public_site') {
    const target = await inspectPublicUrl(args.url, lookupFn);
    return {
      canonical: {
        url: target.url,
        ...(args.search === undefined ? {} : { search: args.search }),
        sitemap: args.sitemap ?? 'include',
        limit: args.limit ?? 25,
        maxCharacters: args.maxCharacters ?? 16000,
      },
      dnsHash: target.dnsHash,
      dnsAnswerCount: target.answerCount,
      cost: 1,
    };
  }
  throw new ServiceError('unknown_tool', 'The paid tool is not recognized.', { statusCode: 404 });
};

const providerBody = (toolName, args) => {
  if (toolName === 'firecrawl_scrape_public_page') {
    return {
      url: args.url,
      formats: ['markdown'],
      onlyMainContent: true,
      maxAge: 0,
      skipTlsVerification: false,
      timeout: 30000,
      parsers: [{ type: 'pdf', mode: 'fast', maxPages: args.maxPdfPages }],
      removeBase64Images: true,
      blockAds: true,
      proxy: 'basic',
      storeInCache: false,
    };
  }
  if (toolName === 'firecrawl_search_public_web') {
    return {
      query: args.query,
      limit: args.limit,
      sources: [{ type: 'web' }],
      ...(args.includeDomains ? { includeDomains: args.includeDomains } : {}),
      ...(args.excludeDomains ? { excludeDomains: args.excludeDomains } : {}),
      timeout: 30000,
      ignoreInvalidURLs: true,
    };
  }
  if (toolName === 'firecrawl_map_public_site') {
    return {
      url: args.url,
      ...(args.search === undefined ? {} : { search: args.search }),
      sitemap: args.sitemap,
      includeSubdomains: false,
      ignoreQueryParameters: true,
      ignoreCache: false,
      limit: args.limit,
      timeout: 30000,
    };
  }
  throw new ServiceError('unknown_tool', 'The paid tool is not recognized.', { statusCode: 404 });
};

const normalizedPaidOutput = (toolName, payload, args) => {
  if (toolName === 'firecrawl_scrape_public_page') return normalizeScrapeResult(payload, args.maxCharacters);
  if (toolName === 'firecrawl_search_public_web') return normalizeSearchResult(payload, args.limit, args.maxCharacters);
  if (toolName === 'firecrawl_map_public_site') return normalizeMapResult(payload, args.limit, args.maxCharacters);
  throw new ServiceError('unknown_tool', 'The paid tool is not recognized.', { statusCode: 404 });
};

export class FirecrawlService {
  constructor({ config, client, ledger, lookupFn }) {
    this.config = config;
    this.client = client;
    this.ledger = ledger;
    this.lookupFn = lookupFn;
    this.manifest = buildToolManifest(config);
  }

  async execute(toolName, rawArguments = {}, context = {}, requestId = newRequestId()) {
    const tool = TOOL_BY_NAME.get(toolName);
    const endpoint = tool?.endpoint || null;
    try {
      if (!tool) throw new ServiceError('unknown_tool', 'Unknown Firecrawl MCP tool.', { statusCode: 404 });
      const args = validateAgainstSchema(rawArguments, tool.inputSchema);
      let data;
      let meta = {};

      if (toolName === 'check_configuration') data = this.checkConfiguration(context);
      else if (toolName === 'list_capabilities') data = this.listCapabilities(args);
      else if (toolName === 'get_endpoint_coverage') data = this.getEndpointCoverage(args.filter);
      else if (toolName === 'get_tool_usage') data = this.getToolUsage(args.toolName);
      else if (tool.family === 'provider_read') ({ data, meta } = await this.executeRead(toolName, context));
      else if (tool.family === 'paid_provider_write') ({ data, meta } = await this.executePaid(toolName, args, context));
      else throw new ServiceError('unknown_tool', 'Unknown Firecrawl MCP tool.', { statusCode: 404 });

      return successEnvelope({ data, tool: toolName, requestId, endpoint, meta });
    } catch (error) {
      return errorEnvelope({ error: asServiceError(error), tool: toolName, requestId, endpoint });
    }
  }

  checkConfiguration(context) {
    const userPresent = Boolean(normalizeUserId(context.readUserId?.()));
    const keyPresent = Boolean(normalizeFirecrawlApiKey(context.readApiKey?.()));
    return {
      setup_status: this.config.providerExecutionEnabled && userPresent && keyPresent ? 'ready' : 'setup_required',
      access_mode: this.config.mode,
      inbound_authentication: this.config.mode === 'portal' ? 'portal_grant' : 'bearer_token',
      provider_execution_enabled: this.config.providerExecutionEnabled,
      user_identity_present: userPresent,
      firecrawl_api_key_present: keyPresent,
      provider_key_storage: 'request_scoped_only',
      fixed_provider_origin: this.config.providerOrigin,
      max_operation_credits: this.config.maxOperationCredits,
      daily_credit_limit: this.config.dailyCreditLimit,
      max_in_flight_per_key: this.config.maxInFlightPaid,
      preview_ttl_seconds: this.config.previewTtlSeconds,
      build_sha: this.config.buildSha,
      source_fingerprint: this.config.sourceFingerprint,
      image_reference: this.config.imageReference,
      descriptor_hash: this.manifest.descriptorHash,
      tool_count: TOOLS.length,
    };
  }

  listCapabilities(args) {
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        category: tool.category,
        endpoint: tool.endpoint,
        read_only: tool.annotations.readOnlyHint,
        destructive: tool.annotations.destructiveHint,
        open_world: tool.annotations.openWorldHint,
        confirmation: tool.confirmation,
      })),
      safety: {
        access_mode: this.config.mode,
        portal_grant_required: this.config.mode === 'portal',
        standalone_bearer_required: this.config.mode === 'standalone',
        provider_execution_default: false,
        provider_origin_fixed: this.config.providerOrigin,
        provider_key_request_scoped: true,
        paid_calls_use_one_use_preview: true,
        paid_calls_retried: false,
        output_limit_bytes: this.config.toolOutputMaxBytes,
      },
      coverage: COVERAGE_SUMMARY,
      provenance: {
        official_mcp: OFFICIAL_MCP_PROVENANCE,
        openapi: OPENAPI_PROVENANCE,
        clean_room: true,
      },
      ...(args.includeDescriptors ? { tool_manifest: this.manifest } : {}),
    };
  }

  getEndpointCoverage(filter) {
    const needle = filter?.toLowerCase();
    const operations = needle
      ? ENDPOINT_COVERAGE.filter((row) => canonicalJson(row).toLowerCase().includes(needle))
      : ENDPOINT_COVERAGE;
    return { summary: COVERAGE_SUMMARY, operations };
  }

  getToolUsage(toolName) {
    const tool = TOOL_BY_NAME.get(toolName);
    if (!tool) throw new ServiceError('unknown_tool', 'No exact Firecrawl tool matches toolName.', { statusCode: 404 });
    const descriptor = this.manifest.tools.find(({ nativeToolName }) => nativeToolName === toolName);
    return {
      tool_name: tool.name,
      canonical_name: descriptor.canonicalName,
      description: tool.description,
      category: tool.category,
      endpoint: tool.endpoint,
      cost: tool.cost || 'none',
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema,
      annotations: tool.annotations,
      confirmation: tool.confirmation,
      deprecation: descriptor.deprecation,
      descriptor_hash: descriptor.descriptorHash,
    };
  }

  async executeRead(toolName, context) {
    assertProviderExecution(this.config);
    const identity = requiredRequestIdentity(context, this.config.mode);
    const route = FIRECRAWL_ROUTES[toolName];
    const result = await this.client.request({ ...route, apiKey: identity.apiKey, paid: false });
    const data = toolName === 'firecrawl_get_credit_usage'
      ? normalizeCreditUsage(result.payload)
      : normalizeQueueStatus(result.payload);
    return {
      data,
      meta: {
        ...result.meta,
        untrusted_external_content: true,
        external_source: 'Firecrawl API',
      },
    };
  }

  async executePaid(toolName, args, context) {
    assertProviderExecution(this.config);
    const identity = requiredRequestIdentity(context, this.config.mode);
    const operationBudget = parseLowerBudget(
      context.readOperationBudget?.(),
      this.config.maxOperationCredits,
      'x-firecrawl-max-operation-credits',
    );
    const dailyBudget = parseLowerBudget(
      context.readDailyBudget?.(),
      this.config.dailyCreditLimit,
      'x-firecrawl-daily-credit-limit',
    );
    const mode = pairState(args);
    const normalized = await canonicalPaidArguments(toolName, args, this.lookupFn);
    if (normalized.cost > operationBudget) {
      throw new ServiceError('operation_credit_limit', 'The projected Firecrawl credit cost exceeds the request-scoped operation limit.', {
        statusCode: 429,
        details: { projected_credits: normalized.cost, operation_limit: operationBudget },
      });
    }
    const binding = {
      userHash: identity.userHash,
      keyHash: identity.keyHash,
      tool: toolName,
      argsHash: sha256(canonicalJson(normalized.canonical)),
      dnsHash: normalized.dnsHash,
      buildSha: this.config.buildSha,
      sourceFingerprint: this.config.sourceFingerprint,
      descriptorHash: this.manifest.descriptorHash,
      operationBudget,
      dailyBudget,
    };
    if (mode === 'preview') {
      const issued = await this.ledger.issue({ binding, cost: normalized.cost, ttlSeconds: this.config.previewTtlSeconds });
      return {
        data: {
          preview: true,
          provider_called: false,
          tool: toolName,
          fixed_endpoint: FIRECRAWL_ROUTES[toolName].method + ' ' + FIRECRAWL_ROUTES[toolName].path,
          projected_credits: normalized.cost,
          operation_credit_limit: operationBudget,
          daily_credit_limit: dailyBudget,
          daily_committed_credits: issued.dailyCommitted,
          dns_answer_count: normalized.dnsAnswerCount,
          previewToken: issued.token,
          expires_at: new Date(issued.expiresAt).toISOString(),
          next_action: 'Repeat this exact request with previewToken and confirm=true within 300 seconds.',
        },
        meta: { attempts: 0 },
      };
    }

    const consumed = await this.ledger.consume({ token: args.previewToken, binding, cost: normalized.cost });
    const route = FIRECRAWL_ROUTES[toolName];
    let result;
    try {
      result = await this.client.request({
        method: route.method,
        path: route.path,
        body: providerBody(toolName, normalized.canonical),
        apiKey: identity.apiKey,
        paid: true,
      });
    } catch (error) {
      if (error && typeof error === 'object') error.retryable = false;
      const reportedCharge = Number.isSafeInteger(error?.details?.actual_credits)
        && error.details.actual_credits >= 0
        ? error.details.actual_credits
        : undefined;
      const conservativeCharge = reportedCharge ?? (
        error?.code === 'provider_credit_usage_unknown' ? this.config.dailyCreditLimit : undefined
      );
      try {
        await this.ledger.settle(
          consumed.tokenHash,
          error?.outcomeUnknown ? 'indeterminate' : 'spent',
          conservativeCharge,
        );
      } catch {
        throw new ServiceError(
          'accounting_outcome_unknown',
          'The paid Firecrawl attempt completed without a durable accounting settlement. The token remains consumed; do not retry automatically.',
          { statusCode: 502, retryable: false, outcomeUnknown: true },
        );
      }
      throw error;
    }
    const actualCredits = Object.hasOwn(result.payload, 'creditsUsed')
      ? result.payload.creditsUsed
      : normalized.cost;
    try {
      await this.ledger.settle(consumed.tokenHash, 'spent', actualCredits);
    } catch {
      throw new ServiceError(
        'accounting_outcome_unknown',
        'Firecrawl returned success but durable accounting settlement failed. The token remains consumed; do not retry automatically.',
        { statusCode: 502, retryable: false, outcomeUnknown: true },
      );
    }
    if (actualCredits > normalized.cost) {
      throw new ServiceError(
        'provider_credit_drift',
        'Firecrawl reported credit usage above the pinned projection. Actual usage was charged and further paid calls remain budget-gated.',
        {
          statusCode: 502,
          retryable: false,
          details: { projected_credits: normalized.cost, actual_credits: actualCredits },
        },
      );
    }
    return {
      data: normalizedPaidOutput(toolName, result.payload, normalized.canonical),
      meta: {
        ...result.meta,
        projected_credits: normalized.cost,
        preview_token_consumed: true,
        untrusted_external_content: true,
        external_source: 'Firecrawl API',
      },
    };
  }
}
