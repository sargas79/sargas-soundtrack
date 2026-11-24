import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml, meterLevel, candidateKind, formatStats, mergeListeners, listenersHtml, deviceOptionsHtml, buildRowModel
} from "../scripts/sidebar-model.js";
import { strictI18n } from "./helpers/i18n.js";

const i18n = strictI18n();

test("escapeHtml escapes markup and quotes, tolerates null", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(5), "5");
});

test("meterLevel: silence at or below -100 dB is empty, loud is full, in between is linear", () => {
  assert.equal(meterLevel(-100), 0);
  assert.equal(meterLevel(-120), 0);
  assert.equal(meterLevel(-Infinity), 0);
  assert.equal(meterLevel(NaN), 0);
  assert.equal(meterLevel(0), 1);
  const mid = meterLevel(-55);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(meterLevel(-40) > meterLevel(-60));
});

test("candidateKind: relay wins, otherwise the more NATed side, null when unknown", () => {
  assert.equal(candidateKind(null), null);
  assert.equal(candidateKind({ local: "?", remote: "?" }), null);
  assert.equal(candidateKind({ local: "host", remote: "host" }), "host");
  assert.equal(candidateKind({ local: "host", remote: "srflx" }), "srflx");
  assert.equal(candidateKind({ local: "relay", remote: "host" }), "relay");
  assert.equal(candidateKind({ local: "srflx", remote: "relay" }), "relay");
});

test("formatStats: kbps, loss and route; omits what is unknown", () => {
  assert.equal(formatStats(null, i18n), "");
  assert.equal(formatStats({}, i18n), "");
  assert.equal(formatStats({ bitrateKbps: 127.6, lossPct: 0.04, candidatePair: { local: "host", remote: "srflx" } }, i18n), "128 kbps · 0.0 % loss · srflx");
  assert.equal(formatStats({ bitrateKbps: null, lossPct: 2.345, candidatePair: { local: "relay", remote: "relay" } }, i18n), "2.3 % loss · relay");
  assert.equal(formatStats({ bitrateKbps: 96 }, i18n), "96 kbps");
});

const users = [
  { id: "gm1", name: "GM", isGM: true, active: true },
  { id: "p1", name: "Zed", isGM: false, active: true },
  { id: "p2", name: "Ana", isGM: false, active: true },
  { id: "p3", name: "Off", isGM: false, active: false },
  { id: "gm2", name: "Other GM", isGM: true, active: true }
];

test("mergeListeners: peers kept, active non-GM users without a peer shown as 'none', sorted by name", () => {
  const items = mergeListeners([{ userId: "p1", name: "Zed", state: "failed" }], users);
  assert.deepEqual(items, [
    { userId: "p2", name: "Ana", state: "none" },
    { userId: "p1", name: "Zed", state: "failed" }
  ]);
  assert.deepEqual(mergeListeners([], []), []);
});

test("listenersHtml: one row per player with state, stats and escaped names", () => {
  const items = [
    { userId: "p1", name: "<b>Eve</b>", state: "connected" },
    { userId: "p2", name: "Bob", state: "none" },
    { userId: "p3", name: "Cy", state: "failed" },
    { userId: "p4", name: "Di", state: "connecting" }
  ];
  const html = listenersHtml(items, i18n, {
    p1: { bitrateKbps: 128, lossPct: 0.5, candidatePair: { local: "relay", remote: "relay" } },
    p2: { bitrateKbps: 50 }, p3: { bitrateKbps: 50 }
  });
  assert.ok(!html.includes("<b>"), "player name must be escaped");
  assert.ok(html.includes("&lt;b&gt;Eve&lt;/b&gt;"));
  assert.match(html, /data-user="p1" data-state="connected"/);
  assert.match(html, /data-user="p2" data-state="none"/);
  assert.match(html, /data-user="p3" data-state="failed"/);
  assert.match(html, /data-route="relay">128 kbps · 0.5 % loss · relay</);
  assert.ok(html.includes("Not connected") && html.includes("Failed") && html.includes("Connecting") && html.includes("Connected"));
  // stats are only shown for peers that are up; a failed or absent one shows none
  assert.ok(!html.includes("50 kbps"));
});

test("listenersHtml: empty list shows the placeholder; a hostile user id cannot break out of the attribute", () => {
  assert.match(listenersHtml([], i18n), /ss-empty">No players online</);
  const html = listenersHtml([{ userId: "x\" onclick=\"y", name: "n", state: "connected" }], i18n);
  assert.ok(!html.includes("onclick=\"y"));
});

test("deviceOptionsHtml: placeholder, saved-but-unlisted, listed, and missing device", () => {
  assert.match(deviceOptionsHtml(null, "", i18n), /<option value="" selected disabled>Choose a device/);
  assert.match(deviceOptionsHtml(null, "d1", i18n), /<option value="d1" selected>Saved device/);
  const list = [{ deviceId: "d1", label: "CABLE <Output>" }, { deviceId: "d2", label: "Mic" }];
  const html = deviceOptionsHtml(list, "d2", i18n);
  assert.ok(html.includes("CABLE &lt;Output&gt;"));
  assert.match(html, /<option value="d2" selected>Mic/);
  assert.ok(!/value="d1" selected/.test(html));
  assert.match(deviceOptionsHtml(list, "gone", i18n), /<option value="gone" selected>Saved device \(not found\)/);
});

test("buildRowModel (GM): idle, live, source and levels", () => {
  const base = { isGM: true, live: false, source: "tab", deviceId: "", devices: null, sendLevel: 1, monitorLevel: 0.8, peers: [], users, stats: {}, nowPlaying: "" };
  let m = buildRowModel(base, i18n);
  assert.equal(m.role, "gm");
  assert.deepEqual([m.live, m.goHidden, m.stopHidden, m.fadeDisabled, m.deviceHidden], [false, false, true, true, true]);
  assert.equal(m.statusLabel, "Not live");
  assert.equal(m.sendLevel, "1");
  assert.equal(m.monitorLevel, "0.8");
  assert.equal(m.listenerCount, 2);

  m = buildRowModel({ ...base, live: true, source: "device", deviceId: "d", sendLevel: 7, monitorLevel: -1 }, i18n);
  assert.deepEqual([m.live, m.goHidden, m.stopHidden, m.fadeDisabled, m.deviceHidden, m.statusKey], [true, true, false, false, false, "live"]);
  assert.equal(m.statusLabel, "You are live");
  assert.equal(m.sendLevel, "1");
  assert.equal(m.monitorLevel, "0");
  assert.equal(buildRowModel({ ...base, source: "weird" }, i18n).source, "tab");
});

test("buildRowModel (player): idle, connecting, live, failed, unknown, mute, hint and now playing", () => {
  const base = { isGM: false, status: "idle", muted: false, audioLocked: false, nowPlaying: "" };
  const labels = { idle: "Not live", connecting: "Connecting…", live: "Live from the GM", failed: "Connection failed" };
  for (const [status, label] of Object.entries(labels)) {
    const m = buildRowModel({ ...base, status }, i18n);
    assert.equal(m.role, "player");
    assert.equal(m.statusLabel, label);
    assert.equal(m.statusKey, status);
    assert.equal(m.live, status === "live");
  }
  assert.equal(buildRowModel({ ...base, status: "bogus" }, i18n).statusKey, "idle");
  const m = buildRowModel({ ...base, muted: true, audioLocked: true, nowPlaying: "Tavern <3" }, i18n);
  assert.deepEqual([m.muted, m.hintHidden, m.nowPlayingHidden, m.nowPlaying], [true, false, false, "Tavern <3"]);
  assert.deepEqual([buildRowModel(base, i18n).hintHidden, buildRowModel(base, i18n).nowPlayingHidden], [true, true]);
});
