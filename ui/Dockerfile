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

ENV NEXT_PUBLIC_API_URL=http://agent-hq-api:3501
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3500
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /build/.next/standalone ./
COPY --from=builder /build/.next/static ./.next/static

EXPOSE 3500
CMD ["node", "server.js"]
