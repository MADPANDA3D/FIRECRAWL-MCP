import { isAccessTokenValid, isPortalGrantValid } from './auth.js';
import {
  MCP_PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_TITLE,
  SERVICE_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_COUNT,
} from './constants.js';
import { PUBLIC_TOOL_DESCRIPTORS } from './manifest.js';
import { errorEnvelope, isPlainObject, newRequestId } from './util.js';
import { ServiceError } from './errors.js';

const LEGACY_TOOL_DESCRIPTORS = Object.freeze(PUBLIC_TOOL_DESCRIPTORS.map((descriptor) => {
  const { outputSchema: _outputSchema, ...legacy } = descriptor;
  return Object.freeze(legacy);
}));

const sendJson = (response, statusCode, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
};

const jsonRpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const readBody = (request, maximumBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  let settled = false;
  request.on('data', (chunk) => {
    if (settled) return;
    total += chunk.length;
    if (total > maximumBytes) {
      settled = true;
      reject(new ServiceError('request_too_large', 'The MCP request body exceeds the configured limit.', { statusCode: 413 }));
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (settled) return;
    try {
      resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      reject(error);
    }
  });
  request.on('error', (error) => {
    if (!settled) reject(error);
  });
});

const headerValue = (request, name) => request.headers[name.toLowerCase()];

const requestContext = (request, config) => ({
  readUserId: () => config.mode === 'portal' ? headerValue(request, 'x-madpanda-user-id') : 'standalone',
  readApiKey: () => headerValue(request, 'x-firecrawl-api-key'),
  readOperationBudget: () => headerValue(request, 'x-firecrawl-max-operation-credits'),
  readDailyBudget: () => headerValue(request, 'x-firecrawl-daily-credit-limit'),
});

const validJsonRpcId = (id) => (
  (typeof id === 'string' && id.length >= 1 && id.length <= 128 && !/[\r\n\0]/u.test(id))
  || (typeof id === 'number' && Number.isSafeInteger(id))
);

const validJsonRpcMethod = (method) => (
  typeof method === 'string'
  && method.length >= 1
  && method.length <= 100
  && !/[\r\n\0]/u.test(method)
);

const validJsonRpcRequest = (payload) => (
  isPlainObject(payload)
  && payload.jsonrpc === '2.0'
  && validJsonRpcMethod(payload.method)
  && !Object.hasOwn(payload, 'result')
  && !Object.hasOwn(payload, 'error')
  && (
    payload.params === undefined
    || isPlainObject(payload.params)
    || Array.isArray(payload.params)
  )
);

const toolCallResponse = (id, envelope, protocolVersion) => {
  const { toolManifest: _toolManifest, ...legacyData } = envelope.data || {};
  const legacyEnvelope = envelope.ok && envelope.meta?.tool === 'list_capabilities' && envelope.data?.tool_manifest
    ? { ...envelope, data: legacyData }
    : envelope;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{
        type: 'text',
        text: protocolVersion === MCP_PROTOCOL_VERSION
          ? envelope.ok
            ? 'Firecrawl MCP tool completed; use structuredContent.'
            : 'Firecrawl MCP tool failed with ' + envelope.error.code + '; use the attached structuredContent error.'
          : JSON.stringify(legacyEnvelope),
      }],
      ...(protocolVersion === MCP_PROTOCOL_VERSION ? { structuredContent: envelope } : {}),
      isError: !envelope.ok,
    },
  };
};

const healthPayload = (config, manifest) => {
  const grantConfigured = typeof config.portalGrantToken === 'string' && config.portalGrantToken.length >= 32;
  const accessTokenConfigured = typeof config.accessToken === 'string' && config.accessToken.length >= 32;
  const accessControlConfigured = config.mode === 'portal' ? grantConfigured : accessTokenConfigured;
  const immutableProvenanceConfigured = (
    /^[a-f0-9]{40}$/u.test(config.buildSha)
    && /^[a-f0-9]{64}$/u.test(config.sourceFingerprint)
    && /@sha256:[a-f0-9]{64}$/u.test(config.imageReference)
  );
  return {
    status: 'healthy',
    service: SERVICE_NAME,
    service_id: manifest.serviceId,
    version: SERVICE_VERSION,
    tool_count: TOOL_COUNT,
    raw_tool_count: manifest.rawToolCount,
    exposed_tool_count: TOOL_COUNT,
    agent_ready_tool_count: manifest.agentReadyToolCount,
    documented_tool_count: manifest.documentedToolCount,
    setup_status: config.providerExecutionEnabled ? 'provider_enabled' : 'setup_required',
    provider_execution_enabled: config.providerExecutionEnabled,
    provider_origin: config.providerOrigin,
    access_mode: config.mode,
    access_control_configured: accessControlConfigured,
    configuration_ready: accessControlConfigured,
    portal_grant_configured: grantConfigured,
    immutable_provenance_configured: immutableProvenanceConfigured,
    build_sha: config.buildSha,
    source_fingerprint: config.sourceFingerprint,
    image_reference: config.imageReference,
    catalog_version: config.catalogVersion,
    descriptor_hash: manifest.descriptorHash,
  };
};

export const createHttpHandler = ({ config, service }) => async (request, response) => {
  const origin = headerValue(request, 'origin');
  if (origin !== undefined) {
    sendJson(response, 403, { error: 'origin_forbidden', message: 'Browser-origin MCP requests are not accepted.' });
    request.resume();
    return;
  }
  const requestTarget = request.url || '/';
  if (request.method === 'GET' && requestTarget === '/health') {
    sendJson(response, 200, healthPayload(config, service.manifest));
    return;
  }
  if (requestTarget !== '/mcp') {
    sendJson(response, 404, { error: 'not_found', canonical_mcp_path: '/mcp' });
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed', allowed: ['POST'] }, { allow: 'POST' });
    return;
  }

  const protocolHeader = headerValue(request, 'mcp-protocol-version');
  if (protocolHeader !== undefined && (
    Array.isArray(protocolHeader)
    || typeof protocolHeader !== 'string'
    || !SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)
  )) {
    sendJson(response, 400, {
      error: 'unsupported_protocol_version',
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    });
    request.resume();
    return;
  }
  const effectiveProtocolVersion = protocolHeader || '2025-03-26';

  const authorized = config.mode === 'portal'
    ? isPortalGrantValid(headerValue(request, 'x-madpanda-portal-grant'), config.portalGrantToken)
    : isAccessTokenValid(headerValue(request, 'authorization'), config.accessToken);
  if (!authorized) {
    const message = config.mode === 'portal'
      ? 'A valid MAD MCP Portal grant is required.'
      : 'A valid Bearer access token is required.';
    const headers = config.mode === 'standalone' ? { 'www-authenticate': 'Bearer realm="firecrawl-mcp"' } : {};
    sendJson(response, 401, { error: 'unauthorized', message }, headers);
    request.resume();
    return;
  }
  const contentType = String(headerValue(request, 'content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/u.test(contentType)) {
    sendJson(response, 415, { error: 'unsupported_media_type', expected: 'application/json' });
    request.resume();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request, config.requestBodyMaxBytes));
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'request_too_large') {
      sendJson(response, 413, { error: error.code, message: error.message });
      return;
    }
    sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }
  if (!validJsonRpcRequest(payload)) {
    const safeId = isPlainObject(payload) && validJsonRpcId(payload.id) ? payload.id : null;
    sendJson(response, 400, jsonRpcError(safeId, -32600, 'Invalid Request'));
    return;
  }

  const { id, method, params } = payload;
  const hasId = Object.hasOwn(payload, 'id');
  if (!hasId) {
    response.writeHead(202, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (!validJsonRpcId(id)) {
    sendJson(response, 400, jsonRpcError(null, -32600, 'Invalid Request'));
    return;
  }
  if (method === 'notifications/initialized') {
    sendJson(response, 400, jsonRpcError(id, -32600, 'Notifications must not include an id'));
    return;
  }
  if (method === 'ping') {
    sendJson(response, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'initialize') {
    const validClientInfo = isPlainObject(params?.clientInfo)
      && typeof params.clientInfo.name === 'string'
      && params.clientInfo.name.length >= 1
      && params.clientInfo.name.length <= 200
      && typeof params.clientInfo.version === 'string'
      && params.clientInfo.version.length >= 1
      && params.clientInfo.version.length <= 100;
    const requestedVersion = params?.protocolVersion;
    const validRequestedVersion = typeof requestedVersion === 'string'
      && requestedVersion.length >= 1
      && requestedVersion.length <= 100
      && !/[\r\n\0]/u.test(requestedVersion);
    if (
      !isPlainObject(params)
      || !validRequestedVersion
      || !isPlainObject(params.capabilities)
      || !validClientInfo
    ) {
      sendJson(response, 400, jsonRpcError(id, -32602, 'Invalid initialize params', {
        supported_protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
        required: ['protocolVersion', 'capabilities', 'clientInfo.name', 'clientInfo.version'],
      }));
      return;
    }
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVICE_TITLE, version: SERVICE_VERSION },
        instructions: 'Use navigation tools first. Provider execution defaults disabled. Paid tools require an exact one-use 300-second preview token plus confirm=true.',
      },
    }, { 'mcp-protocol-version': protocolVersion });
    return;
  }
  if (method === 'tools/list') {
    const descriptors = effectiveProtocolVersion === MCP_PROTOCOL_VERSION
      ? PUBLIC_TOOL_DESCRIPTORS
      : LEGACY_TOOL_DESCRIPTORS;
    sendJson(response, 200, { jsonrpc: '2.0', id, result: { tools: descriptors } });
    return;
  }
  if (method === 'tools/call') {
    if (
      !isPlainObject(params)
      || typeof params.name !== 'string'
      || !/^[a-z0-9_]{1,100}$/u.test(params.name)
      || (params.arguments !== undefined && !isPlainObject(params.arguments))
    ) {
      sendJson(response, 400, jsonRpcError(id, -32602, 'Invalid params'));
      return;
    }
    const requestId = newRequestId();
    let envelope = await service.execute(params.name, params.arguments || {}, requestContext(request, config), requestId);
    let rpcPayload = toolCallResponse(id, envelope, effectiveProtocolVersion);
    if (Buffer.byteLength(JSON.stringify(rpcPayload), 'utf8') > config.toolOutputMaxBytes) {
      envelope = errorEnvelope({
        error: new ServiceError('tool_output_too_large', 'The bounded tool output exceeded 48 KiB.', { statusCode: 502 }),
        tool: params.name,
        requestId,
      });
      rpcPayload = toolCallResponse(id, envelope, effectiveProtocolVersion);
    }
    sendJson(response, 200, rpcPayload);
    return;
  }
  sendJson(response, 404, jsonRpcError(id, -32601, 'Method not found'));
};
