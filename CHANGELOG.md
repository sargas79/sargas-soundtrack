# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-24

### Changed
- CI and release workflows use the Node 24 releases of their GitHub Actions (`actions/checkout` v7, `actions/setup-node` v7, `softprops/action-gh-release` v3).

## [0.1.0] - 2026-11-24

First release.

### Added
- Live streaming of the GM's browser tab or an audio device (for example VB-Cable) to every player's Music channel over WebRTC, as stereo Opus.
- "Sargas Soundtrack" row in the Playlists sidebar. GM: Go live and Stop, source picker (browser tab or audio device, with a device list filled on request), send and monitor levels, 3 second Fade out and Fade in, a level meter, a status line per player (connected, connecting, failed, not connected) with measured kbps, packet loss and route type (host, srflx or relay), and a typed Now playing line. Players: a live indicator, a personal mute, the Now playing line and a hint while the browser still blocks audio.
- Macro API (`game.modules.get("sargas-soundtrack").api`): `goLive`, `stop`, `fadeTo`, `isLive`, `status`, `setNowPlaying`, `setSendLevel`, `setMonitorLevel`, `setMute` and `testTone`, plus the `live`, `ended`, `status` and `routeFallback` hooks.
- Setup checklist (GM-only settings menu): HTTPS, tab-capture browser support, chosen source and saved device, a headphones reminder, a 10 second stereo test tone for the players, and notes on muted tabs, VB-Cable defaults, Discord and app routing.
- Automatic recovery: players who join late or reload connect by themselves, failed connections retry with backoff, and a player whose connection failed shows as "failed" in the GM row until they connect again, leave or the broadcast stops.
- English and Brazilian Portuguese strings for all of the above.
- README user guide: installation, quick start for both routes, settings, macro API, TURN with coturn, troubleshooting and a privacy note.
