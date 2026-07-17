import { createServer } from 'node:http';

import { FirecrawlClient } from './client.js';
import { readConfig } from './config.js';
import { createHttpHandler } from './http.js';
import { PreviewLedger } from './ledger.js';
import { FirecrawlService } from './service.js';

const config = readConfig();
const ledger = await new PreviewLedger({
  path: config.ledgerPath,
  maxInFlight: config.maxInFlightPaid,
}).init();
const client = new FirecrawlClient({ config });
const service = new FirecrawlService({ config, client, ledger });
const server = createServer(createHttpHandler({ config, service }));

server.listen(config.port, config.host, () => {
  process.stdout.write('firecrawl-mcp listening on configured interface\n');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
