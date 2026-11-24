import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeAudioContext, FakePC, flush } from "./helpers/fakes.js";
import { MODULE_ID, SOCKET_CHANNEL, MSG, HOOKS } from "../scripts/constants.js";

let stub, n = 0;
const realLog = console.log, realWarn = console.warn;

/** Fresh copy of main.js (it keeps module-level state) wired to a fresh stub. */
async function boot(opts) {
  stub = installFoundryStub(opts);
  game.audio = { unlock: Promise.resolve(), music: new FakeAudioContext() };
  globalThis.RTCPeerConnection = FakePC;
  console.log = () => {};
  console.warn = () => {};
  await import(`../scripts/main.js?run=${++n}`);
  Hooks.callAll("init");
  Hooks.callAll("ready");
  return game.modules.get(MODULE_ID).api;
}

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  delete globalThis.RTCPeerConnection;
  stub?.uninstall();
});

const users = [{ id: "gm1", isGM: true }, { id: "p1" }];

test("active GM: builds capture + broadcaster, exposes the api, goLive/stop/fadeTo work", async () => {
  const api = await boot({ users, currentUserId: "gm1" });
  assert.ok(api.broadcaster);
  assert.equal(api.receiver, null);
  assert.ok(api.capture);
  assert.equal(api.isLive, false);
  assert.deepEqual(api.status, { role: "broadcaster", live: false, peers: [] });

  assert.equal(await api.goLive("tone"), true);
  assert.equal(api.isLive, true);
  assert.equal(stub.socket.sent(MSG.LIVE).length, 1);
  assert.ok(stub.notifications.some(x => x[0] === "info"));

  api.fadeTo(0, 1000);
  api.stop();
  assert.equal(api.isLive, false);
  assert.equal(stub.socket.sent(MSG.END).length, 1);
});

test("GM: a rejected source is reported with a localized notification and returns false", async () => {
  const api = await boot({ users, currentUserId: "gm1" });
  assert.equal(await api.goLive("bogus"), false);
  const [kind, msg] = stub.notifications.at(-1);
  assert.equal(kind, "error");
  assert.equal(msg, "SARGAS_SOUNDTRACK.Error.unsupported");
  assert.equal(api.isLive, false);
});

test("GM: incoming REQUEST is routed to the broadcaster, via the module socket", async () => {
  const api = await boot({ users, currentUserId: "gm1" });
  await api.goLive("tone");
  stub.socket.clear();
  stub.socket.deliver(SOCKET_CHANNEL, { type: MSG.REQUEST, sessionId: null, to: null }, "p1");
  await flush();
  assert.equal(stub.socket.sent(MSG.OFFER).length, 1);
  assert.deepEqual(stub.socket.sent(MSG.OFFER)[0].options, { recipients: ["p1"] });
});

test("userConnected hook is forwarded to the broadcaster", async () => {
  const api = await boot({ users, currentUserId: "gm1" });
  await api.goLive("tone");
  stub.socket.deliver(SOCKET_CHANNEL, { type: MSG.REQUEST, sessionId: null, to: null }, "p1");
  await flush();
  assert.equal(api.broadcaster.peerCount, 1);
  Hooks.callAll("userConnected", { id: "p1" }, false);
  assert.equal(api.broadcaster.peerCount, 0);
});

test("player: builds a receiver, probes the GM, goLive is refused", async () => {
  const api = await boot({ users, currentUserId: "p1" });
  assert.equal(api.broadcaster, null);
  assert.ok(api.receiver);
  const [probe] = stub.socket.sent(MSG.REQUEST);
  assert.deepEqual(probe.options, { recipients: ["gm1"] });
  assert.equal(probe.payload.sessionId, null);

  assert.equal(await api.goLive("tone"), false);
  assert.equal(stub.notifications.at(-1)[1], "SARGAS_SOUNDTRACK.Error.notActiveGM");
  assert.deepEqual(api.status, { role: "listener", status: "idle" });
});

test("player: LIVE from the GM starts a session, notifies, and END notifies again", async () => {
  const api = await boot({ users, currentUserId: "p1" });
  stub.socket.clear();
  stub.socket.deliver(SOCKET_CHANNEL, { type: MSG.LIVE, sessionId: "s", to: null }, "gm1");
  assert.equal(api.receiver.status, "connecting");
  assert.equal(stub.socket.sent(MSG.REQUEST).length, 1);
  assert.ok(stub.notifications.some(x => x[0] === "info"));
  stub.socket.deliver(SOCKET_CHANNEL, { type: MSG.END, sessionId: "s", to: null }, "gm1");
  assert.equal(api.status.status, "idle");
  assert.equal(stub.notifications.filter(x => x[0] === "info").length, 2);
  assert.equal(stub.hooks.calls.filter(c => c.name === HOOKS.ENDED).length, 1);
});

test("a throwing handler does not break the socket listener", async () => {
  const api = await boot({ users, currentUserId: "p1" });
  api.receiver.handle = () => { throw new Error("boom"); };
  const err = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => stub.socket.deliver(SOCKET_CHANNEL, { type: MSG.LIVE, sessionId: "s", to: null }, "gm1"));
  } finally { console.error = err; }
});

// --- chunk 2/3: macro API, settings menu, sidebar wiring ----------------------------------------

import { SETTINGS, SIDEBAR_TEMPLATE, CHECKLIST_TEMPLATE, CHECKLIST_MENU } from "../scripts/constants.js";
import { fakeAppElement, FakeEl } from "./helpers/fakes.js";

test("init preloads the templates, registers the checklist menu and hooks the sidebar", async () => {
  await boot({ users, currentUserId: "gm1" });
  assert.deepEqual(stub.preloaded.sort(), [CHECKLIST_TEMPLATE, SIDEBAR_TEMPLATE].sort());
  assert.ok(stub.menus.has(`${MODULE_ID}.${CHECKLIST_MENU}`));
  assert.equal(stub.menus.get(`${MODULE_ID}.${CHECKLIST_MENU}`).restricted, true);
  assert.ok(stub.hooks.listenerCount("renderPlaylistDirectory") >= 1);
});

test("api: setSendLevel / setMonitorLevel go through capture and persist; setNowPlaying writes the world setting", async () => {
  const api = await boot({ users, currentUserId: "gm1" });
  api.setSendLevel(0.3);
  api.setMonitorLevel(0.5);
  await flush();
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.SEND_LEVEL), 0.3);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.MONITOR_LEVEL), 0.5);
  assert.equal(await api.setNowPlaying("Tavern"), true);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.NOW_PLAYING), "Tavern");
});

test("api: a player cannot set the now playing line; setMute works for listeners", async () => {
  const api = await boot({ users, currentUserId: "p1" });
  assert.equal(await api.setNowPlaying("nope"), false);
  assert.equal(stub.notifications.at(-1)[1], "SARGAS_SOUNDTRACK.Error.notActiveGM");
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.NOW_PLAYING), "");
  api.setMute(true);
  await flush();
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.MUTE), true);
  assert.doesNotThrow(() => { api.setSendLevel(0.1); api.setMonitorLevel(0.1); });
});

test("sidebar integration: the render hook inserts a row and a nowPlaying change updates it in place", async () => {
  const api = await boot({ users, currentUserId: "p1" });
  const element = fakeAppElement();
  const realToElement = globalThis.document;
  globalThis.document = { createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: new FakeEl("row") } }) };
  try {
    Hooks.callAll("renderPlaylistDirectory", {}, element, {}, { parts: ["header"], isFirstRender: true });
    await flush();
    assert.equal(element.inserts, 1);
    Hooks.callAll("renderPlaylistDirectory", {}, element, {}, { parts: ["playing"] });
    await flush();
    assert.equal(element.inserts, 1);
    await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "Boss music");
    assert.equal(element.row.querySelector("[data-ss=\"now-playing\"]").textContent, "Boss music");
    assert.equal(api.status.status, "idle");
  } finally {
    if (realToElement === undefined) delete globalThis.document; else globalThis.document = realToElement;
  }
});
