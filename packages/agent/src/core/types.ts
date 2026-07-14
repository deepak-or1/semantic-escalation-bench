import type {
  EngineName,
  FailureCategory,
  PipelineResult,
  RunLogger,
  SessionMode,
  StepResult,
  TokensUsage
} from "@ssda/shared";

export interface Credentials {
  username: string;
  password: string;
}

export interface SessionSetup {
  /**
   * fresh: start with no cookies.
   * reuse: load cookies from stateFile (expected to still be valid).
   * expired: load cookies from stateFile (server has invalidated them; the
   * pipeline must detect the bounce and log in again).
   */
  mode: SessionMode;
  stateFile?: string;
}

export interface PipelineOptions {
  labUrl: string;
  pages: Array<"stats" | "odds">;
  credentials: Credentials;
  session: SessionSetup;
  runId: string;
  /** Directory for this run's artifacts (raw/, artifacts/, normalized.json). */
  runDir: string;
  logger: RunLogger;
  scenarioId?: string;
  seed?: number;
  headless: boolean;
  /** Whole-pipeline attempts; 2 means one recovery retry. */
  maxAttempts: number;
  navTimeoutMs: number;
  stepTimeoutMs: number;
  /** Stagehand engine only; the baseline always runs a local browser. */
  env: "local" | "browserbase";
  /** When set, persist the session cookies here after a successful run. */
  saveSessionStateTo?: string;
  /**
   * Freeze the hybrid engine's deterministic tier (--no-repair): when true it
   * NEVER invokes the LLM repair path (observe/extract) even if a model key is
   * present — behaviourally identical to keyless, but explicit and reproducible.
   * The baseline and stagehand engines ignore this flag.
   */
  disableRepair?: boolean;
  /**
   * Warm-cache seeding (--seed-cache <path>): a path to a healed-cache.json
   * artifact (the same shape the hybrid engine persists after a repair). When
   * set, the hybrid engine loads it as the trial's INITIAL selector cache
   * instead of the bootstrap, so a repair discovered in an earlier keyed run can
   * be replayed deterministically (zero LLM) in a later run. Unset → behaviour
   * is byte-identical to today (start from the bootstrap). A missing or
   * malformed file is a clean internal PipelineStepError that names the path.
   * The baseline and stagehand engines ignore this option.
   */
  seedCacheFile?: string;
}

export interface AttemptOutcome {
  steps: StepResult[];
  /** Raw extractor output per page, BEFORE schema validation. */
  statsRaw?: unknown;
  oddsRaw?: unknown;
  screenshots: string[];
  tokens?: TokensUsage | null;
  /**
   * Step names whose cached selector failed and was repaired via an LLM observe
   * call this attempt (hybrid engine only). runPipeline copies the final
   * attempt's value into PipelineResult.healedSteps.
   */
  healedSteps?: string[];
  /**
   * Step names where a hand-written deterministic guard fired after the semantic
   * act failed to clear a session blocker (stagehand engine only). runPipeline
   * copies the final attempt's value into PipelineResult.deterministicFallbacks.
   */
  deterministicFallbacks?: string[];
}

/** Thrown by engines when an attempt dies mid-flight. Carries what happened. */
export class AttemptFailure extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly step: string,
    readonly steps: StepResult[],
    readonly screenshots: string[] = [],
    readonly tokens: TokensUsage | null = null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "AttemptFailure";
  }
}

export interface Engine {
  readonly name: EngineName;
  run(options: PipelineOptions): Promise<PipelineResult>;
}

export const DEFAULT_PIPELINE_TIMEOUTS = {
  navTimeoutMs: 20_000,
  stepTimeoutMs: 45_000
} as const;
