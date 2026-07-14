import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      environment: "node",
      include: [
        "packages/**/src/**/*.test.ts",
        "apps/**/src/**/*.test.ts"
      ]
    }
  },
  {
    test: {
      name: "integration",
      environment: "node",
      include: ["tests/integration/**/*.test.ts"],
      testTimeout: 180_000,
      hookTimeout: 180_000,
      // Browser-driven tests share one lab server; keep them serial.
      pool: "forks",
      poolOptions: { forks: { singleFork: true } }
    }
  }
]);
