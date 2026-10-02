# Configuration

HomeCast is configured with environment variables. The defaults suit most setups.

## Environment variables

| Variable                     | Default                         | Description |
|------------------------------|---------------------------------|-------------|
| `PORT`                       | `3000`                          | Web interface port |
| `HOST_IP`                    | auto-detect                     | LAN address receivers use to fetch streams from HomeCast. Set it if auto-detection picks the wrong interface |
| `NODE_ENV`                   | `development`                   | Set to `production` for deployment (the Docker image does this) |
| `STALE_DEVICE_TIMEOUT_HOURS` | `3`                             | Hours before a device that hasn't been seen is removed. Increase it for devices that rarely announce themselves |
| `CSRF_SECRET`                | random at startup               | Set it to keep browser sessions valid across restarts |
| `DISABLE_CSRF`               | `false`                         | Disables CSRF protection (not recommended) |
| `DISABLE_SSRF_PROTECTION`    | `false`                         | Allows HomeCast to fetch private and loopback addresses. Use it only if you need to cast from servers on your LAN, and only on a network you trust |
| `AIRPLAY_PAIRING_STORE`      | `./data/airplay-pairings.json`  | Where AirPlay pairings are stored |
| `WEBOS_KEY_STORE`            | `./data/webos-keys.json`        | Where the keys LG TVs give HomeCast are stored |
| `PLAYWRIGHT_BROWSERS_PATH`   | auto-detected                   | Path to Playwright's browser binaries |
| `YTDLP_PATH`                 | `yt-dlp` on the `PATH`          | The [yt-dlp](https://github.com/yt-dlp/yt-dlp) that YouTube links are resolved with. Without it, YouTube isn't supported |
| `SPONSORBLOCK_CATEGORIES`    | `sponsor,selfpromo,interaction` | [SponsorBlock](https://sponsor.ajay.app) categories skipped in YouTube videos, comma-separated (also `intro`, `outro`, `preview`, `hook`, `filler`, `music_offtopic`). `none` turns skipping off. These are the defaults under Advanced, where each YouTube cast can pick its own |

### 4K conversion

See [4K on Chromecast](4k-conversion.md).

| Variable                | Default | Description |
|-------------------------|---------|-------------|
| `TRANSCODE_DEVICE`      | auto (tries each `/dev/dri/renderD*`) | GPU to use, e.g. `renderD129` or `/dev/dri/renderD129` |
| `TRANSCODE_ENCODER`     | `auto`  | `auto`, `vaapi` (Intel, AMD), `nvenc` (NVIDIA), `videotoolbox` (Mac), `x265` (software; too slow for 4K, for testing only) or `off` |
| `TRANSCODE_BITRATE`     | `25M`   | Maximum bitrate for a converted segment. Each segment gets 4× its source bitrate, up to this limit |
| `TRANSCODE_CONCURRENCY` | `1`     | Segments encoded at once. Most GPUs have one video engine, where two encodes just take turns. Try `2` on a GPU with two |

### Advanced tuning

Change these only to work around a specific problem.

| Variable                     | Default | Description |
|------------------------------|---------|-------------|
| `STALL_TIMEOUT_SECONDS`      | `15`    | Seconds a Chromecast can go without fetching any media before its stream is restarted |
| `MAX_RECOVERY_ATTEMPTS`      | `3`     | Restarts after a stall before giving up |
| `HEARTBEAT_INTERVAL_SECONDS` | `5`     | How often each device connection is checked |
| `MAX_MISSED_HEARTBEATS`      | `3`     | Missed checks before a connection is marked unhealthy |
| `RECONNECT_DELAY_SECONDS`    | `10`    | Wait before reconnecting to a device that dropped |
| `MAX_RECONNECT_ATTEMPTS`     | `3`     | Reconnection attempts before giving up |
| `CACHE_TTL_VOD_SECONDS`      | `60`    | How long an on-demand HLS playlist is cached |
| `CACHE_TTL_LIVE_SECONDS`     | `4`     | Maximum time a live HLS playlist is cached (capped at half its target segment duration) |

## Persistent data

`/app/data` in the container holds AirPlay pairings and LG TV keys. Mount a volume there. Otherwise Apple TVs that
need a PIN have to be paired again, and LG TVs ask again to allow HomeCast, every time the container is re-created.

To use a host directory instead of a named volume, create the directory first and make it writable by the container
user:

```bash
mkdir data && sudo chown 1001:1001 data
```

## Network

Discovery uses multicast, so in Docker HomeCast needs `network_mode: host`. Bridge networking blocks it. Receivers
connect back to HomeCast to fetch the stream, so they have to be able to reach it on `PORT`.

| Port        | Direction | Used for |
|-------------|-----------|----------|
| `PORT`/tcp  | inbound   | Web interface; receivers fetching streams |
| 5353/udp    | both      | mDNS discovery |
| 1900/udp    | both      | SSDP discovery (Cast TVs, LG TVs) |
| 8008–8009/tcp | outbound | Chromecast |
| 7000/tcp    | outbound  | AirPlay |
| 3000–3001/tcp | outbound | LG webOS |
| 7, 9/udp    | outbound  | Wake-on-LAN (broadcast) |
