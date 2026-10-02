# Devices

HomeCast finds receivers on the local network over mDNS and SSDP. Each way of casting is listed separately in the
device picker. An LG TV with Chromecast built in therefore appears twice, once as **Chromecast** and once as
**LG webOS**.

If a device isn't found, press the rescan button next to the device list, or choose **Enter IP address…**.

## Chromecast and Cast TVs

Chromecasts play HLS, DASH, MP4 and WebM. You can change the volume and switch subtitles from the dashboard during
playback.

**Volume controlled by the TV.** Some Chromecasts, such as Google TV models set to control the TV's volume over
HDMI, don't let apps change their volume. If the TV is an LG webOS TV that HomeCast has cast to before, HomeCast
finds it (it's the one showing an HDMI input) and the dashboard's slider sets the TV's volume instead, labelled
**TV volume**. Otherwise the slider is disabled and the TV remote sets the volume.

Chromecasts and Cast TVs decode 4K only as HEVC, VP9 or AV1. A 4K H.264 stream plays at 1080p unless HomeCast can
[convert it](4k-conversion.md). An LG TV can instead play it as it is, in its browser (see below).

## Apple TV (AirPlay)

Apple TVs are cast to over AirPlay and play HLS and MP4. DASH streams have to be cast to a Chromecast or LG TV.

**PIN pairing.** If the Apple TV asks for a code (the default), HomeCast prompts for the code shown on screen the
first time you cast. It stores the pairing in `data/airplay-pairings.json` and reuses it after that. HomeCast works
with every **Allow Access** setting on the Apple TV:

| Allow Access                   | Pairing             |
|--------------------------------|---------------------|
| Everyone                       | None                |
| Anyone on the Same Network     | May ask for a PIN   |
| Only People Sharing This Home  | PIN required        |

Some models need one pairing even when set to **Everyone**.

**Controls.** Pause, seek and go live work from the dashboard. The volume is set with the Apple TV remote. The Apple
TV doesn't report how far behind live it is, so **Go live** is always offered during a live stream. It doesn't report
when a video ends either, so videos in **Up next** start when you press **Play next now**, not by themselves.

**TVs with AirPlay 2 built in** (LG, Samsung and others) aren't offered as AirPlay targets. They only play video
over AirPlay 2's encrypted sessions, and HomeCast sends AirPlay 1 video. Most of these TVs have Chromecast built in
as well, and LG TVs can also be cast to through their browser. For each TV it skips, the server log gives the reason
`no AirPlay 1 video`.

## LG webOS TVs

Casting to an **LG webOS** device opens HomeCast's player full screen in the TV's own web browser. The TV decodes the
stream itself, so 4K H.264 plays without conversion and without a GPU, and nothing is lost to re-encoding.

- **The first cast** shows an "allow this device?" prompt on the TV. Accept it with the remote. HomeCast keeps the
  TV's key in `data/webos-keys.json`, and later casts start without asking.
- **The TV must be able to reach HomeCast** on its port, because it loads the player page and the stream from
  HomeCast. LG TVs always stream through HomeCast's proxy, whatever the **Proxy stream** setting.
- **A TV in standby is woken** with Wake-on-LAN once HomeCast has been allowed on it. For this to work, turn on the
  TV's "TV On With Mobile" or "Turn on via Wi-Fi" setting (the name depends on the model).
- **Controls.** Pause, seek, go live and volume work from the dashboard. The play/pause and left/right keys on the
  TV's remote work too. Stopping the stream, or the video reaching its end, returns the TV to the input or app it
  was showing before.
- **Frame-rate headers are corrected.** Some streams declare a frame rate that doesn't match the video. X/Periscope
  broadcasts, for example, claim 1000 fps, and LG's player then plays them choppy. HomeCast checks each MPEG-TS
  segment's header against its timestamps. Where the two disagree, it rewrites only the header as the segment passes
  through, without re-encoding.
- **DASH** plays through dash.js. DRM-protected DASH can't be played.
- **Subtitles** are chosen when casting. They can't be switched from the dashboard during playback.

## Subtitles

After you press Analyze, the **Subtitles** picker lists what was found with the video:

- **On the page:** `<track>` elements next to the `<video>`
- **In the stream:** subtitle renditions in an HLS master playlist or a DASH manifest
- **From YouTube:** the uploader's subtitles, and YouTube's automatic captions of the original audio and of each
  dubbed audio track. YouTube's machine translations aren't offered: it refuses them without a sign-in token
- **From a URL:** any WebVTT or SRT file, for example for a plain MP4 on a file server

A long list starts with the likely languages (the video's own, your browser's and the last one you picked), with
**All languages…** to show the rest.

| Device     | Support                                                                                         |
|------------|-------------------------------------------------------------------------------------------------|
| Chromecast | All three. Tracks can be switched or turned off from the dashboard                              |
| LG webOS   | A separate file, or a language from the stream. Chosen when casting                             |
| Apple TV   | Subtitles inside HLS streams, turned on with the TV remote. AirPlay can't show a separate file  |

Subtitle files are always fetched through HomeCast, because receivers only accept them with CORS headers. On the
way, SRT is converted to WebVTT. The last language you picked becomes the default for the next video.

## Audio languages

When an HLS or DASH stream has audio in more than one language (YouTube's dubbed videos, multi-language broadcasts),
an **Audio** picker appears under Subtitles. It starts on the original audio where the stream marks one, otherwise on
the stream's own default. HomeCast's proxy hands the receiver only the language you picked, so this works on every
device, but needs the proxy (always used for LG webOS). The language is chosen when casting.
