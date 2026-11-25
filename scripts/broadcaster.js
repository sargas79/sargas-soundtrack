/**
 * GM side: one RTCPeerConnection per listening player, all fed by the same capture output track.
 * Only constructed for the active GM.
 */
import { MSG, HOOKS, LOG_PREFIX } from "./constants.js";
import { inspect } from "./signaling.js";
import { mungeOffer } from "./sdp.js";
import { CaptureError } from "./capture.js";
import { summarizeStats } from "./stats.js";

/** A player whose connection is not up this long after the offer is shown as failed. Longer than the
 * player's own 15 s connect timeout, so a player's re-request normally replaces the peer first. */
export const PEER_CONNECT_TIMEOUT = 20000;

export class Broadcaster {
  /** @type {Map<string, {pc:RTCPeerConnection, state:string, pendingIce:object[], hasRemote:boolean, prev:object|null}>} */
  #peers = new Map();
  /** Users whose peer failed: reported as "failed" until they REQUEST again, disconnect, or the broadcast stops. */
  #failed = new Set();
  #live = false;
  #sessionId = null;
  #onUnload;

  /**
   * @param {object} o
   * @param {import("./signaling.js").Signaling} o.signaling
   * @param {import("./capture.js").Capture} o.capture
   * @param {() => object[]} o.getIceServers
   * @param {() => RTCConfiguration} [o.getRtcConfig] full connection config; wins over getIceServers
   * @param {() => number} o.getBitrate
   * @param {typeof RTCPeerConnection} [o.RTCPeerConnection] injectable for tests
   * @param {{addEventListener:Function, removeEventListener:Function}|null} [o.windowLike] receives "beforeunload"
   */
  constructor({ signaling, capture, getIceServers, getRtcConfig = null, getBitrate, RTCPeerConnection = null, windowLike = globalThis, scheduler = globalThis }) {
    this.scheduler = scheduler;
    this.signaling = signaling;
    this.capture = capture;
    this.getIceServers = getIceServers;
    this.getRtcConfig = getRtcConfig;
    this.getBitrate = getBitrate;
    this.RTCPeerConnection = RTCPeerConnection;
    this.windowLike = windowLike;

    capture.onEnded(() => {
      if (!this.#live) return;
      ui.notifications.warn(game.i18n.localize("SARGAS_SOUNDTRACK.Notify.SourceEnded"));
      this.stop();
    });
    this.#onUnload = () => {
      if (!this.#live) return;
      try { this.signaling.send(MSG.END, { sessionId: this.#sessionId }); } catch { /* page is closing */ }
    };
    this.windowLike?.addEventListener?.("beforeunload", this.#onUnload);
  }

  get live() { return this.#live; }
  get sessionId() { return this.#sessionId; }
  get peerCount() { return this.#peers.size; }

  destroy() {
    this.windowLike?.removeEventListener?.("beforeunload", this.#onUnload);
    this.stop();
  }

  /** One entry per user with a peer ("connecting" | "connected") or a failed one ("failed"). */
  statuses() {
    const name = userId => game.users.get(userId)?.name ?? userId;
    return [
      ...[...this.#peers].map(([userId, e]) => ({ userId, name: name(userId), state: e.state })),
      ...[...this.#failed].filter(userId => !this.#peers.has(userId)).map(userId => ({ userId, name: name(userId), state: "failed" }))
    ];
  }

  /**
   * Start capturing `source` and go live. When already live, only switches the source
   * (the outgoing track is persistent, so no renegotiation). Throws CaptureError on failure,
   * leaving any previous state untouched.
   * @param {"tab"|"device"|"tone"} [source]
   * @param {{deviceId?:string}} [opts]
   */
  async goLive(source = "tab", opts = {}) {
    if (!game.user.isActiveGM) throw new CaptureError("notActiveGM");
    await this.capture.start(source, opts);
    if (this.#live) return;
    this.#sessionId = foundry.utils.randomID();
    this.#live = true;
    this.signaling.send(MSG.LIVE, { sessionId: this.#sessionId });
    Hooks.callAll(HOOKS.LIVE, { sessionId: this.#sessionId });
    this.#emitStatus();
  }

  stop() {
    if (!this.#live) return;
    const sessionId = this.#sessionId;
    this.signaling.send(MSG.END, { sessionId });
    for (const [uid, e] of [...this.#peers]) this.#closePeer(uid, e);
    this.#failed.clear();
    this.#live = false;
    this.#sessionId = null;
    this.capture.stop();
    Hooks.callAll(HOOKS.ENDED, { sessionId });
    this.#emitStatus();
  }

  /** Forwarded from Hooks "userConnected". */
  userConnected(user, connected) {
    if (connected || !user) return;
    const e = this.#peers.get(user.id);
    const hadFailed = this.#failed.delete(user.id);
    if (e) this.#closePeer(user.id, e);
    if (e || hadFailed) this.#emitStatus();
  }

  /** Context for {@link inspect}. */
  context() {
    return {
      selfId: game.user.id,
      role: "broadcaster",
      activeGMId: game.users.activeGM?.id ?? null,
      lock: null,
      live: this.#live,
      sessionId: this.#sessionId,
      peers: new Set(this.#peers.keys())
    };
  }

  /** Route a socket message (identity from senderId only). */
  handle(msg, senderId) {
    const verdict = inspect(msg, senderId, this.context());
    if (!verdict.ok) { console.debug(LOG_PREFIX, "dropped", msg?.type, verdict.reason); return; }
    switch (msg.type) {
      case MSG.REQUEST: return this.#onRequest(senderId);
      case MSG.ANSWER: return this.#onAnswer(senderId, msg);
      case MSG.ICE: return this.#onIce(senderId, msg);
    }
  }

  async stats() {
    const out = [];
    for (const [userId, e] of this.#peers) {
      try {
        const { info, sample } = summarizeStats(await e.pc.getStats(), "outbound", e.prev);
        if (sample) e.prev = sample;
        out.push({ userId, ...info });
      } catch (err) {
        console.debug(LOG_PREFIX, "stats failed for", userId, err);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------

  #emitStatus() {
    Hooks.callAll(HOOKS.STATUS, { role: "broadcaster", live: this.#live, peers: this.statuses() });
  }

  #closePeer(uid, entry) {
    if (this.#peers.get(uid) === entry) this.#peers.delete(uid);
    if (entry.timer != null) { this.scheduler.clearTimeout(entry.timer); entry.timer = null; }
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    try { entry.pc.close(); } catch { /* already closed */ }
  }

  /** Drop the peer but remember the failure so the GM row can show it. */
  #failPeer(uid, entry) {
    this.#closePeer(uid, entry);
    this.#failed.add(uid);
    this.#emitStatus();
  }

  async #onRequest(uid) {
    if (!this.#live || !this.capture.active) return;
    const old = this.#peers.get(uid);
    if (old) this.#closePeer(uid, old);
    this.#failed.delete(uid);

    const sessionId = this.#sessionId;
    const pc = new (this.RTCPeerConnection ?? globalThis.RTCPeerConnection)(this.getRtcConfig ? this.getRtcConfig() : { iceServers: this.getIceServers() });
    const entry = { pc, state: "connecting", pendingIce: [], hasRemote: false, prev: null };
    this.#peers.set(uid, entry);
    const stale = () => this.#peers.get(uid) !== entry;

    pc.onicecandidate = ev => {
      if (ev.candidate && !stale()) this.signaling.send(MSG.ICE, { sessionId, candidate: ev.candidate.toJSON() }, uid);
    };
    pc.onconnectionstatechange = () => this.#onConnectionState(uid, entry);
    this.#emitStatus();

    try {
      const transceiver = pc.addTransceiver(this.capture.outputTrack, { direction: "sendonly", streams: [this.capture.outputStream] });
      const offer = await pc.createOffer();
      if (stale()) return;
      const sdp = mungeOffer(offer.sdp);
      await pc.setLocalDescription({ type: "offer", sdp });
      if (stale()) return;
      this.signaling.send(MSG.OFFER, { sessionId, sdp }, uid);
      this.#applyBitrate(transceiver.sender);
      entry.timer = this.scheduler.setTimeout(() => {
        entry.timer = null;
        if (stale() || entry.state === "connected") return;
        console.log(LOG_PREFIX, `peer ${uid} did not connect in time; marked failed`);
        this.#failPeer(uid, entry);
      }, PEER_CONNECT_TIMEOUT);
      entry.timer?.unref?.(); // never keeps a Node test process alive
    } catch (err) {
      console.warn(LOG_PREFIX, "offer failed for", uid, err);
      if (!stale()) this.#failPeer(uid, entry);
    }
  }

  async #applyBitrate(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.getBitrate() * 1000;
      await sender.setParameters(params);
    } catch (err) {
      console.debug(LOG_PREFIX, "could not set maxBitrate (best effort)", err);
    }
  }

  async #onAnswer(uid, msg) {
    const entry = this.#peers.get(uid);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      if (this.#peers.get(uid) !== entry) return;
      entry.hasRemote = true;
      for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c);
    } catch (err) {
      console.warn(LOG_PREFIX, "answer failed for", uid, err);
      if (this.#peers.get(uid) === entry) this.#failPeer(uid, entry);
    }
  }

  async #onIce(uid, msg) {
    const entry = this.#peers.get(uid);
    if (!entry) return;
    if (!entry.hasRemote) { entry.pendingIce.push(msg.candidate); return; }
    try { await entry.pc.addIceCandidate(msg.candidate); } catch (err) { console.debug(LOG_PREFIX, "addIceCandidate", err); }
  }

  #onConnectionState(uid, entry) {
    if (this.#peers.get(uid) !== entry) return;
    const s = entry.pc.connectionState;
    if (s === "failed") {
      console.log(LOG_PREFIX, `peer ${uid} failed; removed`);
      this.#failPeer(uid, entry);
      return;
    } else if (s === "closed") {
      console.log(LOG_PREFIX, `peer ${uid} closed; removed`);
      this.#closePeer(uid, entry);
    } else {
      entry.state = s === "connected" ? "connected" : "connecting";
    }
    this.#emitStatus();
  }
}
