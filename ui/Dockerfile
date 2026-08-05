###############################################################################
# Dockerfile — Agent HQ UI (Next.js)
###############################################################################

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /build
COPY ui/package.json ui/package-lock.json ./
RUN npm ci

# ── Stage 2: builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY ui/ ./

ARG NEXT_PUBLIC_API_URL=http://localhost:3501
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -S agenthq && adduser -S agenthq -G agenthq

ENV NODE_ENV=production
ENV PORT=3500
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=agenthq:agenthq /build/.next/standalone ./
COPY --from=builder --chown=agenthq:agenthq /build/.next/static ./.next/static

EXPOSE 3500
USER agenthq
CMD ["node", "server.js"]
