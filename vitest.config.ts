import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/auth/**/*.ts",
        "src/github/**/*.ts",
        "src/settings.ts",
        "src/sync/**/*.ts",
        "src/utils/**/*.ts"
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 80,
        lines: 80
      }
    }
  }
});
