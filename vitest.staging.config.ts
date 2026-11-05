import { defineConfig } from "vitest/config";

// Runs outside the Workers runtime, against a real SweatStack. See test/fake-check/staging.test.ts.
export default defineConfig({
  test: { include: ["test/fake-check/staging.test.ts"], testTimeout: 30_000 },
});
