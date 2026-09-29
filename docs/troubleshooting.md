# Troubleshooting

## No devices found

Discovery uses multicast, which only works on the local network.

- **In Docker, use host networking.** `docker inspect homecast | grep NetworkMode` should show `"host"`. Bridge
  networking blocks mDNS.
- **Check the log.** Run `docker logs homecast | grep -E "Discovery|AirPlay"`.
- **Check discovery status.** `http://<host>:3000/api/discovery/status` shows the network interfaces and what
  discovery has seen.
- **Common causes:** a firewall blocking UDP 5353 or 1900, HomeCast and the TV on different subnets or VLANs, or
  HomeCast running on a cloud server.

As a workaround, choose **Enter IP address…** in the device picker.

## The TV connects but nothing plays

- If the TV gives up on a stream, the dashboard shows its reason (for example *The TV could not decode this
  stream*). Try a lower quality.
- Make sure **Proxy stream** (under Advanced) is on.
- Check that the TV can reach HomeCast. If HomeCast advertises the wrong interface, set `HOST_IP` to its LAN address,
  and allow inbound connections on `PORT`.
- In the server log, `[Cast] Receiver reported …` is the TV's own error message.
- Check that the source URL still works.

## AirPlay

- **Wrong PIN.** The Apple TV shows a new code each time. Enter the number currently on screen.
- **Pairing fails.** Make sure the Apple TV and HomeCast are on the same network and that outbound TCP 7000 isn't
  blocked. Try restarting the Apple TV.
- **Reset a pairing.** Delete `airplay-pairings.json` from the data directory and restart. In Docker, run
  `docker exec homecast rm /app/data/airplay-pairings.json`.
- **"Everyone" mode doesn't work.** Some models need one pairing even with this setting. Pair once.
- **A TV with AirPlay 2 built in isn't listed.** This is expected. See [Devices](devices.md#apple-tv-airplay).

## LG TVs

- **No prompt on the TV.** The TV has to be on, not in standby, for the first cast.
- **The player page doesn't load.** The TV has to reach HomeCast on `PORT`. See the network table in
  [Configuration](configuration.md#network).
- **The TV doesn't wake from standby.** Turn on "TV On With Mobile" or "Turn on via Wi-Fi" in the TV's settings.

## 4K conversion not offered

The quality picker only offers converted 4K when HomeCast found a working encoder at startup. Check the log with
`docker logs homecast | grep Transcode`:

| Log message | Fix |
|-------------|-----|
| `does not exist — is /dev/dri passed through` | Add `devices: /dev/dri:/dev/dri` |
| `No permission to use /dev/dri/renderD…` | Add the render node's group with `group_add` (`stat -c %g /dev/dri/renderD128`) |
| `ffmpeg not found` | You're on an arm64 image, or one built with `TRANSCODE=none` |
| `vaapi (…) unusable` | The GPU can't encode HEVC through VAAPI, or the host driver is too old |
| `nvenc unusable` | The container can't reach the NVIDIA driver. Check that the NVIDIA Container Toolkit is installed and the GPU is reserved with the `video` capability |
| `No hardware HEVC encoder` (NVIDIA) | The GPU isn't reserved for the container at all (there's no `/dev/nvidiactl` inside it) |

With several Intel or AMD GPUs, set `TRANSCODE_DEVICE` to the right one.

If conversion runs but the dashboard's **Speed** stays near or below 1×, the GPU can't keep up. Check that nothing
else is using it (another transcoder, for example) and that `TRANSCODE_CONCURRENCY` is `1`.
