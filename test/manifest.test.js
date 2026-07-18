import assert from 'node:assert/strict';
import test from 'node:test';

import { COVERAGE_SUMMARY, ENDPOINT_COVERAGE } from '../src/coverage.js';
import { TOOL_COUNT } from '../src/constants.js';
import {
  buildToolManifest,
  PUBLIC_TOOL_DESCRIPTORS,
  TOOLS,
} from '../src/manifest.js';
import { canonicalJson, sha256 } from '../src/util.js';
import { makeConfig } from './helpers.js';

const exactNames = [
  'check_configuration',
  'list_capabilities',
  'get_endpoint_coverage',
  'get_tool_usage',
  'firecrawl_get_credit_usage',
  'firecrawl_get_queue_status',
  'firecrawl_scrape_public_page',
  'firecrawl_search_public_web',
  'firecrawl_map_public_site',
];

test('public inventory is the exact nine-name v1 contract with no aliases', () => {
  assert.equal(TOOL_COUNT, 9);
  assert.deepEqual(TOOLS.map(({ name }) => name), exactNames);
  assert.equal(new Set(TOOLS.map(({ name }) => name)).size, 9);
  assert.ok(TOOLS.every(({ aliases }) => aliases.length === 0));
});

test('all MCP descriptors expose complete schemas and required annotations', () => {
  assert.equal(PUBLIC_TOOL_DESCRIPTORS.length, 9);
  for (const descriptor of PUBLIC_TOOL_DESCRIPTORS) {
    assert.equal(descriptor.inputSchema.type, 'object');
    assert.equal(descriptor.outputSchema.type, 'object');
    assert.equal(descriptor.outputSchema.additionalProperties, false);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint', 'idempotentHint']) {
      assert.equal(typeof descriptor.annotations[hint], 'boolean');
    }
  }
});

test('paid tools are non-read-only, destructive, open-world, non-idempotent and confirm with one-use token', () => {
  const paid = TOOLS.filter(({ family }) => family === 'paid_provider_write');
  assert.equal(paid.length, 3);
  for (const tool of paid) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    assert.equal(tool.confirmation.required, true);
    assert.equal(tool.confirmation.previewTokenTtlSeconds, 300);
    assert.equal(tool.confirmation.tokenParameter, 'previewToken');
    assert.equal(tool.confirmation.confirmationValue, true);
  }
});

test('list_capabilities accepts only the canonical descriptor flag and its compatibility alias', () => {
  const schema = TOOLS.find(({ name }) => name === 'list_capabilities').inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.include_descriptors.type, 'boolean');
  assert.equal(schema.properties.includeDescriptors.type, 'boolean');
});

test('ToolManifest v2 is complete, deterministic, and hash-verifiable', () => {
  const manifest = buildToolManifest(makeConfig());
  const roundTrip = JSON.parse(JSON.stringify(manifest));
  assert.equal(roundTrip.schemaVersion, '2.0.0');
  assert.equal(roundTrip.serviceId, 'firecrawl');
  assert.deepEqual(roundTrip.counts, { raw: 9, agentReady: 9, legacy: 0, hidden: 0 });
  assert.equal(roundTrip.tools.length, 9);
  assert.equal(roundTrip.provenance.cleanRoom, true);
  assert.equal(roundTrip.provenance.openapi.operation_count, 50);
  assert.equal(roundTrip.provenance.openapi.baseline_commit, 'c4621cb28a9961bb6ecd268b1d8c8a838d84deb8');
  for (const tool of roundTrip.tools) {
    assert.equal(tool.canonicalName, 'firecrawl.' + tool.nativeToolName);
    assert.equal(tool.deprecation.deprecated, false);
    assert.equal(tool.outputSchema.type, 'object');
    const { ordinal: _ordinal, descriptorHash, ...hashable } = tool;
    assert.equal(descriptorHash, sha256(canonicalJson(hashable)));
  }
  const wireTools = roundTrip.tools.map(({ ordinal: _ordinal, ...tool }) => tool);
  assert.equal(roundTrip.descriptorHash, sha256(canonicalJson(wireTools)));
});

test('all 50 reviewed OpenAPI operations are accounted for exactly once', () => {
  assert.equal(ENDPOINT_COVERAGE.length, 50);
  assert.equal(new Set(ENDPOINT_COVERAGE.map(({ method, path }) => method + ' ' + path)).size, 50);
  assert.equal(ENDPOINT_COVERAGE.filter(({ status }) => status === 'implemented').length, 5);
  assert.equal(ENDPOINT_COVERAGE.filter(({ status }) => status === 'excluded').length, 45);
  assert.equal(COVERAGE_SUMMARY.reviewed_scope_complete, true);
  assert.equal(COVERAGE_SUMMARY.endpoint_complete, false);
  assert.ok(ENDPOINT_COVERAGE.every((row) => row.tool || row.reason));
});

test('full ToolManifest response remains inside the 48 KiB result boundary', async () => {
  const manifest = buildToolManifest(makeConfig());
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 49152);
});
