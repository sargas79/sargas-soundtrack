/**
 * Player side (every non-broadcasting client): locks onto the active GM's session,
 * answers the offer and routes the incoming stream into the Foundry music channel.
 */
import { MODULE_ID, SETTINGS, MSG, HOOKS, LOG_PREFIX } from "./constants.js";
import { inspect } from "./signaling.js";
import { mungeAnswer } from "./sdp.js";
import { summarizeStats } from "./stats.js";

export const RETRY_DELAYS = [2000, 5000, 10000];
/** How long to wait for an OFFER after sending a REQUEST before counting it as a failed attempt. */
export const OFFER_TIMEOUT = 8000;
/** How long a connection may take after the answer is sent before it counts as a failed attempt
 * (with no usable route, for example Relay only without a reachable TURN server, ICE can stay "checking"). */
export const CONNECT_TIMEOUT = 15000;

export class Receiver {
  #lock = null;
  #status = "idle";
  #pc = null;
  #hasRemote = false;
  #pendingIce = [];
  #retries = 0;
  #retryTimer = null;
  #audioEl = null;
  #srcNode = null;
  #personalGain = null;
  #hookVolume = 1;
  #usingFallback = false;
  #prev = null;
  #volumeHook;

  /**
   * @param {object} o
   * @param {import("./signaling.js").Signaling} o.signaling
   * @param {() => number} o.getBitrate
   * @param {() => object[]} [o.getIceServers]
   * @param {() => RTCConfiguration} [o.getRtcConfig] full connection config; wins over getIceServers
   * @param {{setTimeout:Function, clearTimeout:Function}} [o.scheduler] injectable for tests
   * @param {typeof RTCPeerConnection} [o.RTCPeerConnection] injectable for tests
   * @param {Document} [o.document] injectable for tests
   */
  constructor({ signaling, getBitrate, getIceServers = () => [], getRtcConfig = null, scheduler = globalThis, RTCPeerConnection = null, document = null }) {
    this.signaling = signaling;
    this.RTCPeerConnection = RTCPeerConnection;
    this.document = document;
    this.getBitrate = getBitrate;
    this.getIceServers = getIceServers;
    this.getRtcConfig = getRtcConfig;
    this.scheduler = scheduler;
    this.#volumeHook = Hooks.on("globalPlaylistVolumeChanged", v => {
      this.#hookVolume = Number(v) || 0;
      if (this.#usingFallback) this.#applyGain();
    });
  }

  get status() { return this.#status; }
  get lock() { return this.#lock; }
  get isLive() { return this.#status === "live"; }

  destroy() {
    Hooks.off("globalPlaylistVolumeChanged", this.#volumeHook);
    this.#end(false);
  }

  /** Late join / reload: ask the active GM whether a session is running. */
  probe() {
    const gm = game.users.activeGM;
    if (!gm?.active || gm.id === game.user.id) return;
    this.signaling.send(MSG.REQUEST, { sessionId: null }, gm.id);
  }

  setMute(mute) {
    game.settings.set(MODULE_ID, SETTINGS.MUTE, !!mute)?.catch?.(() => {});
    this.#applyGain();
  }

  /** Context for {@link inspect}. */
  context() {
    return {
      selfId: game.user.id,
      role: "listener",
      activeGMId: game.users.activeGM?.id ?? null,
      lock: this.#lock,
      live: false,
      sessionId: this.#lock?.sessionId ?? null,
      peers: new Set()
    };
  }

  /** Route a socket message (identity from senderId only). */
  handle(msg, senderId) {
    const verdict = inspect(msg, senderId, this.context());
    if (!verdict.ok) { console.debug(LOG_PREFIX, "dropped", msg?.type, verdict.reason); return; }

    switch (msg.type) {
      case MSG.LIVE:
        this.#teardown();
        this.#cancelRetry();
        this.#retries = 0;
        this.#lock = { senderId, sessionId: msg.sessionId };
        this.#setStatus("connecting");
        Hooks.callAll(HOOKS.LIVE, { sessionId: msg.sessionId });
        this.#request();
        break;
      case MSG.OFFER:
        if (!this.#lock) {
          this.#lock = { senderId, sessionId: msg.sessionId };
          Hooks.callAll(HOOKS.LIVE, { sessionId: msg.sessionId });
        }
        this.#cancelRetry();
        this.#onOffer(msg);
        break;
      case MSG.ICE:
        this.#onIce(msg.candidate);
        break;
      case MSG.END:
        this.#end(true);
        break;
    }
  }

  /** Forwarded from Hooks "userConnected". */
  userConnected(user, connected) {
    if (connected || !user || !this.#lock || user.id !== this.#lock.senderId) return;
    this.#end(true);
  }

  async stats() {
    if (!this.#pc) return null;
    try {
      const { info, sample } = summarizeStats(await this.#pc.getStats(), "inbound", this.#prev);
      if (sample) this.#prev = sample;
      return info;
    } catch (err) {
      console.debug(LOG_PREFIX, "stats failed", err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------

  #setStatus(status) {
    if (this.#status === status) return;
    this.#status = status;
    Hooks.callAll(HOOKS.STATUS, { role: "listener", status });
  }

  #request() {
    if (!this.#lock) return;
    const lock = this.#lock;
    this.signaling.send(MSG.REQUEST, { sessionId: lock.sessionId }, lock.senderId);
    // Watchdog: if no OFFER arrives (GM not live, message lost), treat it as a failure and back off.
    // Shares the retry slot, so OFFER / END / LIVE cancel it like a pending retry.
    this.#cancelRetry();
    this.#retryTimer = this.scheduler.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#lock !== lock || this.#pc) return;
      console.log(LOG_PREFIX, "no offer received; will re-request");
      this.#setStatus("failed");
      this.#scheduleRetry();
    }, OFFER_TIMEOUT);
  }

  #cancelRetry() {
    if (this.#retryTimer !== null) { this.scheduler.clearTimeout(this.#retryTimer); this.#retryTimer = null; }
  }

  #scheduleRetry() {
    this.#cancelRetry();
    if (!this.#lock) return;
    if (this.#retries >= RETRY_DELAYS.length) { this.#setStatus("failed"); return; }
    const lock = this.#lock;
    const delay = RETRY_DELAYS[this.#retries++];
    this.#retryTimer = this.scheduler.setTimeout(() => {
      this.#retryTimer = null;
      if (this.#lock !== lock) return;
      this.#setStatus("connecting");
      this.#request();
    }, delay);
  }

  /** Connection died but the lock stands: tear down and ask again with backoff. */
  #connectionFailed(pc) {
    if (this.#pc !== pc) return;
    console.log(LOG_PREFIX, "connection failed; will re-request");
    this.#teardown();
    this.#setStatus("failed");
    this.#scheduleRetry();
  }

  /** END, GM left, or destroy: drop everything including the lock. */
  #end(announce) {
    this.#cancelRetry();
    this.#teardown();
    const had = this.#lock !== null;
    this.#lock = null;
    this.#retries = 0;
    this.#setStatus("idle");
    if (announce && had) Hooks.callAll(HOOKS.ENDED, {});
  }

  #teardown() {
    const pc = this.#pc;
    this.#pc = null;
    this.#hasRemote = false;
    this.#pendingIce = [];
    this.#prev = null;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch { /* already closed */ }
    }
    this.#teardownRouting();
  }

  #teardownRouting() {
    if (this.#srcNode) { try { this.#srcNode.disconnect(); } catch { /* ignore */ } this.#srcNode = null; }
    if (this.#personalGain) { try { this.#personalGain.disconnect(); } catch { /* ignore */ } this.#personalGain = null; }
    if (this.#audioEl) {
      try { this.#audioEl.pause(); this.#audioEl.srcObject = null; this.#audioEl.remove(); } catch { /* ignore */ }
      this.#audioEl = null;
    }
  }

  async #onOffer(msg) {
    this.#teardown();
    const lock = this.#lock;
    const pc = new (this.RTCPeerConnection ?? globalThis.RTCPeerConnection)(this.getRtcConfig ? this.getRtcConfig() : { iceServers: this.getIceServers() });
    this.#pc = pc;
    this.#setStatus("connecting");

    pc.onicecandidate = ev => {
      if (ev.candidate && this.#pc === pc) this.signaling.send(MSG.ICE, { sessionId: lock.sessionId, candidate: ev.candidate.toJSON() }, lock.senderId);
    };
    pc.onconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.#cancelRetry(); // the connect timeout
        this.#retries = 0;
        this.#setStatus("live");
      } else if (pc.connectionState === "failed") {
        this.#connectionFailed(pc);
      }
    };
    pc.ontrack = ev => {
      const stream = ev.streams?.[0] ?? new (globalThis.MediaStream)([ev.track]);
      this.#route(stream, pc).catch(err => console.warn(LOG_PREFIX, "routing failed", err));
    };

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      if (this.#pc !== pc) return;
      this.#hasRemote = true;
      for (const c of this.#pendingIce.splice(0)) await pc.addIceCandidate(c);
      const answer = await pc.createAnswer();
      if (this.#pc !== pc) return;
      const sdp = mungeAnswer(answer.sdp, this.getBitrate());
      await pc.setLocalDescription({ type: "answer", sdp });
      if (this.#pc !== pc) return;
      this.signaling.send(MSG.ANSWER, { sessionId: lock.sessionId, sdp }, lock.senderId);
      // Connect timeout: shares the retry slot, so OFFER / END / LIVE and a successful connection cancel it.
      this.#cancelRetry();
      this.#retryTimer = this.scheduler.setTimeout(() => {
        this.#retryTimer = null;
        if (this.#pc !== pc || pc.connectionState === "connected") return;
        console.log(LOG_PREFIX, "no connection after the answer; will re-request");
        this.#connectionFailed(pc);
      }, CONNECT_TIMEOUT);
    } catch (err) {
      console.warn(LOG_PREFIX, "offer handling failed", err);
      this.#connectionFailed(pc);
    }
  }

  async #onIce(candidate) {
    if (!this.#pc || !this.#hasRemote) { this.#pendingIce.push(candidate); return; }
    try { await this.#pc.addIceCandidate(candidate); } catch (err) { console.debug(LOG_PREFIX, "addIceCandidate", err); }
  }

  async #route(stream, pc) {
    await game.audio.unlock;
    if (this.#pc !== pc) return;
    this.#teardownRouting();
    const ctx = game.audio.music;

    // Chromium bug 933677: a remote stream fed to Web Audio is silent unless it is also
    // attached to a playing (muted) media element. Required, keep it referenced.
    const doc = this.document ?? globalThis.document;
    const el = doc.createElement("audio");
    el.style.display = "none";
    el.muted = true;
    el.autoplay = true;
    el.srcObject = stream;
    doc.body?.append(el);
    this.#audioEl = el;
    try { await el.play(); } catch (err) { console.debug(LOG_PREFIX, "audio element play() rejected", err); }
    if (this.#pc !== pc) return;

    this.#srcNode = ctx.createMediaStreamSource(stream);
    this.#personalGain = ctx.createGain();
    this.#srcNode.connect(this.#personalGain);
    this.#usingFallback = false;
    try {
      if (!ctx.gainNode) throw new Error("game.audio.music.gainNode is not available");
      this.#personalGain.connect(ctx.gainNode);
    } catch (err) {
      console.warn(LOG_PREFIX, "could not route into the Foundry music channel; using the plain destination", err);
      this.#usingFallback = true;
      this.#personalGain.connect(ctx.destination);
      Hooks.callAll(HOOKS.ROUTE_FALLBACK, { reason: String(err?.message ?? err) });
    }
    this.#applyGain();
  }

  #applyGain() {
    if (!this.#personalGain) return;
    let mute = false;
    try { mute = !!game.settings.get(MODULE_ID, SETTINGS.MUTE); } catch { /* not ready */ }
    const base = this.#usingFallback ? this.#hookVolume : 1;
    this.#personalGain.gain.value = mute ? 0 : base;
  }
}
