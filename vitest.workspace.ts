import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      environment: "node",
      // Credential isolation (see the setup file): runs before any test module
      // is imported, which is the only point early enough to beat module-level
      // ambient-key reads.
      setupFiles: ["./tests/setup/scrub-credentials.ts"],
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
      setupFiles: ["./tests/setup/scrub-credentials.ts"],
      include: ["tests/integration/**/*.test.ts"],
      testTimeout: 180_000,
      hookTimeout: 180_000,
      // Browser-driven tests share one lab server; keep them serial.
      pool: "forks",
      poolOptions: { forks: { singleFork: true } }
    }
  }
]);
