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

# FFmpeg for converting 4K H.264 variants to HEVC so Chromecasts can play them
# (lib/transcode.js). Jellyfin's build: unlike Debian's it has NVENC for NVIDIA
# as well as VAAPI, with Intel's and AMD's drivers bundled — one package for
# any of the three, passed through per docker-compose.yml. amd64 only; the
# feature stays off elsewhere. TRANSCODE=none leaves it out (~200MB smaller).
# The repository key is fetched with Node (already here); apt reads .asc keys.
ARG TRANSCODE=gpu
ARG TARGETARCH
ENV FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg
RUN if [ "$TRANSCODE" != "none" ] && [ "$TARGETARCH" = "amd64" ]; then \
        apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
        node -e "fetch('https://repo.jellyfin.org/jellyfin_team.gpg.key').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(k => require('fs').writeFileSync('/usr/share/keyrings/jellyfin.asc', k))" && \
        . /etc/os-release && \
        echo "deb [signed-by=/usr/share/keyrings/jellyfin.asc] https://repo.jellyfin.org/debian $VERSION_CODENAME main" > /etc/apt/sources.list.d/jellyfin.list && \
        apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 && \
        rm -rf /var/lib/apt/lists/*; \
    fi

# yt-dlp, for YouTube (lib/youtube.js): its standalone build, which brings
# its own Python, checked against the release's SHA-256 list. It answers
# YouTube's challenges by running them in Node, already here. YouTube breaks
# older yt-dlp releases every few weeks, so the default takes the latest;
# YTDLP=2026.08.19 pins one, YTDLP=none leaves it out (~40MB smaller).
ARG YTDLP=latest
RUN if [ "$YTDLP" != "none" ]; then \
        case "$TARGETARCH" in \
            amd64) asset=yt-dlp_linux ;; \
            arm64) asset=yt-dlp_linux_aarch64 ;; \
            *) echo "No yt-dlp build for $TARGETARCH" >&2 && exit 1 ;; \
        esac && \
        base=$([ "$YTDLP" = "latest" ] && echo "https://github.com/yt-dlp/yt-dlp/releases/latest/download" \
            || echo "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP") && \
        ASSET="$asset" BASE="$base" node -e " \
            const { createHash } = require('crypto'); \
            const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }; \
            (async () => { \
                const [binary, sums] = await Promise.all([get(process.env.BASE + '/' + process.env.ASSET), get(process.env.BASE + '/SHA2-256SUMS')]); \
                const line = sums.toString().split('\n').find(l => l.trim().endsWith(' ' + process.env.ASSET)); \
                if (!line) throw new Error('No checksum listed for ' + process.env.ASSET); \
                if (createHash('sha256').update(binary).digest('hex') !== line.split(/\s+/)[0]) throw new Error('Checksum mismatch for ' + process.env.ASSET); \
                require('fs').writeFileSync('/usr/local/bin/yt-dlp', binary, { mode: 0o755 }); \
            })().catch(e => { console.error(e.message); process.exit(1); });" && \
        yt-dlp --version; \
    fi

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
