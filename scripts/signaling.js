import { MSG } from "./constants.js";

const TYPES = new Set(Object.values(MSG));
const isStr = v => typeof v === "string" && v.length > 0;
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Decide whether an incoming signalling message should be acted on.
 * Identity comes ONLY from `senderId` (appended by the server), never from the payload.
 *
 * @param {object} msg
 * @param {string} senderId
 * @param {{selfId:string, role:"broadcaster"|"listener", activeGMId:string|null,
 *          lock:{senderId:string,sessionId:string}|null, live:boolean,
 *          sessionId:string|null, peers:Set<string>}} ctx
 * @returns {{ok:boolean, reason:string|null, lock?:boolean}} `lock: true` means a listener
 *          with no lock should lock to this sender (OFFER from the active GM).
 */
export function inspect(msg, senderId, ctx) {
  const no = reason => ({ ok: false, reason });
  const yes = extra => ({ ok: true, reason: null, ...extra });

  if (!isObj(msg)) return no("malformed");
  if (!TYPES.has(msg.type)) return no("unknown-type");
  if (!isStr(senderId)) return no("no-sender");

  if (msg.type === MSG.REQUEST) {
    if (msg.sessionId != null && !isStr(msg.sessionId)) return no("malformed");
  } else if (!isStr(msg.sessionId)) return no("malformed");
  if (msg.to !== undefined && msg.to !== null && typeof msg.to !== "string") return no("malformed");
  if ((msg.type === MSG.OFFER || msg.type === MSG.ANSWER) && !isStr(msg.sdp)) return no("malformed");
  if (msg.type === MSG.ICE && !isObj(msg.candidate)) return no("malformed");

  if (msg.to && msg.to !== ctx.selfId) return no("not-for-me");
  if (senderId === ctx.selfId) return no("self");

  if (ctx.role === "listener") {
    const lock = ctx.lock;
    const session = ctx.sessionId ?? lock?.sessionId ?? null;
    switch (msg.type) {
      case MSG.LIVE:
        return senderId === ctx.activeGMId ? yes() : no("not-active-gm");
      case MSG.OFFER:
        if (lock) {
          if (senderId !== lock.senderId) return no("wrong-sender");
          return msg.sessionId === session ? yes() : no("stale-session");
        }
        return senderId === ctx.activeGMId ? yes({ lock: true }) : no("not-active-gm");
      case MSG.ICE:
      case MSG.END:
        if (!lock) return no("no-lock");
        if (senderId !== lock.senderId) return no("wrong-sender");
        return msg.sessionId === session ? yes() : no("stale-session");
      default:
        return no("wrong-role");
    }
  }

  if (ctx.role === "broadcaster") {
    switch (msg.type) {
      case MSG.REQUEST:
        if (!ctx.live) return no("not-live");
        if (msg.sessionId != null && msg.sessionId !== ctx.sessionId) return no("stale-session");
        return yes();
      case MSG.ANSWER:
      case MSG.ICE:
        if (!ctx.live) return no("not-live");
        if (!ctx.peers?.has(senderId)) return no("unknown-peer");
        return msg.sessionId === ctx.sessionId ? yes() : no("stale-session");
      default:
        return no("wrong-role");
    }
  }
  return no("bad-role");
}

/** Boolean form of {@link inspect}. */
export function accept(msg, senderId, ctx) {
  return inspect(msg, senderId, ctx).ok;
}

/** Thin wrapper over the Foundry module socket. */
export class Signaling {
  /**
   * @param {string} channel
   * @param {{emit:Function, on:Function}} [socket] injectable for tests; defaults to game.socket
   */
  constructor(channel, socket = null) {
    this.channel = channel;
    this._socket = socket;
  }

  get socket() { return this._socket ?? game.socket; }

  /** Send to one user (`to`) or broadcast to everyone else (no `to`). */
  send(type, payload = {}, to = null) {
    const msg = { sessionId: null, ...payload, type, to: to ?? null };
    if (to) this.socket.emit(this.channel, msg, { recipients: [to] });
    else this.socket.emit(this.channel, msg);
  }

  /**
   * Register a handler. With `getCtx` every message is first filtered through {@link inspect}
   * and the handler gets (msg, senderId, verdict); without it, messages are passed through raw.
   */
  onMessage(handler, getCtx = null) {
    this.socket.on(this.channel, (msg, senderId) => {
      if (!getCtx) return handler(msg, senderId, null);
      const verdict = inspect(msg, senderId, getCtx());
      if (verdict.ok) handler(msg, senderId, verdict);
    });
  }
}
