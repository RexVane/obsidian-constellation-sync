import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [manifest, packageJson, packageLock, versions] = await Promise.all([
  readJson("manifest.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("versions.json")
]);

const version = manifest.version;
const expectedTag = process.argv[2] || process.env.RELEASE_TAG;
const assertions = [
  [typeof version === "string" && version.length > 0, "manifest.json must contain a version"],
  [packageJson.version === version, "package.json version must match manifest.json"],
  [packageLock.version === version, "package-lock.json version must match manifest.json"],
  [packageLock.packages?.[""]?.version === version, "package-lock root package version must match manifest.json"],
  [versions[version] === manifest.minAppVersion, "versions.json must map the release to manifest.minAppVersion"],
  [!expectedTag || expectedTag === version, "release tag must match manifest.json"]
];

const failures = assertions.filter(([valid]) => !valid).map(([, message]) => message);
if (failures.length > 0) throw new Error(failures.join("; "));

console.log(`Release metadata is consistent for ${version}.`);
