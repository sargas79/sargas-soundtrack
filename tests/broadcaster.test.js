import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeAudioContext, FakePC, FakeStream, FakeTrack, fakeScheduler, flush } from "./helpers/fakes.js";
import { Broadcaster, PEER_CONNECT_TIMEOUT } from "../scripts/broadcaster.js";
import { Capture, CaptureError } from "../scripts/capture.js";
import { Signaling } from "../scripts/signaling.js";
import { MSG, HOOKS, SOCKET_CHANNEL } from "../scripts/constants.js";
import { registerSettings } from "../scripts/settings.js";

const ICE = [{ urls: "stun:test.example:3478" }];
let stub, music, capture, b, win;

const users = [
  { id: "gm1", isGM: true }, { id: "p1" }, { id: "p2" }
];

function makeWindow() {
  const handlers = new Map();
  return {
    addEventListener: (t, fn) => handlers.set(t, fn),
    removeEventListener: (t, fn) => { if (handlers.get(t) === fn) handlers.delete(t); },
    fire: t => handlers.get(t)?.(),
    has: t => handlers.has(t)
  };
}

const request = (sessionId = null) => ({ type: MSG.REQUEST, sessionId, to: null });
const sent = type => stub.socket.sent(type);

async function live() {
  await b.goLive("tone");
  stub.socket.clear();
  return b.sessionId;
}

/** Deliver a REQUEST from `uid` and wait for the OFFER. */
async function connect(uid) {
  b.handle(request(), uid);
  await flush();
  return FakePC.last;
}

beforeEach(() => {
  stub = installFoundryStub({ users });
  registerSettings();
  FakePC.reset();
  music = new FakeAudioContext();
  game.audio = { unlock: Promise.resolve(), music };
  capture = new Capture();
  win = makeWindow();
  b = new Broadcaster({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), capture,
    getIceServers: () => ICE, getBitrate: () => 128, RTCPeerConnection: FakePC, windowLike: win
  });
});
afterEach(() => { b.destroy(); stub.uninstall(); });

test("goLive starts capture, broadcasts LIVE with a session id and fires the live hook", async () => {
  await b.goLive("tone");
  assert.equal(capture.active, true);
  assert.equal(b.live, true);
  assert.ok(b.sessionId);
  const [live] = sent(MSG.LIVE);
  assert.equal(live.payload.sessionId, b.sessionId);
  assert.equal(live.channel, SOCKET_CHANNEL);
  assert.equal(live.options, undefined, "LIVE is a broadcast, not addressed");
  assert.equal(stub.hooks.calls.filter(c => c.name === HOOKS.LIVE).length, 1);
});

test("goLive only works for the active GM", async () => {
  stub.setUser("p1");
  await assert.rejects(b.goLive("tone"), e => e instanceof CaptureError && e.code === "notActiveGM");
  assert.equal(b.live, false);
  assert.equal(capture.active, false);
});

test("goLive propagates a capture failure and stays offline", async () => {
  await assert.rejects(b.goLive("bogus"), e => e.code === "unsupported");
  assert.equal(b.live, false);
  assert.equal(sent(MSG.LIVE).length, 0);
});

test("goLive while live only switches the source (no second LIVE)", async () => {
  await live();
  const track = capture.outputTrack;
  await b.goLive("tone");
  assert.equal(sent(MSG.LIVE).length, 0);
  assert.equal(capture.outputTrack, track);
});

test("REQUEST while not live is ignored", async () => {
  b.handle(request(), "p1");
  await flush();
  assert.equal(FakePC.instances.length, 0);
  assert.equal(sent(MSG.OFFER).length, 0);
});

test("REQUEST creates a peer, adds the persistent track sendonly and sends a munged OFFER only to that user", async () => {
  const sessionId = await live();
  const pc = await connect("p1");

  assert.deepEqual(pc.config, { iceServers: ICE });
  const [t] = pc.transceivers;
  assert.equal(t.track, capture.outputTrack);
  assert.equal(t.init.direction, "sendonly");
  assert.deepEqual(t.init.streams, [capture.outputStream]);

  const [offer] = sent(MSG.OFFER);
  assert.deepEqual(offer.options, { recipients: ["p1"] });
  assert.equal(offer.payload.to, "p1");
  assert.equal(offer.payload.sessionId, sessionId);
  assert.match(offer.payload.sdp, /a=fmtp:111 [^\r\n]*sprop-stereo=1/);
  assert.equal(pc.localDescription.type, "offer");
  assert.equal(pc.localDescription.sdp, offer.payload.sdp);
  assert.equal(b.peerCount, 1);
});

test("sender maxBitrate is kbps * 1000", async () => {
  await live();
  const pc = await connect("p1");
  assert.equal(pc.setParametersCalls.at(-1).encodings[0].maxBitrate, 128000);
});

test("local ICE candidates are trickled to that user only", async () => {
  const sessionId = await live();
  const pc = await connect("p1");
  stub.socket.clear();
  pc.emitCandidate();
  const [ice] = sent(MSG.ICE);
  assert.deepEqual(ice.options, { recipients: ["p1"] });
  assert.equal(ice.payload.sessionId, sessionId);
  assert.equal(ice.payload.candidate.sdpMid, "0");
});

test("two listeners get independent peers", async () => {
  await live();
  const a = await connect("p1");
  const c = await connect("p2");
  assert.notEqual(a, c);
  assert.equal(b.peerCount, 2);
  assert.deepEqual(b.statuses().map(s => s.userId).sort(), ["p1", "p2"]);
});

test("a second REQUEST from the same user closes the old peer and offers on a new one", async () => {
  await live();
  const first = await connect("p1");
  const second = await connect("p1");
  assert.notEqual(first, second);
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  assert.equal(b.peerCount, 1);
  assert.equal(sent(MSG.OFFER).length, 2);
  // late events from the replaced peer are ignored
  stub.socket.clear();
  first.emitCandidate();
  assert.equal(sent(MSG.ICE).length, 0);
});

test("ANSWER sets the remote description", async () => {
  const sessionId = await live();
  const pc = await connect("p1");
  b.handle({ type: MSG.ANSWER, sessionId, sdp: "answer-sdp", to: null }, "p1");
  await flush();
  assert.deepEqual(pc.remoteDescription, { type: "answer", sdp: "answer-sdp" });
});

test("remote ICE is queued until the answer is applied, then flushed in order", async () => {
  const sessionId = await live();
  const pc = await connect("p1");
  const c1 = { candidate: "c1" }, c2 = { candidate: "c2" }, c3 = { candidate: "c3" };
  b.handle({ type: MSG.ICE, sessionId, candidate: c1 }, "p1");
  b.handle({ type: MSG.ICE, sessionId, candidate: c2 }, "p1");
  await flush();
  assert.deepEqual(pc.added, []);
  b.handle({ type: MSG.ANSWER, sessionId, sdp: "a" }, "p1");
  await flush();
  assert.deepEqual(pc.added, [c1, c2]);
  b.handle({ type: MSG.ICE, sessionId, candidate: c3 }, "p1");
  await flush();
  assert.deepEqual(pc.added, [c1, c2, c3]);
});

test("ANSWER/ICE from unknown users or with a stale session are ignored", async () => {
  const sessionId = await live();
  const pc = await connect("p1");
  b.handle({ type: MSG.ANSWER, sessionId, sdp: "a" }, "p2");
  b.handle({ type: MSG.ANSWER, sessionId: "old", sdp: "a" }, "p1");
  b.handle({ type: MSG.ICE, sessionId: "old", candidate: { candidate: "x" } }, "p1");
  await flush();
  assert.equal(pc.remoteDescription, null);
  assert.deepEqual(pc.pendingIce ?? [], []);
});

test("peer removed when its connection fails or closes", async () => {
  await live();
  const a = await connect("p1");
  const c = await connect("p2");
  a.setState("failed");
  assert.equal(b.peerCount, 1);
  assert.equal(a.closed, true);
  c.setState("closed");
  assert.equal(b.peerCount, 0);
});

test("connected state is reported in statuses and the STATUS hook", async () => {
  await live();
  const pc = await connect("p1");
  assert.equal(b.statuses()[0].state, "connecting");
  pc.setState("connected");
  assert.equal(b.statuses()[0].state, "connected");
  const last = stub.hooks.calls.filter(c => c.name === HOOKS.STATUS).at(-1);
  assert.equal(last.args[0].peers[0].state, "connected");
  assert.equal(last.args[0].live, true);
});

test("userConnected(false) removes that user's peer; connected=true does nothing", async () => {
  await live();
  const a = await connect("p1");
  await connect("p2");
  b.userConnected({ id: "p1" }, true);
  assert.equal(b.peerCount, 2);
  b.userConnected({ id: "p1" }, false);
  assert.equal(a.closed, true);
  assert.equal(b.peerCount, 1);
  b.userConnected({ id: "nobody" }, false);
  assert.equal(b.peerCount, 1);
});

test("stop sends END to all, closes peers, stops capture and fires the ended hook", async () => {
  const sessionId = await live();
  const a = await connect("p1");
  const c = await connect("p2");
  stub.socket.clear();
  b.stop();
  const [end] = sent(MSG.END);
  assert.equal(end.payload.sessionId, sessionId);
  assert.equal(end.options, undefined, "END is broadcast");
  assert.ok(a.closed && c.closed);
  assert.equal(b.peerCount, 0);
  assert.equal(b.live, false);
  assert.equal(capture.active, false);
  assert.equal(stub.hooks.calls.filter(x => x.name === HOOKS.ENDED).length, 1);
  b.stop();
  assert.equal(sent(MSG.END).length, 1, "second stop is a no-op");
});

test("after stop a REQUEST is ignored and a new goLive uses a new session", async () => {
  const s1 = await live();
  b.stop();
  b.handle(request(), "p1");
  await flush();
  assert.equal(FakePC.instances.length, 0);
  await b.goLive("tone");
  assert.notEqual(b.sessionId, s1);
});

test("best-effort END on beforeunload, only while live", async () => {
  win.fire("beforeunload");
  assert.equal(sent(MSG.END).length, 0);
  const sessionId = await live();
  win.fire("beforeunload");
  assert.equal(sent(MSG.END)[0].payload.sessionId, sessionId);
});

test("destroy removes the beforeunload listener", () => {
  assert.equal(win.has("beforeunload"), true);
  b.destroy();
  assert.equal(win.has("beforeunload"), false);
});

test("when the capture source ends by itself the broadcast stops with a warning", async () => {
  const track = new FakeTrack("audio");
  const stream = new FakeStream([new FakeTrack("video", { displaySurface: "browser" }), track]);
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getDisplayMedia: async () => stream } }, configurable: true });
  try {
    await b.goLive("tab");
    assert.equal(b.live, true);
    track.fire("ended");
  } finally {
    if (prev) Object.defineProperty(globalThis, "navigator", prev); else delete globalThis.navigator;
    delete globalThis.isSecureContext;
  }
  assert.equal(b.live, false);
  assert.ok(stub.notifications.some(n => n[0] === "warn"));
  assert.equal(sent(MSG.END).length, 1);
});

test("REQUEST for an offer that fails to build drops the peer", async () => {
  await live();
  const orig = FakePC.prototype.createOffer;
  FakePC.prototype.createOffer = async () => { throw new Error("boom"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await connect("p1");
  } finally {
    FakePC.prototype.createOffer = orig;
    console.warn = warn;
  }
  assert.equal(b.peerCount, 0);
  assert.equal(sent(MSG.OFFER).length, 0);
});

test("stats() summarises each peer via stats.js", async () => {
  await live();
  const pc = await connect("p1");
  pc.stats = [
    { id: "o", type: "outbound-rtp", kind: "audio", ssrc: 1, codecId: "c", bytesSent: 0, packetsSent: 100, timestamp: 1000 },
    { id: "c", type: "codec", mimeType: "audio/opus", channels: 2 }
  ];
  let [s] = await b.stats();
  assert.equal(s.userId, "p1");
  assert.equal(s.bitrateKbps, null);
  pc.stats[0] = { ...pc.stats[0], bytesSent: 16000, timestamp: 2000 };
  [s] = await b.stats();
  assert.equal(s.bitrateKbps, 128);
  assert.equal(s.codec, "audio/opus");
  assert.equal(s.channels, 2);
});

// --- failed-peer tracking (GM row) ---------------------------------------------------------------

test("a failed peer is reported as failed in statuses until the user REQUESTs again", async () => {
  await live();
  const a = await connect("p1");
  await connect("p2");
  a.setState("failed");
  assert.equal(b.peerCount, 1);
  assert.deepEqual(b.statuses().map(s => [s.userId, s.state]).sort(), [["p1", "failed"], ["p2", "connecting"]]);
  const last = stub.hooks.calls.filter(c => c.name === HOOKS.STATUS).at(-1);
  assert.ok(last.args[0].peers.some(p => p.userId === "p1" && p.state === "failed"), "STATUS hook carries the failure");

  const again = await connect("p1");
  assert.notEqual(again, a);
  assert.deepEqual(b.statuses().find(s => s.userId === "p1").state, "connecting");
  assert.equal(b.statuses().length, 2);
});

test("a failed user disappears from statuses when they disconnect", async () => {
  await live();
  const a = await connect("p1");
  a.setState("failed");
  stub.hooks.calls.length = 0;
  b.userConnected({ id: "p1" }, false);
  assert.deepEqual(b.statuses(), []);
  assert.equal(stub.hooks.calls.filter(c => c.name === HOOKS.STATUS).length, 1, "status re-emitted so the row updates");
  b.userConnected({ id: "p1" }, false);
  assert.equal(stub.hooks.calls.filter(c => c.name === HOOKS.STATUS).length, 1, "nothing to clear the second time");
});

test("failed users are forgotten when the broadcast stops", async () => {
  await live();
  const a = await connect("p1");
  a.setState("failed");
  b.stop();
  assert.deepEqual(b.statuses(), []);
  await b.goLive("tone");
  assert.deepEqual(b.statuses(), []);
});

test("a failed offer or answer also marks the peer failed; a plain close does not", async () => {
  await live();
  const pc = await connect("p1");
  pc.setRemoteDescription = async () => { throw new Error("bad answer"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    b.handle({ type: MSG.ANSWER, sessionId: b.sessionId, sdp: "x", to: null }, "p1");
    await flush();
  } finally { console.warn = warn; }
  assert.equal(b.statuses().find(s => s.userId === "p1").state, "failed");

  const c = await connect("p2");
  c.setState("closed");
  assert.equal(b.statuses().find(s => s.userId === "p2"), undefined);
});

test("connections are built from getRtcConfig when given (iceTransportPolicy included)", async () => {
  b.destroy();
  const cfg = { iceServers: [{ urls: "turn:t.example:3478", username: "u", credential: "c" }], iceTransportPolicy: "relay" };
  b = new Broadcaster({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), capture,
    getIceServers: () => ICE, getRtcConfig: () => cfg, getBitrate: () => 128, RTCPeerConnection: FakePC, windowLike: win
  });
  await live();
  const pc = await connect("p1");
  assert.deepEqual(pc.config, cfg);
  assert.equal(pc.config.iceTransportPolicy, "relay");
});

test("a peer that never connects is marked failed after the connect timeout; a connected one is not", async () => {
  b.destroy();
  const sched = fakeScheduler();
  b = new Broadcaster({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), capture,
    getIceServers: () => ICE, getBitrate: () => 128, RTCPeerConnection: FakePC, windowLike: win, scheduler: sched
  });
  await live();
  const stuck = await connect("p1");
  const ok = await connect("p2");
  ok.setState("connected");
  assert.deepEqual(sched.pending.map(t => t.ms), [PEER_CONNECT_TIMEOUT, PEER_CONNECT_TIMEOUT]);
  sched.fireNext(); sched.fireNext();
  assert.equal(stuck.closed, true);
  assert.deepEqual(b.statuses().map(s => `${s.userId}:${s.state}`).sort(), ["p1:failed", "p2:connected"]);
  // a new REQUEST from the failed player starts over (and clears the failed mark)
  await connect("p1");
  assert.ok(b.statuses().some(s => s.userId === "p1" && s.state === "connecting"));
});

test("closing a peer cancels its connect timeout", async () => {
  b.destroy();
  const sched = fakeScheduler();
  b = new Broadcaster({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), capture,
    getIceServers: () => ICE, getBitrate: () => 128, RTCPeerConnection: FakePC, windowLike: win, scheduler: sched
  });
  await live();
  await connect("p1");
  assert.equal(sched.pending.length, 1);
  b.userConnected({ id: "p1" }, false);
  assert.equal(sched.pending.length, 0);
});
