import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": "./worker/test-cloudflare-workers.ts",
      // The sidecar ships as a Bun binary and its tests import `bun:test`, but they only use
      // the describe/test/expect trio that Vitest provides identically. Aliasing keeps
      // `bun test` working for sidecar development while letting `npm test` — the only suite
      // most contributors and CI run — actually cover the sidecar.
      "bun:test": "vitest"
    }
  },
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "sidecar/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 10000
  }
});
