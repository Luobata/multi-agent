import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/web/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    reporters: ["./e2e/support/reporter.ts"]
  },
  ssr: {
    external: ["@silvia-odwyer/photon"]
  }
});
