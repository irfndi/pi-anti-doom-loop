/**
 * Version bump guard — the consistency gate before `npm publish`.
 *
 * Fails (exit 1) unless BOTH hold:
 *   1. The package.json version is NOT already the latest published on npm
 *      (npm never overwrites a published version; re-releasing the same
 *      version is a no-op at best and a dishonest release at worst).
 *   2. If an expected version is passed (e.g. a tag like v0.0.1), it matches
 *      the package.json version — so tags and manifests can't drift.
 *
 * Usage:
 *   node scripts/guard-publish.mjs            # keep published version < local
 *   node scripts/guard-publish.mjs v0.0.1     # also require local == 0.0.1
 *
 * Exits 0 and prints the exact `version` to publish; the workflow uses that.
 */
import { readFile } from "node:fs/promises";

/** @type {{ name: string, version: string }} */
let pkg;
try {
  pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
} catch {
  console.error("GUARD FAIL: could not read valid JSON from package.json");
  process.exit(1);
}
const local = pkg.version;
const expected = (process.argv[2] ?? "").replace(/^v/, ""); // tolerate "v0.0.1"

if (!/^\d+\.\d+\.\d+$/.test(local)) {
  console.error(`GUARD FAIL: package.json version "${local}" is not a semver X.Y.Z.`);
  process.exit(1);
}

let published = null;
try {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
    headers: { accept: "application/json" },
  });
  if (res.ok) published = (await res.json()).version;
} catch {
  console.warn("GUARD WARN: could not reach the npm registry; skipping published-version check.");
}

if (expected && expected !== local) {
  console.error(
    `GUARD FAIL: expected "${expected}" (tag/input) does not match package.json version "${local}". ` +
      `Bump package.json to ${expected}, or tag ${local}.`,
  );
  process.exit(1);
}
if (published === local) {
  console.error(
    `GUARD FAIL: ${pkg.name}@${local} is already published on npm. ` +
      `Bump the version in package.json to cut a new release.`,
  );
  process.exit(1);
}

console.log(
  `GUARD OK: publishing ${pkg.name}@${local}` +
    (published ? ` (latest on npm: ${published})` : " (first publish — not on npm yet)"),
);
