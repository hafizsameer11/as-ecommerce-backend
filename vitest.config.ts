import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // one MySQL test database → run files one after another
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
