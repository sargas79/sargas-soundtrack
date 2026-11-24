/** Setup-checklist checks as pure functions of a plain environment snapshot (no Foundry, no DOM). */

const K = "SARGAS_SOUNDTRACK.Checklist";

/** @typedef {"pass"|"warn"|"info"} CheckStatus  info = static reminder or not checked yet */

/** Chromium-based = Chrome, Edge, Brave, Opera, etc. (client hints when present, user agent otherwise). */
export function isChromiumBased({ userAgent = "", brands = [] } = {}) {
  if (brands.some(b => /chromium/i.test(b?.brand ?? ""))) return true;
  return /\bChrome\/|\bChromium\//.test(userAgent) && !/Firefox\//.test(userAgent);
}

export function checkSecureContext({ isSecureContext }) {
  return { id: "secure", status: isSecureContext ? "pass" : "warn", titleKey: `${K}.Secure.Title`, detailKey: `${K}.Secure.${isSecureContext ? "Pass" : "Warn"}` };
}

export function checkTabCapture({ userAgent = "", brands = [], hasGetDisplayMedia = false }) {
  const base = { id: "browser", titleKey: `${K}.Browser.Title` };
  if (/Firefox\//.test(userAgent)) return { ...base, status: "warn", detailKey: `${K}.Browser.Firefox` };
  if (!isChromiumBased({ userAgent, brands })) return { ...base, status: "warn", detailKey: `${K}.Browser.Other` };
  if (!hasGetDisplayMedia) return { ...base, status: "warn", detailKey: `${K}.Browser.NoApi` };
  return { ...base, status: "pass", detailKey: `${K}.Browser.Pass` };
}

/**
 * @param {{source:string, deviceId:string, devices:{deviceId:string,label:string}[]|null, devicesError?:boolean}} s
 *        `devices` is null until the GM pressed "Check devices".
 */
export function checkSource({ source, deviceId, devices, devicesError = false }) {
  const base = { id: "source", titleKey: `${K}.Source.Title` };
  if (source !== "device") return { ...base, status: "pass", detailKey: `${K}.Source.Tab` };
  if (!deviceId) return { ...base, status: "warn", detailKey: `${K}.Source.DeviceNone`, action: "checkDevices" };
  if (devicesError) return { ...base, status: "warn", detailKey: `${K}.Source.DeviceError`, action: "checkDevices" };
  if (!devices) return { ...base, status: "info", detailKey: `${K}.Source.DeviceUnchecked`, action: "checkDevices" };
  const found = devices.find(d => d.deviceId === deviceId);
  return found
    ? { ...base, status: "pass", detailKey: `${K}.Source.DeviceFound`, detailData: { label: found.label }, action: "checkDevices" }
    : { ...base, status: "warn", detailKey: `${K}.Source.DeviceMissing`, action: "checkDevices" };
}

export const checkHeadphones = () => ({ id: "headphones", status: "info", titleKey: `${K}.Headphones.Title`, detailKey: `${K}.Headphones.Detail` });
export const checkTone = () => ({ id: "tone", status: "info", titleKey: `${K}.Tone.Title`, detailKey: `${K}.Tone.Detail`, action: "sendTone" });

/** Static troubleshooting notes shown under the checks (keys only). */
export const NOTE_KEYS = Object.freeze(["Muted", "VbDefaults", "Discord", "Routing", "Headphones"].map(k => `${K}.Notes.${k}`));

/**
 * @param {{isSecureContext:boolean, userAgent:string, brands:{brand:string}[], hasGetDisplayMedia:boolean}} env
 * @param {{source:string, deviceId:string, devices:object[]|null, devicesError?:boolean}} source
 */
export function runChecks(env, source) {
  return [checkSecureContext(env), checkTabCapture(env), checkSource(source), checkHeadphones(), checkTone()];
}

const ACTION_LABEL = { checkDevices: "CheckDevices", sendTone: "SendTone" };

/** Localised data for checklist.hbs. */
export function buildChecklistView(checks, { t, f }) {
  return {
    checks: checks.map(c => ({
      id: c.id,
      status: c.status,
      statusLabel: t(`${K}.Status.${c.status}`),
      title: t(c.titleKey),
      detail: c.detailData ? f(c.detailKey, c.detailData) : t(c.detailKey),
      action: c.action ?? null,
      actionLabel: c.action ? t(`${K}.${ACTION_LABEL[c.action]}`) : null
    })),
    notesTitle: t(`${K}.Notes.Title`),
    notes: NOTE_KEYS.map(k => t(k)),
    recheckLabel: t(`${K}.Recheck`)
  };
}

/** Snapshot of the browser (impure; the only function here touching globals). */
export function readEnvironment(g = globalThis) {
  const nav = g.navigator ?? {};
  return {
    isSecureContext: !!g.isSecureContext,
    userAgent: nav.userAgent ?? "",
    brands: nav.userAgentData?.brands ?? [],
    hasGetDisplayMedia: typeof nav.mediaDevices?.getDisplayMedia === "function"
  };
}
