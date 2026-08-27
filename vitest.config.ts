import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Scope coverage to the core logic. We deliberately KEEP orchestrator.ts
      // and subagent.ts in scope even though they're LLM-heavy: their
      // deterministic pockets (e.g. emptyScopeResult, the overall_pass AND) show
      // up as uncovered lines in the HTML report, which is exactly the signal
      // for "extract + unit-test this". Excluded: types.ts (declarations only)
      // and llm.ts (a thin Anthropic SDK wrapper with nothing deterministic).
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/types.ts", "src/core/llm.ts"],
    },
  },
  resolve: {
    alias: {
      "@": "/src",
      "@core": "/src/core",
    },
  },
});
