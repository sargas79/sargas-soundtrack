import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { parseIceServers, clampBitrate, getIceServers, getBitrate, registerSettings, resetIceWarning } from "../scripts/settings.js";
import { DEFAULT_ICE_SERVERS, DEFAULT_BITRATE, MODULE_ID, SETTINGS, MSG, HOOKS, SOCKET_CHANNEL } from "../scripts/constants.js";

test("constants match the spec", () => {
  assert.equal(MODULE_ID, "sargas-soundtrack");
  assert.equal(SOCKET_CHANNEL, "module.sargas-soundtrack");
  assert.deepEqual(Object.keys(MSG).sort(), ["ANSWER", "END", "ICE", "LIVE", "OFFER", "REQUEST"]);
  assert.deepEqual(DEFAULT_ICE_SERVERS, [{ urls: "stun:stun.l.google.com:19302" }]);
  assert.equal(HOOKS.LIVE, "sargas-soundtrack.live");
  assert.equal(HOOKS.ENDED, "sargas-soundtrack.ended");
  assert.equal(HOOKS.STATUS, "sargas-soundtrack.status");
});

test("parseIceServers: empty or blank gives defaults without error", () => {
  for (const input of ["", "   ", undefined, null]) {
    const r = parseIceServers(input);
    assert.deepEqual(r.servers, DEFAULT_ICE_SERVERS, String(input));
    assert.equal(r.error, null);
  }
});

test("parseIceServers: valid servers pass through", () => {
  const json = JSON.stringify([
    { urls: "stun:a.example:3478" },
    { urls: ["turn:b.example:3478", "turns:b.example:5349"], username: "u", credential: "c" }
  ]);
  const r = parseIceServers(json);
  assert.equal(r.error, null);
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers[1], { urls: ["turn:b.example:3478", "turns:b.example:5349"], username: "u", credential: "c" });
});

test("parseIceServers: invalid JSON falls back with an error", () => {
  const r = parseIceServers("[{");
  assert.deepEqual(r.servers, DEFAULT_ICE_SERVERS);
  assert.match(r.error, /Json$/);
});

test("parseIceServers: wrong shapes fall back with an error", () => {
  const bad = [
    "{}", "42", "\"stun:x\"", "[]", "[1]", "[null]", "[[]]", "[{}]", "[{\"urls\":5}]", "[{\"urls\":[]}]",
    "[{\"urls\":[\"stun:x\",3]}]", "[{\"urls\":\"stun:x\",\"username\":1}]", "[{\"urls\":\"stun:x\",\"credential\":{}}]"
  ];
  for (const b of bad) {
    const r = parseIceServers(b);
    assert.deepEqual(r.servers, DEFAULT_ICE_SERVERS, b);
    assert.match(r.error, /Shape$/, b);
  }
});

test("parseIceServers: non stun/turn scheme is rejected", () => {
  const r = parseIceServers("[{\"urls\":\"http://x\"}]");
  assert.deepEqual(r.servers, DEFAULT_ICE_SERVERS);
  assert.match(r.error, /Scheme$/);
});

test("parseIceServers: returned defaults are copies", () => {
  const r = parseIceServers("");
  r.servers[0].urls = "mutated";
  assert.equal(DEFAULT_ICE_SERVERS[0].urls, "stun:stun.l.google.com:19302");
});

test("clampBitrate: default, clamp 32-256, round", () => {
  assert.equal(clampBitrate("abc"), DEFAULT_BITRATE);
  assert.equal(clampBitrate(undefined), DEFAULT_BITRATE);
  assert.equal(clampBitrate(NaN), DEFAULT_BITRATE);
  assert.equal(clampBitrate(Infinity), DEFAULT_BITRATE);
  assert.equal(clampBitrate(1), 32);
  assert.equal(clampBitrate(-50), 32);
  assert.equal(clampBitrate(9999), 256);
  assert.equal(clampBitrate(127.6), 128);
  assert.equal(clampBitrate("96"), 96);
  assert.equal(clampBitrate(32), 32);
  assert.equal(clampBitrate(256), 256);
});

let stub;
beforeEach(() => { stub = installFoundryStub(); resetIceWarning(); });
afterEach(() => stub.uninstall());

test("registerSettings registers every setting with the right scope", () => {
  registerSettings();
  for (const key of Object.values(SETTINGS)) assert.ok(stub.settings.has(`${MODULE_ID}.${key}`), key);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.BITRATE), DEFAULT_BITRATE);
  assert.equal(game.settings.get(MODULE_ID, SETTINGS.SOURCE), "tab");
});

test("getIceServers reads the setting and warns the GM once on invalid input", () => {
  registerSettings();
  assert.deepEqual(getIceServers(), DEFAULT_ICE_SERVERS);
  assert.equal(stub.notifications.length, 0);

  game.settings.set(MODULE_ID, SETTINGS.ICE_SERVERS, "nope");
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(getIceServers(), DEFAULT_ICE_SERVERS);
    getIceServers();
  } finally { console.warn = origWarn; }
  assert.equal(stub.notifications.filter(n => n[0] === "warn").length, 1);
});

test("getBitrate clamps the stored value", async () => {
  registerSettings();
  await game.settings.set(MODULE_ID, SETTINGS.BITRATE, 5000);
  assert.equal(getBitrate(), 256);
});
