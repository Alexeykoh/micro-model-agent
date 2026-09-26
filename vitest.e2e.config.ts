import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e-test.ts"],
    testTimeout: 120000,
    hookTimeout: 60000,
    // Each file boots its own `mma web` server + Chromium: run files
    // sequentially so they never contend for CPU/ports and flake on timeouts.
    maxWorkers: 1,
  },
});
