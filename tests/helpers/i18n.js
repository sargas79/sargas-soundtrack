/** Strict i18n over lang/en.json: throws on a missing key, so tests catch typos in lang keys. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const loadLang = name => JSON.parse(readFileSync(join(root, "lang", `${name}.json`), "utf8"));

export const flatKeys = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) => {
  const key = prefix ? `${prefix}.${k}` : k;
  return v && typeof v === "object" ? flatKeys(v, key) : [[key, v]];
});

export function strictI18n(name = "en") {
  const dict = new Map(flatKeys(loadLang(name)));
  const t = key => {
    if (!dict.has(key)) throw new Error(`missing lang key: ${key}`);
    return dict.get(key);
  };
  const f = (key, data = {}) => t(key).replace(/\{(\w+)\}/g, (_, k) => String(data[k]));
  return { t, f, has: key => dict.has(key), keys: [...dict.keys()] };
}
