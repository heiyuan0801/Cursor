import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["core/**/*.test.ts", "sidecar/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Bound process pressure: bridge tests spawn Node subprocesses while PGlite boots WASM.
    maxWorkers: 2,
    testTimeout: 10000
  }
});
