import { z } from "zod";
import { ChaosFlagSchema } from "../chaos";
import { ChaosParamsSchema } from "../chaosParams";
import {
  DisplayOverrideSchema,
  GroundTruthSchema,
  NormalizedMarketSchema,
  NormalizedTeamStatsSchema
} from "./domain";
/**
 * The verbatim pre-normalization payloads (record version 2). Both keys are
 * `unknown`, so ANY value the extractor produced round-trips unchanged — but
 * both must be PRESENT: "this page produced nothing" is said with `null`, never
 * by leaving the key out, because an absent key and a null one would otherwise
 * recompute to different schema-check errors.
 */
const RawPayloadsSchema = z
  .object({ stats: z.unknown(), odds: z.unknown() })
  .superRefine((value, ctx) => {
    for (const page of ["stats", "odds"] as const) {
      if (!Object.hasOwn(value, page)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [page],
          message: `canonical.raw.${page} must be present (null when the page produced no payload)`
        });
      }
    }
  });
import {
  EngineNameSchema,
  FailureCategorySchema,
  StepTraceEntrySchema,
  TokensUsageSchema
} from "./run";

export const SessionModeSchema = z.enum(["fresh", "reuse", "expired"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/**
 * The hybrid engine's repair dispatch (PROTOCOL_2A §1). `off` freezes the tier
 * (the frozen alias of `--no-repair`, policy B); `deterministic` runs the B2
 * deterministic re-location ladder with NO model call in the code path;
 * `llm` (default) runs the one key-gated LLM repair per broken step (policy C).
 */
export const RepairModeSchema = z.enum(["off", "deterministic", "llm"]);
export type RepairMode = z.infer<typeof RepairModeSchema>;

/**
 * What "correct behaviour" means for a scenario. `validation-failure` means
 * the pipeline should complete with a clean, categorised validation failure
 * (extracting garbage silently counts as a FAIL).
 */
export const ExpectedOutcomeSchema = z.enum([
  "success",
  "validation-failure",
  "success-with-warnings"
]);
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

/**
 * Which arc a scenario belongs to. `core` = a single isolated failure mode
 * (the original catalog). `compound` = several obstacles co-occurring in one
 * run. `survival` = the same site frozen at accumulating versions of drift,
 * graded against engines written before that drift existed.
 */
export const ScenarioGroupSchema = z.enum(["core", "compound", "survival"]);
export type ScenarioGroup = z.infer<typeof ScenarioGroupSchema>;

/**
 * Why this run exists. Recorded so evidence separation is machine-enforced:
 * smoke runs can never aggregate with campaign evidence, and persistence runs can
 * never blend with the warm economics sweep.
 */
export const RunPurposeSchema = z.enum(["smoke", "cold", "persistence", "warm"]);
export type RunPurpose = z.infer<typeof RunPurposeSchema>;

/**
 * The readiness predicate a run used — the ONE variable of the Phase-2B
 * ablation (docs/PROTOCOL_2B.md §Design).
 *  - `frozen`: the Phase-2A predicate, bit-identical (≥5 rows / ≥8 cards for
 *    stats, ≥4 / ≥4 for odds). The replication control.
 *  - `any-row`: ready as soon as ONE data row or card is visible. Everything
 *    else in the poll — structure-awareness, class-freedom, timeout, poll cap —
 *    is unchanged.
 */
export const ReadinessModeSchema = z.enum(["frozen", "any-row"]);
export type ReadinessMode = z.infer<typeof ReadinessModeSchema>;

/**
 * Behaviour classification of a trial, ORTHOGONAL to the judged pass/fail.
 * Derived from what the pipeline actually did (not from whether it met the
 * scenario's expectation):
 *  - `pass`: succeeded, perfect accuracy, first attempt, no repairs.
 *  - `recovered`: succeeded with perfect accuracy, but only after a retry or an
 *    LLM repair.
 *  - `safe-failure`: failed, but the engine itself caught the data problem
 *    (validation/extraction) — e.g. a schema-violation refusal. Note this is a
 *    CLASS, not a verdict: a clean validation-failure is judged PASS yet still
 *    classed `safe-failure`. The two dimensions are deliberately orthogonal.
 *  - `silent-corruption`: claimed success on data that is wrong or unverifiable.
 *    THE headline safety metric.
 *  - `hard-failure`: failed with visible breakage (navigation/auth/not_found/…).
 */
export const OutcomeClassSchema = z.enum([
  "pass",
  "recovered",
  "safe-failure",
  "silent-corruption",
  "hard-failure"
]);
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;

export const ScenarioSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  chaos: z.array(ChaosFlagSchema),
  seed: z.number().int(),
  session: SessionModeSchema,
  expected: ExpectedOutcomeSchema,
  group: ScenarioGroupSchema.default("core"),
  /**
   * Phase-2A perturbation parameters (PROTOCOL_2A §3), the parameterized parallel
   * to the binary `chaos` flags. Optional and subject to the §3 flag-XOR-param
   * precedence rule (see chaosParams.validateChaosParamsCompat). Absent for every
   * Phase-1 scenario.
   */
  params: ChaosParamsSchema.optional()
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;
export type ScenarioSpecInput = z.input<typeof ScenarioSpecSchema>;

export const AccuracyReportSchema = z.object({
  expectedRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  fieldChecks: z.number().int().nonnegative(),
  fieldMatches: z.number().int().nonnegative(),
  rowCoverage: z.number().min(0).max(1),
  fieldAccuracy: z.number().min(0).max(1),
  /**
   * Entity-completeness guards (Wave E 8e). `duplicateRows` counts extracted
   * rows whose key repeats (the same team/fixture reported twice);
   * `unexpectedRows` counts extracted rows whose key is absent from ground
   * truth (a ghost entity). Both are 0 for a faithful extraction; a
   * success-branch judge PASS requires both to be 0 on every page.
   */
  duplicateRows: z.number().int().nonnegative(),
  unexpectedRows: z.number().int().nonnegative(),
  /** rowCoverage × fieldAccuracy */
  score: z.number().min(0).max(1)
});
export type AccuracyReport = z.infer<typeof AccuracyReportSchema>;

export const TrialResultSchema = z.object({
  scenarioId: z.string().min(1),
  engine: EngineNameSchema,
  trial: z.number().int().positive(),
  runId: z.string().min(1),
  /** Pass/fail judged against the scenario's `expected` outcome. */
  outcome: z.enum(["pass", "fail"]),
  outcomeReason: z.string(),
  /**
   * Behaviour class of the trial (see OutcomeClassSchema), computed from the
   * pipeline's behaviour and INDEPENDENT of the judged `outcome` above.
   */
  outcomeClass: OutcomeClassSchema,
  pipelineSuccess: z.boolean(),
  extractionSuccess: z.boolean(),
  validationSuccess: z.boolean(),
  accuracy: z
    .object({
      stats: AccuracyReportSchema.optional(),
      odds: AccuracyReportSchema.optional(),
      overall: z.number().min(0).max(1).optional()
    })
    .nullable(),
  durationMs: z.number().nonnegative(),
  retries: z.number().int().nonnegative(),
  recoveredAfterFailure: z.boolean(),
  failureCategory: FailureCategorySchema.optional(),
  failureDetail: z.string().optional(),
  artifactsDir: z.string(),
  tokens: TokensUsageSchema.nullable().optional(),
  /** Step names the engine repaired via LLM observe this trial (hybrid only). */
  healedSteps: z.array(z.string()).optional(),
  /**
   * Step names the B2 deterministic ladder re-located/re-read this trial
   * (PROTOCOL_2A §2; hybrid `--repair-mode deterministic` only). DISTINCT from
   * `healedSteps` (semantic/LLM repair, which B2 never writes) and from
   * `deterministicFallbacks` (stagehand's guards). Present and non-empty only
   * when a deterministic repair actually fired.
   */
  deterministicRepairSteps: z.array(z.string()).optional(),
  /**
   * Steps where a hand-written deterministic guard fired after the semantic act
   * failed to clear a session blocker (stagehand engine only). Disclosed so
   * full-semantic results never silently lean on hand-written code.
   */
  deterministicFallbacks: z.array(z.string()).optional(),
  // ── Evidence-complete record, version 2 (docs/RECORD_FORMAT.md) ────────────
  /**
   * Record format version. ABSENT means version 1 (counters attested, raw rows
   * not shipped), and an EXPLICIT `1` says the same thing — v1 records predate
   * the field and normally omit it, but a producer that states it is accepted
   * (docs/RECORD_FORMAT.md). `2` means this record embeds the grading INPUTS, so
   * a third party can recompute the accuracy counters instead of trusting them.
   * Every v2 addition is optional, so every v1 bundle keeps parsing
   * byte-for-byte.
   */
  recordVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  /**
   * The grading inputs, shipped at BOTH stages of the pipeline.
   *
   * `raw` is the pre-normalization extraction payload per page, recorded
   * VERBATIM as `unknown`: exactly the value `runPipeline` handed to
   * `checkStatsSchema` / `checkOddsSchema`, with no shape imposed and no
   * reshaping of any kind. Two reasons, and both are load-bearing: validating it
   * here would make the extraction checks pass by construction and turn
   * `extractionSuccess` back into an attestation; and rewriting a payload the
   * record layer found unfamiliar (an earlier draft mapped anything that was not
   * `{ rows: [...] }` to null) would change what an honestly MALFORMED payload's
   * schema-error detail recomputes to, breaking the attribution recompute on a
   * record that did nothing wrong. A page that produced no payload records null —
   * never omission. It is the root of the chain: because it ships,
   * everything downstream of it is RE-DERIVABLE, so the normalized rows,
   * failures and warnings below are cross-checks rather than assertions — a
   * shipped value that does not follow from `raw` fails verification. A page is
   * null when the engine produced no payload for it at all.
   *
   * `stats`/`odds` are the normalized rows the scorer consumed; `failures`/
   * `warnings` are the dataset annotations normalization produced (what
   * `assessDataset` seeds its verdict from). All four are null/empty together
   * only in the one case the pipeline can produce them that way: both row pages
   * are null exactly when NO normalized dataset was built at all — the same
   * condition that records `accuracy: null`. A page that WAS normalized but
   * yielded nothing records an empty array, never null.
   *
   * Note the two nullabilities are independent in the honest direction only:
   * `raw.<page>` may be null while the rows are present (that page extracted
   * nothing, and normalization still built a dataset from the other page), but
   * rows cannot be null while raw is present — no dataset is built without a
   * completed attempt.
   */
  canonical: z
    .object({
      raw: RawPayloadsSchema,
      stats: z.array(NormalizedTeamStatsSchema).nullable(),
      odds: z.array(NormalizedMarketSchema).nullable(),
      failures: z.array(z.string()),
      warnings: z.array(z.string())
    })
    .optional(),
  /**
   * Which pages the pipeline was ASKED to extract (record version 2). Absent
   * means both — every bench run to date requests both, so the field changes no
   * existing record; it exists so the verifier recomputes the extraction verdict
   * over exactly the requested set instead of assuming it, and a future
   * single-page run cannot false-positive on `extractionSuccess`.
   */
  pagesRequested: z.array(z.enum(["stats", "odds"])).min(1).optional(),
  /**
   * The browser build that executed THIS trial (record version 2). Per-trial
   * because it is a per-trial fact: engines in one run can launch different
   * browsers, and their version sources report different forms. null when no
   * source could supply one. `BenchmarkResults.environment.chromeVersion`
   * summarises these and is emitted only when every trial reported the same one.
   */
  chromeVersion: z.string().nullable().optional(),
  /**
   * Why escalation did or did not fire, step by step (see StepTraceEntrySchema).
   * Best-effort per engine; absent for the baseline, which has no escalation
   * machinery to trace.
   */
  stepTrace: z.array(StepTraceEntrySchema).optional()
});
export type TrialResult = z.infer<typeof TrialResultSchema>;

/**
 * The exact ground-truth slice the scorer compared a scenario's extractions
 * against: the lab's seeded truth plus the display overrides that tell the
 * scorer which cells to expect as missing and which to exclude. Recorded once
 * per scenario at the RUN level (see BenchmarkResults.oracles) rather than once
 * per trial; trials reference it through their existing `scenarioId`.
 */
export const TrialOracleSchema = z.object({
  truth: GroundTruthSchema,
  overrides: z.array(DisplayOverrideSchema)
});
export type TrialOracle = z.infer<typeof TrialOracleSchema>;

/**
 * What the model was configured to do, for runs that used one (record version
 * 2). No code path in this repo sets a temperature, so a run with a model
 * records `provider-default` with a null temperature — the honest statement of
 * what Phase 1 and Phase 2A actually did. `n/a-no-model` is a keyless run, where
 * the question does not arise; `explicit` is reserved for a future run that sets
 * a temperature deliberately.
 */
export const ModelConfigSchema = z.object({
  temperature: z.number().nullable(),
  temperatureSource: z.enum(["explicit", "provider-default", "n/a-no-model"])
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const EngineSummarySchema = z.object({
  engine: EngineNameSchema,
  trials: z.number().int().nonnegative(),
  /** Set when the engine could not run at all (e.g. no model key). */
  skippedReason: z.string().optional(),
  taskSuccessRate: z.number().min(0).max(1).nullable(),
  extractionSuccessRate: z.number().min(0).max(1).nullable(),
  validationSuccessRate: z.number().min(0).max(1).nullable(),
  meanAccuracy: z.number().min(0).max(1).nullable(),
  meanDurationMs: z.number().nonnegative().nullable(),
  totalRetries: z.number().int().nonnegative(),
  recovery: z.object({
    firstAttemptFailures: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    recoveryRate: z.number().min(0).max(1).nullable()
  }),
  /**
   * Trials that reached a perfect success only after a whole-attempt RETRY
   * (from recoveredAfterFailure) — reported separately from the heal-based
   * `recovered` outcome class (Wave E 8d): a retry-only success is class
   * `pass`, whereas class `recovered` now requires a semantic repair
   * (healedSteps nonempty). Equals `recovery.recovered` numerically; surfaced
   * under a distinct name so the two notions of "recovery" never blur.
   */
  retryRecoveries: z.number().int().nonnegative(),
  failuresByCategory: z.record(z.number().int().nonnegative()),
  /** Count of trials per behaviour class (see OutcomeClassSchema keys). */
  outcomeClasses: z.record(z.number().int().nonnegative()),
  /**
   * Share of trials that claimed success on wrong/unverifiable data
   * (silent-corruption count / trials). null when the engine ran no trials.
   */
  silentCorruptionRate: z.number().min(0).max(1).nullable(),
  tokens: TokensUsageSchema.nullable().optional(),
  /**
   * Number of trials in which at least one step was LLM-repaired (hybrid only).
   * Omitted when no trial healed anything.
   */
  healedTrials: z.number().int().nonnegative().optional(),
  /**
   * Number of trials in which the B2 deterministic ladder repaired ≥1 step
   * (hybrid `--repair-mode deterministic` only). Omitted when none fired.
   */
  deterministicRepairTrials: z.number().int().nonnegative().optional()
});
export type EngineSummary = z.infer<typeof EngineSummarySchema>;

export const ScenarioComparisonSchema = z.object({
  scenarioId: z.string().min(1),
  /** One verdict per requested engine; engines that never ran are "skipped". */
  results: z.record(EngineNameSchema, z.enum(["pass", "fail", "skipped"])),
  note: z.string().optional()
});
export type ScenarioComparison = z.infer<typeof ScenarioComparisonSchema>;

export const BenchmarkResultsSchema = z.object({
  benchId: z.string().min(1),
  createdAt: z.string(),
  labUrl: z.string().min(1),
  trialsPerScenario: z.number().int().positive(),
  scenarios: z.array(ScenarioSpecSchema),
  trials: z.array(TrialResultSchema),
  engines: z.array(EngineSummarySchema),
  comparison: z.array(ScenarioComparisonSchema),
  /**
   * Present only when a `beforeTrial` hook halted the run early (PROTOCOL_2A §7:
   * the pre-trial budget stop). An incomplete campaign is PRESERVED evidence — the
   * runner still writes every artifact — so this records why it stopped and how
   * far it got. `completedTrials` is how many trials actually ran; `plannedTrials`
   * is how many the full scenario × engine × trial grid would have produced.
   * Absent on any run that ran to completion (keeps every prior results.json
   * parsing).
   */
  stopped: z
    .object({
      reason: z.string(),
      completedTrials: z.number().int().nonnegative(),
      plannedTrials: z.number().int().nonnegative()
    })
    .optional(),
  /**
   * Record version 2 (docs/RECORD_FORMAT.md): the exact ground-truth slice used
   * to grade each scenario, keyed by `scenarioId`. Run-level so each oracle ships
   * ONCE rather than once per trial. Absent on v1 runs, whose trials therefore
   * cannot be re-graded from raw output.
   */
  oracles: z.record(TrialOracleSchema).optional(),
  environment: z.object({
    node: z.string(),
    stagehandVersion: z.string().optional(),
    stagehandModel: z.string().optional(),
    /** Provider whose key was present ("anthropic" | "openai"), or null. */
    modelProvider: z.string().nullable(),
    browserbase: z.boolean(),
    // ── Reproducibility provenance (Wave E 8j) ──────────────────────────────
    /** `git rev-parse HEAD` at run time, or null when git is unavailable. */
    gitCommit: z.string().nullable(),
    /** True when `git status --porcelain` was non-empty; null when unknown. */
    gitDirty: z.boolean().nullable(),
    /** Whether the hybrid repair path was frozen for this run (--no-repair). */
    disableRepair: z.boolean(),
    /**
     * The hybrid engine's resolved repair dispatch for this run (PROTOCOL_2A §1).
     * Optional for backward compatibility with committed Phase-1 results.json
     * files, which predate the flag; absent there. `--no-repair` records "off".
     */
    repairMode: RepairModeSchema.optional(),
    /** Which warm-cache seeding mode was active. */
    seedCacheMode: z.enum(["none", "file", "manifest"]),
    /**
     * content hash: sha256 of the seed-cache file for --seed-cache; for
     * --seed-cache-manifest, sha256 over the manifest hash plus every referenced
     * cache file's verified content sha256. null when seedCacheMode is "none".
     */
    seedCacheHash: z.string().nullable(),
    /**
     * Why this run exists. Recorded so evidence separation is machine-enforced:
     * smoke runs can never aggregate with campaign evidence, and persistence runs
     * can never blend with the warm economics sweep. The `.default("cold")` keeps
     * committed pre-v3 results parseable.
     */
    runPurpose: RunPurposeSchema.default("cold"),
    /**
     * sha256 over the canonical sorted registry of ALL fixed instruction strings
     * (packages/agent/src/instructions.ts): stagehand extraction + act/observe
     * instructions and the hybrid's repair instructions. Pins the complete
     * prompt surface for the protocol.
     */
    promptsHash: z.string(),
    /** sha256 of pnpm-lock.yaml — pins the exact dependency graph. */
    lockfileHash: z.string(),
    /**
     * Protocol identifier (PROTOCOL_2A §5 item 6; e.g. "phase2a-v1"). Optional for
     * backward compatibility with Phase-1 files, which predate it. Populated by a
     * later stage-1 deliverable; the aggregator refuses to mix protocolIds.
     */
    protocolId: z.string().optional(),
    /**
     * sha256 of the scenario-suite file bytes (or the built-in catalog's canonical
     * serialization) for this run (PROTOCOL_2A §5 item 4). Optional for backward
     * compatibility with Phase-1 files; populated by a later stage-1 deliverable.
     */
    suiteHash: z.string().optional(),
    // ── Record version 2 provenance (docs/RECORD_FORMAT.md) ─────────────────
    /**
     * The model configuration in effect for this run (see ModelConfigSchema).
     * Optional so v1 files keep parsing.
     */
    modelConfig: ModelConfigSchema.optional(),
    /**
     * Run-level SUMMARY of the per-trial `TrialResult.chromeVersion` values.
     * Emitted only when EVERY trial in the run reported a build and all reported
     * the SAME one; null otherwise — including when only some trials reported.
     * A trial that reported nothing is not a vote for its siblings' answer, so a
     * baseline+hybrid run is never labelled with the baseline's browser.
     */
    chromeVersion: z.string().nullable().optional(),
    /**
     * The pinned price-table date used for cost derivation
     * (packages/agent/src/reliability/prices.ts). Costs are never summed into
     * results; they are derived at analysis time from that table, so the record
     * names which table applies.
     */
    pricesPinnedAt: z.string().nullable().optional(),
    // ── Phase-2B arm provenance (docs/PROTOCOL_2B.md §Design) ────────────────
    /**
     * The ARM this run belongs to: the readiness predicate it actually used,
     * always the RESOLVED value, so a run that passed no flag honestly records
     * "frozen" rather than staying silent. Optional in the schema because
     * records written before the arm machinery existed have no stamp at all —
     * absent means "pre-arm", never "frozen by default". The Phase-2B verifier
     * requires it, behind its own flag, so nothing existing breaks.
     */
    readinessMode: ReadinessModeSchema.optional(),
    /**
     * Which CAMPAIGN this run belongs to, verbatim as configured (e.g.
     * "phase2b-ablation-v1"). Distinct from `protocolId`, which names the
     * SUITE's lineage and must equal the supplied suite's — so it cannot also
     * name the campaign. Never defaulted and never invented: absent config
     * means an absent key.
     */
    campaignProtocolId: z.string().min(1).optional()
  })
});
export type BenchmarkResults = z.infer<typeof BenchmarkResultsSchema>;
