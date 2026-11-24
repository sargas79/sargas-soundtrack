import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeAudioContext, FakeStream, FakeTrack, displayStream } from "./helpers/fakes.js";
import { Capture, CaptureError, validateDisplayCapture, mapCaptureError } from "../scripts/capture.js";
import { registerSettings } from "../scripts/settings.js";

let stub, music, restores, md, activation;
const realLog = console.log;

function setGlobal(name, value) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restores.push(() => { if (prev) Object.defineProperty(globalThis, name, prev); else delete globalThis[name]; });
}

const domErr = name => Object.assign(new Error(name), { name });
const code = async p => { try { await p; } catch (e) { assert.ok(e instanceof CaptureError, `expected CaptureError, got ${e}`); return e.code; } return null; };

beforeEach(() => {
  restores = [];
  stub = installFoundryStub();
  registerSettings();
  music = new FakeAudioContext();
  game.audio = { unlock: Promise.resolve(), music };
  activation = { isActive: true };
  md = {
    calls: [],
    getDisplayMedia: async c => { md.calls.push(["display", c]); return md.displayResult(); },
    getUserMedia: async c => { md.calls.push(["user", c]); return md.userResult(); },
    enumerateDevices: async () => md.devices,
    displayResult: () => displayStream(),
    userResult: () => new FakeStream([new FakeTrack("audio")]),
    devices: []
  };
  setGlobal("isSecureContext", true);
  setGlobal("navigator", { mediaDevices: md, userActivation: activation });
  console.log = () => {};
});
afterEach(() => {
  console.log = realLog;
  restores.reverse().forEach(r => r());
  stub.uninstall();
});

test("validateDisplayCapture accepts a browser tab with audio", () => {
  assert.doesNotThrow(() => validateDisplayCapture(displayStream()));
});

test("validateDisplayCapture: wrong surface throws wrongSurface", () => {
  for (const surface of ["monitor", "window", null]) {
    assert.throws(() => validateDisplayCapture(displayStream({ surface })), e => e instanceof CaptureError && e.code === "wrongSurface");
  }
});

test("validateDisplayCapture: no audio track throws noAudio", () => {
  assert.throws(() => validateDisplayCapture(displayStream({ audio: 0 })), e => e instanceof CaptureError && e.code === "noAudio");
});

test("mapCaptureError maps DOMException names", () => {
  assert.equal(mapCaptureError(domErr("NotAllowedError")).code, "cancelled");
  assert.equal(mapCaptureError(domErr("NotAllowedError"), { hadActivation: false }).code, "needsClick");
  assert.equal(mapCaptureError(domErr("InvalidStateError")).code, "needsClick");
  assert.equal(mapCaptureError(domErr("NotFoundError")).code, "deviceMissing");
  assert.equal(mapCaptureError(domErr("OverconstrainedError")).code, "deviceMissing");
  assert.equal(mapCaptureError(domErr("NotSupportedError")).code, "unsupported");
  assert.equal(mapCaptureError(new Error("boom")).code, "failed");
  const own = new CaptureError("insecure");
  assert.equal(mapCaptureError(own), own);
});

test("tab: asks getDisplayMedia with the audio-preserving constraints", async () => {
  const cap = new Capture();
  await cap.start("tab");
  const [, c] = md.calls[0];
  assert.deepEqual(c.video, { displaySurface: "browser" });
  assert.equal(c.audio.echoCancellation, false);
  assert.equal(c.audio.noiseSuppression, false);
  assert.equal(c.audio.autoGainControl, false);
  assert.equal(c.audio.channelCount, 2);
  assert.equal(c.audio.suppressLocalAudioPlayback, true);
  assert.equal(c.selfBrowserSurface, "exclude");
  assert.equal(c.surfaceSwitching, "exclude");
  assert.equal(c.systemAudio, "exclude");
  assert.equal(c.monitorTypeSurfaces, "exclude");
});

test("tab: video track is stopped after acquiring, audio keeps running", async () => {
  const stream = displayStream();
  md.displayResult = () => stream;
  const cap = new Capture();
  await cap.start("tab");
  assert.equal(stream.getVideoTracks()[0].stopped, true);
  assert.equal(stream.getAudioTracks()[0].stopped, false);
  assert.equal(cap.active, true);
});

test("audio graph: source -> sendGain -> dest, sendGain -> monitorGain -> music gainNode", async () => {
  const cap = new Capture();
  await cap.start("tab");
  const [source] = music.of("streamSource");
  const [sendGain, monitorGain] = music.of("gain");
  const [dest] = music.of("dest");
  assert.ok(source.connectedTo(sendGain));
  assert.ok(sendGain.connectedTo(dest));
  assert.ok(sendGain.connectedTo(monitorGain));
  assert.ok(monitorGain.connectedTo(music.gainNode));
  assert.ok(!monitorGain.connectedTo(music.destination), "monitor goes through the Music slider node");
  assert.equal(cap.outputStream, dest.stream);
  assert.equal(cap.outputTrack, dest.stream.getAudioTracks()[0]);
});

test("persistent destination: switching source keeps the same output track and releases the old source", async () => {
  const cap = new Capture();
  await cap.start("tab");
  const track = cap.outputTrack;
  const tabStream = md.calls.length && music.of("streamSource")[0].stream;
  await cap.switchSource("tone");
  assert.equal(cap.outputTrack, track);
  assert.equal(music.of("dest").length, 1);
  assert.equal(music.of("streamSource")[0].disconnected, true);
  assert.equal(tabStream.getAudioTracks()[0].stopped, true);
  assert.equal(cap.sourceLabel, "tone");
});

test("a failed switch keeps the previous source running", async () => {
  const cap = new Capture();
  await cap.start("tab");
  const src = music.of("streamSource")[0];
  md.displayResult = () => displayStream({ surface: "window" });
  assert.equal(await code(cap.switchSource("tab")), "wrongSurface");
  assert.equal(cap.active, true);
  assert.equal(src.disconnected, false);
});

test("tab errors: wrongSurface and noAudio stop every track of the rejected stream", async () => {
  const bad1 = displayStream({ surface: "monitor" });
  md.displayResult = () => bad1;
  assert.equal(await code(new Capture().start("tab")), "wrongSurface");
  assert.ok(bad1.getTracks().every(t => t.stopped));

  const bad2 = displayStream({ audio: 0 });
  md.displayResult = () => bad2;
  assert.equal(await code(new Capture().start("tab")), "noAudio");
  assert.ok(bad2.getTracks().every(t => t.stopped));
});

test("tab errors: cancelled, needsClick", async () => {
  md.displayResult = () => { throw domErr("NotAllowedError"); };
  assert.equal(await code(new Capture().start("tab")), "cancelled");

  activation.isActive = false;
  assert.equal(await code(new Capture().start("tab")), "needsClick");

  activation.isActive = true;
  md.displayResult = () => { throw domErr("InvalidStateError"); };
  assert.equal(await code(new Capture().start("tab")), "needsClick");
});

test("errors: insecure and unsupported", async () => {
  setGlobal("isSecureContext", false);
  assert.equal(await code(new Capture().start("tab")), "insecure");
  setGlobal("isSecureContext", true);
  setGlobal("navigator", { mediaDevices: {} });
  assert.equal(await code(new Capture().start("tab")), "unsupported");
  assert.equal(await code(new Capture().start("device", { deviceId: "d" })), "unsupported");
  assert.equal(await code(new Capture().start("bogus")), "unsupported");
});

test("device: exact deviceId with processing disabled", async () => {
  const cap = new Capture();
  await cap.start("device", { deviceId: "mic-1" });
  const [kind, c] = md.calls[0];
  assert.equal(kind, "user");
  assert.deepEqual(c.audio, { deviceId: { exact: "mic-1" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 });
  assert.equal(cap.sourceLabel, "device");
});

test("device errors: missing id, not found, no audio track", async () => {
  assert.equal(await code(new Capture().start("device")), "deviceMissing");
  md.userResult = () => { throw domErr("NotFoundError"); };
  assert.equal(await code(new Capture().start("device", { deviceId: "x" })), "deviceMissing");
  md.userResult = () => { throw domErr("OverconstrainedError"); };
  assert.equal(await code(new Capture().start("device", { deviceId: "x" })), "deviceMissing");
  md.userResult = () => new FakeStream([]);
  assert.equal(await code(new Capture().start("device", { deviceId: "x" })), "noAudio");
});

test("tone: 440 Hz left, 660 Hz right through a 2-input channel merger", async () => {
  const cap = new Capture();
  await cap.start("tone");
  const [l, r] = music.of("osc");
  const [merger] = music.of("merger");
  assert.equal(l.frequency.value, 440);
  assert.equal(r.frequency.value, 660);
  assert.equal(merger.inputs, 2);
  assert.deepEqual(l.connections[0], [merger, 0, 0]);
  assert.deepEqual(r.connections[0], [merger, 0, 1]);
  assert.ok(l.started && r.started);
  cap.stop();
  assert.ok(l.stopped && r.stopped);
});

test("tone does not need secure context or media devices", async () => {
  setGlobal("isSecureContext", false);
  setGlobal("navigator", {});
  await new Capture().start("tone");
});

test("onEnded fires when the source track ends, once, and releases the source", async () => {
  const stream = displayStream();
  md.displayResult = () => stream;
  const cap = new Capture();
  const seen = [];
  cap.onEnded(label => seen.push(label));
  await cap.start("tab");
  stream.getAudioTracks()[0].fire("ended");
  stream.getAudioTracks()[0].fire("ended");
  assert.deepEqual(seen, ["tab"]);
  assert.equal(cap.active, false);
  assert.ok(cap.outputTrack, "destination track survives");
});

test("onEnded from a replaced source is ignored", async () => {
  const first = displayStream();
  md.displayResult = () => first;
  const cap = new Capture();
  const seen = [];
  cap.onEnded(l => seen.push(l));
  await cap.start("tab");
  await cap.switchSource("tone");
  first.getAudioTracks()[0].fire("ended");
  assert.deepEqual(seen, []);
  assert.equal(cap.active, true);
});

test("stop releases source tracks but keeps the destination", async () => {
  const stream = displayStream();
  md.displayResult = () => stream;
  const cap = new Capture();
  await cap.start("tab");
  const track = cap.outputTrack;
  cap.stop();
  assert.equal(stream.getAudioTracks()[0].stopped, true);
  assert.equal(cap.active, false);
  assert.equal(cap.outputTrack, track);
  cap.stop(); // idempotent
});

test("fadeTo schedules cancel, set-current, linear ramp on the audio clock", async () => {
  const cap = new Capture();
  await cap.start("tone");
  const [sendGain] = music.of("gain");
  sendGain.gain.calls.length = 0;
  sendGain.gain.value = 0.9;
  cap.fadeTo(0, 2000);
  assert.deepEqual(sendGain.gain.calls, [["cancel", 10], ["set", 0.9, 10], ["ramp", 0, 12]]);
  sendGain.gain.calls.length = 0;
  cap.fadeTo(5, -10);
  assert.deepEqual(sendGain.gain.calls[2], ["ramp", 1, 10], "level clamped to 1, negative time to 0");
});

test("fadeTo before any graph exists is a no-op", () => {
  assert.doesNotThrow(() => new Capture().fadeTo(0, 100));
});

test("setSendLevel and setMonitorLevel persist client settings", async () => {
  const cap = new Capture();
  await cap.start("tone");
  cap.setMonitorLevel(0.25);
  cap.setSendLevel(2);
  assert.equal(game.settings.get("sargas-soundtrack", "monitorLevel"), 0.25);
  assert.equal(game.settings.get("sargas-soundtrack", "sendLevel"), 1);
});

test("listDevices returns audio inputs only", async () => {
  md.devices = [
    { kind: "audioinput", deviceId: "a", label: "Mic A" },
    { kind: "audiooutput", deviceId: "o", label: "Speakers" },
    { kind: "videoinput", deviceId: "v", label: "Cam" },
    { kind: "audioinput", deviceId: "b", label: "Cable" }
  ];
  assert.deepEqual(await new Capture().listDevices(), [
    { deviceId: "a", label: "Mic A" }, { deviceId: "b", label: "Cable" }
  ]);
  assert.equal(md.calls.length, 0, "no getUserMedia when labels are visible");
});

test("listDevices unlocks hidden labels with a temporary stream that is stopped", async () => {
  const tmp = new FakeStream([new FakeTrack("audio")]);
  md.devices = [{ kind: "audioinput", deviceId: "a", label: "" }];
  md.userResult = () => { md.devices = [{ kind: "audioinput", deviceId: "a", label: "Mic A" }]; return tmp; };
  const list = await new Capture().listDevices();
  assert.deepEqual(list, [{ deviceId: "a", label: "Mic A" }]);
  assert.equal(tmp.getTracks()[0].stopped, true);
});
