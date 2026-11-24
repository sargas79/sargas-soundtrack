import { test } from "node:test";
import assert from "node:assert/strict";
import { opusPayloadType, setOpusFmtpParams, mungeOffer, mungeAnswer } from "../scripts/sdp.js";
import { CHROMIUM_AUDIO_OFFER, NO_FMTP_OFFER, ANSWER_WITH_STEREO0, NO_OPUS } from "./helpers/sdp-fixtures.js";

const line = (sdp, prefix) => sdp.split(/\r?\n/).find(l => l.startsWith(prefix));
const otherLines = (sdp, skipPrefix) => sdp.split(/\r?\n/).filter(l => !l.startsWith(skipPrefix));

test("opusPayloadType finds the Opus payload type", () => {
  assert.equal(opusPayloadType(CHROMIUM_AUDIO_OFFER), "111");
  assert.equal(opusPayloadType(ANSWER_WITH_STEREO0), "109");
  assert.equal(opusPayloadType(NO_OPUS), null);
  assert.equal(opusPayloadType(undefined), null);
});

test("mungeOffer adds sprop-stereo=1 and keeps existing params", () => {
  const out = mungeOffer(CHROMIUM_AUDIO_OFFER);
  assert.equal(line(out, "a=fmtp:111"), "a=fmtp:111 minptime=10;useinbandfec=1;sprop-stereo=1");
});

test("mungeOffer only touches the Opus fmtp line", () => {
  const out = mungeOffer(CHROMIUM_AUDIO_OFFER);
  assert.deepEqual(otherLines(out, "a=fmtp:111"), otherLines(CHROMIUM_AUDIO_OFFER, "a=fmtp:111"));
  assert.equal(line(out, "a=fmtp:63"), "a=fmtp:63 111/111", "RED fmtp unchanged");
});

test("CRLF line endings are preserved, and LF input stays LF", () => {
  const out = mungeOffer(CHROMIUM_AUDIO_OFFER);
  assert.ok(out.endsWith("\r\n"));
  assert.equal(out.replace(/\r\n/g, "").includes("\n"), false, "no bare LF introduced");
  const lf = CHROMIUM_AUDIO_OFFER.replace(/\r\n/g, "\n");
  const outLf = mungeOffer(lf);
  assert.equal(outLf.includes("\r"), false);
  assert.ok(outLf.includes("sprop-stereo=1"));
});

test("mungeAnswer sets stereo=1 and maxaveragebitrate from kbps", () => {
  const out = mungeAnswer(CHROMIUM_AUDIO_OFFER, 128);
  const f = line(out, "a=fmtp:111");
  assert.match(f, /stereo=1/);
  assert.match(f, /maxaveragebitrate=128000/);
  assert.match(f, /useinbandfec=1/);
});

test("existing values of the same key are replaced, not duplicated", () => {
  const out = mungeAnswer(ANSWER_WITH_STEREO0, 96);
  const f = line(out, "a=fmtp:109");
  assert.equal(f, "a=fmtp:109 minptime=10;stereo=1;useinbandfec=1;maxaveragebitrate=96000");
  assert.equal(f.match(/stereo=/g).length, 1);
});

test("idempotent", () => {
  const once = mungeAnswer(CHROMIUM_AUDIO_OFFER, 128);
  assert.equal(mungeAnswer(once, 128), once);
  const offer = mungeOffer(CHROMIUM_AUDIO_OFFER);
  assert.equal(mungeOffer(offer), offer);
});

test("a missing Opus fmtp line is added right after the rtpmap line; video fmtp untouched", () => {
  const out = mungeAnswer(NO_FMTP_OFFER, 128);
  const lines = out.split("\r\n");
  const i = lines.indexOf("a=rtpmap:111 opus/48000/2");
  assert.equal(lines[i + 1], "a=fmtp:111 stereo=1;maxaveragebitrate=128000");
  assert.equal(line(out, "a=fmtp:96"), "a=fmtp:96 x-google-start-bitrate=800");
  assert.equal(lines.filter(l => l.startsWith("a=fmtp:111")).length, 1);
});

test("an SDP without Opus, or a non-string, is returned unchanged", () => {
  assert.equal(mungeOffer(NO_OPUS), NO_OPUS);
  assert.equal(mungeAnswer(NO_OPUS, 128), NO_OPUS);
  assert.equal(setOpusFmtpParams(undefined, { a: 1 }), undefined);
});

test("setOpusFmtpParams supports arbitrary keys and leaves non-Opus codecs alone", () => {
  const out = setOpusFmtpParams(CHROMIUM_AUDIO_OFFER, { usedtx: 1 });
  assert.match(line(out, "a=fmtp:111"), /usedtx=1/);
  assert.equal(line(out, "a=rtpmap:0"), "a=rtpmap:0 PCMU/8000");
  assert.equal(out.split("\r\n").filter(l => l.startsWith("a=fmtp:")).length, 2, "only the two original fmtp lines");
});
