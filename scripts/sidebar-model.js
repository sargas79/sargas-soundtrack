/**
 * Pure view-model and HTML helpers for the Playlists-sidebar row. No DOM, no Foundry globals:
 * everything user-controlled (player names, device labels) is escaped here.
 */

const K = "SARGAS_SOUNDTRACK.Row";

/** @typedef {{t:(key:string)=>string, f:(key:string, data:object)=>string}} I18n */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

export const METER_ID = "sargas-soundtrack";
export const METER_INTERVAL = 100;
export const STATS_INTERVAL = 2000;
export const FADE_MS = 3000;
export const NOW_PLAYING_DEBOUNCE = 600;
/** Meter scale: maxDecibel from the analyser, silence at or below -100 dB. */
export const METER_FLOOR_DB = -90;
export const METER_CEIL_DB = -20;

/** 0..1 meter fill for a level report in dB. */
export function meterLevel(db) {
  if (!Number.isFinite(db) || db <= -100) return 0;
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

const RANK = { host: 0, prflx: 1, srflx: 2, relay: 3 };

/** Route label for a selected candidate pair: "relay" if either side is relayed, else the more NATed of the two; null if unknown. */
export function candidateKind(pair) {
  if (!pair) return null;
  const kinds = [pair.local, pair.remote].filter(k => k in RANK);
  if (!kinds.length) return null;
  return kinds.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** "128 kbps · 0.4 % loss · relay" from a broadcaster.stats() entry; "" when nothing is known yet. */
export function formatStats(info, { f }) {
  if (!info) return "";
  const parts = [];
  if (Number.isFinite(info.bitrateKbps)) parts.push(`${Math.round(info.bitrateKbps)} kbps`);
  if (Number.isFinite(info.lossPct)) parts.push(f(`${K}.Stats.Loss`, { pct: info.lossPct.toFixed(1) }));
  const kind = candidateKind(info.candidatePair);
  if (kind) parts.push(kind);
  return parts.join(" · ");
}

/**
 * Peers reported by the broadcaster plus active non-GM users that have no peer ("none" = not connected).
 * @param {{userId:string,name:string,state:string}[]} peers
 * @param {{id:string,name:string,isGM:boolean,active:boolean}[]} users
 */
export function mergeListeners(peers = [], users = []) {
  const items = peers.map(p => ({ userId: p.userId, name: p.name, state: p.state }));
  const known = new Set(items.map(i => i.userId));
  for (const u of users) {
    if (u.active && !u.isGM && !known.has(u.id)) items.push({ userId: u.id, name: u.name, state: "none" });
  }
  return items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const PEER_LABEL = { connected: "Connected", connecting: "Connecting", failed: "Failed", none: "NotConnected" };

export function listenersHtml(items, i18n, stats = {}) {
  if (!items.length) return `<li class="ss-empty">${escapeHtml(i18n.t(`${K}.NoListeners`))}</li>`;
  return items.map(it => {
    const state = it.state in PEER_LABEL ? it.state : "none";
    const info = stats[it.userId];
    const text = state === "connected" || state === "connecting" ? formatStats(info, i18n) : "";
    const route = candidateKind(info?.candidatePair) ?? "";
    return `<li class="ss-listener" data-user="${escapeHtml(it.userId)}" data-state="${state}">`
      + `<span class="ss-dot"></span><span class="ss-name">${escapeHtml(it.name)}</span>`
      + `<span class="ss-peer-state">${escapeHtml(i18n.t(`${K}.Peer.${PEER_LABEL[state]}`))}</span>`
      + `<span class="ss-stats" data-route="${escapeHtml(route)}">${escapeHtml(text)}</span></li>`;
  }).join("");
}

/** <option> list for the device select. `devices` is null until the GM asked for the list. */
export function deviceOptionsHtml(devices, selectedId, i18n) {
  const opt = (value, label, selected, extra = "") => `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}${extra}>${escapeHtml(label)}</option>`;
  if (!devices) {
    return selectedId
      ? opt(selectedId, i18n.t(`${K}.SavedDevice`), true)
      : opt("", i18n.t(`${K}.ChooseDevice`), true, " disabled");
  }
  const out = [opt("", i18n.t(`${K}.ChooseDevice`), !selectedId, " disabled")];
  for (const d of devices) out.push(opt(d.deviceId, d.label, d.deviceId === selectedId));
  if (selectedId && !devices.some(d => d.deviceId === selectedId)) out.push(opt(selectedId, i18n.t(`${K}.MissingDevice`), true));
  return out.join("");
}

const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));

const PLAYER_STATUS = { idle: "Idle", connecting: "Connecting", live: "Live", failed: "Failed" };

/**
 * @param {object} s plain state (see sidebar.js readState)
 * @param {I18n} i18n
 */
export function buildRowModel(s, i18n) {
  const { t } = i18n;
  if (s.isGM) {
    const source = s.source === "device" ? "device" : "tab";
    const listeners = mergeListeners(s.peers, s.users);
    return {
      role: "gm",
      live: !!s.live,
      statusLabel: t(`${K}.Status.${s.live ? "GMLive" : "Idle"}`),
      statusKey: s.live ? "live" : "idle",
      goHidden: !!s.live,
      stopHidden: !s.live,
      fadeDisabled: !s.live,
      source,
      deviceHidden: source !== "device",
      deviceOptionsHtml: deviceOptionsHtml(s.devices ?? null, s.deviceId ?? "", i18n),
      sendLevel: String(clamp01(s.sendLevel)),
      monitorLevel: String(clamp01(s.monitorLevel)),
      listenersHtml: listenersHtml(listeners, i18n, s.stats ?? {}),
      listenerCount: listeners.length,
      nowPlaying: s.nowPlaying ?? ""
    };
  }
  const status = s.status in PLAYER_STATUS ? s.status : "idle";
  return {
    role: "player",
    live: status === "live",
    statusKey: status,
    statusLabel: t(`${K}.Status.${PLAYER_STATUS[status]}`),
    muted: !!s.muted,
    nowPlaying: s.nowPlaying ?? "",
    nowPlayingHidden: !s.nowPlaying,
    hintHidden: !s.audioLocked
  };
}
