import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = p => JSON.parse(readFileSync(join(root, p), "utf8"));
const manifest = readJson("module.json");

const keyset = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) => {
  const key = prefix ? `${prefix}.${k}` : k;
  return v && typeof v === "object" ? keyset(v, key) : [key];
}).sort();

test("module.json parses and id matches package.json name", () => {
  assert.equal(typeof manifest, "object");
  assert.equal(manifest.id, readJson("package.json").name);
});

test("module uses the module socket", () => {
  assert.equal(manifest.socket, true);
});

test("every language file exists and parses", () => {
  assert.ok(manifest.languages.length >= 2);
  for (const l of manifest.languages) {
    assert.ok(existsSync(join(root, l.path)), `missing ${l.path}`);
    assert.doesNotThrow(() => readJson(l.path), `${l.path} is not valid JSON`);
  }
});

test("en and pt-BR have identical key sets", () => {
  assert.deepEqual(keyset(readJson("lang/pt-BR.json")), keyset(readJson("lang/en.json")));
});

test("esmodules and styles exist", () => {
  for (const f of [...manifest.esmodules, ...manifest.styles]) {
    assert.ok(existsSync(join(root, f)), `missing ${f}`);
  }
});
