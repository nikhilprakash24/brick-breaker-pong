import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // AI matches and soaks forward-simulate tens of thousands of ticks; the
    // default 5 s is too tight for the deterministic heavy suites.
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
