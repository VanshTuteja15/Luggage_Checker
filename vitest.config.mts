import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Pages are rendered in the plain-text scan (A5.2): the same JSX runtime as Next.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Network is never touched by unit tests: adapters get recorded fixtures.
    testTimeout: 20_000,
  },
});
