import { OPENAPI_PROVENANCE } from './constants.js';

const included = new Map([
  ['GET /team/credit-usage', 'firecrawl_get_credit_usage'],
  ['GET /team/queue-status', 'firecrawl_get_queue_status'],
  ['POST /scrape', 'firecrawl_scrape_public_page'],
  ['POST /search', 'firecrawl_search_public_web'],
  ['POST /map', 'firecrawl_map_public_site'],
]);

const operations = Object.freeze([
  ['POST', '/monitor', 'createMonitor'],
  ['GET', '/monitor', 'listMonitors'],
  ['GET', '/monitor/{monitorId}', 'getMonitor'],
  ['PATCH', '/monitor/{monitorId}', 'updateMonitor'],
  ['DELETE', '/monitor/{monitorId}', 'deleteMonitor'],
  ['POST', '/monitor/{monitorId}/run', 'runMonitor'],
  ['GET', '/monitor/{monitorId}/checks', 'listMonitorChecks'],
  ['GET', '/monitor/{monitorId}/checks/{checkId}', 'getMonitorCheck'],
  ['POST', '/scrape', 'scrapeAndExtractFromUrl'],
  ['POST', '/scrape/{jobId}/interact', 'interactWithScrapeBrowserSession'],
  ['DELETE', '/scrape/{jobId}/interact', 'stopInteractiveScrapeBrowserSession'],
  ['POST', '/parse', 'parseFile'],
  ['POST', '/batch/scrape', 'scrapeAndExtractFromUrls'],
  ['GET', '/batch/scrape/{id}', 'getBatchScrapeStatus'],
  ['DELETE', '/batch/scrape/{id}', 'cancelBatchScrape'],
  ['GET', '/batch/scrape/{id}/errors', 'getBatchScrapeErrors'],
  ['GET', '/crawl/{id}', 'getCrawlStatus'],
  ['DELETE', '/crawl/{id}', 'cancelCrawl'],
  ['GET', '/crawl/{id}/errors', 'getCrawlErrors'],
  ['POST', '/crawl', 'crawlUrls'],
  ['POST', '/crawl/params-preview', 'crawlParamsPreview'],
  ['POST', '/map', 'mapUrls'],
  ['POST', '/extract', 'extractData'],
  ['GET', '/extract/{id}', 'getExtractStatus'],
  ['POST', '/agent', 'startAgent'],
  ['GET', '/agent/{jobId}', 'getAgentStatus'],
  ['DELETE', '/agent/{jobId}', 'cancelAgent'],
  ['GET', '/crawl/active', 'getActiveCrawls'],
  ['GET', '/team/credit-usage', 'getCreditUsage'],
  ['GET', '/team/credit-usage/historical', 'getHistoricalCreditUsage'],
  ['GET', '/team/token-usage', 'getTokenUsage'],
  ['GET', '/team/token-usage/historical', 'getHistoricalTokenUsage'],
  ['GET', '/team/queue-status', 'getQueueStatus'],
  ['GET', '/team/activity', 'getActivity'],
  ['POST', '/search', 'searchAndScrape'],
  ['POST', '/interact', 'createBrowserSession'],
  ['GET', '/interact', 'listBrowserSessions'],
  ['POST', '/interact/{sessionId}/execute', 'executeBrowserCode'],
  ['DELETE', '/interact/{sessionId}', 'deleteBrowserSession'],
  ['GET', '/scrape/{jobId}', 'getScrapeStatus'],
  ['POST', '/search/{jobId}/feedback', 'submitSearchFeedback'],
  ['POST', '/support/ask', 'askSupportAgent'],
  ['POST', '/support/docs-search', 'searchSupportDocs'],
  ['GET', '/search/research/papers', 'researchSearchPapers'],
  ['GET', '/search/research/papers/{id}', 'researchGetPaper'],
  ['GET', '/search/research/papers/{id}/similar', 'researchRelatedPapers'],
  ['GET', '/search/research/github', 'researchSearchGitHub'],
  ['POST', '/feedback', 'submitEndpointFeedback'],
  ['GET', '/team/threat-protection', 'getThreatProtection'],
  ['PUT', '/team/threat-protection', 'updateThreatProtection'],
]);

const exclusionReason = (method, path) => {
  if (/interact|agent|extract|parse|research|support/iu.test(path)) return 'excluded_high_risk_or_unbounded_execution_surface';
  if (/monitor|feedback|threat-protection/iu.test(path)) return 'excluded_provider_write_or_administration_surface';
  if (/crawl|batch/iu.test(path)) return 'excluded_async_or_multi_page_credit_surface';
  if (/historical|token-usage|activity/iu.test(path)) return 'excluded_from_bounded_v1_scope';
  if (method === 'DELETE' || method === 'PATCH' || method === 'PUT') return 'excluded_destructive_or_mutating_surface';
  return 'excluded_from_bounded_v1_scope';
};

export const ENDPOINT_COVERAGE = Object.freeze(operations.map(([method, path, operationId]) => {
  const tool = included.get(`${method} ${path}`) || null;
  return Object.freeze({
    method,
    path: `/v2${path}`,
    operation_id: operationId,
    status: tool ? 'implemented' : 'excluded',
    tool,
    reason: tool ? null : exclusionReason(method, path),
  });
}));

export const COVERAGE_SUMMARY = Object.freeze({
  reviewed_operations: ENDPOINT_COVERAGE.length,
  implemented_operations: ENDPOINT_COVERAGE.filter(({ status }) => status === 'implemented').length,
  excluded_operations: ENDPOINT_COVERAGE.filter(({ status }) => status === 'excluded').length,
  reviewed_scope_complete: ENDPOINT_COVERAGE.length === OPENAPI_PROVENANCE.operation_count,
  endpoint_complete: false,
  statement: 'Complete against the reviewed nine-tool v1 scope; all 50 reviewed v2 operations are explicitly accounted for. This is not full provider endpoint coverage.',
});
