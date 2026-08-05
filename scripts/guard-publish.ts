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
 * Implemented with Effect v4: each fallible step (read, parse, fetch, guard
 * rules) lives in the typed error channel, so failures short-circuit with a
 * clean GUARD FAIL message and exit code 1.
 *
 * Usage:
 *   node scripts/guard-publish.ts            # keep published version < local
 *   node scripts/guard-publish.ts v0.0.1     # also require local == 0.0.1
 */
import { Effect } from "effect";
import { readFile } from "node:fs/promises";

interface GuardError {
  message: string;
}

interface Manifest {
  name: string;
  version: string;
}

const fail = (message: string): Effect.Effect<never, GuardError> => Effect.fail({ message });

const readManifest: Effect.Effect<string, GuardError> = Effect.tryPromise({
  try: () => readFile(new URL("../package.json", import.meta.url), "utf8"),
  catch: () => ({ message: "GUARD FAIL: could not read package.json" }),
});

const parseManifest = (raw: string): Effect.Effect<Manifest, GuardError> => {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    return Effect.fail({ message: "GUARD FAIL: package.json is not valid JSON" });
  }
  return Effect.succeed(manifest);
};
const semverLike = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);

/**
 * Whether a git tag `v<version>` exists in the current checkout. On the
 * manual-dispatch path no tag is pushed, so this closes the tag/sync gap.
 */
const tagExists = (version: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      try {
        const { stdout } = await run("git", ["tag", "-l", `v${version}`], { cwd: process.cwd() });
        return stdout.trim().length > 0;
      } catch {
        return false; // no git repo / git missing → treat as no tag
      }
    },
    catch: () => false,
  });
/**
 * Latest published version on npm, or null when the package was never
 * published or the registry is unreachable (warn-only on network failure —
 * `npm publish` remains the real gate).
 */
const fetchPublished = (name: string): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return ((await res.json()) as { version?: string }).version ?? null;
    },
    catch: () => {
      console.warn(
        "GUARD WARN: could not reach the npm registry; skipping published-version check.",
      );
      return new Error("registry unreachable");
    },
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const program: Effect.Effect<string, GuardError> = Effect.gen(function* () {
  const raw = yield* readManifest;
  const pkg = yield* parseManifest(raw);
  const local = pkg.version;
  const expected = (process.argv[2] ?? "").replace(/^v/, ""); // tolerate "v0.0.1"

  if (!semverLike(local)) {
    yield* fail(`GUARD FAIL: package.json version "${local}" is not a semver X.Y.Z.`);
  }
  if (expected && expected !== local) {
    yield* fail(
      `GUARD FAIL: expected "${expected}" (tag/input) does not match package.json version "${local}". ` +
        `Bump package.json to ${expected}, or tag ${local}.`,
    );
  }

  const published = yield* fetchPublished(pkg.name);
  if (published === local) {
    yield* fail(
      `GUARD FAIL: ${pkg.name}@${local} is already published on npm. ` +
        `Bump the version in package.json to cut a new release.`,
    );
  }

  // On the manual-dispatch path no tag is pushed, so require the version to
  // exist as a git tag — keeps the tag/manifest-sync invariant on both entry
  // points (clawpatch finding).
  if (expected && (yield* tagExists(expected)) === false) {
    yield* fail(
      `GUARD FAIL: expected version "${expected}" has no matching git tag v${expected}. Tag it first.`,
    );
  }

  return (
    `GUARD OK: publishing ${pkg.name}@${local}` +
    (published ? ` (latest on npm: ${published})` : " (first publish — not on npm yet)")
  );
});

interface Outcome {
  ok: boolean;
  message: string;
}

const outcome: Outcome = await Effect.runPromise(
  Effect.match(program, {
    onFailure: (error: GuardError): Outcome => ({ ok: false, message: error.message }),
    onSuccess: (message: string): Outcome => ({ ok: true, message }),
  }),
);

if (!outcome.ok) {
  console.error(outcome.message);
  process.exit(1);
}
console.log(outcome.message);
