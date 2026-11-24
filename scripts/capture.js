/**
 * GM-side audio capture. Sources (tab / device / test tone) feed one stable
 * MediaStreamAudioDestinationNode, so switching source while live needs no renegotiation.
 *
 *   source -> sendGain -> dest (outgoing track)
 *             sendGain -> monitorGain -> game.audio.music.gainNode (what the GM hears)
 */
import { MODULE_ID, SETTINGS, LOG_PREFIX } from "./constants.js";

export class CaptureError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "CaptureError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export const errorKey = code => `SARGAS_SOUNDTRACK.Error.${code}`;

const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));

/**
 * Check a getDisplayMedia stream: must be a browser tab with at least one audio track.
 * Does not stop any track; the caller does that.
 * @param {MediaStream} stream
 * @throws {CaptureError} wrongSurface | noAudio
 */
export function validateDisplayCapture(stream) {
  const video = stream?.getVideoTracks?.()[0];
  if (video?.getSettings?.().displaySurface !== "browser") throw new CaptureError("wrongSurface");
  if (!(stream.getAudioTracks().length >= 1)) throw new CaptureError("noAudio");
}

/**
 * Map a thrown error (DOMException or CaptureError) to a CaptureError.
 * @param {*} e
 * @param {{hadActivation?: boolean}} [opts] hadActivation=false makes NotAllowedError mean "needsClick"
 */
export function mapCaptureError(e, { hadActivation = true } = {}) {
  if (e instanceof CaptureError) return e;
  switch (e?.name) {
    case "InvalidStateError": return new CaptureError("needsClick", e);
    case "NotAllowedError": return new CaptureError(hadActivation ? "cancelled" : "needsClick", e);
    case "NotFoundError":
    case "OverconstrainedError": return new CaptureError("deviceMissing", e);
    case "NotSupportedError": return new CaptureError("unsupported", e);
    default: return new CaptureError("failed", e);
  }
}

const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };

export class Capture {
  #endedCb = null;

  #ctx = null;
  #graphPromise = null;
  #sendGain = null;
  #monitorGain = null;
  #dest = null;
  #source = null;
  #token = 0;
  #tone = null;

  get active() { return this.#source !== null; }
  get outputStream() { return this.#dest?.stream ?? null; }
  get outputTrack() { return this.#dest?.stream.getAudioTracks()[0] ?? null; }
  get sourceLabel() { return this.#source?.label ?? null; }

  /** Register a callback (given the source label) for when the live source ends by itself: tab closed, sharing stopped, device unplugged. */
  onEnded(cb) { this.#endedCb = typeof cb === "function" ? cb : null; }

  /**
   * Start (or switch to) a source. The previous source is only released once the new one is ready,
   * so a failed switch keeps the old one running.
   * @param {"tab"|"device"|"tone"} source
   * @param {{deviceId?: string}} [opts]
   */
  async start(source, { deviceId } = {}) {
    let acquired;
    try {
      acquired = await this.#acquire(source, deviceId);
    } catch (e) {
      throw mapCaptureError(e);
    }
    try {
      await this.#ensureGraph();
      const node = acquired.build(this.#ctx);
      node.connect(this.#sendGain);
      this.#clearTone();
      const old = this.#source;
      const token = ++this.#token;
      this.#source = { node, token, label: acquired.label, stream: acquired.stream, cleanup: acquired.cleanup };
      acquired.track?.addEventListener("ended", () => this.#handleEnded(token));
      if (old) this.#release(old);
    } catch (e) {
      acquired.stream?.getTracks().forEach(t => t.stop());
      acquired.cleanup?.();
      throw mapCaptureError(e);
    }
  }

  /** Switch source while keeping the same outgoing track. */
  switchSource(source, opts) { return this.start(source, opts); }

  /**
   * Replace what is being sent by the test tone WITHOUT releasing the current source (a tab capture
   * cannot be re-acquired without a click). The source is only muted (disconnected from the send gain).
   * @returns {Promise<() => void>} restore function: removes the tone and reconnects the muted source
   *          (unless the source was switched or stopped in the meantime). Safe to call more than once.
   * @throws {CaptureError} notCapturing when nothing is active
   */
  async playTone() {
    if (!this.#source) throw new CaptureError("notCapturing");
    this.#clearTone();
    const tone = await this.#acquireTone();
    const src = this.#source;
    if (!src) throw new CaptureError("notCapturing");
    const node = tone.build(this.#ctx);
    try { src.node.disconnect(); } catch { /* already disconnected */ }
    node.connect(this.#sendGain);
    const entry = { node, cleanup: tone.cleanup, src };
    this.#tone = entry;
    return () => { if (this.#tone === entry) this.#clearTone(); };
  }

  /** Remove an active test tone; reconnect the source it muted if that source is still the live one. */
  #clearTone() {
    const tone = this.#tone;
    if (!tone) return;
    this.#tone = null;
    try { tone.node.disconnect(); } catch { /* already disconnected */ }
    try { tone.cleanup?.(); } catch { /* ignore */ }
    if (this.#source === tone.src) {
      try { tone.src.node.connect(this.#sendGain); } catch { /* ignore */ }
    }
  }

  stop() {
    this.#clearTone();
    const src = this.#source;
    this.#source = null;
    this.#token++;
    if (src) this.#release(src);
  }

  /** Linear ramp of the send level, scheduled on the audio clock so it works with the tab in the background. */
  fadeTo(level, ms = 0) {
    if (!this.#sendGain) return;
    const g = this.#sendGain.gain;
    const now = this.#ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(clamp01(level), now + Math.max(0, ms) / 1000);
  }

  setSendLevel(v) {
    const level = clamp01(v);
    if (this.#sendGain) {
      const g = this.#sendGain.gain;
      const now = this.#ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(level, now);
    }
    this.#persist(SETTINGS.SEND_LEVEL, level);
  }

  setMonitorLevel(v) {
    const level = clamp01(v);
    if (this.#monitorGain) {
      const g = this.#monitorGain.gain;
      const now = this.#ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(level, now);
    }
    this.#persist(SETTINGS.MONITOR_LEVEL, level);
  }

  /**
   * List audio inputs. If the browser hides labels (no mic permission yet), a temporary
   * getUserMedia({audio:true}) is opened and stopped again; this briefly opens the default mic.
   * @returns {Promise<{deviceId:string,label:string}[]>}
   */
  async listDevices() {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.enumerateDevices) throw new CaptureError("unsupported");
    const inputs = async () => (await md.enumerateDevices()).filter(d => d.kind === "audioinput");
    let devs = await inputs();
    if (devs.length && devs.some(d => !d.label)) {
      try {
        const s = await md.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        devs = await inputs();
      } catch (e) {
        console.warn(LOG_PREFIX, "could not unlock device labels", e);
      }
    }
    return devs.map(d => ({ deviceId: d.deviceId, label: d.label || d.deviceId }));
  }

  // ---------------------------------------------------------------------------------------------

  #persist(key, value) {
    try { game.settings.set(MODULE_ID, key, value)?.catch?.(() => {}); } catch { /* settings not ready */ }
  }

  #setting(key, fallback) {
    try {
      const v = game.settings.get(MODULE_ID, key);
      return typeof v === "number" ? clamp01(v) : fallback;
    } catch { return fallback; }
  }

  #ensureGraph() {
    return (this.#graphPromise ??= this.#buildGraph());
  }

  async #buildGraph() {
    await game.audio.unlock;
    const ctx = game.audio.music;
    this.#ctx = ctx;
    this.#sendGain = ctx.createGain();
    this.#sendGain.gain.value = this.#setting(SETTINGS.SEND_LEVEL, 1);
    this.#dest = ctx.createMediaStreamDestination();
    this.#sendGain.connect(this.#dest);
    this.#monitorGain = ctx.createGain();
    this.#monitorGain.gain.value = this.#setting(SETTINGS.MONITOR_LEVEL, 0.8);
    this.#sendGain.connect(this.#monitorGain);
    this.#monitorGain.connect(ctx.gainNode ?? ctx.destination);
  }

  #release(src) {
    try { src.node.disconnect(); } catch { /* already disconnected */ }
    src.stream?.getTracks().forEach(t => t.stop());
    try { src.cleanup?.(); } catch { /* ignore */ }
  }

  #handleEnded(token) {
    const src = this.#source;
    if (!src || src.token !== token) return;
    this.#source = null;
    this.#release(src);
    console.log(LOG_PREFIX, "source ended:", src.label);
    this.#endedCb?.(src.label);
  }

  async #acquire(source, deviceId) {
    if (source === "tone") return this.#acquireTone();
    if (source !== "tab" && source !== "device") throw new CaptureError("unsupported");

    if (!globalThis.isSecureContext) throw new CaptureError("insecure");
    const md = globalThis.navigator?.mediaDevices;
    if (!md || !(source === "tab" ? md.getDisplayMedia : md.getUserMedia)) throw new CaptureError("unsupported");

    if (source === "tab") {
      // Must be the first await after the click (transient user activation).
      const hadActivation = globalThis.navigator.userActivation?.isActive ?? true;
      let stream;
      try {
        stream = await md.getDisplayMedia({
          video: { displaySurface: "browser" },
          audio: { ...AUDIO_CONSTRAINTS, suppressLocalAudioPlayback: true },
          selfBrowserSurface: "exclude",
          monitorTypeSurfaces: "exclude",
          windowAudio: "exclude",
          systemAudio: "exclude",
          surfaceSwitching: "exclude" // no "Share this tab instead": switching to the Foundry tab would capture the monitor (feedback)
        });
      } catch (e) {
        throw mapCaptureError(e, { hadActivation });
      }
      const audio = stream.getAudioTracks();
      try {
        validateDisplayCapture(stream);
      } catch (e) {
        stream.getTracks().forEach(t => t.stop());
        throw e;
      }
      stream.getVideoTracks().forEach(t => t.stop()); // the audio track keeps running
      return { label: "tab", stream, track: audio[0], build: ctx => ctx.createMediaStreamSource(stream) };
    }

    if (!deviceId) throw new CaptureError("deviceMissing");
    let stream;
    try {
      stream = await md.getUserMedia({ audio: { deviceId: { exact: deviceId }, ...AUDIO_CONSTRAINTS } });
    } catch (e) {
      throw mapCaptureError(e);
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach(t => t.stop());
      throw new CaptureError("noAudio");
    }
    return { label: "device", stream, track, build: ctx => ctx.createMediaStreamSource(stream) };
  }

  /** Stereo test tone: 440 Hz left, 660 Hz right, gain 0.2. */
  async #acquireTone() {
    const oscs = [];
    return {
      label: "tone",
      stream: null,
      track: null,
      build: ctx => {
        const l = ctx.createOscillator();
        const r = ctx.createOscillator();
        const merger = ctx.createChannelMerger(2);
        const gain = ctx.createGain();
        l.frequency.value = 440;
        r.frequency.value = 660;
        gain.gain.value = 0.2;
        l.connect(merger, 0, 0);
        r.connect(merger, 0, 1);
        merger.connect(gain);
        l.start();
        r.start();
        oscs.push(l, r);
        return gain;
      },
      cleanup: () => { for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } } }
    };
  }
}
