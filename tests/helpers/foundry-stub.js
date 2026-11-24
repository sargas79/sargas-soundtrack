/**
 * Minimal Foundry stub for node tests. Install with `installFoundryStub()` and
 * remove with the returned `uninstall()`. Later tests extend it as needed.
 */
import { MODULE_ID } from "../../scripts/constants.js";

class HooksStub {
  #handlers = new Map();
  #next = 1;
  calls = [];
  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Map());
    const id = this.#next++;
    this.#handlers.get(name).set(id, fn);
    return id;
  }
  once(name, fn) { return this.on(name, (...a) => { fn(...a); }); }
  off(name, id) { this.#handlers.get(name)?.delete(id); }
  callAll(name, ...args) {
    this.calls.push({ name, args });
    for (const fn of this.#handlers.get(name)?.values() ?? []) fn(...args);
    return true;
  }
  call(name, ...args) { return this.callAll(name, ...args); }
  listenerCount(name) { return this.#handlers.get(name)?.size ?? 0; }
}

/** Fake game.socket: records emits, lets tests deliver incoming messages. */
export class FakeSocket {
  emitted = [];
  handlers = new Map();
  emit(channel, payload, options) { this.emitted.push({ channel, payload: structuredClone(payload), options }); }
  on(channel, fn) { if (!this.handlers.has(channel)) this.handlers.set(channel, []); this.handlers.get(channel).push(fn); }
  /** Simulate the server delivering a message from `senderId`. */
  deliver(channel, payload, senderId) { for (const fn of this.handlers.get(channel) ?? []) fn(structuredClone(payload), senderId); }
  sent(type) { return this.emitted.filter(e => e.payload.type === type); }
  clear() { this.emitted.length = 0; }
}

export function installFoundryStub({ users = [{ id: "gm1", isGM: true, active: true }], currentUserId = "gm1", activeGMId } = {}) {
  const prev = {};
  const keep = (k, v) => { prev[k] = globalThis[k]; globalThis[k] = v; };

  const hooks = new HooksStub();
  const notifications = [];
  const settings = new Map();
  const onChanges = new Map();
  const menus = new Map();

  const userDocs = new Map();
  for (const u of users) userDocs.set(u.id, { id: u.id, name: u.name ?? u.id, isGM: !!u.isGM, active: u.active !== false });

  const gm = activeGMId !== undefined
    ? userDocs.get(activeGMId)
    : [...userDocs.values()].find(u => u.isGM && u.active) ?? null;
  for (const u of userDocs.values()) Object.defineProperty(u, "isActiveGM", { get: () => userDocs.activeGM?.id === u.id, enumerable: true });
  userDocs.activeGM = gm ?? null;

  const socket = new FakeSocket();
  const game = {
    user: userDocs.get(currentUserId),
    users: userDocs,
    socket,
    settings: {
      register(ns, key, data) {
        if (!settings.has(`${ns}.${key}`)) settings.set(`${ns}.${key}`, structuredClone(data.default));
        if (data.onChange) onChanges.set(`${ns}.${key}`, data.onChange);
      },
      registerMenu(ns, key, data) { menus.set(`${ns}.${key}`, data); },
      get(ns, key) { return structuredClone(settings.get(`${ns}.${key}`)); },
      async set(ns, key, value) {
        settings.set(`${ns}.${key}`, structuredClone(value));
        onChanges.get(`${ns}.${key}`)?.(value);
        return value;
      }
    },
    modules: new Map([[MODULE_ID, { id: MODULE_ID, active: true, version: "0.0.0-test" }]]),
    i18n: {
      has: () => true,
      localize: k => k,
      format: (k, d) => `${k}${d ? " " + JSON.stringify(d) : ""}`
    }
  };

  keep("game", game);
  keep("Hooks", hooks);
  keep("ui", { notifications: { info: m => notifications.push(["info", m]), warn: m => notifications.push(["warn", m]), error: m => notifications.push(["error", m]) } });
  const rendered = [];
  const preloaded = [];
  class FakeApplicationV2 {
    static DEFAULT_OPTIONS = {};
    renders = 0;
    async _prepareContext() { return {}; }
    async render() { this.renders++; return this; }
  }
  keep("foundry", {
    utils: { randomID: (n = 16) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, "x") },
    applications: {
      api: { ApplicationV2: FakeApplicationV2, HandlebarsApplicationMixin: Base => class extends Base {} },
      handlebars: {
        renderTemplate: async (path, data) => { rendered.push({ path, data }); return `<section data-template="${path}"></section>`; },
        loadTemplates: async paths => { preloaded.push(...paths); }
      }
    }
  });

  return {
    game, hooks, settings, notifications, socket, menus, rendered, preloaded,
    setActiveGM(id) { userDocs.activeGM = userDocs.get(id) ?? null; },
    setUser(id) { game.user = userDocs.get(id); },
    uninstall() { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
  };
}
