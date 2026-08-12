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
  overrides: [
    {
      files: ["**/*"],
      rules: effectNativeOff,
    },
  ],
});
