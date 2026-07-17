# Firecrawl v2 endpoint coverage

Reviewed source: Firecrawl documentation v2 OpenAPI JSON.

- Baseline commit: c4621cb28a9961bb6ecd268b1d8c8a838d84deb8
- Baseline snapshot SHA-256:
  bc340bd919cacac333812f42187b1fd419ac5cb983ad2bc8f89affb80cc20ca5
- Current review snapshot SHA-256:
  e6f3805fdfb8a927769e84463cc75ea4316b25d4d48bdb64ac27cb824db7b6ed
- Retrieval/review date: 2026-07-14
- Reviewed operations: 50
- Implemented: 5
- Explicitly excluded: 45

The current-review hash differs from the baseline snapshot and is retained as
drift provenance. The audited 50-operation inventory remains the v1.0.0
coverage contract. Complete means every reviewed operation is mapped or
excluded; it does not mean the service exposes every Firecrawl feature.

Provider auth for implemented operations is a request-scoped Firecrawl API key.
All implemented provider routes also require the access credential for the
selected startup mode. Portal mode additionally requires user identity.

| Method | v2 path | Operation | MCP mapping/disposition | Risk |
|---|---|---|---|---|
| POST | /monitor | createMonitor | Excluded: provider write/admin | Write |
| GET | /monitor | listMonitors | Excluded: bounded v1 scope | Read |
| GET | /monitor/{monitorId} | getMonitor | Excluded: bounded v1 scope | Read |
| PATCH | /monitor/{monitorId} | updateMonitor | Excluded: provider write/admin | Write |
| DELETE | /monitor/{monitorId} | deleteMonitor | Excluded: destructive | Destructive |
| POST | /monitor/{monitorId}/run | runMonitor | Excluded: provider write/admin | Write |
| GET | /monitor/{monitorId}/checks | listMonitorChecks | Excluded: bounded v1 scope | Read |
| GET | /monitor/{monitorId}/checks/{checkId} | getMonitorCheck | Excluded: bounded v1 scope | Read |
| POST | /scrape | scrapeAndExtractFromUrl | firecrawl_scrape_public_page | Paid, external |
| POST | /scrape/{jobId}/interact | interactWithScrapeBrowserSession | Excluded: unbounded interaction | High risk |
| DELETE | /scrape/{jobId}/interact | stopInteractiveScrapeBrowserSession | Excluded: destructive interaction | Destructive |
| POST | /parse | parseFile | Excluded: file/upload surface | High risk |
| POST | /batch/scrape | scrapeAndExtractFromUrls | Excluded: multi-page credit surface | Paid |
| GET | /batch/scrape/{id} | getBatchScrapeStatus | Excluded: async batch surface | Read |
| DELETE | /batch/scrape/{id} | cancelBatchScrape | Excluded: destructive async surface | Destructive |
| GET | /batch/scrape/{id}/errors | getBatchScrapeErrors | Excluded: async batch surface | Read |
| GET | /crawl/{id} | getCrawlStatus | Excluded: async crawl surface | Read |
| DELETE | /crawl/{id} | cancelCrawl | Excluded: destructive async surface | Destructive |
| GET | /crawl/{id}/errors | getCrawlErrors | Excluded: async crawl surface | Read |
| POST | /crawl | crawlUrls | Excluded: multi-page credit surface | Paid |
| POST | /crawl/params-preview | crawlParamsPreview | Excluded: crawl surface | Read-like |
| POST | /map | mapUrls | firecrawl_map_public_site | Paid, external |
| POST | /extract | extractData | Excluded: unbounded AI extraction | High risk |
| GET | /extract/{id} | getExtractStatus | Excluded: async extraction | Read |
| POST | /agent | startAgent | Excluded: autonomous execution | High risk |
| GET | /agent/{jobId} | getAgentStatus | Excluded: autonomous execution | Read |
| DELETE | /agent/{jobId} | cancelAgent | Excluded: destructive autonomous execution | Destructive |
| GET | /crawl/active | getActiveCrawls | Excluded: crawl surface | Read |
| GET | /team/credit-usage | getCreditUsage | firecrawl_get_credit_usage | Read |
| GET | /team/credit-usage/historical | getHistoricalCreditUsage | Excluded: bounded v1 scope | Read |
| GET | /team/token-usage | getTokenUsage | Excluded: bounded v1 scope | Read |
| GET | /team/token-usage/historical | getHistoricalTokenUsage | Excluded: bounded v1 scope | Read |
| GET | /team/queue-status | getQueueStatus | firecrawl_get_queue_status | Read |
| GET | /team/activity | getActivity | Excluded: bounded v1 scope | Read |
| POST | /search | searchAndScrape | firecrawl_search_public_web | Paid, external |
| POST | /interact | createBrowserSession | Excluded: browser session | High risk |
| GET | /interact | listBrowserSessions | Excluded: browser session | Read |
| POST | /interact/{sessionId}/execute | executeBrowserCode | Excluded: code execution | High risk |
| DELETE | /interact/{sessionId} | deleteBrowserSession | Excluded: destructive browser session | Destructive |
| GET | /scrape/{jobId} | getScrapeStatus | Excluded: async scrape surface | Read |
| POST | /search/{jobId}/feedback | submitSearchFeedback | Excluded: provider write/admin | Write |
| POST | /support/ask | askSupportAgent | Excluded: autonomous support/AI | High risk |
| POST | /support/docs-search | searchSupportDocs | Excluded: support surface | External |
| GET | /search/research/papers | researchSearchPapers | Excluded: research surface | External |
| GET | /search/research/papers/{id} | researchGetPaper | Excluded: research surface | External |
| GET | /search/research/papers/{id}/similar | researchRelatedPapers | Excluded: research surface | External |
| GET | /search/research/github | researchSearchGitHub | Excluded: research surface | External |
| POST | /feedback | submitEndpointFeedback | Excluded: provider write/admin | Write |
| GET | /team/threat-protection | getThreatProtection | Excluded: team admin | Read/admin |
| PUT | /team/threat-protection | updateThreatProtection | Excluded: team admin write | Write |

Every implemented route has local schema, fixed-route, fail-closed auth,
provider-disabled, output-whitelist, and no-live-provider tests. The three paid
routes additionally have preview binding, SSRF where applicable, accounting,
one-attempt, ambiguous-outcome, redaction, and request-body tests.
