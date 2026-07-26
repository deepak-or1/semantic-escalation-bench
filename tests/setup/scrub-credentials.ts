/**
 * CREDENTIAL ISOLATION FOR THE TEST SUITE — registered as a `setupFiles` entry
 * for BOTH vitest projects, so it runs before any test module is imported.
 *
 * The incident this fixes: `pnpm test` consumed a live provider key during an
 * external audit. Two suites read ambient key presence AT MODULE LOAD
 * (tests/integration/stagehand-live.test.ts, tests/integration/benchmark.test.ts)
 * and light up live, paid trials when one is found. A per-file `beforeAll` scrub
 * runs far too late — the module-level `const hasKey = ...` has already been
 * evaluated by then. Only a global setup file runs early enough.
 *
 * WHY THE VARS ARE SET TO "" RATHER THAN ONLY DELETED. Parts of the test path
 * import modules that do `import "dotenv/config"` (scripts/verify-suite.ts and
 * scripts/run-campaign-2b.ts, both imported by integration tests), and that
 * import runs AFTER this setup file. dotenv does not overwrite a variable that
 * is already set, but it will happily populate one that has been deleted — so a
 * plain `delete` would be silently undone by the project's own .env. Assigning
 * the empty string is both: it is falsy everywhere the config layer reads it
 * (packages/agent/src/core/config.ts treats "" exactly as absent), and it is
 * "set" as far as dotenv is concerned, so a later .env load cannot repopulate it.
 * The file's contents are never read here.
 *
 * ESCAPE HATCH: RUN_LIVE_KEYED_TESTS=1 opts back in, deliberately explicit and
 * deliberately not the default. The two ambient-gated suites ALSO require that
 * flag in their own skipIf, so an ordering regression in this file can never on
 * its own be enough to start spending money.
 */

/**
 * Every provider/model variable `loadAgentEnvConfig` consults
 * (packages/agent/src/core/config.ts:20-30) — the authoritative list, taken from
 * the code rather than from memory.
 */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "STAGEHAND_MODEL",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSERBASE_CONTEXT_ID"
] as const;

/** True when the operator has explicitly opted into live, paid test runs. */
export function liveKeyedTestsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RUN_LIVE_KEYED_TESTS === "1";
}

/** Neutralise every credential variable. Idempotent; never reads their values. */
export function scrubCredentials(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of CREDENTIAL_ENV_VARS) {
    delete env[name];
    // …and re-assert as empty so a later `dotenv/config` import cannot refill it.
    env[name] = "";
  }
}

if (!liveKeyedTestsRequested()) scrubCredentials();
