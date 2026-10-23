const fs = require("node:fs");
const path = require("node:path");

const backend = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(backend, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(backend, "package-lock.json"), "utf8"));
const packages = Object.entries(lock.packages).filter(([location]) => location !== "");
const direct = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).map(([name, requested]) => {
  const entry = lock.packages[`node_modules/${name}`] || {};
  return { name, requested, installed: entry.version || null, license: entry.license || "UNRECORDED", development: Object.hasOwn(manifest.devDependencies || {}, name) };
});
const report = {
  schemaVersion: 1,
  note: "Lockfile metadata inventory, not a license clearance, vulnerability scan or certified SBOM. No application or provider code executed.",
  toolchain: { node: process.version, npm: manifest.packageManager, engines: manifest.engines },
  lockfileVersion: lock.lockfileVersion,
  packageLocations: packages.length,
  direct: direct.sort((a, b) => a.name.localeCompare(b.name)),
  deprecated: packages.filter(([, entry]) => entry.deprecated).map(([location, entry]) => ({ location, version: entry.version, reason: entry.deprecated })),
  unrecordedLicense: packages.filter(([, entry]) => !entry.license).map(([location, entry]) => ({ location, version: entry.version })),
  installScriptLocations: packages.filter(([, entry]) => entry.hasInstallScript).map(([location]) => location),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
