import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    env: {
      NODE_ENV: "test",
      AUTH_PROVIDER: "local",
      PAYMENT_PROVIDER: "demo",
      STORAGE_PROVIDER: "local",
      LOCAL_JWT_SECRET: "test-only-secret-that-is-longer-than-thirty-two-characters",
      PGLITE_DATA_DIR: "memory://",
      DATABASE_URL: "",
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
