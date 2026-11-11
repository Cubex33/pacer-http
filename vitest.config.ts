import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["src/**"],
      // types.ts is pure type declarations: it compiles to zero runtime
      // code, so no line in it can ever execute under v8 coverage.
      exclude: ["src/**/*.d.ts", "src/types.ts"],
      thresholds: {
        lines: 90,
      },
    },
  },
});
