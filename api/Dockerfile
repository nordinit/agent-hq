# Agent HQ API image. Build context is the repository root.
FROM node:20-alpine AS builder

WORKDIR /build/api
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner

RUN addgroup -S agenthq && adduser -S agenthq -G agenthq

# pg/migrationDirs resolves four levels above dist/db/pg to the repository root.
# Keeping the compiled API at /app/api therefore makes that root /app.
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=agenthq:agenthq /build/api/dist ./dist
COPY --chown=agenthq:agenthq db/ /app/db/
COPY --chown=agenthq:agenthq agent-contracts/ /app/agent-contracts/
COPY --chown=agenthq:agenthq skills/create-agent/SKILL.md /app/skills/create-agent/SKILL.md
RUN mkdir -p /app/workspaces /app/uploads \
    && chown agenthq:agenthq /app/workspaces /app/uploads

ENV NODE_ENV=production \
    PORT=3501

EXPOSE 3501
USER agenthq

# Schema changes are a separate, single-actor command. Compose runs this same
# image as agent-hq-migrate before starting the non-mutating API process.
CMD ["node", "dist/index.js"]
