export const MODULE_ID = "sargas-soundtrack";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

/** Signalling message types carried over the module socket. */
export const MSG = Object.freeze({
  LIVE: "live",
  REQUEST: "request",
  OFFER: "offer",
  ANSWER: "answer",
  ICE: "ice",
  END: "end"
});

/** Setting keys (registered in settings.js). */
export const SETTINGS = Object.freeze({
  ICE_SERVERS: "iceServers",
  BITRATE: "bitrate",
  NOW_PLAYING: "nowPlaying",
  SOURCE: "source",
  DEVICE_ID: "deviceId",
  SEND_LEVEL: "sendLevel",
  MONITOR_LEVEL: "monitorLevel",
  MUTE: "mute"
});

export const DEFAULT_ICE_SERVERS = Object.freeze([Object.freeze({ urls: "stun:stun.l.google.com:19302" })]);
export const DEFAULT_BITRATE = 128;
export const BITRATE_MIN = 32;
export const BITRATE_MAX = 256;

/** Module hooks other code (UI, macros) can listen to. */
export const HOOKS = Object.freeze({
  LIVE: "sargas-soundtrack.live",
  ENDED: "sargas-soundtrack.ended",
  STATUS: "sargas-soundtrack.status",
  /** A listener could not use the Foundry music node and routed to the plain destination. */
  ROUTE_FALLBACK: "sargas-soundtrack.routeFallback"
});

export const LOG_PREFIX = "sargas-soundtrack |";

export const SIDEBAR_TEMPLATE = `modules/${MODULE_ID}/templates/sidebar-row.hbs`;
export const CHECKLIST_TEMPLATE = `modules/${MODULE_ID}/templates/checklist.hbs`;
/** Settings menu key of the setup checklist. */
export const CHECKLIST_MENU = "checklist";
