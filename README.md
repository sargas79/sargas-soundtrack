# Sargas Soundtrack

A Foundry VTT v14 module that streams the GM's live music to every player.
The GM's browser captures the music playing on the GM's PC (a browser tab such
as a web music player, or an audio input such as a virtual audio cable) and
sends it live over WebRTC to each player's Foundry, where it plays on the core
**Music** channel. It follows each player's Music volume slider and Foundry's
global mute.

Foundry's module socket carries only the connection handshake. The server never
carries the audio. The module contains no code specific to any streaming
service and records nothing.

## Installation

Install on the Foundry server by pasting the manifest URL into Foundry's
**Install Module** dialog:

```
https://github.com/sargas79/sargas-soundtrack/releases/latest/download/module.json
```

Requires Foundry VTT **14.370** or later. The module is system-agnostic.
Players install nothing: it loads for them from the server.

## Requirements

- The GM must open Foundry over **HTTPS**. Browsers only allow audio capture in
  secure contexts (`localhost` counts).
- The GM must use a **Chromium-based browser** (Chrome, Edge, Brave...) for the
  Browser tab source. Firefox cannot capture tab audio; the Audio device source
  may still work there. Players can use any browser.
- The GM should wear **headphones**, so the captured music is not picked up
  again through the speakers (and fed back to Discord as an echo).

## Quick start

Enable the module in your world, then open the **Playlists** tab of the
sidebar. A **Sargas Soundtrack** row sits near the top of it. Only the active
GM sees the GM controls; everybody else sees the player row.

### Route A: a browser tab (simplest)

1. Open your music player in another tab of the same browser.
2. In the Foundry row, leave **Source** on *Browser tab* and click **Go live**.
3. In the browser's picker, choose the music **tab** (not a window or the whole
   screen) and tick **Also share tab audio**.
4. Players hear it within a second or two. Use **Stop** when you are done.

Tab capture needs a click every time: the browser forgets the permission, so
after reloading Foundry you must pick the tab again.

### Route B: an audio device such as VB-Cable (any desktop player)

1. Install a virtual audio cable (for example VB-Cable).
2. Send **only your desktop music app** to
   *CABLE Input*: in Windows open **Volume mixer** or **App volume and device
   preferences** and set that app's output to *CABLE Input*.
3. In the Foundry row choose **Source: Audio device**, press the refresh button
   to list your inputs, and pick *CABLE Output*. The browser may ask for
   microphone permission once, because that is how it reveals device names.
4. Click **Go live**. Your choice of device is remembered on that browser.

> The VB-Cable installer makes CABLE your default Windows playback and
> recording devices. Set your real speakers or headphones and microphone back
> as the Windows defaults. In Discord keep input and output on **Default** or
> on your real devices, never on a CABLE device.

## The GM row

| Control | What it does |
| --- | --- |
| **Go live / Stop** | Starts or stops the broadcast. Go live opens the tab picker for the Browser tab source. |
| **Source** | *Browser tab* or *Audio device*. Changing it while live switches the source without reconnecting anyone. A tab switch may ask you to pick the tab again. |
| **Audio device** list + refresh | Filled only when you ask (choosing Audio device, or the refresh button), because the browser may briefly open the microphone to read device names. |
| **Send level** | Master level of what is sent to the players. |
| **Monitor** | How loud *you* hear what is being sent, on top of your own Music slider. |
| **Fade out / Fade in** | 3 second ramps of the send level, to 0 and back to your Send level. They are scheduled on the audio clock, so they stay smooth with the tab in the background. |
| **Level meter** | Level of the signal actually being sent (after fades). |
| **Players** | One line per player: *Connected*, *Connecting*, *Failed* or *Not connected*, plus, every 2 seconds while live, the measured **kbps**, **% loss** and the route type: `host` (same network), `srflx` (through NAT) or `relay` (through a TURN server). |
| **Now playing** | A line you type (saved when you press Enter or leave the box). Every player sees it. |

## The player row

- A live indicator: *Not live*, *Connecting...*, *Live from the GM* or
  *Connection failed* (the module keeps retrying by itself).
- **Mute for me**: a personal mute that only affects this player.
- The GM's **Now playing** line.
- If the browser has not had a click yet, a hint says that audio starts after
  you click anywhere in the window.

Volume is the core **Music** slider in Foundry's audio settings; there is no
separate volume control. Foundry's global mute applies too.

## Settings

| Setting | Scope | Default | Purpose |
| --- | --- | --- | --- |
| ICE servers (JSON) | World, in Module Settings | one public STUN server | STUN and TURN servers for every connection. Invalid values fall back to the default and warn the GM once. See [TURN with coturn](#turn-with-coturn). |
| Relay only (TURN test) | World, in Module Settings | off | Forces every connection through a TURN relay, to check that it works. Leave it off in normal play. A change applies to new connections: Stop and Go live again. See [Testing the relay](#testing-the-relay). |
| Also use Foundry's relay server | World, in Module Settings | on | When Foundry's Audio/Video settings use a Custom Relay Server, the module adds it to its ICE servers. See [Reusing Foundry's relay](#reusing-foundrys-relay). |
| Stream bitrate (kbps) | World, in Module Settings | 128 | Opus bitrate of the stream, 32 to 256. 128 is a good balance for stereo music. A change applies to new connections: Stop and Go live again to apply it to everyone. |
| Setup checklist | Menu in Module Settings, GM only | n/a | Opens the [checklist](#setup-checklist). |
| `nowPlaying` | World, hidden | empty | The "Now playing" line. |
| `source`, `deviceId` | Client, hidden | `tab`, empty | The GM's capture source and device. |
| `sendLevel`, `monitorLevel` | Client, hidden | 1, 0.8 | The GM's send and monitor levels. |
| `mute` | Client, hidden | false | A player's personal mute. |

## Setup checklist

*Game Settings > Configure Settings > Sargas Soundtrack > Open checklist* (GM
only) shows live checks:

- **Secure connection (HTTPS)**: audio capture is blocked without it.
- **Browser can capture tab audio**: Chromium-based with `getDisplayMedia`
  (Firefox gets a warning).
- **Audio source**: the chosen source and, for a device, whether the saved
  device still exists. The device check runs only when you press its button,
  because it may briefly open the microphone.
- **Headphones** reminder, with the echo explanation.
- **Send test tone**: goes live for 10 seconds with a stereo tone (440 Hz in the
  left ear, 660 Hz in the right) that players hear through their Music slider.
  If you were already live, your source is held silently and comes back
  afterwards; if you were not live, the broadcast stops again.

## Macro API

```js
const sargas = game.modules.get("sargas-soundtrack").api;
```

| Member | Who | Description |
| --- | --- | --- |
| `await goLive(source, opts)` | active GM | `source` is `"tab"`, `"device"` or `"tone"`. For a device pass `{ deviceId }`. Returns `true` on success; errors are shown as notifications. If already live it switches the source. |
| `stop()` | active GM | Ends the broadcast. |
| `fadeTo(level, ms)` | active GM | Ramps the send level (0 to 1) over `ms` milliseconds. |
| `setSendLevel(v)`, `setMonitorLevel(v)` | active GM | Set and remember the levels (0 to 1). |
| `await setNowPlaying(text)` | active GM | Sets the "Now playing" line (up to 120 characters). |
| `await testTone(seconds = 10)` | active GM | The checklist's test tone. |
| `setMute(bool)` | everyone else | Personal mute. |
| `isLive`, `status` | everyone | Live flag, and per-player or listener status. |
| `capture`, `broadcaster`, `receiver` | n/a | The internals (only the ones for your role are set). |

Examples:

```js
// Fade the music out over 5 seconds, then change the line shown to players
sargas.fadeTo(0, 5000);
await sargas.setNowPlaying("Silence in the crypt");

// Go live from a saved audio device (works from any macro)
await sargas.goLive("device", { deviceId: game.settings.get("sargas-soundtrack", "deviceId") });

// Bring the music back up
sargas.fadeTo(1, 3000);
```

`goLive("tab")` only works when it is called from a click (a button, or a macro
run by clicking its hotbar slot), because the browser requires a user gesture
for the tab picker. Every GM reload needs the picker again. `fadeTo`, `stop`,
`goLive("device")` and the rest work from any macro.

### Hooks

| Hook | Argument | When |
| --- | --- | --- |
| `sargas-soundtrack.live` | `{ sessionId }` | A broadcast started (GM) or the GM went live (player). |
| `sargas-soundtrack.ended` | `{ sessionId }` (GM), `{}` (player) | The broadcast ended. |
| `sargas-soundtrack.status` | GM: `{ role: "broadcaster", live, peers }`; player: `{ role: "listener", status }` | A connection changed. A peer is `{ userId, name, state }` with state `connecting`, `connected` or `failed`. A player status is `idle`, `connecting`, `live` or `failed`. |
| `sargas-soundtrack.routeFallback` | `{ reason }` | A player could not use Foundry's music node and routed to the plain output, so only the module's gain follows the Music slider. |

```js
Hooks.on("sargas-soundtrack.live", () => ui.notifications.info("The music is on."));
```

## TURN with coturn

Most home tables connect directly or through a public STUN server. Some
networks (strict corporate Wi-Fi, mobile carriers) block that, and those players
need a **TURN relay**. Whether anybody at *your* table needs one can only be
known on your real server. The GM row shows the route per player: `relay`
means TURN is being used; if everybody shows `host` or `srflx`, you do not need
it.

A minimal `turnserver.conf` for a home server running
[coturn](https://github.com/coturn/coturn):

```
listening-port=3478
fingerprint
lt-cred-mech
user=sargas:CHANGE-THIS-PASSWORD
realm=your-domain.example
# Your public IP. Behind a NAT use external-ip=PUBLIC_IP/PRIVATE_IP
external-ip=203.0.113.10
# Relay ports (forward these too)
min-port=49160
max-port=49200
no-cli
```

Open the firewall and forward the ports on your router to the coturn machine:
**3478 UDP and TCP**, and the relay range **49160-49200 UDP**.

Then paste the matching JSON into **ICE servers (JSON)** in the module
settings (replace host, user and password):

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": ["turn:your-domain.example:3478?transport=udp", "turn:your-domain.example:3478?transport=tcp"],
    "username": "sargas",
    "credential": "CHANGE-THIS-PASSWORD"
  }
]
```

`stun:`, `stuns:`, `turn:` and `turns:` URLs are accepted, with optional
`username` and `credential`. If the JSON is invalid the module falls back to the
default STUN server and shows the GM a warning once. Note that the setting is
readable by every connected client, so use a TURN user made only for this.

### Reusing Foundry's relay

Foundry's default Audio/Video relay setting, "Provided by Signaling Server", is
not a relay: it gives the browsers only public STUN servers, and the Foundry
server runs no TURN (checked in Foundry 14.370). If you set a **Custom Relay
Server** (URL, username and password) in Foundry's Audio/Video settings, the
module reuses it as an extra ICE server, unless **Also use Foundry's relay
server** is off. The module skips it if the same URL is already in **ICE servers
(JSON)**.

### Testing the relay

Turn on **Relay only (TURN test)**, then Stop and Go live again, because the
setting applies to new connections. Every player row in the GM row must show
`relay`. A player who shows *Failed* (after about 20 seconds) cannot reach your
TURN server. Turn Relay only off afterwards: it is only a test, and with it on
nobody can connect without a working TURN server.

## Troubleshooting

- **Players hear nothing.** Use the checklist's test tone first. If the tone
  works, the problem is the source. A **muted browser or a muted tab captures
  silence**: unmute the music tab (and the browser) in Windows and in the
  browser. Check that the tab picker had **Also share tab audio** ticked.
- **A player hears nothing, others do.** They may not have clicked in the page
  yet (the hint says so), have the Music slider at 0, or have muted themselves
  in the row or in Foundry. Their row shows the connection status.
- **Everybody hears an echo.** Wear headphones.
- **Discord, Windows or other apps sound wrong after installing VB-Cable.** The
  installer makes CABLE the default Windows devices. Set your real devices back
  as the Windows defaults and keep Discord on **Default** or your real devices.
  Route only the music app to *CABLE Input*.
- **"Audio capture needs a secure connection".** Open Foundry over HTTPS.
- **The tab picker does not open from a macro.** Tab capture needs a click.
- **The broadcast stopped by itself.** The shared tab was closed, sharing was
  stopped from the browser bar, or the audio device was unplugged.
- **A player shows *Failed*.** The connection could not be set up (often a
  strict network). It retries by itself; if it keeps failing, set up
  [TURN](#turn-with-coturn).

## Privacy

Signalling travels over Foundry's module socket. Only the short "live" and
"end" announcements go to every connected client; the connection details (SDP
and ICE candidates, which include IP addresses) are addressed to the one
player they belong to, and each client ignores anything not meant for it.
Audio goes directly between browsers (or through your TURN server), never
through the Foundry server. Nothing is recorded or stored.

## Music service terms

Streaming audio from a subscription music service to other people may break
that service's terms: many forbid redistributing or broadcasting their content
and can suspend accounts that do. Checking this is the user's responsibility. The module works the same with
music you are licensed to share.

## Status

In development; not yet released.

## License

MIT. See [LICENSE](LICENSE).
