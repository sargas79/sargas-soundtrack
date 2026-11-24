/** Realistic Chromium audio SDP (trimmed to the audio section), CRLF line endings like the real thing. */
const join = lines => lines.join("\r\n") + "\r\n";

export const CHROMIUM_AUDIO_OFFER = join([
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS stream1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:0123456789012345678901",
  "a=fingerprint:sha-256 AA:BB:CC",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendonly",
  "a=msid:stream1 track1",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:13 CN/8000",
  "a=rtpmap:110 telephone-event/48000",
  "a=rtpmap:126 telephone-event/8000",
  "a=ssrc:1234 cname:abc"
]);

/** Opus line without any fmtp, plus a video section with its own fmtp that must stay untouched. */
export const NO_FMTP_OFFER = join([
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=rtpmap:111 opus/48000/2",
  "a=rtpmap:0 PCMU/8000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "a=fmtp:96 x-google-start-bitrate=800"
]);

/** Opus on a non-default payload type, with an existing stereo=0 that must be replaced. */
export const ANSWER_WITH_STEREO0 = join([
  "v=0",
  "o=- 2 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 109",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=recvonly",
  "a=rtpmap:109 opus/48000/2",
  "a=fmtp:109 minptime=10;stereo=0;useinbandfec=1"
]);

export const NO_OPUS = join([
  "v=0",
  "o=- 3 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 0",
  "a=rtpmap:0 PCMU/8000"
]);
