import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // [fork] scrypt password hashing takes ~1.2 s per call.
    testTimeout: 30000,
    alias: {
      "~/src": resolve(__dirname, "./src"),
    },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
