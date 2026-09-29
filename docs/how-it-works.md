# How it works

```
Browser ──▶ HomeCast ──▶ Chromecast / Apple TV / LG TV
   │           │                     │
   │  URL      │  finds the stream,  │  fetches playlists and segments
   └──────────▶│  casts it  ────────▶│  through HomeCast's proxy
               │◀────────────────────┘
               ▼
          source site
```

The browser only sends HomeCast the URL and shows the dashboard. HomeCast works out the stream, tells the receiver to
play it, and usually serves the stream to the receiver through its own proxy. The proxy:

- rewrites HLS playlists so every segment, key and subtitle is fetched through HomeCast, with the Referer the
  source expects
- adds the CORS headers receivers require
- caches playlists (briefly for live streams) and follows the live edge
- corrects headers receivers get wrong (frame rates on LG TVs) and, with a GPU, converts 4K H.264 to HEVC for
  Chromecasts

It also measures what the receiver actually fetches. That is where the dashboard's transfer rate, buffering and
latency figures come from, and how HomeCast notices a stalled stream and restarts it.

## Stream detection

Analyze tries the cheap methods first and stops as soon as it finds something castable. Its progress is shown as it
goes, and it can be cancelled at any point.

1. **The URL itself.** A stream link is recognised by its extension. If it has none, HomeCast sniffs the response.
2. **The page.** It looks at `<video>` and `<source>` elements, Open Graph and schema.org metadata, and URLs hidden in
   inline scripts (JSON-escaped, URL-encoded or base64).
3. **Embedded players.** It follows iframes a few levels deep. The frame that holds the player becomes the Referer.
4. **Player scripts.** It searches the page's own external scripts.
5. **A headless browser.** It loads the page, nudges the player to start and captures its network requests. This
   step also runs when a site blocks plain HTTP requests. It isn't available in the `lite` image.

Every candidate is then checked. Dead links are dropped. HLS master playlists report their qualities, and MP4 files
report their resolution and size. The likeliest main video is listed first, and ads, previews and single segments
are ranked lower.

Some sites have their own handling:

- **Twitch.** Live channels and VODs are resolved through Twitch's API.
- **X / Periscope.** Replays are distinguished from live broadcasts, and HomeCast remembers, per host, whether the
  CDN rejects a Referer.
- **SpaceX launch pages** (`spacex.com/launches/...`). The webcast is looked up in SpaceX's mission data. X
  broadcasts play. YouTube webcasts can't be cast.

## Protocols

- **Discovery:** mDNS (via multicast-dns) and SSDP
- **Chromecast:** Cast v2 via castv2-client
- **Apple TV:** AirPlay 1 on port 7000, with SRP-6a PIN pairing (2048-bit) and Curve25519/Ed25519 pair-verify
- **LG webOS:** the TV's SSAP WebSocket API opens HomeCast's player page in the TV's browser, which plays HLS
  natively and DASH through dash.js
- **Wake-on-LAN:** magic packets to the device's MAC address, which HomeCast learns from ARP

## Stack

Node.js 26 and Express 5 on the server, plain ES modules in the browser, with no build step. The Docker image is based
on `node:26-slim`. The full image adds Playwright's headless Chromium, and amd64 images add Jellyfin's FFmpeg.
