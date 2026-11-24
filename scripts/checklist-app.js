/** ApplicationV2 "Setup checklist" window, opened from the module settings (GM only). */
import { MODULE_ID, SETTINGS, CHECKLIST_TEMPLATE } from "./constants.js";
import { Capture } from "./capture.js";
import { runChecks, buildChecklistView, readEnvironment } from "./checklist.js";

const i18n = () => ({ t: k => game.i18n.localize(k), f: (k, d) => game.i18n.format(k, d) });
const api = () => game.modules.get(MODULE_ID)?.api;

/** Built lazily: ApplicationV2 only exists inside Foundry. */
export function createChecklistApp() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class SetupChecklist extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "sargas-soundtrack-checklist",
      classes: ["sargas-soundtrack"],
      tag: "div",
      window: { title: "SARGAS_SOUNDTRACK.Checklist.Title", icon: "fa-solid fa-list-check", resizable: true },
      position: { width: 520 },
      actions: {
        // ApplicationV2 calls actions with `this` = the application instance.
        checkDevices() { return this.checkDevices(); },
        sendTone() { return this.sendTone(); },
        recheck() { return this.render(); }
      }
    };

    static PARTS = { main: { template: CHECKLIST_TEMPLATE } };

    devices = null;
    devicesError = false;

    async _prepareContext(options) {
      const context = await super._prepareContext?.(options) ?? {};
      return { ...context, ...this.buildView() };
    }

    buildView() {
      const get = key => game.settings.get(MODULE_ID, key);
      const checks = runChecks(readEnvironment(), {
        source: get(SETTINGS.SOURCE), deviceId: get(SETTINGS.DEVICE_ID), devices: this.devices, devicesError: this.devicesError
      });
      return buildChecklistView(checks, i18n());
    }

    /** Only on a button press: listing devices may briefly open the microphone. */
    async checkDevices() {
      const capture = api()?.capture ?? new Capture();
      try {
        this.devices = await capture.listDevices();
        this.devicesError = false;
      } catch {
        this.devices = null;
        this.devicesError = true;
      }
      return this.render();
    }

    async sendTone() {
      await api()?.testTone(10);
    }
  };
}
