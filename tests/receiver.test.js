import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeAudioContext, FakePC, FakeStream, FakeTrack, fakeDocument, fakeScheduler, flush } from "./helpers/fakes.js";
import { Receiver, RETRY_DELAYS, OFFER_TIMEOUT, CONNECT_TIMEOUT } from "../scripts/receiver.js";
import { Signaling } from "../scripts/signaling.js";
import { MSG, HOOKS, SOCKET_CHANNEL, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { registerSettings } from "../scripts/settings.js";
import { CHROMIUM_AUDIO_OFFER } from "./helpers/sdp-fixtures.js";

const ICE = [{ urls: "stun:test.example:3478" }];
const S = "sess1";
let stub, music, r, doc, sched;
const realWarn = console.warn, realLog = console.log;

const users = [{ id: "gm1", isGM: true }, { id: "p1" }, { id: "p2" }];
const sent = type => stub.socket.sent(type);
const live = (sessionId = S) => ({ type: MSG.LIVE, sessionId });
const offer = (sessionId = S) => ({ type: MSG.OFFER, sessionId, sdp: CHROMIUM_AUDIO_OFFER });
const ice = (candidate, sessionId = S) => ({ type: MSG.ICE, sessionId, candidate });
const end = (sessionId = S) => ({ type: MSG.END, sessionId });
const hookCount = name => stub.hooks.calls.filter(c => c.name === name).length;

/** LIVE + OFFER from the GM, returning the receiver's peer connection. */
async function connect() {
  r.handle(live(), "gm1");
  r.handle(offer(), "gm1");
  await flush();
  return FakePC.last;
}

beforeEach(() => {
  stub = installFoundryStub({ users, currentUserId: "p1" });
  registerSettings();
  FakePC.reset();
  music = new FakeAudioContext();
  game.audio = { unlock: Promise.resolve(), music };
  doc = fakeDocument();
  sched = fakeScheduler();
  console.warn = () => {};
  console.log = () => {};
  r = new Receiver({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), getBitrate: () => 128, getIceServers: () => ICE,
    scheduler: sched, RTCPeerConnection: FakePC, document: doc
  });
});
afterEach(() => {
  r.destroy();
  console.warn = realWarn;
  console.log = realLog;
  stub.uninstall();
});

test("LIVE from the active GM locks, fires the live hook and sends a REQUEST to the GM only", () => {
  r.handle(live(), "gm1");
  assert.deepEqual(r.lock, { senderId: "gm1", sessionId: S });
  assert.equal(r.status, "connecting");
  const [req] = sent(MSG.REQUEST);
  assert.deepEqual(req.options, { recipients: ["gm1"] });
  assert.equal(req.payload.sessionId, S);
  assert.equal(req.payload.to, "gm1");
  assert.equal(hookCount(HOOKS.LIVE), 1);
});

test("messages from anyone but the active GM / lock holder are ignored", async () => {
  r.handle(live(), "p2");
  r.handle(offer(), "p2");
  assert.equal(r.lock, null);
  assert.equal(sent(MSG.REQUEST).length, 0);
  assert.equal(FakePC.instances.length, 0);

  await connect();
  const pc = FakePC.last;
  r.handle(end(), "p2");
  r.handle(ice({ candidate: "x" }), "p2");
  r.handle(offer(), "p2");
  await flush();
  assert.equal(r.lock.senderId, "gm1");
  assert.equal(pc.closed, false);
  assert.equal(FakePC.instances.length, 1);
});

test("messages addressed to another user are ignored", () => {
  r.handle({ ...live(), to: "p2" }, "gm1");
  assert.equal(r.lock, null);
});

test("probe sends a sessionless REQUEST to the active GM; none without one", () => {
  r.probe();
  const [req] = sent(MSG.REQUEST);
  assert.deepEqual(req.options, { recipients: ["gm1"] });
  assert.equal(req.payload.sessionId, null);

  stub.socket.clear();
  stub.setActiveGM("p2"); // not an active GM doc? p2 is active but is no GM; probe still addresses the "active GM" user
  stub.setActiveGM("nobody");
  r.probe();
  assert.equal(sent(MSG.REQUEST).length, 0);
});

test("an OFFER from the active GM while unlocked locks onto it (late join) and is answered", async () => {
  r.handle(offer("late"), "gm1");
  await flush();
  assert.deepEqual(r.lock, { senderId: "gm1", sessionId: "late" });
  const [ans] = sent(MSG.ANSWER);
  assert.deepEqual(ans.options, { recipients: ["gm1"] });
  assert.equal(ans.payload.sessionId, "late");
  assert.equal(hookCount(HOOKS.LIVE), 1);
});

test("OFFER -> ANSWER carries the munged SDP (stereo=1, maxaveragebitrate)", async () => {
  const pc = await connect();
  assert.deepEqual(pc.config, { iceServers: ICE });
  assert.deepEqual(pc.remoteDescription, { type: "offer", sdp: CHROMIUM_AUDIO_OFFER });
  const [ans] = sent(MSG.ANSWER);
  assert.match(ans.payload.sdp, /a=fmtp:111 [^\r\n]*stereo=1/);
  assert.match(ans.payload.sdp, /maxaveragebitrate=128000/);
  assert.equal(pc.localDescription.type, "answer");
  assert.equal(pc.localDescription.sdp, ans.payload.sdp);
});

test("bitrate setting flows into the answer", async () => {
  r.getBitrate = () => 64;
  await connect();
  assert.match(sent(MSG.ANSWER)[0].payload.sdp, /maxaveragebitrate=64000/);
});

test("remote ICE arriving before the remote description is queued, then added in order", async () => {
  r.handle(live(), "gm1");
  const c1 = { candidate: "c1" }, c2 = { candidate: "c2" }, c3 = { candidate: "c3" };
  r.handle(ice(c1), "gm1"); // no pc yet
  r.handle(offer(), "gm1");
  r.handle(ice(c2), "gm1"); // pc exists, setRemoteDescription still pending
  await flush();
  const pc = FakePC.last;
  assert.deepEqual(pc.added, [c2], "ice queued before the offer belongs to the previous (no) connection");
  r.handle(ice(c3), "gm1");
  await flush();
  assert.deepEqual(pc.added, [c2, c3]);
});

test("local ICE is trickled to the GM", async () => {
  const pc = await connect();
  stub.socket.clear();
  pc.emitCandidate();
  const [m] = sent(MSG.ICE);
  assert.deepEqual(m.options, { recipients: ["gm1"] });
  assert.equal(m.payload.sessionId, S);
});

test("track: muted playing <audio> element holds the stream and Web Audio routes into the Music gain node", async () => {
  const pc = await connect();
  const stream = pc.emitTrack();
  await flush();
  const [el] = doc.made;
  assert.equal(el.tag, "audio");
  assert.equal(el.muted, true);
  assert.equal(el.autoplay, true);
  assert.equal(el.srcObject, stream);
  assert.equal(el.played, 1);
  assert.equal(el.attached, true);

  const [src] = music.of("streamSource");
  const [gain] = music.of("gain");
  assert.equal(src.stream, stream);
  assert.ok(src.connectedTo(gain));
  assert.ok(gain.connectedTo(music.gainNode));
  assert.ok(!gain.connectedTo(music.destination));
  assert.equal(gain.gain.value, 1);
});

test("track waits for game.audio.unlock before touching the context", async () => {
  let release;
  game.audio.unlock = new Promise(res => { release = res; });
  const pc = await connect();
  pc.emitTrack();
  await flush();
  assert.equal(doc.made.length, 0);
  assert.equal(music.of("streamSource").length, 0);
  release();
  await flush();
  assert.equal(doc.made.length, 1);
  assert.equal(music.of("streamSource").length, 1);
});

test("fallback: without the Music gain node, routes to the destination and calls the hook", async () => {
  music.gainNode = undefined;
  const pc = await connect();
  pc.emitTrack();
  await flush();
  const [gain] = music.of("gain");
  assert.ok(gain.connectedTo(music.destination));
  assert.equal(hookCount(HOOKS.ROUTE_FALLBACK), 1);
});

test("setMute silences the personal gain and persists the setting", async () => {
  const pc = await connect();
  pc.emitTrack();
  await flush();
  const [gain] = music.of("gain");
  r.setMute(true);
  assert.equal(gain.gain.value, 0);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.MUTE), true);
  r.setMute(false);
  assert.equal(gain.gain.value, 1);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.MUTE), false);
});

test("a persisted mute applies to a stream that arrives later", async () => {
  await game.settings.set(MODULE_ID, SETTINGS.MUTE, true);
  const pc = await connect();
  pc.emitTrack();
  await flush();
  assert.equal(music.of("gain")[0].gain.value, 0);
});

test("connected -> live; failure schedules re-requests after 2s, 5s, 10s, then gives up", async () => {
  assert.deepEqual(RETRY_DELAYS, [2000, 5000, 10000]);
  let pc = await connect();
  stub.socket.clear();

  for (const delay of RETRY_DELAYS) {
    pc.setState("failed");
    assert.equal(r.status, "failed");
    assert.equal(pc.closed, true);
    assert.equal(sched.pending.length, 1);
    assert.equal(sched.pending[0].ms, delay);
    assert.equal(sent(MSG.REQUEST).length, RETRY_DELAYS.indexOf(delay), "nothing sent before the timer fires");
    sched.fireNext();
    assert.equal(r.status, "connecting");
    assert.equal(sent(MSG.REQUEST).length, RETRY_DELAYS.indexOf(delay) + 1);
    r.handle(offer(), "gm1");
    await flush();
    pc = FakePC.last;
  }

  pc.setState("failed");
  assert.equal(sched.pending.length, 0, "gave up");
  assert.equal(r.status, "failed");
  assert.equal(sent(MSG.REQUEST).length, 3);
  assert.notEqual(r.lock, null, "lock is kept so a later LIVE/OFFER still works");
});

test("no OFFER after a REQUEST: the watchdog counts it as a failure and backs off, then gives up", async () => {
  assert.equal(OFFER_TIMEOUT, 8000);
  r.handle(live(), "gm1");
  assert.equal(sent(MSG.REQUEST).length, 1);
  assert.equal(sched.pending.length, 1);
  assert.equal(sched.pending[0].ms, OFFER_TIMEOUT);
  for (const [i, delay] of RETRY_DELAYS.entries()) {
    assert.equal(sched.fireNext(), OFFER_TIMEOUT, "watchdog fires");
    assert.equal(r.status, "failed");
    assert.equal(sched.pending[0].ms, delay);
    sched.fireNext();
    assert.equal(r.status, "connecting");
    assert.equal(sent(MSG.REQUEST).length, i + 2);
  }
  sched.fireNext();
  assert.equal(r.status, "failed");
  assert.equal(sched.pending.length, 0, "gave up");
});

test("the watchdog is cancelled by an OFFER and by END", async () => {
  r.handle(live(), "gm1");
  r.handle(offer(), "gm1");
  assert.equal(sched.pending.length, 0);
  await flush();
  r.handle(end(), "gm1");
  r.handle(live("s2"), "gm1");
  assert.equal(sched.pending.length, 1);
  r.handle(end("s2"), "gm1");
  assert.equal(sched.pending.length, 0);
});

test("a successful connection resets the retry budget", async () => {
  let pc = await connect();
  pc.setState("failed");
  assert.equal(sched.fireNext(), 2000);
  r.handle(offer(), "gm1");
  await flush();
  pc = FakePC.last;
  pc.setState("connected");
  assert.equal(r.status, "live");
  assert.equal(r.isLive, true);
  pc.setState("failed");
  assert.equal(sched.pending[0].ms, 2000);
});

test("an OFFER cancels a pending retry", async () => {
  const pc = await connect();
  pc.setState("failed");
  assert.equal(sched.pending.length, 1);
  r.handle(offer(), "gm1");
  assert.equal(sched.pending.length, 0);
  await flush();
});

test("END from the lock holder tears everything down and clears the lock", async () => {
  const pc = await connect();
  pc.setState("connected");
  const stream = pc.emitTrack();
  await flush();
  const [el] = doc.made;
  const [src] = music.of("streamSource");
  const [gain] = music.of("gain");
  assert.equal(r.isLive, true);

  r.handle(end(), "gm1");
  assert.equal(pc.closed, true);
  assert.equal(el.removed, true);
  assert.equal(el.srcObject, null);
  assert.equal(src.disconnected, true);
  assert.equal(gain.disconnected, true);
  assert.equal(r.lock, null);
  assert.equal(r.status, "idle");
  assert.equal(hookCount(HOOKS.ENDED), 1);
  void stream;
});

test("END cancels a pending retry; END with a stale session is ignored", async () => {
  const pc = await connect();
  pc.setState("failed");
  r.handle(end("old"), "gm1");
  assert.notEqual(r.lock, null);
  assert.equal(sched.pending.length, 1);
  r.handle(end(), "gm1");
  assert.equal(sched.pending.length, 0);
  assert.equal(r.lock, null);
});

test("after END a new LIVE starts a fresh session", async () => {
  await connect();
  r.handle(end(), "gm1");
  stub.socket.clear();
  r.handle(live("s2"), "gm1");
  assert.deepEqual(r.lock, { senderId: "gm1", sessionId: "s2" });
  assert.equal(sent(MSG.REQUEST)[0].payload.sessionId, "s2");
});

test("a new LIVE while connected replaces the old connection", async () => {
  const first = await connect();
  r.handle(live("s2"), "gm1");
  assert.equal(first.closed, true);
  assert.equal(r.lock.sessionId, "s2");
});

test("GM leaving (userConnected false) tears down; other users leaving does not", async () => {
  const pc = await connect();
  r.userConnected({ id: "p2" }, false);
  assert.equal(pc.closed, false);
  r.userConnected({ id: "gm1" }, true);
  assert.equal(pc.closed, false);
  r.userConnected({ id: "gm1" }, false);
  assert.equal(pc.closed, true);
  assert.equal(r.lock, null);
  assert.equal(r.status, "idle");
});

test("a failing offer (setRemoteDescription rejects) goes through the retry path", async () => {
  const orig = FakePC.prototype.setRemoteDescription;
  FakePC.prototype.setRemoteDescription = async () => { throw new Error("bad sdp"); };
  try {
    r.handle(live(), "gm1");
    r.handle(offer(), "gm1");
    await flush();
  } finally { FakePC.prototype.setRemoteDescription = orig; }
  assert.equal(r.status, "failed");
  assert.equal(sched.pending[0].ms, 2000);
  assert.equal(sent(MSG.ANSWER).length, 0);
});

test("stats() reads inbound stats of the live connection, null when idle", async () => {
  assert.equal(await r.stats(), null);
  const pc = await connect();
  pc.stats = [
    { id: "i", type: "inbound-rtp", kind: "audio", codecId: "c", bytesReceived: 0, packetsReceived: 100, packetsLost: 0, jitter: 0.002, timestamp: 1000 },
    { id: "c", type: "codec", mimeType: "audio/opus", channels: 2 }
  ];
  await r.stats();
  pc.stats[0] = { ...pc.stats[0], bytesReceived: 16000, timestamp: 2000 };
  const info = await r.stats();
  assert.equal(info.bitrateKbps, 128);
  assert.equal(info.jitter, 0.002);
  assert.equal(info.lossPct, 0);
});

test("destroy releases the hook and tears down", async () => {
  const pc = await connect();
  r.destroy();
  assert.equal(pc.closed, true);
  assert.equal(stub.hooks.listenerCount("globalPlaylistVolumeChanged"), 0);
});

void FakeStream; void FakeTrack;

test("the connection is built from getRtcConfig when given (iceTransportPolicy included)", async () => {
  r.destroy();
  const cfg = { iceServers: [{ urls: "turn:t.example:3478", username: "u", credential: "c" }], iceTransportPolicy: "relay" };
  r = new Receiver({
    signaling: new Signaling(SOCKET_CHANNEL, stub.socket), getBitrate: () => 128, getIceServers: () => ICE, getRtcConfig: () => cfg,
    scheduler: sched, RTCPeerConnection: FakePC, document: doc
  });
  const pc = await connect();
  assert.deepEqual(pc.config, cfg);
  assert.equal(pc.config.iceTransportPolicy, "relay");
});

test("no connection within the connect timeout after the answer counts as a failure and backs off", async () => {
  assert.equal(CONNECT_TIMEOUT, 15000);
  const pc = await connect();
  assert.equal(sched.pending.length, 1);
  assert.equal(sched.pending[0].ms, CONNECT_TIMEOUT);
  pc.connectionState = "checking";
  assert.equal(sched.fireNext(), CONNECT_TIMEOUT);
  assert.equal(r.status, "failed");
  assert.equal(pc.closed, true);
  assert.equal(sched.pending[0].ms, RETRY_DELAYS[0], "the normal retry follows");
});

test("a connection that comes up cancels the connect timeout", async () => {
  const pc = await connect();
  pc.setState("connected");
  assert.equal(sched.pending.length, 0);
  assert.equal(r.status, "live");
});
