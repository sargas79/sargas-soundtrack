/**
 * Setup-checklist test tone: players hear 440 Hz (left) / 660 Hz (right) for N seconds.
 *  - not live: go live with the "tone" source, and stop again afterwards (if it is still the tone);
 *  - live: play the tone in place of the current source (which stays held, muted) and restore it afterwards.
 */
import { LOG_PREFIX } from "./constants.js";

export const TEST_TONE_DEFAULT_SECONDS = 10;
export const TEST_TONE_MAX_SECONDS = 60;

export const clampSeconds = n => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(TEST_TONE_MAX_SECONDS, v) : TEST_TONE_DEFAULT_SECONDS;
};

/**
 * @param {object} o
 * @param {import("./broadcaster.js").Broadcaster} o.broadcaster
 * @param {import("./capture.js").Capture} o.capture
 * @param {number} [o.seconds]
 * @param {{setTimeout:Function, clearTimeout:Function}} [o.scheduler]
 * @param {{current: object|null, starting?: boolean}} [o.state] holds a running test between calls (a second call restarts the countdown)
 * @returns {Promise<boolean>} true once the tone is playing (it ends by itself after `seconds`); throws CaptureError on failure
 */
export async function runTestTone({ broadcaster, capture, seconds = TEST_TONE_DEFAULT_SECONDS, scheduler = globalThis, state = { current: null } }) {
  const ms = clampSeconds(seconds) * 1000;
  const running = state.current;
  if (running) { running.rearm(ms); return true; } // already playing: just restart the countdown

  if (state.starting) return false; // a start is already in flight
  let restore;
  state.starting = true;
  try {
    if (broadcaster.live) {
      const stopTone = await capture.playTone();
      restore = () => stopTone();
    } else {
      await broadcaster.goLive("tone");
      restore = () => { if (broadcaster.live && capture.sourceLabel === "tone") broadcaster.stop(); };
    }
  } finally {
    state.starting = false;
  }

  const handle = {
    timer: null,
    done: false,
    rearm(newMs) {
      if (handle.timer !== null) scheduler.clearTimeout(handle.timer);
      handle.timer = scheduler.setTimeout(() => { handle.timer = null; handle.cancel(); }, newMs);
    },
    cancel(runRestore = true) {
      if (handle.done) return;
      handle.done = true;
      if (handle.timer !== null) scheduler.clearTimeout(handle.timer);
      if (state.current === handle) state.current = null;
      if (runRestore) {
        try { restore(); } catch (e) { console.warn(LOG_PREFIX, "test tone cleanup failed", e); }
      }
    }
  };
  state.current = handle;
  handle.rearm(ms);
  return true;
}
