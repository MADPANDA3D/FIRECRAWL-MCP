# linux/amd64 Node 24.18.0 LTS pin. Update the digest deliberately when upgrading.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

ARG BUILD_SHA=development
ARG SOURCE_FINGERPRINT=development

LABEL org.opencontainers.image.title="MADPANDA Firecrawl MCP" \
      org.opencontainers.image.description="Dual-mode, budgeted clean-room Firecrawl adapter" \
      org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.source="https://github.com/MADPANDA3D/FIRECRAWL-MCP" \
      org.opencontainers.image.licenses="MIT" \
      com.madpanda.source-fingerprint="${SOURCE_FINGERPRINT}"

RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /opt/yarn-v* /usr/local/lib/node_modules \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/runtime-smoke.mjs ./scripts/runtime-smoke.mjs
COPY --chown=node:node README.md CHANGELOG.md LICENSE NOTICE ./

ENV NODE_ENV=production \
    MCP_MODE=standalone \
    HOST=0.0.0.0 \
    PORT=8080 \
    HOME=/tmp \
    FIRECRAWL_PROVIDER_EXECUTION_ENABLED=false \
    MCP_BUILD_SHA="${BUILD_SHA}" \
    MCP_SOURCE_FINGERPRINT="${SOURCE_FINGERPRINT}"

EXPOSE 8080
VOLUME ["/data"]
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:8080/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{const j=JSON.parse(b);process.exit(r.statusCode===200&&j.status==='healthy'&&j.tool_count===9?0:1)}catch{process.exit(1)}})}).on('error',()=>process.exit(1))"]

CMD ["node", "src/server.js"]
