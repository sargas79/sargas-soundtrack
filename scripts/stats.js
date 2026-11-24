/** Pure helpers turning an RTCStatsReport into the readout used by the GM/player UI (D12/D17). */

const toMap = report => { const m = new Map(); report.forEach(s => m.set(s.id, s)); return m; };

export function candidatePairInfo(map) {
  let pair = null;
  map.forEach(s => { if (!pair && s.type === "transport" && s.selectedCandidatePairId) pair = map.get(s.selectedCandidatePairId) ?? null; });
  if (!pair) map.forEach(s => { if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s; });
  if (!pair) return null;
  return {
    local: map.get(pair.localCandidateId)?.candidateType ?? "?",
    remote: map.get(pair.remoteCandidateId)?.candidateType ?? "?"
  };
}

/** Lost share in percent of everything expected (lost + delivered); null when unknown. */
export function lossPct(lost, delivered) {
  if (!Number.isFinite(lost) || !Number.isFinite(delivered)) return null;
  const total = Math.max(0, lost) + delivered;
  return total > 0 ? (Math.max(0, lost) / total) * 100 : 0;
}

/**
 * @param {{forEach:Function}} report RTCStatsReport
 * @param {"outbound"|"inbound"} direction
 * @param {{bytes:number, ts:number}|null} prev previous sample, for the bitrate delta
 * @returns {{info: object, sample: {bytes:number, ts:number}|null}}
 */
export function summarizeStats(report, direction, prev = null) {
  const map = toMap(report);
  let rtp = null;
  map.forEach(s => { if (!rtp && s.type === `${direction}-rtp` && (s.kind ?? s.mediaType) === "audio") rtp = s; });
  const candidatePair = candidatePairInfo(map);
  if (!rtp) return { info: { candidatePair }, sample: null };

  const codec = map.get(rtp.codecId);
  const bytes = direction === "outbound" ? rtp.bytesSent : rtp.bytesReceived;
  const sample = { bytes, ts: rtp.timestamp };
  let kbps = null;
  if (prev && sample.ts > prev.ts && bytes >= prev.bytes) kbps = ((bytes - prev.bytes) * 8) / (sample.ts - prev.ts);

  const info = {
    codec: codec?.mimeType ?? null,
    channels: codec?.channels ?? null,
    sdpFmtpLine: codec?.sdpFmtpLine ?? null,
    bitrateKbps: kbps,
    packetsLost: null,
    lossPct: null,
    jitter: null,
    candidatePair
  };
  if (direction === "outbound") {
    let remote = null;
    map.forEach(s => { if (!remote && s.type === "remote-inbound-rtp" && s.ssrc === rtp.ssrc) remote = s; });
    info.packetsLost = remote?.packetsLost ?? null;
    info.jitter = remote?.jitter ?? null;
    info.roundTripTime = remote?.roundTripTime ?? null;
    info.lossPct = lossPct(info.packetsLost, rtp.packetsSent);
  } else {
    info.packetsLost = rtp.packetsLost ?? null;
    info.jitter = rtp.jitter ?? null;
    info.lossPct = lossPct(info.packetsLost, rtp.packetsReceived);
  }
  return { info, sample };
}
