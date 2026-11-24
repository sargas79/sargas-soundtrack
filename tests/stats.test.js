import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeStats, lossPct, candidatePairInfo } from "../scripts/stats.js";

const report = items => new Map(items.map(s => [s.id, s]));

const outboundReport = (bytes, ts, extra = {}) => report([
  { id: "OT1", type: "outbound-rtp", kind: "audio", ssrc: 7, codecId: "C1", bytesSent: bytes, packetsSent: 990, timestamp: ts },
  { id: "C1", type: "codec", mimeType: "audio/opus", channels: 2, sdpFmtpLine: "stereo=1" },
  { id: "RI1", type: "remote-inbound-rtp", ssrc: 7, packetsLost: 10, jitter: 0.004, roundTripTime: 0.02 },
  { id: "T", type: "transport", selectedCandidatePairId: "P" },
  { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
  { id: "L", type: "local-candidate", candidateType: "host" },
  { id: "R", type: "remote-candidate", candidateType: "srflx" },
  ...(extra.items ?? [])
]);

test("lossPct", () => {
  assert.equal(lossPct(10, 990), 1);
  assert.equal(lossPct(0, 100), 0);
  assert.equal(lossPct(0, 0), 0);
  assert.equal(lossPct(null, 5), null);
  assert.equal(lossPct(-3, 100), 0, "negative lost (RTCP quirk) is treated as zero");
});

test("outbound: first sample has no bitrate, second computes kbps from byte delta", () => {
  const first = summarizeStats(outboundReport(0, 1000), "outbound");
  assert.equal(first.info.bitrateKbps, null);
  assert.deepEqual(first.sample, { bytes: 0, ts: 1000 });

  // 16000 bytes in 1000 ms = 128 kbps
  const second = summarizeStats(outboundReport(16000, 2000), "outbound", first.sample);
  assert.equal(second.info.bitrateKbps, 128);
  assert.equal(second.info.codec, "audio/opus");
  assert.equal(second.info.channels, 2);
  assert.equal(second.info.packetsLost, 10);
  assert.equal(second.info.lossPct, 1);
  assert.equal(second.info.jitter, 0.004);
  assert.deepEqual(second.info.candidatePair, { local: "host", remote: "srflx" });
});

test("bitrate is null when the clock or counter did not advance", () => {
  const prev = { bytes: 5000, ts: 2000 };
  assert.equal(summarizeStats(outboundReport(6000, 2000), "outbound", prev).info.bitrateKbps, null);
  assert.equal(summarizeStats(outboundReport(100, 3000), "outbound", prev).info.bitrateKbps, null);
});

test("inbound: reads loss and jitter from the inbound-rtp entry", () => {
  const r = report([
    { id: "IT1", type: "inbound-rtp", kind: "audio", codecId: "C1", bytesReceived: 32000, packetsReceived: 95, packetsLost: 5, jitter: 0.01, timestamp: 3000 },
    { id: "C1", type: "codec", mimeType: "audio/opus", channels: 2 }
  ]);
  const { info } = summarizeStats(r, "inbound", { bytes: 16000, ts: 2000 });
  assert.equal(info.bitrateKbps, 128);
  assert.equal(info.packetsLost, 5);
  assert.equal(info.lossPct, 5);
  assert.equal(info.jitter, 0.01);
  assert.equal(info.codec, "audio/opus");
});

test("no matching rtp entry yields an empty summary with a null sample", () => {
  const { info, sample } = summarizeStats(report([{ id: "x", type: "transport" }]), "inbound");
  assert.equal(sample, null);
  assert.equal(info.bitrateKbps, undefined);
});

test("video entries are ignored", () => {
  const r = report([{ id: "V", type: "outbound-rtp", kind: "video", bytesSent: 1, timestamp: 1 }]);
  assert.equal(summarizeStats(r, "outbound").sample, null);
});

test("candidatePairInfo falls back to a nominated succeeded pair without transport", () => {
  const m = report([
    { id: "P", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
    { id: "L", type: "local-candidate", candidateType: "relay" },
    { id: "R", type: "remote-candidate", candidateType: "host" }
  ]);
  assert.deepEqual(candidatePairInfo(m), { local: "relay", remote: "host" });
  assert.equal(candidatePairInfo(new Map()), null);
});
