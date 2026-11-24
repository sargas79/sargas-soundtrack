import {
  MODULE_ID, SETTINGS, DEFAULT_ICE_SERVERS, DEFAULT_BITRATE, BITRATE_MIN, BITRATE_MAX, LOG_PREFIX, CHECKLIST_MENU
} from "./constants.js";

const SCHEME = /^(stun|stuns|turn|turns):/i;
const ERR = "SARGAS_SOUNDTRACK.Settings.IceServers.Error";

const defaults = () => DEFAULT_ICE_SERVERS.map(s => ({ ...s }));

/**
 * Parse and validate the ICE servers JSON typed in the module settings.
 * Never throws: on any problem returns the default servers plus a lang key in `error`.
 * @param {string} json
 * @returns {{servers: object[], error: string|null}}
 */
export function parseIceServers(json) {
  const fail = key => ({ servers: defaults(), error: `${ERR}${key}` });
  if (json === undefined || json === null || (typeof json === "string" && json.trim() === "")) return { servers: defaults(), error: null };
  let data;
  try { data = JSON.parse(json); } catch { return fail("Json"); }
  if (!Array.isArray(data) || data.length === 0) return fail("Shape");

  const servers = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("Shape");
    const { urls, username, credential } = entry;
    const list = typeof urls === "string" ? [urls] : urls;
    if (!Array.isArray(list) || list.length === 0 || !list.every(u => typeof u === "string")) return fail("Shape");
    if (username !== undefined && typeof username !== "string") return fail("Shape");
    if (credential !== undefined && typeof credential !== "string") return fail("Shape");
    if (!list.every(u => SCHEME.test(u.trim()))) return fail("Scheme");
    const out = { urls };
    if (username !== undefined) out.username = username;
    if (credential !== undefined) out.credential = credential;
    servers.push(out);
  }
  return { servers, error: null };
}

export function clampBitrate(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_BITRATE;
  return Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, v));
}

let warned = false;
/** Test hook: forget that the invalid-setting warning was shown. */
export function resetIceWarning() { warned = false; }

/** Read the world ICE servers setting, falling back to the default (and warning the GM once). */
export function getIceServers() {
  const { servers, error } = parseIceServers(game.settings.get(MODULE_ID, SETTINGS.ICE_SERVERS));
  if (error) {
    console.warn(LOG_PREFIX, "invalid ICE servers setting:", error);
    if (!warned && game.user?.isGM) {
      warned = true;
      ui.notifications.warn(game.i18n.format("SARGAS_SOUNDTRACK.Settings.IceServers.Fallback", { reason: game.i18n.localize(error) }));
    }
  }
  return servers;
}

export function getBitrate() {
  return clampBitrate(game.settings.get(MODULE_ID, SETTINGS.BITRATE));
}

/**
 * @param {object} [o]
 * @param {Function|null} [o.checklistApp] ApplicationV2 class for the "Setup checklist" settings menu
 * @param {{nowPlaying?:(value:string)=>void, mute?:(value:boolean)=>void}} [o.onChange] UI hooks run when a setting changes
 */
export function registerSettings({ checklistApp = null, onChange = {} } = {}) {
  const S = "SARGAS_SOUNDTRACK.Settings";
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);
  const changed = name => value => { try { onChange[name]?.(value); } catch (e) { console.warn(LOG_PREFIX, `${name} change handler failed`, e); } };

  if (checklistApp && typeof game.settings.registerMenu === "function") {
    game.settings.registerMenu(MODULE_ID, CHECKLIST_MENU, {
      name: `${S}.Checklist.Name`, label: `${S}.Checklist.Label`, hint: `${S}.Checklist.Hint`,
      icon: "fa-solid fa-list-check", type: checklistApp, restricted: true
    });
  }

  reg(SETTINGS.ICE_SERVERS, {
    name: `${S}.IceServers.Name`, hint: `${S}.IceServers.Hint`,
    scope: "world", config: true, type: String,
    default: JSON.stringify(DEFAULT_ICE_SERVERS)
  });
  reg(SETTINGS.BITRATE, {
    name: `${S}.Bitrate.Name`, hint: `${S}.Bitrate.Hint`,
    scope: "world", config: true, type: Number,
    range: { min: BITRATE_MIN, max: BITRATE_MAX, step: 8 },
    default: DEFAULT_BITRATE
  });
  reg(SETTINGS.NOW_PLAYING, { scope: "world", config: false, type: String, default: "", onChange: changed("nowPlaying") });

  reg(SETTINGS.SOURCE, { scope: "client", config: false, type: String, default: "tab", choices: { tab: "tab", device: "device" } });
  reg(SETTINGS.DEVICE_ID, { scope: "client", config: false, type: String, default: "" });
  reg(SETTINGS.SEND_LEVEL, { scope: "client", config: false, type: Number, range: { min: 0, max: 1, step: 0.01 }, default: 1 });
  reg(SETTINGS.MONITOR_LEVEL, { scope: "client", config: false, type: Number, range: { min: 0, max: 1, step: 0.01 }, default: 0.8 });
  reg(SETTINGS.MUTE, { scope: "client", config: false, type: Boolean, default: false, onChange: changed("mute") });
}
