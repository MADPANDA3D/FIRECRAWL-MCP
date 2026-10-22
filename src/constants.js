export const SERVICE_NAME = 'firecrawl-mcp';
export const SERVICE_ID = 'firecrawl';
export const SERVICE_TITLE = 'MADPANDA Firecrawl MCP';
export const SERVICE_VERSION = '1.1.1';
export const TOOL_COUNT = 9;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

export const FIRECRAWL_ORIGIN = 'https://api.firecrawl.dev';
export const FIRECRAWL_HOST = 'api.firecrawl.dev';
export const FIRECRAWL_ROUTES = Object.freeze({
  firecrawl_get_credit_usage: Object.freeze({ method: 'GET', path: '/v2/team/credit-usage', paid: false }),
  firecrawl_get_queue_status: Object.freeze({ method: 'GET', path: '/v2/team/queue-status', paid: false }),
  firecrawl_scrape_public_page: Object.freeze({ method: 'POST', path: '/v2/scrape', paid: true }),
  firecrawl_search_public_web: Object.freeze({ method: 'POST', path: '/v2/search', paid: true }),
  firecrawl_map_public_site: Object.freeze({ method: 'POST', path: '/v2/map', paid: true }),
});

export const OFFICIAL_MCP_PROVENANCE = Object.freeze({
  repository: 'https://github.com/firecrawl/firecrawl-mcp-server',
  commit: '3eb1115b1f2883ff2fb74e61b5c4acf5a9ac0fb0',
  tree: 'e8d0b344b8f27920714a995f87a2433e90b1140d',
  package: 'firecrawl-mcp@3.22.3',
  archive_sha256: '9015b8846d36ae6bf1f3bbcfdf83e36c908f20721ab20912cbee64c0b13ccd82',
  license: 'MIT',
});

export const OPENAPI_PROVENANCE = Object.freeze({
  repository: 'https://github.com/firecrawl/firecrawl-docs',
  baseline_commit: 'c4621cb28a9961bb6ecd268b1d8c8a838d84deb8',
  baseline_snapshot_sha256: 'bc340bd919cacac333812f42187b1fd419ac5cb983ad2bc8f89affb80cc20ca5',
  review_snapshot_sha256: 'e6f3805fdfb8a927769e84463cc75ea4316b25d4d48bdb64ac27cb824db7b6ed',
  operation_count: 50,
  retrieved_at: '2026-07-14',
});
