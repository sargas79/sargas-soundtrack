/**
 * Sargas Soundtrack — lifecycle entry point.
 * GM (active) = Capture + Broadcaster; everyone else = Receiver.
 */
import { MODULE_ID, SOCKET_CHANNEL, LOG_PREFIX, HOOKS, SETTINGS, SIDEBAR_TEMPLATE, CHECKLIST_TEMPLATE } from "./constants.js";
import { registerSettings, getIceServers, getRtcConfig, getBitrate } from "./settings.js";
import { Signaling } from "./signaling.js";
import { Capture, errorKey } from "./capture.js";
import { Broadcaster } from "./broadcaster.js";
import { Receiver } from "./receiver.js";
import { createSidebar, preloadTemplates } from "./sidebar.js";
import { createChecklistApp } from "./checklist-app.js";
import { runTestTone } from "./testtone.js";

let signaling = null;
let capture = null;
let broadcaster = null;
let receiver = null;
let sidebar = null;
const testToneState = { current: null };

const t = key => game.i18n.localize(key);

function notifyError(e) {
  console.warn(LOG_PREFIX, "error:", e);
  const code = e?.code ?? "failed";
  ui.notifications.error(t(errorKey(game.i18n.has(errorKey(code)) ? code : "failed")));
}

function buildApi() {
  return {
    /**
     * Start capturing `source` ("tab" | "device" | "tone") and go live. If already live, switches source
     * without renegotiation. "tab" needs a user gesture (call it from a click handler).
     * @returns {Promise<boolean>} true on success (errors are shown as notifications)
     */
    async goLive(source = "tab", opts = {}) {
      if (!broadcaster) { notifyError({ code: "notActiveGM" }); return false; }
      const wasLive = broadcaster.live;
      try {
        await broadcaster.goLive(source, opts);
      } catch (e) {
        notifyError(e);
        return false;
      }
      if (!wasLive) ui.notifications.info(t("SARGAS_SOUNDTRACK.Notify.Live"));
      return true;
    },
    stop() {
      if (!broadcaster) return;
      const wasLive = broadcaster.live;
      broadcaster.stop();
      if (wasLive) ui.notifications.info(t("SARGAS_SOUNDTRACK.Notify.Stopped"));
    },
    fadeTo(level, ms) { capture?.fadeTo(level, ms); },
    /** Set the "Now playing" line shown to everyone (active GM only). */
    async setNowPlaying(text) {
      if (!broadcaster) { notifyError({ code: "notActiveGM" }); return false; }
      await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, String(text ?? "").slice(0, 120));
      return true;
    },
    /** GM send level (0..1), saved to the client setting. */
    setSendLevel(v) { capture?.setSendLevel(v); },
    /** GM monitor level (0..1), saved to the client setting. */
    setMonitorLevel(v) { capture?.setMonitorLevel(v); },
    /** Listener: personal mute, saved to the client setting. */
    setMute(mute) { receiver?.setMute(mute); },
    /**
     * Play the stereo test tone (440 Hz left, 660 Hz right) to the players for `seconds`, then go back:
     * to the previous source if one was live, or stop if the GM was not live. Active GM only.
     * @returns {Promise<boolean>} true once the tone is playing
     */
    async testTone(seconds = 10) {
      if (!broadcaster) { notifyError({ code: "notActiveGM" }); return false; }
      const wasLive = broadcaster.live;
      try {
        const ok = await runTestTone({ broadcaster, capture, seconds, state: testToneState });
        if (ok && !wasLive) ui.notifications.info(t("SARGAS_SOUNDTRACK.Notify.Live"));
        return ok;
      } catch (e) {
        notifyError(e);
        return false;
      }
    },
    get isLive() { return broadcaster ? broadcaster.live : receiver?.isLive ?? false; },
    get status() {
      return broadcaster
        ? { role: "broadcaster", live: broadcaster.live, peers: broadcaster.statuses() }
        : { role: "listener", status: receiver?.status ?? "idle" };
    },
    get capture() { return capture; },
    get broadcaster() { return broadcaster; },
    get receiver() { return receiver; }
  };
}

Hooks.once("init", () => {
  sidebar = createSidebar(() => game.modules.get(MODULE_ID)?.api ?? null);
  registerSettings({
    checklistApp: createChecklistApp(),
    onChange: { nowPlaying: text => sidebar.nowPlayingChanged(text), mute: () => sidebar.refresh(), gmControls: () => sidebar.refresh() }
  });
  sidebar.register();
  preloadTemplates([SIDEBAR_TEMPLATE, CHECKLIST_TEMPLATE]);
  signaling = new Signaling(SOCKET_CHANNEL);
  console.log(LOG_PREFIX, "init");
});

Hooks.once("ready", () => {
  if (game.user.isActiveGM) {
    capture = new Capture();
    broadcaster = new Broadcaster({ signaling, capture, getIceServers, getRtcConfig, getBitrate });
  } else {
    receiver = new Receiver({ signaling, getBitrate, getIceServers, getRtcConfig });
  }
  const peer = () => broadcaster ?? receiver;
  signaling.onMessage((msg, senderId) => {
    try { peer().handle(msg, senderId); }
    catch (e) { console.error(LOG_PREFIX, "message handler failed", e); }
  }, () => peer().context());
  if (receiver) {
    Hooks.on(HOOKS.LIVE, () => ui.notifications.info(t("SARGAS_SOUNDTRACK.Notify.Live")));
    Hooks.on(HOOKS.ENDED, () => ui.notifications.info(t("SARGAS_SOUNDTRACK.Notify.Stopped")));
  }
  game.modules.get(MODULE_ID).api = buildApi();
  receiver?.probe();
  // The sidebar may have rendered before the api existed.
  const playlists = ui.playlists;
  if (playlists?.rendered && playlists.element) sidebar.onRender(playlists, playlists.element);
  console.log(LOG_PREFIX, `ready (${broadcaster ? "broadcaster" : "listener"})`);
});

Hooks.on("userConnected", (user, connected) => {
  (broadcaster ?? receiver)?.userConnected(user, connected);
});
