import type {
  EngineName,
  FailureCategory,
  PipelineResult,
  RepairMode,
  RunLogger,
  SessionMode,
  StepResult,
  StepTraceEntry,
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
   * The hybrid engine's repair dispatch (PROTOCOL_2A §1). When unset the engine
   * derives it from `disableRepair` (`off` when true, else `llm`), so existing
   * callers keep their exact behaviour. `off` reproduces --no-repair; `llm`
   * (default) runs the key-gated LLM repair; `deterministic` runs the B2 ladder
   * with NO model call in the code path. The baseline and stagehand engines
   * ignore this option.
   */
  repairMode?: RepairMode;
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
   * call (hybrid engine only). Trial-scoped across attempts, so it accumulates
   * heals from earlier failed attempts; runPipeline copies it into
   * PipelineResult.healedSteps.
   */
  healedSteps?: string[];
  /**
   * Step names the B2 deterministic ladder re-located/re-read this trial (hybrid
   * `--repair-mode deterministic` only, PROTOCOL_2A §2). Trial-scoped across
   * attempts exactly like healedSteps; runPipeline copies it into
   * PipelineResult. B2 NEVER writes healedSteps.
   */
  deterministicRepairSteps?: string[];
  /**
   * Step names where a hand-written deterministic guard fired after the semantic
   * act failed to clear a session blocker (stagehand engine only). Trial-scoped
   * across attempts (one entry per firing, so a step may repeat once per attempt);
   * runPipeline copies it into PipelineResult.deterministicFallbacks.
   */
  deterministicFallbacks?: string[];
  /**
   * Per-step escalation trace (record version 2, docs/RECORD_FORMAT.md).
   * Trial-scoped across attempts exactly like healedSteps, so a trigger evaluated
   * on a losing attempt is still recorded; runPipeline copies it into
   * PipelineResult.stepTrace. Pure bookkeeping — recording it never changes what
   * the engine does.
   */
  stepTrace?: StepTraceEntry[];
  /**
   * The browser build this attempt ran against, when the engine can read it from
   * its own browser instance for free (Playwright's `browser.version()`).
   * Stagehand-backed engines drive Chrome over CDP and leave it unset.
   */
  chromeVersion?: string;
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
    /**
     * Trial-scoped step names LLM-repaired so far this trial (hybrid only).
     * Carried on the failure so a trial that heals then fails entirely still
     * records the heal (runPipeline's no-outcome path reads it).
     */
    readonly healedSteps?: string[],
    /**
     * Trial-scoped deterministic-fallback firings so far this trial (stagehand
     * only). Carried on the failure so a guard that fired on a losing attempt is
     * never lost when the whole trial fails.
     */
    readonly deterministicFallbacks?: string[],
    options?: { cause?: unknown },
    /**
     * Trial-scoped B2 deterministic-repair step names so far this trial (hybrid
     * `--repair-mode deterministic` only). Carried on the failure so a trial that
     * deterministically repaired then failed entirely still records it. Ordered
     * AFTER `options` deliberately: the baseline engine constructs AttemptFailure
     * with `options` as its final positional argument and is out of scope for this
     * change, so a new param before `options` would shift its call.
     */
    readonly deterministicRepairSteps?: string[],
    /**
     * Trial-scoped escalation trace so far this trial (record version 2). Carried
     * on the failure so a trial whose trigger evaluations happened on a losing
     * attempt still ships them. Appended LAST for the same reason
     * `deterministicRepairSteps` was: every existing positional call site stays
     * unchanged.
     */
    readonly stepTrace?: StepTraceEntry[],
    /**
     * The browser build this attempt ran against, carried on the failure so a
     * trial that DIES still records which browser executed it. Without this the
     * version is attached only to a completed attempt's outcome, and every
     * trial whose attempts all threw records `chromeVersion: null` — the
     * diagnosed cause of the gate-1 smoke's nulls. Appended LAST for the same
     * reason `stepTrace` was: every existing positional call site is unchanged.
     */
    readonly chromeVersion?: string
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
