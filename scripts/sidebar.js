/**
 * "Sargas Soundtrack" row in the Playlists sidebar.
 *
 * The row is rendered once from templates/sidebar-row.hbs (static structure, localised labels) and then
 * only ever updated by writing to its DOM directly: never by re-rendering the sidebar. The sidebar
 * re-renders in parts and in full (every Music slider change), so `onRender` is idempotent: it keeps a
 * live row, replaces a stale one and discards an async render that was overtaken by a newer one.
 */
import { MODULE_ID, SETTINGS, HOOKS, LOG_PREFIX, SIDEBAR_TEMPLATE } from "./constants.js";
import { errorKey } from "./capture.js";
import {
  buildRowModel, meterLevel, METER_ID, METER_INTERVAL, STATS_INTERVAL, FADE_MS, NOW_PLAYING_DEBOUNCE
} from "./sidebar-model.js";

export const ROW_ID = "sargas-soundtrack-row";
const ROW_SELECTOR = `#${ROW_ID}`;
const HEADER_SELECTOR = "[data-application-part=\"header\"]";

const i18n = () => ({ t: k => game.i18n.localize(k), f: (k, d) => game.i18n.format(k, d) });
const getSetting = key => { try { return game.settings.get(MODULE_ID, key); } catch { return undefined; } };
const setSetting = (key, value) => { try { game.settings.set(MODULE_ID, key, value)?.catch?.(() => {}); } catch { /* not ready */ } };

/** Everything a row needs to draw itself, read from the live game state. */
export function readState(api, view = {}) {
  const isGM = !!(game.user?.isActiveGM && api?.broadcaster);
  const base = { isGM, nowPlaying: getSetting(SETTINGS.NOW_PLAYING) ?? "" };
  if (isGM) {
    return {
      ...base,
      live: api.broadcaster.live,
      source: getSetting(SETTINGS.SOURCE),
      deviceId: getSetting(SETTINGS.DEVICE_ID) ?? "",
      devices: view.devices ?? null,
      sendLevel: getSetting(SETTINGS.SEND_LEVEL),
      monitorLevel: getSetting(SETTINGS.MONITOR_LEVEL),
      peers: api.broadcaster.statuses(),
      users: [...(game.users?.values?.() ?? [])].map(u => ({ id: u.id, name: u.name, isGM: u.isGM, active: u.active })),
      stats: view.stats ?? {}
    };
  }
  return {
    ...base,
    status: api?.receiver?.status ?? "idle",
    muted: !!getSetting(SETTINGS.MUTE),
    audioLocked: !!game.audio?.locked && !view.unlocked
  };
}

/** One bound row: event wiring plus in-place updates. */
export class RowView {
  #el = new Map();
  #last = {};
  #meter = false;
  #statsTimer = null;
  #debounce = null;
  #disposed = false;
  devices = null;
  stats = {};
  unlocked = false;

  constructor(row, { getApi, scheduler, getAudio }) {
    this.row = row;
    this.getApi = getApi;
    this.scheduler = scheduler;
    this.getAudio = getAudio;
    this.role = row.dataset?.ssRole;
  }

  get disposed() { return this.#disposed; }

  el(name) {
    if (!this.#el.has(name)) this.#el.set(name, this.row.querySelector(`[data-ss="${name}"]`));
    return this.#el.get(name);
  }

  bind() {
    // Foundry binds Space to "pause game" and swallows it, so a focused button would never be pressed
    // with Space. Keep Space on our own buttons away from the global keybindings.
    this.row.addEventListener?.("keydown", ev => {
      if ((ev.key === " " || ev.code === "Space") && ev.target?.closest?.("button")) ev.stopPropagation();
    });
    if (this.role === "gm") this.#bindGM(); else this.#bindPlayer();
    this.refresh();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopMeter();
    this.#stopPolling();
    if (this.#debounce !== null) { this.scheduler.clearTimeout(this.#debounce); this.#debounce = null; }
  }

  /** Re-read the game state and write it into the existing elements. */
  refresh() {
    if (this.#disposed) return;
    const api = this.getApi();
    if (!api) return;
    const model = buildRowModel(readState(api, this), i18n());
    // The role is fixed when the row is rendered; if it changed (another GM became active) the next render replaces the row.
    if (model.role !== this.role) return;
    if (model.role === "gm") this.#applyGM(model); else this.#applyPlayer(model);
  }

  /** The nowPlaying world setting changed (fires on every client). */
  setNowPlaying(text) {
    if (this.#disposed) return;
    const value = text ?? "";
    const line = this.el("now-playing");
    if (line) line.textContent = value;
    const wrap = this.el("now-playing-row");
    if (wrap) wrap.hidden = !value;
    const input = this.el("now-playing-input");
    if (input && input.value !== value && input.ownerDocument?.activeElement !== input) input.value = value;
  }

  // --- GM ------------------------------------------------------------------------------------

  #applyGM(m) {
    const set = (name, fn) => { const e = this.el(name); if (e) fn(e); };
    set("live-state", e => { e.textContent = m.statusLabel; e.dataset.state = m.statusKey; });
    // Go live and Stop swap places: keep keyboard focus on the visible one instead of dropping it to the page.
    const go = this.el("go"), stop = this.el("stop");
    const focused = go?.ownerDocument?.activeElement;
    set("go", e => { e.hidden = m.goHidden; });
    set("stop", e => { e.hidden = m.stopHidden; });
    if (focused === go && go?.hidden && stop && !stop.hidden) stop.focus?.();
    else if (focused === stop && stop?.hidden && go && !go.hidden) go.focus?.();
    set("fade-out", e => { e.disabled = m.fadeDisabled; });
    set("fade-in", e => { e.disabled = m.fadeDisabled; });
    // Controls the GM is using are never overwritten (a setting change can arrive mid-drag).
    const idle = e => e.ownerDocument?.activeElement !== e;
    set("source", e => { if (idle(e) && e.value !== m.source) e.value = m.source; });
    set("device-wrap", e => { e.hidden = m.deviceHidden; });
    set("device", e => {
      if (this.#last.devices === m.deviceOptionsHtml) return;
      e.innerHTML = m.deviceOptionsHtml;
      this.#last.devices = m.deviceOptionsHtml;
    });
    set("send", e => { if (idle(e) && e.value !== m.sendLevel) e.value = m.sendLevel; });
    set("monitor", e => { if (idle(e) && e.value !== m.monitorLevel) e.value = m.monitorLevel; });
    this.#applyListeners(m);
    set("now-playing-input", e => { if (e.value !== m.nowPlaying && e.ownerDocument?.activeElement !== e) e.value = m.nowPlaying; });
    this.#syncMeter(m.live);
    this.#syncPolling(m.live);
  }

  #applyListeners(model) {
    const m = model ?? buildRowModel(readState(this.getApi(), this), i18n());
    if (m.role !== "gm") return;
    const e = this.el("listeners");
    if (e && this.#last.listeners !== m.listenersHtml) {
      e.innerHTML = m.listenersHtml;
      this.#last.listeners = m.listenersHtml;
    }
  }

  #bindGM() {
    const on = (name, type, fn) => this.el(name)?.addEventListener(type, fn);
    const api = () => this.getApi();

    // goLive() must be called synchronously inside the click (getDisplayMedia needs transient activation).
    on("go", "click", () => this.#goLive(this.#source()));
    on("stop", "click", () => { api()?.stop(); this.refresh(); });

    on("source", "change", () => {
      const source = this.#source();
      setSetting(SETTINGS.SOURCE, source);
      const wrap = this.el("device-wrap");
      if (wrap) wrap.hidden = source !== "device";
      if (source === "device" && !this.devices) this.loadDevices();
      if (api()?.broadcaster?.live && (source === "tab" || this.#deviceId())) this.#goLive(source);
    });
    on("device", "change", () => {
      setSetting(SETTINGS.DEVICE_ID, this.#deviceId());
      if (api()?.broadcaster?.live && this.#source() === "device" && this.#deviceId()) this.#goLive("device");
    });
    on("refresh-devices", "click", () => { this.loadDevices(); });

    on("send", "input", () => api()?.setSendLevel(Number(this.el("send").value)));
    on("monitor", "input", () => api()?.setMonitorLevel(Number(this.el("monitor").value)));
    on("fade-out", "click", () => api()?.fadeTo(0, FADE_MS));
    on("fade-in", "click", () => api()?.fadeTo(Number(getSetting(SETTINGS.SEND_LEVEL) ?? 1), FADE_MS));

    on("now-playing-input", "input", () => {
      if (this.#debounce !== null) this.scheduler.clearTimeout(this.#debounce);
      this.#debounce = this.scheduler.setTimeout(() => { this.#debounce = null; this.#commitNowPlaying(); }, NOW_PLAYING_DEBOUNCE);
    });
    on("now-playing-input", "change", () => {
      if (this.#debounce !== null) { this.scheduler.clearTimeout(this.#debounce); this.#debounce = null; }
      this.#commitNowPlaying();
    });
  }

  #source() { return this.el("source")?.value === "device" ? "device" : "tab"; }
  #deviceId() { return this.el("device")?.value ?? ""; }

  #goLive(source) {
    const api = this.getApi();
    if (!api) return;
    const opts = source === "device" ? { deviceId: this.#deviceId() } : {};
    const p = api.goLive(source, opts); // no await before this call
    Promise.resolve(p).then(() => this.refresh(), () => this.refresh());
  }

  #commitNowPlaying() {
    const text = this.el("now-playing-input")?.value ?? "";
    if (text === (getSetting(SETTINGS.NOW_PLAYING) ?? "")) return;
    this.getApi()?.setNowPlaying(text);
  }

  /** Fill the device select. Only called from an explicit user action: it may briefly open the mic. */
  async loadDevices() {
    const capture = this.getApi()?.capture;
    if (!capture) return;
    const btn = this.el("refresh-devices");
    if (btn) btn.disabled = true;
    try {
      this.devices = await capture.listDevices();
    } catch (e) {
      console.warn(LOG_PREFIX, "could not list audio devices", e);
      const code = e?.code && game.i18n.has(errorKey(e.code)) ? e.code : "failed";
      ui.notifications.error(game.i18n.localize(errorKey(code)));
    } finally {
      if (btn) btn.disabled = false;
    }
    this.refresh();
  }

  // --- level meter + stats ---------------------------------------------------------------------

  #syncMeter(live) {
    if (live && !this.#meter) this.#startMeter();
    else if (!live && this.#meter) this.#stopMeter();
  }

  #startMeter() {
    const audio = this.getAudio();
    const stream = this.getApi()?.capture?.outputStream;
    if (!audio?.startLevelReports || !stream) return;
    this.#meter = true;
    try { audio.stopLevelReports?.(METER_ID); } catch { /* none running */ }
    audio.startLevelReports(METER_ID, stream, db => {
      if (this.#disposed) return;
      if (!this.row.isConnected) { this.dispose(); return; }
      this.#paintMeter(meterLevel(db));
    }, METER_INTERVAL);
  }

  #stopMeter() {
    if (!this.#meter) return;
    this.#meter = false;
    try { this.getAudio()?.stopLevelReports?.(METER_ID); } catch { /* ignore */ }
    this.#paintMeter(0);
  }

  #paintMeter(level) {
    const bar = this.el("meter");
    if (bar) bar.style.setProperty("--ss-level", level.toFixed(3));
  }

  #syncPolling(live) {
    if (live && this.#statsTimer === null) {
      this.#statsTimer = this.scheduler.setInterval(() => this.#statsTick(), STATS_INTERVAL);
    } else if (!live && this.#statsTimer !== null) {
      this.#stopPolling();
    }
  }

  #stopPolling() {
    if (this.#statsTimer !== null) { this.scheduler.clearInterval(this.#statsTimer); this.#statsTimer = null; }
    this.stats = {};
  }

  async #statsTick() {
    if (this.#disposed) return;
    if (!this.row.isConnected) { this.dispose(); return; }
    const broadcaster = this.getApi()?.broadcaster;
    if (!broadcaster?.live) { this.#stopPolling(); return; }
    let list;
    try { list = await broadcaster.stats(); } catch { return; }
    if (this.#disposed || this.#statsTimer === null) return;
    this.stats = Object.fromEntries(list.map(i => [i.userId, i]));
    this.#applyListeners();
  }

  // --- player ----------------------------------------------------------------------------------

  #applyPlayer(m) {
    const set = (name, fn) => { const e = this.el(name); if (e) fn(e); };
    set("live-state", e => { e.textContent = m.statusLabel; e.dataset.state = m.statusKey; });
    set("mute", e => { e.checked = m.muted; });
    set("now-playing", e => { e.textContent = m.nowPlaying; });
    set("now-playing-row", e => { e.hidden = m.nowPlayingHidden; });
    set("audio-hint", e => { e.hidden = m.hintHidden; });
  }

  #bindPlayer() {
    this.el("mute")?.addEventListener("change", () => this.getApi()?.setMute(!!this.el("mute").checked));
    const audio = this.getAudio();
    if (audio?.locked) {
      Promise.resolve(audio.unlock).then(() => { this.unlocked = true; this.refresh(); }, () => {});
    }
  }
}

export class SidebarUI {
  #token = 0;
  /** @type {RowView|null} */
  view = null;

  /**
   * @param {object} o
   * @param {() => object|null} o.getApi the module api (null before "ready")
   * @param {(path:string, data:object) => Promise<string>} o.renderTemplate
   * @param {(html:string) => HTMLElement} o.toElement parses one element from HTML
   * @param {{setTimeout:Function, clearTimeout:Function, setInterval:Function, clearInterval:Function}} [o.scheduler]
   * @param {() => object} [o.getAudio]
   */
  constructor({ getApi, renderTemplate, toElement, scheduler = globalThis, getAudio = () => game.audio }) {
    this.getApi = getApi;
    this.renderTemplate = renderTemplate;
    this.toElement = toElement;
    this.scheduler = scheduler;
    this.getAudio = getAudio;
  }

  /** Hook everything up (call once, on init). */
  register() {
    Hooks.on("renderPlaylistDirectory", (app, element, context, options) => { this.onRender(app, element, context, options); });
    const refresh = () => this.refresh();
    Hooks.on(HOOKS.STATUS, refresh);
    Hooks.on(HOOKS.LIVE, refresh);
    Hooks.on(HOOKS.ENDED, refresh);
    Hooks.on("userConnected", refresh);
  }

  refresh() { this.view?.refresh(); }
  nowPlayingChanged(text) { this.view?.setNowPlaying(text); }

  /** Dispose the view when its row has left the document (full re-render, app closed). */
  sweep() {
    if (this.view && !this.view.row.isConnected) { this.view.dispose(); this.view = null; }
  }

  #role() { return game.user?.isActiveGM && this.getApi()?.broadcaster ? "gm" : "player"; }

  #isCurrent(row, role) { return !!row && this.view?.row === row && !this.view.disposed && row.dataset?.ssRole === role; }

  /**
   * renderPlaylistDirectory handler. Idempotent and safe to call for every (partial) render.
   * @returns {Promise<void>} settles when this render was handled (inserted, updated or discarded)
   */
  async onRender(app, element, context = {}, options = {}) {
    if (!element || !this.getApi()) return;
    this.sweep();
    const token = ++this.#token;
    const role = this.#role();

    const existing = element.querySelector(ROW_SELECTOR);
    if (this.#isCurrent(existing, role)) { this.view.refresh(); return; }

    const html = await this.renderTemplate(SIDEBAR_TEMPLATE, { isGM: role === "gm" });
    if (token !== this.#token) return; // a newer render overtook this one

    const present = element.querySelector(ROW_SELECTOR);
    if (this.#isCurrent(present, role)) { this.view.refresh(); return; }
    present?.remove();
    this.view?.dispose();
    this.view = null;

    const row = this.toElement(html);
    if (!row) return;
    row.id = ROW_ID;
    row.dataset.ssRole = role;
    const header = element.querySelector(HEADER_SELECTOR);
    if (header) header.after(row); else element.prepend(row);

    this.view = new RowView(row, { getApi: this.getApi, scheduler: this.scheduler, getAudio: this.getAudio });
    this.view.bind();
  }
}

/** Production wiring (Foundry globals). */
export function createSidebar(getApi) {
  const hb = () => foundry.applications.handlebars;
  return new SidebarUI({
    getApi,
    renderTemplate: (path, data) => hb().renderTemplate(path, data),
    toElement: html => {
      const tpl = document.createElement("template");
      tpl.innerHTML = html.trim();
      return tpl.content.firstElementChild;
    }
  });
}

export function preloadTemplates(templates) {
  return foundry.applications.handlebars.loadTemplates(templates);
}
