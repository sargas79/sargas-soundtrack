#!/usr/bin/env node
/**
 * Sanity checks run in CI and before release:
 *  - module.json is valid and has the fields Foundry needs
 *  - the module socket is enabled (the WebRTC handshake travels over it)
 *  - every file the manifest references exists
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const note = (msg) => problems.push(msg);

let manifest;
try { manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8")); }
catch (e) { console.error(`module.json is not valid JSON: ${e.message}`); process.exit(1); }

for (const field of ["id", "title", "description", "version", "authors", "url", "manifest", "download", "esmodules", "languages"]) {
  if (manifest[field] === undefined) note(`module.json: missing "${field}"`);
}
if (!manifest.compatibility?.minimum) note('module.json: missing "compatibility.minimum"');
if (!manifest.compatibility?.verified) note('module.json: missing "compatibility.verified"');
if (manifest.id !== "sargas-soundtrack") note(`module.json: id must be "sargas-soundtrack" (is "${manifest.id}")`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) note(`module.json: version "${manifest.version}" is not semver`);
if (manifest.socket !== true) note("module.json: socket must be true (WebRTC signalling uses the module socket)");

const referenced = [
  ...(manifest.esmodules ?? []),
  ...(manifest.styles ?? []),
  ...(manifest.languages ?? []).map(l => l.path),
  manifest.readme, manifest.license
].filter(Boolean);
for (const f of referenced) if (!existsSync(join(root, f))) note(`module.json references missing file: ${f}`);

try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== manifest.version) note(`package.json version ${pkg.version} differs from module.json version ${manifest.version}`);
} catch (e) { note(`package.json unreadable: ${e.message}`); }
if (manifest.download && !manifest.download.includes(`/v${manifest.version}/`)) note(`module.json download URL does not name version ${manifest.version}: ${manifest.download}`);

if (problems.length) {
  console.error(`check-manifest: ${problems.length} problem(s)`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`check-manifest: ok (${referenced.length} referenced files present)`);
