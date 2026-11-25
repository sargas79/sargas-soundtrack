import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { strictI18n, loadLang, flatKeys } from "./helpers/i18n.js";
import {
  isChromiumBased, checkSecureContext, checkTabCapture, checkSource, checkHeadphones, checkTone,
  runChecks, buildChecklistView, readEnvironment, NOTE_KEYS, checkRelay
} from "../scripts/checklist.js";
import { createChecklistApp } from "../scripts/checklist-app.js";
import { registerSettings } from "../scripts/settings.js";
import { MODULE_ID, SETTINGS, CHECKLIST_MENU } from "../scripts/constants.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i18n = strictI18n();

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/130.0.0.0`;
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

test("isChromiumBased: brands, Chrome/Edge user agents yes; Firefox and Safari no", () => {
  assert.equal(isChromiumBased({ brands: [{ brand: "Not A;Brand" }, { brand: "Chromium" }] }), true);
  assert.equal(isChromiumBased({ userAgent: CHROME_UA }), true);
  assert.equal(isChromiumBased({ userAgent: EDGE_UA }), true);
  assert.equal(isChromiumBased({ userAgent: FIREFOX_UA }), false);
  assert.equal(isChromiumBased({ userAgent: SAFARI_UA }), false);
  assert.equal(isChromiumBased({}), false);
});

test("checkSecureContext: pass over HTTPS/localhost, warn otherwise", () => {
  assert.equal(checkSecureContext({ isSecureContext: true }).status, "pass");
  const w = checkSecureContext({ isSecureContext: false });
  assert.equal(w.status, "warn");
  assert.match(w.detailKey, /Secure\.Warn$/);
});

test("checkTabCapture: Chromium with getDisplayMedia passes; Firefox, other and missing API warn", () => {
  assert.equal(checkTabCapture({ userAgent: CHROME_UA, hasGetDisplayMedia: true }).status, "pass");
  assert.equal(checkTabCapture({ userAgent: EDGE_UA, hasGetDisplayMedia: true }).status, "pass");
  const ff = checkTabCapture({ userAgent: FIREFOX_UA, hasGetDisplayMedia: true });
  assert.equal(ff.status, "warn");
  assert.match(ff.detailKey, /Firefox$/);
  assert.match(checkTabCapture({ userAgent: SAFARI_UA, hasGetDisplayMedia: true }).detailKey, /Other$/);
  const noApi = checkTabCapture({ userAgent: CHROME_UA, hasGetDisplayMedia: false });
  assert.equal(noApi.status, "warn");
  assert.match(noApi.detailKey, /NoApi$/);
});

test("checkSource: tab passes; device: none / unchecked / found / missing / error", () => {
  assert.equal(checkSource({ source: "tab", deviceId: "", devices: null }).status, "pass");
  assert.equal(checkSource({ source: "device", deviceId: "", devices: null }).status, "warn");
  const unchecked = checkSource({ source: "device", deviceId: "d1", devices: null });
  assert.deepEqual([unchecked.status, unchecked.action], ["info", "checkDevices"]);
  const found = checkSource({ source: "device", deviceId: "d1", devices: [{ deviceId: "d1", label: "CABLE Output" }] });
  assert.deepEqual([found.status, found.detailData], ["pass", { label: "CABLE Output" }]);
  const missing = checkSource({ source: "device", deviceId: "gone", devices: [{ deviceId: "d1", label: "x" }] });
  assert.equal(missing.status, "warn");
  assert.match(missing.detailKey, /DeviceMissing$/);
  assert.equal(checkSource({ source: "device", deviceId: "d1", devices: null, devicesError: true }).status, "warn");
});

test("static checks: headphones reminder and test tone action", () => {
  assert.equal(checkHeadphones().status, "info");
  assert.equal(checkTone().action, "sendTone");
});

test("runChecks returns the five checks in order", () => {
  const checks = runChecks(
    { isSecureContext: true, userAgent: CHROME_UA, brands: [], hasGetDisplayMedia: true },
    { source: "tab", deviceId: "", devices: null }
  );
  assert.deepEqual(checks.map(c => c.id), ["secure", "browser", "source", "headphones", "tone"]);
});

test("buildChecklistView localises every check (all keys exist) and lists the troubleshooting notes", () => {
  const checks = runChecks(
    { isSecureContext: false, userAgent: FIREFOX_UA, brands: [], hasGetDisplayMedia: true },
    { source: "device", deviceId: "d1", devices: [{ deviceId: "d1", label: "CABLE <Output>" }] }
  );
  const view = buildChecklistView(checks, i18n);
  assert.equal(view.checks.length, 5);
  assert.ok(view.checks.every(c => c.title && c.detail && c.statusLabel));
  assert.equal(view.checks[0].statusLabel, "Check");
  assert.ok(view.checks[2].detail.includes("CABLE <Output>"), "label is passed as data; Handlebars escapes it on render");
  assert.equal(view.checks.find(c => c.id === "tone").actionLabel, "Send test tone");
  assert.equal(view.notes.length, NOTE_KEYS.length);
  const notes = view.notes.join(" ");
  for (const word of ["muted", "VB-Cable", "Discord", "CABLE Input", "headphones"]) assert.match(notes, new RegExp(word, "i"));
});

test("readEnvironment reads secure context, user agent, client hints and getDisplayMedia", () => {
  assert.deepEqual(
    readEnvironment({ isSecureContext: true, navigator: { userAgent: "ua", userAgentData: { brands: [{ brand: "Chromium" }] }, mediaDevices: { getDisplayMedia() {} } } }),
    { isSecureContext: true, userAgent: "ua", brands: [{ brand: "Chromium" }], hasGetDisplayMedia: true }
  );
  assert.deepEqual(readEnvironment({}), { isSecureContext: false, userAgent: "", brands: [], hasGetDisplayMedia: false });
});

// --- the ApplicationV2 shell --------------------------------------------------------------------

let stub;
afterEach(() => stub?.uninstall());

test("registerSettings registers a GM-restricted checklist menu when given the app class", () => {
  stub = installFoundryStub();
  const App = createChecklistApp();
  registerSettings({ checklistApp: App });
  const menu = stub.menus.get(`${MODULE_ID}.${CHECKLIST_MENU}`);
  assert.equal(menu.type, App);
  assert.equal(menu.restricted, true);
  assert.equal(typeof menu.icon, "string");
  for (const k of ["name", "label", "hint"]) assert.ok(i18n.has(menu[k]), menu[k]);
});

test("registerSettings without the app class still works (no menu)", () => {
  stub = installFoundryStub();
  registerSettings();
  assert.equal(stub.menus.size, 0);
});

test("checklist app: options, parts and context built from live settings; device check only on demand", async () => {
  stub = installFoundryStub();
  registerSettings();
  const App = createChecklistApp();
  assert.ok(App.DEFAULT_OPTIONS.window.title);
  assert.match(App.PARTS.main.template, /templates\/checklist\.hbs$/);
  assert.deepEqual(Object.keys(App.DEFAULT_OPTIONS.actions).sort(), ["checkDevices", "recheck", "sendTone"]);

  await game.settings.set(MODULE_ID, SETTINGS.SOURCE, "device");
  await game.settings.set(MODULE_ID, SETTINGS.DEVICE_ID, "d1");
  const app = new App();
  let ctx = await app._prepareContext({});
  assert.equal(ctx.checks.find(c => c.id === "source").status, "info", "not checked until the button is pressed");

  game.modules.get(MODULE_ID).api = { capture: { listDevices: async () => [{ deviceId: "d1", label: "CABLE Output" }] }, testTone: async s => { app.toneArg = s; return true; } };
  await app.checkDevices();
  assert.equal(app.renders, 1);
  ctx = await app._prepareContext({});
  assert.equal(ctx.checks.find(c => c.id === "source").status, "pass");

  await App.DEFAULT_OPTIONS.actions.sendTone.call(app);
  assert.equal(app.toneArg, 10);

  game.modules.get(MODULE_ID).api = { capture: { listDevices: async () => { throw new Error("denied"); } } };
  await app.checkDevices();
  ctx = await app._prepareContext({});
  assert.equal(ctx.checks.find(c => c.id === "source").status, "warn");
});

// --- templates, styles and lang ------------------------------------------------------------------

const templates = readdirSync(join(root, "templates")).filter(f => f.endsWith(".hbs"));
const read = p => readFileSync(join(root, p), "utf8");

test("templates: no unescaped output ({{{ }}}), only existing lang keys", () => {
  assert.ok(templates.includes("sidebar-row.hbs") && templates.includes("checklist.hbs"));
  for (const f of templates) {
    const src = read(`templates/${f}`);
    assert.ok(!src.includes("{{{"), `${f}: triple-stash would bypass escaping`);
    for (const [, key] of src.matchAll(/localize\s+"([^"]+)"/g)) assert.ok(i18n.has(key), `${f}: unknown lang key ${key}`);
  }
});

test("sidebar template carries every data-ss hook the row code wires", () => {
  const src = read("templates/sidebar-row.hbs");
  const hooks = new Set([...src.matchAll(/data-ss="([^"]+)"/g)].map(m => m[1]));
  for (const h of [
    "live-state", "go", "stop", "source", "device-wrap", "device", "refresh-devices", "send", "monitor", "fade-out", "fade-in",
    "meter", "listeners", "now-playing-input", "mute", "now-playing-row", "now-playing", "audio-hint"
  ]) assert.ok(hooks.has(h), `missing data-ss="${h}"`);
  // the row code must not reference hooks the template lacks
  const code = read("scripts/sidebar.js");
  const used = new Set([...code.matchAll(/(?:el\(|set\(|on\()"([a-z-]+)"/g)].map(m => m[1]));
  for (const h of used) assert.ok(hooks.has(h), `sidebar.js uses data-ss="${h}" but the template lacks it`);
});

test("every localized string in code and templates exists in both languages", () => {
  const en = new Set(flatKeys(loadLang("en")).map(([k]) => k));
  const pt = new Set(flatKeys(loadLang("pt-BR")).map(([k]) => k));
  assert.deepEqual([...en].sort(), [...pt].sort());
  for (const file of readdirSync(join(root, "scripts"))) {
    for (const [, key] of read(`scripts/${file}`).matchAll(/"(SARGAS_SOUNDTRACK\.[A-Za-z.]+[A-Za-z])"/g)) assert.ok(en.has(key) || [...en].some(k => k.startsWith(key)), `${file}: ${key}`); // bare prefixes are built up in code
  }
});

test("pt-BR strings are translated (no value identical to English except names and codes)", () => {
  const en = new Map(flatKeys(loadLang("en")));
  const same = flatKeys(loadLang("pt-BR")).filter(([k, v]) => en.get(k) === v).map(([k]) => k);
  const allowed = new Set(["SARGAS_SOUNDTRACK.Title", "SARGAS_SOUNDTRACK.Checklist.Status.pass", "SARGAS_SOUNDTRACK.Checklist.Status.info"]);
  assert.deepEqual(same.filter(k => !allowed.has(k)), []);
});

test("styles are scoped under .sargas-soundtrack", () => {
  const css = read("styles/sargas-soundtrack.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors] of css.matchAll(/(?:^|})\s*([^{}@]+)\{/g)) {
    for (const sel of selectors.split(",")) assert.match(sel.trim(), /^\.sargas-soundtrack/, `unscoped selector: ${sel.trim()}`);
  }
});

// --- relay check ---------------------------------------------------------------------------------------

test("checkRelay: warn, relay-only info, pass (module / Foundry) and none info", () => {
  const warn = checkRelay({ relayOnly: true, turnSource: null });
  assert.deepEqual([warn.status, warn.detailKey], ["warn", "SARGAS_SOUNDTRACK.Checklist.Relay.OnlyNoTurn"]);
  for (const src of ["module", "foundry"]) {
    const r = checkRelay({ relayOnly: true, turnSource: src });
    assert.deepEqual([r.status, r.detailKey], ["info", "SARGAS_SOUNDTRACK.Checklist.Relay.OnlyActive"]);
  }
  assert.equal(checkRelay({ relayOnly: false, turnSource: "module" }).detailKey, "SARGAS_SOUNDTRACK.Checklist.Relay.PassModule");
  const f = checkRelay({ relayOnly: false, turnSource: "foundry" });
  assert.deepEqual([f.status, f.detailKey], ["pass", "SARGAS_SOUNDTRACK.Checklist.Relay.PassFoundry"]);
  const none = checkRelay({ relayOnly: false, turnSource: null });
  assert.deepEqual([none.status, none.detailKey], ["info", "SARGAS_SOUNDTRACK.Checklist.Relay.None"]);
});

test("runChecks adds the relay check after the source check when given; every state localises", () => {
  const env = { isSecureContext: true, userAgent: CHROME_UA, brands: [], hasGetDisplayMedia: true };
  const src = { source: "tab", deviceId: "", devices: null };
  for (const relay of [{ relayOnly: true, turnSource: null }, { relayOnly: true, turnSource: "module" }, { relayOnly: false, turnSource: "foundry" }, { relayOnly: false, turnSource: null }]) {
    const checks = runChecks(env, src, relay);
    assert.deepEqual(checks.map(c => c.id), ["secure", "browser", "source", "relay", "headphones", "tone"]);
    const v = buildChecklistView(checks, i18n);
    assert.ok(v.checks.every(c => c.title && c.detail));
  }
});

test("checklist app feeds the relay settings into the checks", async () => {
  stub = installFoundryStub();
  registerSettings();
  const app = new (createChecklistApp())();
  let ctx = await app._prepareContext({});
  assert.equal(ctx.checks.find(c => c.id === "relay").status, "info");
  await game.settings.set(MODULE_ID, SETTINGS.RELAY_ONLY, true);
  ctx = await app._prepareContext({});
  assert.equal(ctx.checks.find(c => c.id === "relay").status, "warn");
});
