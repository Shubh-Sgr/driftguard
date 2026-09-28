import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share two Docker databases and create/drop scratch copies of
    // them, so test files must not run at the same time.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
