# syntax=docker/dockerfile:1

# ── Builder ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (cached unless package-lock.json changes)
COPY package.json package-lock.json ./
RUN npm ci

# NEXT_PUBLIC_* env vars are inlined at build time — accept as build arg
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY . .
RUN npm run build

# ── Runner ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy just what's needed to run `next start`
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["npm", "start"]
