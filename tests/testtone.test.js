import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeAudioContext, FakeStream, FakeTrack, fakeClock } from "./helpers/fakes.js";
import { Capture, CaptureError } from "../scripts/capture.js";
import { registerSettings } from "../scripts/settings.js";
import { runTestTone, clampSeconds } from "../scripts/testtone.js";

// --- runTestTone with fake broadcaster/capture -------------------------------------------------

let clock, calls, broadcaster, capture, state;

function fakes({ live = false, label = null } = {}) {
  clock = fakeClock();
  calls = [];
  state = { current: null };
  broadcaster = {
    live,
    async goLive(source) { calls.push(["goLive", source]); broadcaster.live = true; capture.sourceLabel = source; },
    stop() { calls.push(["stop"]); broadcaster.live = false; }
  };
  capture = {
    sourceLabel: label,
    async playTone() { calls.push(["playTone"]); return () => calls.push(["restore"]); }
  };
}
const run = (seconds, extra = {}) => runTestTone({ broadcaster, capture, seconds, scheduler: clock, state, ...extra });

test("clampSeconds: default 10, max 60", () => {
  assert.equal(clampSeconds(undefined), 10);
  assert.equal(clampSeconds(-3), 10);
  assert.equal(clampSeconds("abc"), 10);
  assert.equal(clampSeconds(5), 5);
  assert.equal(clampSeconds(999), 60);
});

test("not live: goes live with the tone and stops after N seconds", async () => {
  fakes();
  assert.equal(await run(10), true);
  assert.deepEqual(calls, [["goLive", "tone"]]);
  clock.advance(9999);
  assert.deepEqual(calls, [["goLive", "tone"]]);
  clock.advance(1);
  assert.deepEqual(calls, [["goLive", "tone"], ["stop"]]);
  assert.equal(state.current, null);
});

test("not live: does not stop if the GM switched to another source meanwhile", async () => {
  fakes();
  await run(5);
  capture.sourceLabel = "device";
  clock.advance(5000);
  assert.deepEqual(calls, [["goLive", "tone"]]);
});

test("not live: does not stop again if the broadcast already ended", async () => {
  fakes();
  await run(5);
  broadcaster.stop();
  calls.length = 0;
  clock.advance(5000);
  assert.deepEqual(calls, []);
});

test("live: plays the tone over the held source and restores it after N seconds, without going live or stopping", async () => {
  fakes({ live: true, label: "tab" });
  await run(3);
  assert.deepEqual(calls, [["playTone"]]);
  clock.advance(3000);
  assert.deepEqual(calls, [["playTone"], ["restore"]]);
  assert.equal(broadcaster.live, true);
});

test("a second call while running only restarts the countdown; one restore, one tone", async () => {
  fakes({ live: true, label: "device" });
  await run(10);
  clock.advance(6000);
  assert.equal(await run(10), true);
  assert.equal(calls.filter(c => c[0] === "playTone").length, 1);
  clock.advance(9999);
  assert.equal(calls.filter(c => c[0] === "restore").length, 0);
  clock.advance(1);
  assert.equal(calls.filter(c => c[0] === "restore").length, 1);
});

test("a call while another start is in flight is refused", async () => {
  fakes();
  const first = run(5);
  assert.equal(await run(5), false);
  assert.equal(await first, true);
  assert.equal(calls.filter(c => c[0] === "goLive").length, 1);
});

test("a failing start propagates, leaves no timer and allows a retry", async () => {
  fakes();
  broadcaster.goLive = async () => { throw new CaptureError("notActiveGM"); };
  await assert.rejects(run(5), /notActiveGM/);
  assert.equal(clock.pendingCount, 0);
  assert.equal(state.current, null);
  assert.equal(state.starting, false);
});

test("seconds are clamped", async () => {
  fakes();
  await run(9999);
  assert.equal([...clock.timers.values()][0].at, 60000);
  fakes();
  await run(0);
  assert.equal([...clock.timers.values()][0].at, 10000);
});

// --- Capture.playTone ---------------------------------------------------------------------------

let stub, music, restores;
const realLog = console.log, realWarn = console.warn;

function setGlobal(name, value) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restores.push(() => { if (prev) Object.defineProperty(globalThis, name, prev); else delete globalThis[name]; });
}

function realCapture() {
  restores = [];
  stub = installFoundryStub();
  registerSettings();
  music = new FakeAudioContext();
  game.audio = { unlock: Promise.resolve(), music };
  const md = { getUserMedia: async () => new FakeStream([new FakeTrack("audio")]) };
  setGlobal("isSecureContext", true);
  setGlobal("navigator", { mediaDevices: md });
  console.log = () => {};
  return new Capture();
}
const cleanup = () => { console.log = realLog; restores?.reverse().forEach(r => r()); stub?.uninstall(); };

const sendGain = () => music.of("gain")[0];
const deviceNode = () => music.of("streamSource")[0];
const toneGain = () => music.of("gain").at(-1);

test("Capture.playTone: refuses when nothing is captured", async () => {
  const c = realCapture();
  try {
    await assert.rejects(c.playTone(), e => e instanceof CaptureError && e.code === "notCapturing");
  } finally { cleanup(); }
});

test("Capture.playTone: mutes (but keeps) the held source, plays the tone, and restore brings the source back", async () => {
  const c = realCapture();
  try {
    await c.start("device", { deviceId: "d" });
    assert.ok(deviceNode().connectedTo(sendGain()));
    const restore = await c.playTone();
    assert.equal(deviceNode().connectedTo(sendGain()), false, "held source muted");
    assert.equal(deviceNode().disconnected, true);
    assert.equal(c.active, true, "source not released");
    assert.ok(toneGain().connectedTo(sendGain()), "tone feeds the send gain");
    const oscs = music.of("osc");
    assert.deepEqual(oscs.map(o => o.frequency.value).sort(), [440, 660]);

    restore();
    assert.ok(oscs.every(o => o.stopped), "oscillators stopped");
    assert.equal(toneGain().connectedTo(sendGain()), false);
    assert.ok(deviceNode().connectedTo(sendGain()), "source reconnected");
    restore(); // idempotent
    assert.equal(music.of("osc").length, 2);
  } finally { cleanup(); }
});

test("Capture.playTone: switching source during the tone removes the tone and does not resurrect the old source", async () => {
  const c = realCapture();
  try {
    await c.start("device", { deviceId: "d" });
    const restore = await c.playTone();
    const oscs = music.of("osc");
    await c.start("device", { deviceId: "d2" });
    assert.ok(oscs.every(o => o.stopped), "tone cleared by the switch");
    const nodes = music.of("streamSource");
    assert.equal(nodes[0].connectedTo(sendGain()), false, "old source stays gone");
    assert.ok(nodes[1].connectedTo(sendGain()));
    restore();
    assert.ok(nodes[1].connectedTo(sendGain()));
  } finally { cleanup(); }
});

test("Capture.playTone: stop() clears the tone", async () => {
  const c = realCapture();
  try {
    await c.start("device", { deviceId: "d" });
    await c.playTone();
    const oscs = music.of("osc");
    c.stop();
    assert.ok(oscs.every(o => o.stopped));
    assert.equal(c.active, false);
  } finally { cleanup(); }
});

// --- api.testTone through main.js ---------------------------------------------------------------

import { FakePC, flush } from "./helpers/fakes.js";
import { MODULE_ID, MSG } from "../scripts/constants.js";

let n = 0;
async function boot(opts) {
  stub = installFoundryStub(opts);
  game.audio = { unlock: Promise.resolve(), music: new FakeAudioContext() };
  globalThis.RTCPeerConnection = FakePC;
  console.log = () => {};
  await import(`../scripts/main.js?tone=${++n}`);
  Hooks.callAll("init");
  Hooks.callAll("ready");
  return game.modules.get(MODULE_ID).api;
}

test("api.testTone (not live): live with the tone, then stopped after the countdown", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const api = await boot({ users: [{ id: "gm1", isGM: true }], currentUserId: "gm1" });
    assert.equal(await api.testTone(10), true);
    assert.equal(api.isLive, true);
    assert.equal(api.capture.sourceLabel, "tone");
    mock.timers.tick(9999);
    assert.equal(api.isLive, true);
    mock.timers.tick(1);
    assert.equal(api.isLive, false);
    assert.equal(stub.socket.sent(MSG.END).length, 1);
  } finally {
    mock.timers.reset();
    delete globalThis.RTCPeerConnection;
    console.log = realLog;
    stub.uninstall();
  }
});

test("api.testTone (live on a source): tone over it, source back afterwards, still live", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const api = await boot({ users: [{ id: "gm1", isGM: true }], currentUserId: "gm1" });
    await flush();
    // a held "device" source via the real capture
    setGlobal_(api);
    await api.goLive("device", { deviceId: "d" });
    const before = api.capture.sourceLabel;
    assert.equal(before, "device");
    assert.equal(await api.testTone(4), true);
    assert.equal(api.capture.sourceLabel, "device", "held source untouched");
    mock.timers.tick(4000);
    assert.equal(api.isLive, true);
    assert.equal(api.capture.sourceLabel, "device");
  } finally {
    mock.timers.reset();
    for (const r of restores ?? []) r();
    delete globalThis.RTCPeerConnection;
    console.log = realLog;
    stub.uninstall();
  }
});

function setGlobal_() {
  restores = [];
  const md = { getUserMedia: async () => new FakeStream([new FakeTrack("audio")]) };
  setGlobal("isSecureContext", true);
  setGlobal("navigator", { mediaDevices: md });
}

test("api.testTone: a player is refused with a notification", async () => {
  try {
    const api = await boot({ users: [{ id: "gm1", isGM: true }, { id: "p1" }], currentUserId: "p1" });
    console.warn = () => {};
    assert.equal(await api.testTone(), false);
    assert.equal(stub.notifications.at(-1)[1], "SARGAS_SOUNDTRACK.Error.notActiveGM");
  } finally {
    delete globalThis.RTCPeerConnection;
    console.log = realLog;
    console.warn = realWarn;
    stub.uninstall();
  }
});
