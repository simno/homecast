FROM node:26-slim

# Set working directory
WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# Create non-root user. Its home is outside /app so Chromium has somewhere
# writable for its caches while the app itself stays read-only.
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -m -d /home/nodejs nodejs

# Two variants from one Dockerfile:
#   full (default) - includes Playwright's Chromium for the headless-browser
#                    fallback that finds streams on JavaScript-only players
#   lite           - no browser; everything else works, and extraction simply
#                    stops before the headless-browser step
ARG VARIANT=full

# Install production dependencies. For full, add Chromium and the system
# libraries it needs (--with-deps: libnss3, libgbm, fonts, ...); this must run
# as root, before switching user. --only-shell skips the headed Chromium build
# (~400MB): lib/browser.js only ever launches headless. For lite, remove the Playwright package so the
# app sees it as unavailable instead of failing to launch a missing browser.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    if [ "$VARIANT" = "full" ]; then \
        npx playwright install --with-deps --only-shell chromium && \
        rm -rf /var/lib/apt/lists/*; \
    elif [ "$VARIANT" = "lite" ]; then \
        rm -rf node_modules/playwright node_modules/playwright-core \
            node_modules/.bin/playwright node_modules/.bin/playwright-core; \
    else \
        echo "Unknown VARIANT '$VARIANT' (expected full or lite)" >&2 && exit 1; \
    fi

# Copy application files (root-owned: the app never writes to its own code)
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# The only path the app writes to: AirPlay pairing credentials. Mount a volume
# here to keep pairings across container re-creation. A named volume inherits
# this directory's ownership; a bind-mounted host directory must be writable by
# uid 1001.
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=1024"

# Health check (uses PORT env var)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/devices', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Expose default port (can be overridden via PORT env var)
# Note: EXPOSE is documentation only - actual port binding happens at runtime
EXPOSE 3000

CMD ["node", "server.js"]
