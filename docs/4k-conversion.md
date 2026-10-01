# 4K on Chromecast (HEVC conversion)

Chromecasts and Cast TVs decode 4K only as HEVC, VP9 or AV1. Some sources, including X/Periscope broadcasts, offer 4K
only as H.264. A Chromecast accepts such a stream, plays a couple of seconds and then stops. If you have a GPU that
encodes HEVC, HomeCast converts these streams segment by segment as it proxies them, so 4K Chromecasts can play them.

Apple TVs and LG TVs play 4K H.264 themselves, so their streams are never converted.

YouTube's 4K is VP9, not H.264, so it isn't converted either: receivers that decode VP9 play it as it is. "Highest
available" picks YouTube's H.264 1080p, which every receiver plays; choose 2160p VP9 in the quality menu for 4K. An
LG G3's Cast receiver plays it; an Android TV box that doesn't decode VP9 refuses to load it.

## Requirements

Conversion needs an amd64 image (arm64 images don't include FFmpeg) and a GPU that encodes HEVC in hardware, passed
through to the container:

| GPU | Encoder | Passing it through |
|-----|---------|--------------------|
| **Intel**: Arc, or an iGPU with Quick Sync (6th gen / Skylake or newer) | VAAPI | `devices: /dev/dri:/dev/dri`, plus `group_add` with the group that owns the render node (`stat -c %g /dev/dri/renderD128`) |
| **AMD**: Radeon RX 400 series (Polaris) or newer, and Ryzen APUs with Radeon graphics | VAAPI | Same as Intel |
| **NVIDIA**: GeForce GTX 950 (second-generation Maxwell) or newer, with a recent driver | NVENC | The [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host, and the GPU reserved with `capabilities: [gpu, video, utility]` |

When HomeCast runs directly on a Mac rather than in Docker, it uses Apple's VideoToolbox and the Mac's own FFmpeg.

The amd64 images use [Jellyfin's FFmpeg build](https://github.com/jellyfin/jellyfin-ffmpeg), which has the encoders
for all three vendors and bundles the Intel and AMD drivers.

> [!NOTE]
> Conversion was developed and tested on an Intel Arc GPU and on a Mac. AMD and NVIDIA use the same pipeline with
> their own encoders but haven't been tested on real hardware yet. Reports are welcome.

## Setup

```yaml
services:
  homecast:
    image: ghcr.io/simno/homecast:latest
    network_mode: host
    volumes:
      - homecast-data:/app/data

    # Intel or AMD
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "992"          # from: stat -c %g /dev/dri/renderD128

    # NVIDIA (instead of the above)
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu, video, utility]

volumes:
  homecast-data:
```

If there's more than one Intel or AMD GPU (for example an Arc next to an iGPU), set `TRANSCODE_DEVICE` to the one to
use, for example `renderD129`. `ls -l /dev/dri/by-path` shows which render node belongs to which PCI slot.

At startup the log says whether conversion is available, for example
`[Transcode] HEVC conversion available via Intel GPU (VAAPI), renderD129`, or why it isn't. See
[Troubleshooting](troubleshooting.md#4k-conversion-not-offered).

## Using it

When conversion is available, a Chromecast's quality picker marks the 4K version as *converted*, and
**Highest available** picks it. A Cast device can't be asked in advance whether it decodes 4K HEVC, so the cast itself
is the test. If a device rejects the converted stream before playing it, HomeCast automatically casts again at the
best quality the device plays directly, and that browser stops choosing conversion for the device.

For converted streams, the dashboard shows a **Converting to HEVC** panel with:

- the conversion speed as a multiple of real time (it has to stay above 1×)
- how many segments are ready ahead of the TV
- the converted and source bitrates
- GPU load and clock

What the GPU load measures depends on the driver. On Intel it's the whole GPU and on NVIDIA it's the encoder (from
`nvidia-smi`). On AMD it's the graphics engine, which doesn't include the video engine that does the encoding, so
the figure reads low.

## Quality

Re-encoding a compressed stream takes more bits than the original to keep the same quality. Each segment is encoded
at 4× its source bitrate, up to `TRANSCODE_BITRATE` (25 Mbps by default). On a 5.5 Mbps 4K broadcast, measured with
VMAF against the source, the converted stream scores about 94. The 1080p version the TV would otherwise upscale
scores 85. On a home network the extra bandwidth doesn't matter.

## Limits

- Only unencrypted MPEG-TS HLS segments can be converted, which is what these broadcasts use. Anything else plays
  as it is.
- Starting takes a few seconds, because the TV waits for about 10 seconds of converted video before it plays.
- Each segment runs in its own FFmpeg process. Decoding and encoding both happen on the GPU. The output is
  fragmented MP4 that keeps the source timestamps, so segments converted independently join seamlessly.
