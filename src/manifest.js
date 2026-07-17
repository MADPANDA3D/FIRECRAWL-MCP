import { createHash } from 'node:crypto';

import { OPENAPI_PROVENANCE, OFFICIAL_MCP_PROVENANCE, SERVICE_ID } from './constants.js';
import { canonicalJson, sha256 } from './util.js';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description, options = {}) => ({ type: 'string', description, ...options });
const integer = (description, minimum, maximum, defaultValue) => ({
  type: 'integer', description, minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const boolean = (description) => ({ type: 'boolean', description });
const enumString = (description, values, defaultValue) => ({
  type: 'string', description, enum: values, ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const array = (description, items, minimum, maximum) => ({
  type: 'array', description, items, minItems: minimum, maxItems: maximum, uniqueItems: true,
});

const navigationAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
const readAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true });
const paidAnnotations = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false });

const publicUrl = string('Public HTTP(S) URL. Credentials, fragments, IP literals, non-80/443 ports, local names, and private/reserved DNS answers are rejected.', { minLength: 8, maxLength: 2048 });
const previewToken = string('One-use 300-second token returned by this exact paid tool preview, bound to identity, API-key fingerprint, canonical arguments, DNS answers, build, and credit budgets.', { minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
const confirm = boolean('Set exactly true together with previewToken to authorize one paid outbound attempt. Omit both fields to preview without contacting Firecrawl.');
const maxCharacters = integer('Maximum characters returned after local output filtering.', 1000, 32000, 16000);
const paidProperties = Object.freeze({ previewToken, confirm });

const boundedEnvelopeOutput = Object.freeze({
  type: 'object',
  description: 'Bounded JSON result envelope. Serialized MCP tool output is capped at 48 KiB and never exposes credentials, raw headers, provider HTML/rawHTML fields, base64 media, screenshots, audio, cookies, or an unfiltered provider payload.',
  properties: {
    ok: { type: 'boolean' },
    data: { description: 'Tool-specific bounded result or null on error.' },
    error: { description: 'Sanitized error object or null on success.' },
    meta: {
      type: 'object',
      properties: {
        request_id: { type: 'string', maxLength: 64 },
        tool: { type: 'string', maxLength: 100 },
        endpoint: { description: 'Fixed provider endpoint or null for local navigation.' },
      },
      required: ['request_id', 'tool', 'endpoint'],
      additionalProperties: true,
    },
  },
  required: ['ok', 'data', 'error', 'meta'],
  additionalProperties: false,
});

const noConfirmation = Object.freeze({
  required: false,
  mechanism: 'none',
  exactPhrase: null,
  previewTokenTtlSeconds: null,
});
const paidConfirmation = Object.freeze({
  required: true,
  mechanism: 'one_use_preview_token_and_boolean',
  exactPhrase: null,
  previewTokenTtlSeconds: 300,
  tokenParameter: 'previewToken',
  confirmationParameter: 'confirm',
  confirmationValue: true,
});

const RAW_TOOLS = [
  {
    name: 'check_configuration',
    title: 'Check Firecrawl MCP configuration',
    family: 'navigation',
    endpoint: null,
    description: 'Use this to check deployment identity/key presence, provider-execution state, local credit ceilings, and build provenance. This never contacts Firecrawl and never returns credential values.',
    inputSchema: object(),
    annotations: navigationAnnotations,
  },
  {
    name: 'list_capabilities',
    title: 'List Firecrawl MCP capabilities',
    family: 'navigation',
    endpoint: null,
    description: 'Use this to discover the exact reviewed tools, paid-call preview flow, credit controls, and deliberate exclusions. This never contacts Firecrawl.',
    inputSchema: object({ includeDescriptors: boolean('Include the complete bounded ToolManifest v2. Defaults false.') }),
    annotations: navigationAnnotations,
  },
  {
    name: 'get_endpoint_coverage',
    title: 'Get Firecrawl endpoint coverage',
    family: 'navigation',
    endpoint: null,
    description: 'Use this to inspect how all 50 reviewed official v2 operations map to five implemented provider tools or explicit exclusions. This is an audit ledger, not a claim of full provider support.',
    inputSchema: object({ filter: string('Optional case-insensitive method, route, operation, tool, status, or reason filter.', { maxLength: 100 }) }),
    annotations: navigationAnnotations,
  },
  {
    name: 'get_tool_usage',
    title: 'Explain one Firecrawl MCP tool',
    family: 'navigation',
    endpoint: null,
    description: 'Use this to retrieve the exact schema, annotations, endpoint, cost model, setup requirements, and safety behavior for one public tool. This never contacts Firecrawl.',
    inputSchema: object({ toolName: string('Exact public tool name.', { minLength: 1, maxLength: 100 }) }, ['toolName']),
    annotations: navigationAnnotations,
  },
  {
    name: 'firecrawl_get_credit_usage',
    title: 'Get Firecrawl credit usage',
    family: 'provider_read',
    endpoint: 'GET /v2/team/credit-usage',
    description: 'Use this to read bounded current team credit totals after deployment setup. This contacts only api.firecrawl.dev, does not spend credits, and returns a whitelist of usage fields.',
    inputSchema: object(),
    annotations: readAnnotations,
  },
  {
    name: 'firecrawl_get_queue_status',
    title: 'Get Firecrawl queue status',
    family: 'provider_read',
    endpoint: 'GET /v2/team/queue-status',
    description: 'Use this to read bounded Firecrawl queue and concurrency counts after deployment setup. This contacts only api.firecrawl.dev and does not create a job.',
    inputSchema: object(),
    annotations: readAnnotations,
  },
  {
    name: 'firecrawl_scrape_public_page',
    title: 'Scrape one public page',
    family: 'paid_provider_write',
    endpoint: 'POST /v2/scrape',
    cost: '1 credit per PDF page, projected conservatively from maxPdfPages',
    description: 'Use this for one bounded public page-to-Markdown scrape. It can spend credits and make Firecrawl access an external site. First omit previewToken and confirm for a local preview; then repeat the exact request with both fields to authorize one non-retried attempt.',
    inputSchema: object({
      url: publicUrl,
      maxPdfPages: integer('Maximum PDF pages Firecrawl may parse; also the conservative projected credit cost.', 1, 25, 5),
      maxCharacters,
      ...paidProperties,
    }, ['url']),
    annotations: paidAnnotations,
  },
  {
    name: 'firecrawl_search_public_web',
    title: 'Search the public web',
    family: 'paid_provider_write',
    endpoint: 'POST /v2/search',
    cost: '2 credits per request for up to 10 web metadata results',
    description: 'Use this for bounded public-web metadata search only. It can spend credits. Images, news, research, scrape options, and arbitrary provider options are unavailable. Preview locally first, then confirm the exact one-use request.',
    inputSchema: object({
      query: string('Public-web search query.', { minLength: 1, maxLength: 500 }),
      limit: integer('Maximum web results.', 1, 10, 10),
      includeDomains: array('Optional hostnames to include. Cannot be combined with excludeDomains.', string('Public DNS hostname only.', { minLength: 1, maxLength: 253 }), 1, 10),
      excludeDomains: array('Optional hostnames to exclude. Cannot be combined with includeDomains.', string('Public DNS hostname only.', { minLength: 1, maxLength: 253 }), 1, 10),
      maxCharacters,
      ...paidProperties,
    }, ['query']),
    annotations: paidAnnotations,
  },
  {
    name: 'firecrawl_map_public_site',
    title: 'Map one public site',
    family: 'paid_provider_write',
    endpoint: 'POST /v2/map',
    cost: '1 credit per request',
    description: 'Use this to return up to 25 deduplicated public URLs from one public site. It can spend credits. Subdomains are disabled, query parameters are deduplicated, cached sitemap data is allowed, and the provider request is capped at 30 seconds.',
    inputSchema: object({
      url: publicUrl,
      search: string('Optional relevance phrase used only to order mapped URLs.', { minLength: 1, maxLength: 200 }),
      sitemap: enumString('Sitemap discovery mode.', ['skip', 'include', 'only'], 'include'),
      limit: integer('Maximum mapped URLs.', 1, 25, 25),
      maxCharacters,
      ...paidProperties,
    }, ['url']),
    annotations: paidAnnotations,
  },
];

export const TOOLS = Object.freeze(RAW_TOOLS.map((tool) => Object.freeze({
  ...tool,
  category: tool.family,
  aliases: Object.freeze([]),
  outputSchema: boundedEnvelopeOutput,
  confirmation: tool.family === 'paid_provider_write' ? paidConfirmation : noConfirmation,
})));

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
export const PUBLIC_TOOL_DESCRIPTORS = Object.freeze(TOOLS.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  outputSchema,
  annotations,
})));
export const DESCRIPTOR_HASH = createHash('sha256').update(JSON.stringify(PUBLIC_TOOL_DESCRIPTORS), 'utf8').digest('hex');

const hashableDescriptor = (descriptor) => {
  const { ordinal: _ordinal, descriptorHash: _descriptorHash, ...hashable } = descriptor;
  return hashable;
};

export const buildToolManifest = (config) => {
  const documentationUrl = 'https://github.com/MADPANDA3D/FIRECRAWL-MCP#tools';
  const tools = TOOLS.map((tool, ordinal) => {
    const descriptor = {
      serviceId: SERVICE_ID,
      nativeToolName: tool.name,
      canonicalName: SERVICE_ID + '.' + tool.name,
      aliases: [...tool.aliases],
      title: tool.title,
      description: tool.description,
      category: tool.category,
      deprecation: {
        deprecated: false,
        since: null,
        replacement: null,
        sunsetAt: null,
        message: null,
      },
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      confirmation: tool.confirmation,
      documentationUrl,
      navigationRole: tool.category === 'navigation' ? tool.name : null,
      catalogVersion: config.catalogVersion,
      tier: 'agent_ready',
      ordinal,
    };
    return Object.freeze({
      ...descriptor,
      descriptorHash: sha256(canonicalJson(hashableDescriptor(descriptor))),
    });
  });
  const wireTools = tools.map(({ ordinal: _ordinal, ...tool }) => tool);
  return Object.freeze({
    schemaVersion: '2.0.0',
    serviceId: SERVICE_ID,
    catalogVersion: config.catalogVersion,
    buildSha: config.buildSha,
    descriptorHash: sha256(canonicalJson(wireTools)),
    counts: { raw: tools.length, agentReady: tools.length, legacy: 0, hidden: 0 },
    rawToolCount: tools.length,
    agentReadyToolCount: tools.length,
    documentedToolCount: tools.length,
    tools,
    provenance: {
      sourceFingerprint: config.sourceFingerprint,
      imageReference: config.imageReference,
      officialMcp: OFFICIAL_MCP_PROVENANCE,
      openapi: OPENAPI_PROVENANCE,
      cleanRoom: true,
    },
  });
};
