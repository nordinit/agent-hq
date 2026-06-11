###############################################################################
# Dockerfile — Agent HQ API
#
# Production-ready multi-stage image for the Agent HQ API (Node.js/TypeScript).
#
# ── Build stages ──────────────────────────────────────────────────────────────
#   builder   Installs all dependencies and compiles TypeScript → dist/
#   runner    Lean runtime image — copies compiled output + prod deps only
#
# ── Key environment variables (all config via env vars) ───────────────────────
#   PORT               API listen port             (default: 3501)
#   AGENT_HQ_DB_PATH   Full path to the SQLite file (default: /data/agent-hq.db)
#   AGENT_HQ_DATA_DIR  Alternative: directory for the DB file (default: /data)
#                      (AGENT_HQ_DB_PATH takes precedence when both are set)
#
# ── Persistent volume ─────────────────────────────────────────────────────────
#   /data   Mount a named volume here to persist the SQLite database across
#           container restarts and image upgrades.
#
# ── Exposed ports ─────────────────────────────────────────────────────────────
#   3501   Agent HQ API (overridable via PORT env var)
#
# ── Quick start ───────────────────────────────────────────────────────────────
#   # Build (run from repo root):
#   docker build -t agent-hq-api -f api/Dockerfile .
#
#   # Run with a named volume for SQLite persistence:
#   docker run -d \
#     -p 3501:3501 \
#     -v agent-hq-data:/data \
#     agent-hq-api
###############################################################################

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Copy manifests first — better layer caching when source changes but deps don't
COPY api/package.json api/package-lock.json ./

# Install all deps (devDependencies are needed for tsc)
RUN npm ci

# Copy TypeScript config and source, then compile
COPY api/tsconfig.json ./
COPY api/src/ ./src/

RUN npm run build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies only
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /build/dist ./dist

# Create data directory for SQLite volume mount
RUN mkdir -p /data

# Declare /data as a volume — mount a named Docker volume here at runtime
# to persist the SQLite database across container restarts and upgrades.
VOLUME ["/data"]

# ── Runtime defaults — override all of these via environment variables ────────
ENV PORT=3501 \
    AGENT_HQ_DB_PATH=/data/agent-hq.db \
    NODE_ENV=production

EXPOSE 3501

CMD ["node", "dist/index.js"]
