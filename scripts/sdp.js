/** Pure SDP helpers: set Opus fmtp parameters (stereo, bitrate) without touching other codecs. */

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000/i;

export function opusPayloadType(sdp) {
  if (typeof sdp !== "string") return null;
  for (const line of sdp.split(/\r?\n/)) {
    const m = OPUS_RTPMAP.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Add or replace keys on the Opus a=fmtp line. Creates the line right after the
 * rtpmap line when missing. Keeps CRLF/LF, only touches the Opus payload type, idempotent.
 * @param {string} sdp
 * @param {Record<string, string|number>} params
 */
export function setOpusFmtpParams(sdp, params) {
  if (typeof sdp !== "string") return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);

  const targets = [];
  lines.forEach((l, i) => { const m = OPUS_RTPMAP.exec(l); if (m) targets.push([i, m[1]]); });

  for (let k = targets.length - 1; k >= 0; k--) {
    const [ri, pt] = targets[k];
    let start = 0;
    for (let j = ri; j >= 0; j--) if (lines[j].startsWith("m=")) { start = j; break; }
    let end = lines.length;
    for (let j = ri + 1; j < lines.length; j++) if (lines[j].startsWith("m=")) { end = j; break; }

    const prefix = `a=fmtp:${pt} `;
    let fi = -1;
    for (let j = start; j < end; j++) if (lines[j].startsWith(prefix)) { fi = j; break; }

    const items = fi >= 0 ? lines[fi].slice(prefix.length).split(";").map(s => s.trim()).filter(Boolean) : [];
    for (const [key, value] of Object.entries(params)) {
      const entry = `${key}=${value}`;
      const idx = items.findIndex(it => it.split("=")[0] === key);
      if (idx >= 0) items[idx] = entry; else items.push(entry);
    }
    const line = prefix + items.join(";");
    if (fi >= 0) lines[fi] = line; else lines.splice(ri + 1, 0, line);
  }
  return lines.join(eol);
}

export const mungeOffer = sdp => setOpusFmtpParams(sdp, { "sprop-stereo": 1 });

export const mungeAnswer = (sdp, kbps) =>
  setOpusFmtpParams(sdp, { stereo: 1, maxaveragebitrate: Math.round(kbps * 1000) });
