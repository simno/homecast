FROM node:25-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application files
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=512"

# Health check (uses PORT env var)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/devices', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Expose default port (can be overridden via PORT env var)
# Note: EXPOSE is documentation only - actual port binding happens at runtime
EXPOSE 3000

CMD ["node", "server.js"]
