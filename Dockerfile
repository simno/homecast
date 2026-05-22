FROM node:26

# Set working directory
WORKDIR /app

# Install Playwright system dependencies and Chromium browser
# --with-deps installs all required shared libraries (libnss3, libgbm, etc.)
# Must run before switching to non-root user
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force && \
    PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers npx playwright install --with-deps chromium

# Copy application files
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -d /app nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# Health check (uses PORT env var)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/devices', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Expose default port (can be overridden via PORT env var)
# Note: EXPOSE is documentation only - actual port binding happens at runtime
EXPOSE 3000

CMD ["node", "server.js"]
