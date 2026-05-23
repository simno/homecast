/**
 * Mock Chromecast Device for Testing
 * Simulates a Chromecast device that can receive cast commands
 * Actually fetches and consumes the stream to generate real metrics
 * Only runs in development mode
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const EventEmitter = require('events');

class MockChromecast extends EventEmitter {
    constructor(name = 'Mock Chromecast', port = 8009) {
        super();
        this.name = name;
        this.port = port;
        this.playerState = 'IDLE';
        this.currentTime = 0;
        this.media = null;
        this.playbackInterval = null;
        this.startTime = null;
        this.streamRequest = null;
        this.streamResponse = null;
        this.liveEdgeTime = null; // Track live edge for HLS streams
        this.playlistRefreshTimeout = null; // Track playlist refresh timeout
    }

    start() {
        // Simulate connection listener
        this.server = http.createServer((req, res) => {
            res.writeHead(200);
            res.end('Mock Chromecast');
        });

        this.server.listen(this.port, () => {
            console.log(`[MockCast] ${this.name} listening on port ${this.port}`);
            console.log('[MockCast] Device ready for casting');
        });
    }

    load(mediaUrl, options = {}) {
        console.log(`[MockCast] Loading media: ${mediaUrl}`);
        this.media = {
            contentId: mediaUrl,
            contentType: options.contentType || 'video/mp4',
            streamType: options.streamType || 'BUFFERED'
        };

        this.currentTime = 0;
        this.playerState = 'BUFFERING';
        this.emit('status', this.getStatus());

        // Start fetching the stream to generate real metrics
        this.startStreamConsumption(mediaUrl);

        // Simulate initial buffering (2-3 seconds)
        const bufferTime = 2000 + Math.random() * 1000;
        setTimeout(() => {
            this.play();
        }, bufferTime);
    }

    startStreamConsumption(mediaUrl) {
        console.log(`[MockCast] Starting stream consumption: ${mediaUrl}`);

        // Check if this is an HLS stream
        const isHLS = mediaUrl.includes('.m3u8') || mediaUrl.includes('playlist');

        if (isHLS) {
            this.consumeHLSStream(mediaUrl);
        } else {
            this.consumeDirectStream(mediaUrl);
        }
    }

    consumeDirectStream(mediaUrl) {
        const protocol = mediaUrl.startsWith('https') ? https : http;

        this.streamRequest = protocol.get(mediaUrl, (res) => {
            this.streamResponse = res;
            console.log(`[MockCast] Direct stream connected, status: ${res.statusCode}`);

            // Consume the stream but discard the data
            let bytesReceived = 0;
            res.on('data', (chunk) => {
                bytesReceived += chunk.length;
                // Just discard the data - we only care about metrics
            });

            res.on('end', () => {
                console.log(`[MockCast] Stream ended, total bytes: ${bytesReceived}`);
                if (this.playerState === 'PLAYING') {
                    this.stop();
                }
            });

            res.on('error', (err) => {
                console.error('[MockCast] Stream error:', err.message);
            });
        });

        this.streamRequest.on('error', (err) => {
            console.error('[MockCast] Request error:', err.message);
        });
    }

    consumeHLSStream(playlistUrl) {
        console.log('[MockCast] Starting HLS stream consumption');

        const lastSegmentUrls = new Set(); // Track segments we've already downloaded

        // Fetch the playlist periodically and download segments
        const fetchPlaylist = () => {
            if (this.playerState === 'IDLE') return;

            const protocol = playlistUrl.startsWith('https') ? https : http;

            protocol.get(playlistUrl, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk.toString();
                });

                res.on('end', () => {
                    console.log(`[MockCast] Fetched playlist, size: ${data.length} bytes`);

                    // Parse URLs from playlist
                    const urls = this.parseHLSSegments(data, playlistUrl);
                    console.log(`[MockCast] Found ${urls.length} URLs in playlist`);

                    if (urls.length > 0) {
                        // Check if the response is an HLS playlist (contains #EXTM3U or #EXTINF)
                        // If so, it's a nested playlist regardless of URL extension
                        const isPlaylist = data.includes('#EXTM3U') || data.includes('#EXTINF');
                        const firstUrl = urls[0];

                        if (isPlaylist && firstUrl && (firstUrl.includes('.m3u8') || data.length < 10000)) {
                            // This is likely a master playlist pointing to media playlists
                            // Small size (<10KB) + HLS tags = probably a playlist reference
                            console.log(`[MockCast] Master playlist detected, fetching media playlist: ${firstUrl}`);
                            this.fetchMediaPlaylist(firstUrl, lastSegmentUrls);
                        } else {
                            // These are actual segments
                            const newSegments = urls.filter(url => !lastSegmentUrls.has(url));
                            if (newSegments.length > 0) {
                                console.log(`[MockCast] Found ${newSegments.length} new segments to download`);
                                newSegments.forEach(url => lastSegmentUrls.add(url));
                                this.downloadHLSSegments(newSegments);
                            }
                        }
                    }

                    // Check if it's a live stream (no EXT-X-ENDLIST)
                    const isLive = !data.includes('#EXT-X-ENDLIST');
                    console.log(`[MockCast] Stream type: ${isLive ? 'LIVE' : 'VOD'}`);

                    if (isLive && this.playerState !== 'IDLE') {
                        // Refresh playlist every 3 seconds for live streams
                        this.playlistRefreshTimeout = setTimeout(fetchPlaylist, 3000);
                    }
                });
            }).on('error', (err) => {
                console.error('[MockCast] Playlist fetch error:', err.message);
            });
        };

        fetchPlaylist();
    }

    fetchMediaPlaylist(playlistUrl, lastSegmentUrls) {
        const protocol = playlistUrl.startsWith('https') ? https : http;

        protocol.get(playlistUrl, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk.toString();
            });

            res.on('end', () => {
                console.log(`[MockCast] Fetched media playlist, size: ${data.length} bytes`);

                // Parse segment URLs from media playlist
                const segments = this.parseHLSSegments(data, playlistUrl);
                console.log(`[MockCast] Found ${segments.length} segments in media playlist`);

                // Check if response is still an HLS playlist (another nesting level)
                // Small size + HLS markers = nested playlist
                const isStillPlaylist = data.includes('#EXTM3U') && data.length < 10000;

                if (segments.length > 0 && (segments[0].includes('.m3u8') || isStillPlaylist)) {
                    // Another nested playlist level
                    console.log(`[MockCast] Nested playlist detected, fetching: ${segments[0]}`);
                    this.fetchMediaPlaylist(segments[0], lastSegmentUrls);
                    return;
                }

                // Only download new segments we haven't seen before
                const newSegments = segments.filter(url => !lastSegmentUrls.has(url));
                if (newSegments.length > 0) {
                    console.log(`[MockCast] Downloading ${newSegments.length} new segments`);
                    newSegments.forEach(url => lastSegmentUrls.add(url));
                    this.downloadHLSSegments(newSegments);
                } else {
                    console.log('[MockCast] All segments already downloaded');
                }
            });
        }).on('error', (err) => {
            console.error('[MockCast] Media playlist fetch error:', err.message);
        });
    }

    parseHLSSegments(playlistContent, baseUrl) {
        const lines = playlistContent.split('\n');
        const segments = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#')) continue;

            // This is a segment URL
            let segmentUrl = trimmed;

            // Resolve relative URLs
            if (!segmentUrl.startsWith('http')) {
                const base = new URL(baseUrl);
                if (segmentUrl.startsWith('/')) {
                    segmentUrl = `${base.protocol}//${base.host}${segmentUrl}`;
                } else {
                    const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/'));
                    segmentUrl = `${base.protocol}//${base.host}${basePath}/${segmentUrl}`;
                }
            }

            segments.push(segmentUrl);
        }

        return segments;
    }

    downloadHLSSegments(segments) {
        let currentIndex = 0;

        const downloadNext = () => {
            if (this.playerState === 'IDLE' || currentIndex >= segments.length) {
                return;
            }

            const segmentUrl = segments[currentIndex];
            currentIndex++;

            console.log(`[MockCast] Downloading segment ${currentIndex}/${segments.length}: ${segmentUrl.substring(0, 80)}...`);

            const protocol = segmentUrl.startsWith('https') ? https : http;

            protocol.get(segmentUrl, (res) => {
                let bytesReceived = 0;

                res.on('data', (chunk) => {
                    bytesReceived += chunk.length;
                    // Discard data
                });

                res.on('end', () => {
                    console.log(`[MockCast] Segment ${currentIndex} complete: ${bytesReceived} bytes`);
                    // Continue downloading next segment
                    if (this.playerState !== 'IDLE') {
                        // Small delay between segments to simulate playback
                        setTimeout(downloadNext, 100);
                    }
                });

                res.on('error', (err) => {
                    console.error('[MockCast] Segment download error:', err.message);
                    // Continue with next segment anyway
                    setTimeout(downloadNext, 100);
                });
            }).on('error', (err) => {
                console.error('[MockCast] Segment request error:', err.message);
                setTimeout(downloadNext, 100);
            });
        };

        downloadNext();
    }

    play() {
        if (this.playerState === 'PLAYING') return;

        console.log('[MockCast] Starting playback');
        this.playerState = 'PLAYING';
        this.startTime = Date.now() - (this.currentTime * 1000);

        // Initialize live edge for HLS streams
        if (this.media && this.media.streamType === 'LIVE') {
            this.liveEdgeTime = this.currentTime + 5; // Start 5 seconds behind live
            console.log(`[MockCast] Initialized live edge at ${this.liveEdgeTime}s`);
        }

        this.emit('status', this.getStatus());

        // Update currentTime every second
        this.playbackInterval = setInterval(() => {
            if (this.playerState === 'PLAYING') {
                this.currentTime = (Date.now() - this.startTime) / 1000;

                // For live streams, advance the live edge in real-time
                if (this.liveEdgeTime !== null) {
                    this.liveEdgeTime += 1; // Live edge moves forward 1 second per second
                }

                // Simulate occasional buffering (5% chance every second)
                if (Math.random() < 0.05) {
                    this.simulateBuffering();
                } else {
                    this.emit('status', this.getStatus());
                }
            }
        }, 1000);
    }

    simulateBuffering() {
        console.log(`[MockCast] Buffering at ${this.currentTime.toFixed(1)}s`);
        this.playerState = 'BUFFERING';
        this.emit('status', this.getStatus());

        // Resume after 1-3 seconds
        const bufferDuration = 1000 + Math.random() * 2000;
        setTimeout(() => {
            if (this.playerState === 'BUFFERING') {
                console.log('[MockCast] Resuming playback');
                this.playerState = 'PLAYING';
                this.startTime = Date.now() - (this.currentTime * 1000);
                this.emit('status', this.getStatus());
            }
        }, bufferDuration);
    }

    pause() {
        if (this.playerState !== 'PLAYING') return;

        console.log(`[MockCast] Pausing at ${this.currentTime.toFixed(1)}s`);
        this.playerState = 'PAUSED';
        if (this.playbackInterval) {
            clearInterval(this.playbackInterval);
            this.playbackInterval = null;
        }
        this.emit('status', this.getStatus());
    }

    stop() {
        console.log('[MockCast] Stopping playback');
        this.playerState = 'IDLE';
        this.currentTime = 0;
        this.media = null;
        this.liveEdgeTime = null;

        if (this.playbackInterval) {
            clearInterval(this.playbackInterval);
            this.playbackInterval = null;
        }

        // Clear playlist refresh timeout
        if (this.playlistRefreshTimeout) {
            clearTimeout(this.playlistRefreshTimeout);
            this.playlistRefreshTimeout = null;
        }

        // Stop stream consumption
        if (this.streamRequest) {
            this.streamRequest.destroy();
            this.streamRequest = null;
        }
        if (this.streamResponse) {
            this.streamResponse.destroy();
            this.streamResponse = null;
        }

        this.emit('status', this.getStatus());
        this.emit('close');
    }

    getStatus() {
        const status = {
            playerState: this.playerState,
            currentTime: this.currentTime,
            media: this.media
        };

        // Add liveSeekableRange for live HLS streams
        if (this.media && this.media.streamType === 'LIVE' && this.liveEdgeTime !== null) {
            status.liveSeekableRange = {
                start: Math.max(0, this.liveEdgeTime - 60), // Can seek back 60 seconds
                end: this.liveEdgeTime // Current live edge
            };
        }

        return status;
    }

    close() {
        this.stop();
        if (this.server) {
            this.server.close();
        }
        console.log(`[MockCast] ${this.name} closed`);
    }
}

// Mock client that mimics castv2-client interface
class MockCastClient extends EventEmitter {
    constructor(device) {
        super();
        this.device = device;
        this.connected = false;
    }

    connect(ip, callback) {
        console.log(`[MockCast] Client connecting to ${ip}`);
        setTimeout(() => {
            this.connected = true;
            console.log('[MockCast] Client connected');
            callback();
        }, 100);
    }

    getStatus(callback) {
        callback(null, {});
    }

    close() {
        this.connected = false;
        console.log('[MockCast] Client disconnected');
    }
}

// Mock player that mimics DefaultMediaReceiver interface
class MockPlayer extends EventEmitter {
    constructor(client, mockDevice) {
        super();
        this.client = client;
        this.mockDevice = mockDevice;

        // Forward events from mock device
        mockDevice.on('status', (status) => {
            this.emit('status', status);
        });

        mockDevice.on('close', () => {
            this.emit('close');
        });
    }

    load(media, options, callback) {
        console.log('[MockCast] Player loading media');
        setTimeout(() => {
            this.mockDevice.load(media.contentId, {
                contentType: media.contentType,
                streamType: media.streamType
            });
            callback(null, this.mockDevice.getStatus());
        }, 100);
    }

    play(callback) {
        this.mockDevice.play();
        if (callback) callback();
    }

    pause(callback) {
        this.mockDevice.pause();
        if (callback) callback();
    }

    stop(callback) {
        this.mockDevice.stop();
        if (callback) callback();
    }

    getStatus(callback) {
        callback(null, this.mockDevice.getStatus());
    }
}

module.exports = { MockChromecast, MockCastClient, MockPlayer };
