import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { FakeEl, fakeAppElement, fakeClock, flush } from "./helpers/fakes.js";
import { SidebarUI, ROW_ID } from "../scripts/sidebar.js";
import { registerSettings } from "../scripts/settings.js";
import { MODULE_ID, SETTINGS, HOOKS, SIDEBAR_TEMPLATE } from "../scripts/constants.js";

const users = [
  { id: "gm1", name: "GM", isGM: true },
  { id: "p1", name: "Ana" },
  { id: "p2", name: "Bob" },
  { id: "p3", name: "Off", active: false }
];

let stub, clock, api, ui, el, reports, templates, deferreds;

function makeApi({ live = false, gm = true } = {}) {
  const calls = [];
  const a = {
    calls,
    broadcaster: gm ? {
      live,
      peers: [],
      statsList: [],
      statsCalls: 0,
      statuses() { return this.peers; },
      async stats() { this.statsCalls++; return this.statsList; }
    } : null,
    capture: gm ? { outputStream: { id: "out" }, listDevices: async () => { calls.push(["listDevices"]); return [{ deviceId: "d1", label: "CABLE Output" }]; } } : null,
    receiver: gm ? null : { status: "idle" },
    goLive(...args) { calls.push(["goLive", ...args]); return Promise.resolve(true); },
    stop() { calls.push(["stop"]); },
    fadeTo(...args) { calls.push(["fadeTo", ...args]); },
    setSendLevel(v) { calls.push(["setSendLevel", v]); },
    setMonitorLevel(v) { calls.push(["setMonitorLevel", v]); },
    setNowPlaying(v) { calls.push(["setNowPlaying", v]); },
    setMute(v) { calls.push(["setMute", v]); }
  };
  return a;
}

/** SidebarUI with a controllable async template render. */
function makeUi({ deferred = false } = {}) {
  deferreds = [];
  templates = [];
  return new SidebarUI({
    getApi: () => api,
    renderTemplate: (path, data) => {
      templates.push({ path, data });
      if (!deferred) return Promise.resolve("<section></section>");
      return new Promise(resolve => deferreds.push(() => resolve("<section></section>")));
    },
    toElement: () => new FakeEl("row"),
    scheduler: clock,
    getAudio: () => game.audio
  });
}

function setup({ user = "gm1", apiOpts, deferred } = {}) {
  stub = installFoundryStub({ users, currentUserId: user });
  registerSettings({ onChange: { nowPlaying: text => ui?.nowPlayingChanged(text), mute: () => ui?.refresh() } });
  clock = fakeClock();
  reports = { started: [], stopped: [] };
  game.audio = {
    locked: false,
    unlock: Promise.resolve(),
    startLevelReports(...args) { reports.started.push(args); },
    stopLevelReports(id) { reports.stopped.push(id); }
  };
  api = makeApi(apiOpts ?? { gm: user === "gm1" });
  ui = makeUi({ deferred });
  el = fakeAppElement();
}

afterEach(() => stub?.uninstall());

const row = () => el.row;
const part = name => el.row.querySelector(`[data-ss="${name}"]`);

test("template is preloaded path, row inserted once after the header part with id and role", async () => {
  setup();
  await ui.onRender({}, el);
  assert.equal(templates[0].path, SIDEBAR_TEMPLATE);
  assert.deepEqual(templates[0].data, { isGM: true });
  assert.equal(el.inserts, 1);
  assert.equal(el.how, "after-header");
  assert.equal(row().id, ROW_ID);
  assert.equal(row().dataset.ssRole, "gm");
  assert.equal(part("live-state").textContent, "SARGAS_SOUNDTRACK.Row.Status.Idle");
  assert.equal(part("go").hidden, false);
  assert.equal(part("stop").hidden, true);
});

test("without a header part the row is prepended", async () => {
  setup();
  el = fakeAppElement({ withHeader: false });
  await ui.onRender({}, el);
  assert.equal(el.how, "prepend");
});

test("no row before the module api exists", async () => {
  setup();
  api = null;
  await ui.onRender({}, el);
  assert.equal(el.inserts, 0);
});

test("repeated hook calls and partial renders never duplicate the row; they refresh it in place", async () => {
  setup();
  await ui.onRender({}, el, {}, { parts: ["header", "controls", "directory", "playing", "footer"], isFirstRender: true });
  const first = row();
  for (let i = 0; i < 5; i++) await ui.onRender({}, el, {}, { parts: ["playing"] });
  assert.equal(el.inserts, 1);
  assert.equal(row(), first);
  assert.equal(templates.length, 1, "an existing live row is not re-rendered from the template");
  // state changed meanwhile: the partial render refreshes the live row
  api.broadcaster.live = true;
  await ui.onRender({}, el, {}, { parts: ["header"] });
  assert.equal(part("stop").hidden, false);
});

test("a full re-render that dropped the row inserts a fresh one and disposes the old view (meter stopped)", async () => {
  setup({ apiOpts: { live: true } });
  await ui.onRender({}, el);
  assert.equal(reports.started.length, 1);
  const old = row();
  old.remove(); // the sidebar re-rendered and the row is gone
  await ui.onRender({}, el);
  assert.notEqual(row(), old);
  assert.equal(el.inserts, 2);
  assert.ok(reports.stopped.length >= 1, "old view stopped its meter");
  assert.equal(clock.intervals.length, 1, "exactly one stats interval, owned by the new row");
});

test("stale async render is discarded: two overlapping renders insert exactly one row (newer wins)", async () => {
  setup({ deferred: true });
  const a = ui.onRender({}, el);
  const b = ui.onRender({}, el);
  assert.equal(deferreds.length, 2);
  deferreds[1]();
  await b;
  assert.equal(el.inserts, 1);
  const inserted = row();
  deferreds[0]();
  await a;
  assert.equal(el.inserts, 1, "the older render must not insert or overwrite");
  assert.equal(row(), inserted);
});

test("older render finishing first is discarded too", async () => {
  setup({ deferred: true });
  const a = ui.onRender({}, el);
  const b = ui.onRender({}, el);
  deferreds[0]();
  await a;
  assert.equal(el.inserts, 0);
  deferreds[1]();
  await b;
  assert.equal(el.inserts, 1);
});

test("role change (active GM changed) replaces the row", async () => {
  setup();
  await ui.onRender({}, el);
  assert.equal(row().dataset.ssRole, "gm");
  stub.setActiveGM(null);
  api = makeApi({ gm: false });
  await ui.onRender({}, el);
  assert.equal(row().dataset.ssRole, "player");
  assert.equal(templates.at(-1).data.isGM, false);
});

// --- GM controls ------------------------------------------------------------------------------

test("Go live calls api.goLive synchronously inside the click, with the chosen source", async () => {
  setup();
  await ui.onRender({}, el);
  part("source").value = "tab";
  part("go").fire("click");
  assert.deepEqual(api.calls, [["goLive", "tab", {}]], "no await may precede goLive");

  api.calls.length = 0;
  part("source").value = "device";
  part("device").value = "d1";
  part("go").fire("click");
  assert.deepEqual(api.calls, [["goLive", "device", { deviceId: "d1" }]]);
});

test("Stop calls api.stop", async () => {
  setup({ apiOpts: { live: true } });
  await ui.onRender({}, el);
  part("stop").fire("click");
  assert.deepEqual(api.calls, [["stop"]]);
});

test("choosing Audio device persists the source, shows the picker and lists devices once (explicit action only)", async () => {
  setup();
  await ui.onRender({}, el);
  assert.equal(api.calls.filter(c => c[0] === "listDevices").length, 0, "rendering never lists devices");
  assert.equal(part("device-wrap").hidden, true);

  part("source").value = "device";
  part("source").fire("change");
  await flush();
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.SOURCE), "device");
  assert.equal(part("device-wrap").hidden, false);
  assert.equal(api.calls.filter(c => c[0] === "listDevices").length, 1);
  assert.match(part("device").innerHTML, /CABLE Output/);

  part("refresh-devices").fire("click");
  await flush();
  assert.equal(api.calls.filter(c => c[0] === "listDevices").length, 2);
});

test("device choice is persisted; while live and on the device source it switches live", async () => {
  setup({ apiOpts: { live: true } });
  game.settings.set(MODULE_ID, SETTINGS.SOURCE, "device");
  await ui.onRender({}, el);
  part("device").value = "d1";
  part("device").fire("change");
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.DEVICE_ID), "d1");
  assert.deepEqual(api.calls.at(-1), ["goLive", "device", { deviceId: "d1" }]);
});

test("changing source while live switches live (tab without a device id; device only once a device is chosen)", async () => {
  setup({ apiOpts: { live: true } });
  await ui.onRender({}, el);
  part("source").value = "device";
  part("source").fire("change");
  await flush();
  assert.ok(!api.calls.some(c => c[0] === "goLive"), "no device yet, nothing to switch to");
  part("source").value = "tab";
  part("source").fire("change");
  assert.deepEqual(api.calls.at(-1), ["goLive", "tab", {}]);
});

test("send and monitor sliders and fade buttons call the api", async () => {
  setup({ apiOpts: { live: true } });
  await game.settings.set(MODULE_ID, SETTINGS.SEND_LEVEL, 0.6);
  await ui.onRender({}, el);
  assert.equal(part("send").value, "0.6");
  assert.equal(part("fade-out").disabled, false);
  part("send").value = "0.4";
  part("send").fire("input");
  part("monitor").value = "0.2";
  part("monitor").fire("input");
  part("fade-out").fire("click");
  part("fade-in").fire("click");
  assert.deepEqual(api.calls, [
    ["setSendLevel", 0.4], ["setMonitorLevel", 0.2], ["fadeTo", 0, 3000], ["fadeTo", 0.6, 3000]
  ]);
});

test("fade buttons are disabled while not live", async () => {
  setup();
  await ui.onRender({}, el);
  assert.equal(part("fade-out").disabled, true);
  assert.equal(part("fade-in").disabled, true);
});

// --- level meter ------------------------------------------------------------------------------

test("meter: started once when live on the output stream at 100 ms, painted from dB, stopped on stop", async () => {
  setup();
  await ui.onRender({}, el);
  assert.equal(reports.started.length, 0);

  api.broadcaster.live = true;
  Hooks.callAll(HOOKS.LIVE);
  ui.register(); // hooks wired
  Hooks.callAll(HOOKS.STATUS);
  Hooks.callAll(HOOKS.STATUS);
  assert.equal(reports.started.length, 1, "repeated refreshes do not start another meter");
  const [id, stream, cb, interval] = reports.started[0];
  assert.equal(id, "sargas-soundtrack");
  assert.equal(stream, api.capture.outputStream);
  assert.equal(interval, 100);
  assert.equal(interval % 50, 0);

  cb(-40);
  assert.ok(Number(part("meter").styleProps["--ss-level"]) > 0);
  cb(-100);
  assert.equal(part("meter").styleProps["--ss-level"], "0.000");

  api.broadcaster.live = false;
  Hooks.callAll(HOOKS.ENDED);
  assert.deepEqual(reports.stopped.at(-1), "sargas-soundtrack");
  assert.equal(part("meter").styleProps["--ss-level"], "0.000");
  const stoppedBefore = reports.stopped.length;
  Hooks.callAll(HOOKS.STATUS);
  assert.equal(reports.stopped.length, stoppedBefore, "not stopped twice");
});

test("meter callback disposes the view when its row left the document", async () => {
  setup({ apiOpts: { live: true } });
  await ui.onRender({}, el);
  const cb = reports.started[0][2];
  row().isConnected = false;
  cb(-30);
  assert.ok(reports.stopped.length >= 1);
  assert.equal(clock.intervals.length, 0);
  assert.equal(ui.view.disposed, true);
});

// --- stats polling ----------------------------------------------------------------------------

test("stats: polled every 2 s while live; shows kbps, loss and candidate type per player", async () => {
  setup({ apiOpts: { live: true } });
  api.broadcaster.peers = [{ userId: "p1", name: "Ana", state: "connected" }];
  api.broadcaster.statsList = [{ userId: "p1", bitrateKbps: 126.4, lossPct: 0.5, candidatePair: { local: "host", remote: "relay" } }];
  await ui.onRender({}, el);
  assert.equal(clock.intervals.length, 1);
  assert.equal(clock.intervals[0].every, 2000);
  assert.equal(api.broadcaster.statsCalls, 0);

  clock.advance(1999);
  assert.equal(api.broadcaster.statsCalls, 0);
  clock.advance(1);
  await flush();
  assert.equal(api.broadcaster.statsCalls, 1);
  const html = part("listeners").innerHTML;
  assert.match(html, /126 kbps · SARGAS_SOUNDTRACK\.Row\.Stats\.Loss .*0\.5.* · relay/); // stub i18n.format echoes key + data
  assert.match(html, /data-user="p2" data-state="none"/, "active player without a peer shows as not connected");
  assert.ok(!html.includes("Off"), "inactive users are not listed");

  clock.advance(2000);
  await flush();
  assert.equal(api.broadcaster.statsCalls, 2);
});

test("stats polling stops when not live, and when the row is gone", async () => {
  setup({ apiOpts: { live: true } });
  await ui.onRender({}, el);
  ui.register();
  assert.equal(clock.intervals.length, 1);
  api.broadcaster.live = false;
  Hooks.callAll(HOOKS.ENDED);
  assert.equal(clock.intervals.length, 0);

  api.broadcaster.live = true;
  Hooks.callAll(HOOKS.LIVE);
  assert.equal(clock.intervals.length, 1);
  row().isConnected = false;
  clock.advance(2000);
  await flush();
  assert.equal(clock.intervals.length, 0, "interval cleared when the row is gone");
  assert.equal(api.broadcaster.statsCalls, 0);
});

test("a stats result arriving after the view was disposed is ignored", async () => {
  setup({ apiOpts: { live: true } });
  let release;
  api.broadcaster.stats = () => new Promise(r => { release = () => r([{ userId: "p1", bitrateKbps: 99 }]); });
  api.broadcaster.peers = [{ userId: "p1", name: "Ana", state: "connected" }];
  await ui.onRender({}, el);
  const before = part("listeners").innerHTML;
  clock.advance(2000);
  ui.view.dispose();
  release();
  await flush();
  assert.equal(part("listeners").innerHTML, before);
});

test("failed peers are shown as failed in the GM row", async () => {
  setup({ apiOpts: { live: true } });
  api.broadcaster.peers = [{ userId: "p1", name: "Ana", state: "failed" }];
  await ui.onRender({}, el);
  assert.match(part("listeners").innerHTML, /data-user="p1" data-state="failed"/);
});

// --- now playing ------------------------------------------------------------------------------

test("GM: now playing is committed on change (and debounced on input) through api.setNowPlaying", async () => {
  setup();
  await ui.onRender({}, el);
  const input = part("now-playing-input");
  input.value = "Tavern theme";
  input.fire("input");
  assert.equal(api.calls.filter(c => c[0] === "setNowPlaying").length, 0);
  clock.advance(599);
  assert.equal(api.calls.filter(c => c[0] === "setNowPlaying").length, 0);
  clock.advance(1);
  assert.deepEqual(api.calls.at(-1), ["setNowPlaying", "Tavern theme"]);

  input.value = "Boss fight";
  input.fire("input");
  input.fire("change");
  assert.deepEqual(api.calls.at(-1), ["setNowPlaying", "Boss fight"]);
  assert.equal(clock.pendingCount, clock.intervals.length, "change cancelled the debounce timer");
});

test("nowPlaying setting onChange updates the player row text in place, without re-rendering or innerHTML", async () => {
  setup({ user: "p1" });
  await ui.onRender({}, el);
  assert.equal(row().dataset.ssRole, "player");
  assert.equal(part("now-playing-row").hidden, true);
  const templatesBefore = templates.length;

  await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "<img src=x onerror=alert(1)>");
  assert.equal(part("now-playing").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(part("now-playing").innerHTML, "", "user text must only be written as text");
  assert.equal(part("now-playing-row").hidden, false);
  assert.equal(templates.length, templatesBefore);
  assert.equal(el.inserts, 1);

  await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "");
  assert.equal(part("now-playing-row").hidden, true);
});

test("nowPlaying onChange updates the GM input unless the GM is typing in it", async () => {
  setup();
  await ui.onRender({}, el);
  const input = part("now-playing-input");
  await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "A");
  assert.equal(input.value, "A");
  input.focus();
  input.value = "typing...";
  await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "B");
  assert.equal(input.value, "typing...");
});

test("a row rendered later shows the stored now playing text", async () => {
  setup({ user: "p1" });
  await game.settings.set(MODULE_ID, SETTINGS.NOW_PLAYING, "Already playing");
  await ui.onRender({}, el);
  assert.equal(part("now-playing").textContent, "Already playing");
  assert.equal(part("now-playing-row").hidden, false);
});

// --- player row -------------------------------------------------------------------------------

test("player: live indicator follows the receiver status through the STATUS hook", async () => {
  setup({ user: "p1" });
  ui.register();
  await ui.onRender({}, el);
  const expected = {
    idle: "SARGAS_SOUNDTRACK.Row.Status.Idle", connecting: "SARGAS_SOUNDTRACK.Row.Status.Connecting",
    live: "SARGAS_SOUNDTRACK.Row.Status.Live", failed: "SARGAS_SOUNDTRACK.Row.Status.Failed"
  };
  for (const [status, label] of Object.entries(expected)) {
    api.receiver.status = status;
    Hooks.callAll(HOOKS.STATUS, { role: "listener", status });
    assert.equal(part("live-state").textContent, label);
    assert.equal(part("live-state").dataset.state, status);
  }
  assert.equal(el.inserts, 1);
});

test("player: mute toggle calls api.setMute and reflects the setting", async () => {
  setup({ user: "p1" });
  await ui.onRender({}, el);
  part("mute").checked = true;
  part("mute").fire("change");
  assert.deepEqual(api.calls.at(-1), ["setMute", true]);
  await game.settings.set(MODULE_ID, SETTINGS.MUTE, true);
  assert.equal(part("mute").checked, true);
  await game.settings.set(MODULE_ID, SETTINGS.MUTE, false);
  assert.equal(part("mute").checked, false);
});

test("player: audio-locked hint shows until game.audio.unlock resolves, and is not shown when already unlocked", async () => {
  setup({ user: "p1" });
  let unlock;
  game.audio.locked = true;
  game.audio.unlock = new Promise(r => { unlock = r; });
  await ui.onRender({}, el);
  assert.equal(part("audio-hint").hidden, false);
  game.audio.locked = false;
  unlock();
  await flush();
  assert.equal(part("audio-hint").hidden, true);

  setup({ user: "p1" });
  await ui.onRender({}, el);
  assert.equal(part("audio-hint").hidden, true);
});

test("player row has no GM controls wired and no meter or stats timers", async () => {
  setup({ user: "p1" });
  await ui.onRender({}, el);
  assert.equal(reports.started.length, 0);
  assert.equal(clock.pendingCount, 0);
});

test("userConnected refreshes the GM listener list (not connected users appear and disappear)", async () => {
  setup();
  ui.register();
  await ui.onRender({}, el);
  assert.match(part("listeners").innerHTML, /data-user="p2" data-state="none"/);
  game.users.get("p2").active = false;
  Hooks.callAll("userConnected", game.users.get("p2"), false);
  assert.ok(!part("listeners").innerHTML.includes("data-user=\"p2\""));
});
