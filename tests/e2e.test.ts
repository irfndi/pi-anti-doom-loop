/**
 * E2E tests — the release pipeline as real subprocesses + tarball checks.
 *
 * These run actual `node` processes (guard script, detector self-check) and
 * inspect the packed npm artifact, so they exercise the shipped code, not
 * mocks. Network-dependent guard branches are avoided (version mismatch and
 * invalid-semver paths fail before any registry fetch).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, readdir, mkdir, copyFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const REPO = new URL("..", import.meta.url).pathname;

async function node(args: string[], cwd = REPO, env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await run("node", args, { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function npm(args: string[], cwd = REPO, env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await run("npm", args, { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("e2e: detector self-check subprocess", () => {
  it("exits 0 and reports all assertions passed", async () => {
    const { code, stdout } = await node(["extensions/detector.ts"]);
    assert.equal(code, 0);
    assert.match(stdout, /detector self-check: all assertions passed/);
  });
});

describe("e2e: version guard subprocess", () => {
  it("fails (exit 1) on a version mismatch without touching the network", async () => {
    const { code, stderr, stdout } = await node(["scripts/guard-publish.ts", "v9.9.9"]);
    assert.equal(code, 1, "mismatched expected version must fail");
    assert.match(stderr + stdout, /GUARD FAIL: expected "9.9.9"/);
  });

  it("fails (exit 1) on a non-semver package version", async () => {
    // Mirror the repo layout in a temp dir with a VALID manifest whose
    // version is not semver (Node refuses to run at all on invalid JSON, so
    // the reachable guard branch is the semver check).
    const dir = await mkdtemp(join(tmpdir(), "guard-e2e-"));
    await mkdir(join(dir, "scripts"), { recursive: true });
    await copyFile(
      join(REPO, "scripts", "guard-publish.ts"),
      join(dir, "scripts", "guard-publish.ts"),
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", version: "not-semver" }),
    );
    await symlink(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    const { code, stderr } = await node(["scripts/guard-publish.ts"], dir);
    assert.equal(code, 1);
    assert.match(stderr, /GUARD FAIL: package.json version "not-semver" is not a semver/);
  });
});

describe("e2e: published artifact", () => {
  it("npm pack --dry-run includes extensions, scripts and the pi manifest", async () => {
    const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));

    // files whitelist must cover every runtime/script source dir.
    for (const dir of ["extensions", "scripts"]) {
      assert.ok(pkg.files.includes(dir), `files must include ${dir}`);
    }
    // pi manifest + keyword gate.
    assert.ok(
      pkg.pi?.extensions?.includes("./extensions"),
      "pi manifest must point at ./extensions",
    );
    assert.ok(pkg.keywords.includes("pi-package"), "pi-package keyword gate must be present");
    assert.equal(pkg.publishConfig?.access, "public");
    assert.equal(pkg.engines?.node, ">=22.18");

    // Dry-run pack and confirm the tarball really contains the entrypoints.
    // --ignore-scripts: npm pack runs prepublishOnly (= npm run check), which
    // would recursively invoke this test suite.
    const { code, stdout } = await npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    assert.equal(code, 0);
    // npm 12 returns an object keyed by package name instead of an array.
    const parsed = JSON.parse(stdout.trim());
    const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const files: string[] = pack.files.map((f: { path: string }) => f.path);
    for (const expected of [
      "extensions/index.ts",
      "extensions/controller.ts",
      "extensions/detector.ts",
      "scripts/guard-publish.ts",
      "package.json",
      "README.md",
      "LICENSE",
    ]) {
      assert.ok(files.includes(expected), `tarball must contain ${expected}`);
    }
  });

  it("test files and review tool state are excluded from the tarball", async () => {
    const { code, stdout } = await npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    assert.equal(code, 0);
    // npm 12 returns an object keyed by package name instead of an array.
    const parsed = JSON.parse(stdout.trim());
    const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const files: string[] = pack.files.map((f: { path: string }) => f.path);
    assert.ok(
      !files.some((f: string) => f.includes("/tests/") || f.startsWith("tests/")),
      "tests must not ship",
    );
    assert.ok(!files.some((f: string) => f.includes(".clawpatch")), "review state must not ship");
  });
});

describe("e2e: quality gate scripts are wired", () => {
  it("package.json scripts cover test/check/lint/format/guard/prepublish", () => {
    return readFile(join(REPO, "package.json"), "utf8").then((raw) => {
      const pkg = JSON.parse(raw);
      for (const script of ["test", "check", "lint", "format", "guard", "prepublishOnly"]) {
        assert.ok(pkg.scripts[script], `script ${script} must exist`);
      }
      assert.match(pkg.scripts.test, /node --test/);
      assert.match(pkg.scripts.check, /oxlint --deny-warnings/);
      assert.match(pkg.scripts.prepublishOnly, /npm run check/);
    });
  });

  it("test directory contains the expected suites", async () => {
    const files = await readdir(join(REPO, "tests"));
    for (const expected of [
      "unit.test.ts",
      "fixture.test.ts",
      "fuzz.test.ts",
      "integration.test.ts",
      "e2e.test.ts",
    ]) {
      assert.ok(files.includes(expected), `tests must include ${expected}`);
    }
  });
});
