/** Browser fakes for unit tests: WebRTC, media tracks, Web Audio, document, scheduler. */
import { CHROMIUM_AUDIO_OFFER } from "./sdp-fixtures.js";

export class FakeTrack {
  constructor(kind = "audio", settings = {}) {
    this.kind = kind;
    this.settings = settings;
    this.stopped = false;
    this.listeners = new Map();
  }
  getSettings() { return this.settings; }
  stop() { this.stopped = true; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type) { for (const fn of this.listeners.get(type) ?? []) fn({ type }); }
}

export class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
}

export const displayStream = ({ surface = "browser", audio = 1, video = 1 } = {}) =>
  new FakeStream([
    ...Array.from({ length: video }, () => new FakeTrack("video", { displaySurface: surface })),
    ...Array.from({ length: audio }, () => new FakeTrack("audio"))
  ]);

export class FakePC {
  static instances = [];
  static reset() { FakePC.instances = []; }
  static get last() { return FakePC.instances.at(-1); }

  constructor(config) {
    this.config = config;
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.added = [];
    this.transceivers = [];
    this.closed = false;
    this.offerSdp = CHROMIUM_AUDIO_OFFER;
    this.answerSdp = CHROMIUM_AUDIO_OFFER.replace("a=sendonly", "a=recvonly");
    this.stats = [];
    this.setParametersCalls = [];
    FakePC.instances.push(this);
  }
  addTransceiver(track, init) {
    const params = { encodings: [{}] };
    const sender = {
      getParameters: () => structuredClone(params),
      setParameters: async p => { this.setParametersCalls.push(structuredClone(p)); Object.assign(params, structuredClone(p)); }
    };
    const t = { track, init, sender };
    this.transceivers.push(t);
    return t;
  }
  async createOffer() { return { type: "offer", sdp: this.offerSdp }; }
  async createAnswer() { return { type: "answer", sdp: this.answerSdp }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate(c) {
    if (!this.remoteDescription) throw new Error("no remote description");
    this.added.push(c);
  }
  async getStats() { return new Map(this.stats.map(s => [s.id, s])); }
  close() { this.closed = true; this.connectionState = "closed"; }
  /** Test helper: change connection state and fire the handler. */
  setState(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  emitCandidate(c = { candidate: "candidate:1 1 udp 1 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 }) {
    this.onicecandidate?.({ candidate: { ...c, toJSON: () => ({ ...c }) } });
  }
  emitTrack(stream = new FakeStream([new FakeTrack("audio")])) {
    this.ontrack?.({ streams: [stream], track: stream.getAudioTracks()[0] });
    return stream;
  }
}

export class FakeParam {
  value = 0;
  calls = [];
  cancelScheduledValues(t) { this.calls.push(["cancel", t]); }
  setValueAtTime(v, t) { this.calls.push(["set", v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.calls.push(["ramp", v, t]); }
}

export class FakeNode {
  constructor(kind) { this.kind = kind; this.connections = []; this.disconnected = false; }
  connect(target, ...args) { this.connections.push([target, ...args]); return target; }
  disconnect() { this.disconnected = true; this.connections = []; }
  connectedTo(target) { return this.connections.some(c => c[0] === target); }
}

export class FakeAudioContext {
  currentTime = 10;
  destination = new FakeNode("destination");
  gainNode = new FakeNode("musicGain");
  nodes = [];
  #make(kind, extra = {}) {
    const n = Object.assign(new FakeNode(kind), extra);
    this.nodes.push(n);
    return n;
  }
  createGain() { return this.#make("gain", { gain: new FakeParam() }); }
  createOscillator() {
    const n = this.#make("osc", { frequency: new FakeParam() });
    n.start = () => { n.started = true; };
    n.stop = () => { n.stopped = true; };
    return n;
  }
  createChannelMerger(n) { return this.#make("merger", { inputs: n }); }
  createMediaStreamDestination() { return this.#make("dest", { stream: new FakeStream([new FakeTrack("audio")]) }); }
  createMediaStreamSource(stream) { return this.#make("streamSource", { stream }); }
  of(kind) { return this.nodes.filter(n => n.kind === kind); }
}

/** Minimal document that records created elements. */
export function fakeDocument() {
  const made = [];
  return {
    made,
    createElement(tag) {
      const el = {
        tag, style: {}, muted: false, autoplay: false, srcObject: null, removed: false, played: 0, paused: false,
        play() { this.played++; return Promise.resolve(); },
        pause() { this.paused = true; },
        remove() { this.removed = true; }
      };
      made.push(el);
      return el;
    },
    body: { append(el) { el.attached = true; } }
  };
}

/** Manual scheduler: setTimeout only records; fireNext() runs the oldest pending timer. */
export function fakeScheduler() {
  let id = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, ms) { const i = id++; timers.set(i, { fn, ms }); return i; },
    clearTimeout(i) { timers.delete(i); },
    get pending() { return [...timers.values()]; },
    /** Fire the oldest pending timer; returns its delay. */
    fireNext() { const [i, t] = timers.entries().next().value; timers.delete(i); t.fn(); return t.ms; }
  };
}

/** Fake timers with intervals; time only moves through advance(). */
export function fakeClock() {
  let now = 0, id = 1;
  const timers = new Map();
  const api = {
    timers,
    get now() { return now; },
    setTimeout(fn, ms) { const i = id++; timers.set(i, { fn, at: now + ms, every: null }); return i; },
    setInterval(fn, ms) { const i = id++; timers.set(i, { fn, at: now + ms, every: ms }); return i; },
    clearTimeout(i) { timers.delete(i); },
    clearInterval(i) { timers.delete(i); },
    get pendingCount() { return timers.size; },
    get intervals() { return [...timers.values()].filter(t => t.every !== null); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [i, t] = due;
        now = t.at;
        if (t.every !== null) t.at += t.every; else timers.delete(i);
        t.fn();
      }
      now = end;
    }
  };
  return api;
}

/** Minimal DOM element: lazily creates children for `[data-ss="name"]` selectors. */
export class FakeEl {
  constructor(name = "el") {
    this.name = name;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.dataset = {};
    this.id = "";
    this.isConnected = true;
    this.ownerDocument = { activeElement: null };
    this.listeners = new Map();
    this.styleProps = {};
    this.style = { setProperty: (k, v) => { this.styleProps[k] = v; } };
    this.children = new Map();
    this.removed = false;
    this.writes = 0;
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, ...ev }); }
  querySelector(sel) {
    const m = /^\[data-ss="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    if (!this.children.has(m[1])) this.children.set(m[1], new FakeEl(m[1]));
    return this.children.get(m[1]);
  }
  remove() { this.removed = true; this.isConnected = false; this.onRemove?.(); }
  focus() { this.ownerDocument.activeElement = this; }
}

/** A fake sidebar app element: holds at most one inserted row, with an optional header part. */
export function fakeAppElement({ withHeader = true } = {}) {
  const el = {
    row: null,
    inserts: 0,
    header: withHeader ? new FakeEl("header") : null,
    querySelector(sel) {
      if (sel === "#sargas-soundtrack-row") return this.row && !this.row.removed ? this.row : null;
      if (sel === "[data-application-part=\"header\"]") return this.header;
      return null;
    },
    prepend(node) { this.insert(node, "prepend"); },
    insert(node, how) { this.row = node; this.how = how; node.isConnected = true; this.inserts++; node.onRemove = () => { if (this.row === node) this.row = null; }; }
  };
  if (el.header) el.header.after = node => el.insert(node, "after-header");
  return el;
}

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
