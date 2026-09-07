import { effectNative, recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

// `effect` is used in exactly one place: scripts/guard-publish.ts, a standalone
// CLI guard that uses Effect purely for its typed error channel.
//
// The `effectNative` category is intentionally turned off. It prescribes
// routing ALL IO through Effect services (HttpClient, FileSystem, Effect.log,
// Effect.gen). That is the right discipline for an Effect library, but it is
// over-engineering for a CLI script whose OS boundary is plain fetch/readFile/
// console — and it produces false positives in the tests and the pi extension,
// which never touch Effect. correctness + antipattern + style stay on.
const effectNativeOff = Object.fromEntries(
  Object.keys(effectNative.rules).map((rule) => [rule, "off"]),
);

export default defineConfig({
  extends: [recommended],
  ignorePatterns: [".clawpatch/**", ".deepsec/**", "tools/oxlint/anti-slop/**"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "eslint/complexity": ["error", { max: 10 }],
  },
  overrides: [
    {
      files: ["**/*"],
      rules: effectNativeOff,
    },
  ],
});
