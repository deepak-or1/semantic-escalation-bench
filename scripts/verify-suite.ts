/**
 * Generic suite verifier (PROTOCOL_2A §5 item 5). Replaces per-engine verify.ts
 * editing: the acceptance logic is frozen at stage 1 and there is NO per-scenario
 * code, ever.
 *
 *   pnpm verify:suite <runDir...> --suite <scenario-suite.json> \
 *     --expect-policies <A,B,B2,C,D subset> --expect-trials <n> \
 *     [--expect-record-version <1|2>]
 *
 * The caller DECLARES the expected experiment grid: which frozen policies must be
 * present and how many independent sweeps (distinct runs) each (scenario × policy)
 * cell must carry. The verifier refuses to certify anything that does not match
 * that grid exactly — a partial campaign, a policy presented under the wrong label
 * (e.g. `hybrid-keyless` masquerading as C), or N trials smuggled out of one run.
 *
 * For every run directory's results.json it checks, and GATES on (exit nonzero
 * only when one of these is violated):
 *   (a) SCHEMA        — results.json validates under BenchmarkResultsSchema.
 *   (b) PROVENANCE    — the reproducibility stamps are present and uniform
 *                       (gitCommit, gitDirty:false, promptsHash, lockfileHash,
 *                       protocolId, suiteHash, and repairMode for hybrid runs),
 *                       and protocolId/suiteHash match the supplied suite. ALSO
 *                       the RECORD FORMAT (docs/RECORD_FORMAT.md): every trial in
 *                       one run must declare the same record version (an absent
 *                       recordVersion IS version 1), and when the caller passes
 *                       --expect-record-version <n> every trial in every run must
 *                       declare exactly n — so a v2 record cannot be "downgraded"
 *                       to v1 to escape recomputation.
 *   (c) COMPLETENESS  — the observed runs realise the declared expect-grid EXACTLY:
 *                       each expected policy maps (string equality, no predicates)
 *                       to ONE admissible configuration label; every suite scenario
 *                       × expected policy cell holds exactly expect.trials trials;
 *                       those trials come from expect.trials DISTINCT runs (one
 *                       sweep each); no configuration outside the expected images
 *                       appears; no two inputs share a benchId or carry identical
 *                       trial content (a relabeled copy is not a distinct sweep);
 *                       every trial's artifactsDir embeds its run's own benchId; and
 *                       every trial's scenario is present in the supplied suite.
 *   (d) GRADING       — the recorded verdict/reason/outcomeClass equal a
 *                       recomputation from the raw recorded trial data plus the
 *                       SUPPLIED SUITE's scenario oracle (never the run's own
 *                       recorded oracle), using the SAME frozen judge/classifier
 *                       the runner uses (imported, never reimplemented). The run's
 *                       recorded scenario is ALSO cross-checked against the suite
 *                       (id/seed/chaos/params/session/expected); any divergence is
 *                       a grading violation. For a record-version-2 trial the
 *                       WHOLE grading chain is re-run from the record's raw
 *                       payloads — extraction checks (so extractionSuccess is
 *                       recomputed, not attested), normalization (the shipped rows
 *                       and dataset annotations must follow from raw), the domain
 *                       assessment, both pipeline identities, accuracy, and the
 *                       judge — against a ground-truth oracle RE-DERIVED here from
 *                       the supplied suite's seed; the run's own `oracles` entry is
 *                       checked against that re-derivation and never used for
 *                       grading. The step trace is reconciled against the record's
 *                       token count and repair lists.
 *
 * It ALSO scores sol's per-policy prediction table (§4a). FROZEN SEMANTICS
 * (auditor-required, do not weaken): a judged POLICY failure is admissible evidence
 * and NEVER fails the verifier; the verifier gates only completeness, provenance,
 * schema validity, and grading consistency; prediction misses are report-only and
 * never gate. All 2A scenarios are `expected: success`, so policy failures against
 * them are the measurement, not a defect.
 *
 * SCOPE (honest boundary): the verifier checks the structure and internal
 * consistency of self-reported evidence files — it detects EXACT AND IDENTITY-ONLY
 * COPIES — a shared benchId, a relabeled copy, or a copy whose benchId was
 * consistently rewritten through its artifact paths (content hashed after
 * normalizing run-identity strings) — but cannot detect fabricated or hand-edited
 * trial content, nor cryptographically prove two files came from separate
 * executions; fabricated fresh content is countered by publishing raw run
 * artifacts, not by this tool.
 *
 * Pure verification core (verifySuite) is unit-testable; the CLI is only file I/O.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  // The domain validator the PIPELINE ran (imported, never reimplemented), so a
  // v2 record's validationSuccess is recomputed by exactly the code that set it.
  assessDataset,
  // The lab's own seeded ground-truth generator (apps/lab/src/state.ts builds its
  // truth/overrides with these two functions and nothing else), so the verifier
  // can RE-DERIVE the oracle a scenario must have been graded against instead of
  // trusting the one the run ships.
  computeDisplayOverrides,
  generateGroundTruth,
  loadScenarioSuite,
  suiteScenarioToSpec,
  type AccuracyReport,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type Prediction,
  type ScenarioSpec,
  type StepTraceEntry,
  type TrialOracle,
  type TrialResult
} from "@ssda/shared";
// Every stage of the grading chain below is the RUNNER'S OWN module (imported,
// never reimplemented), so a v2 record is re-derived by exactly the code that
// produced it: the extraction schema checks, normalization, dataset assembly,
// scoring, the judge and the classifier.
import {
  buildDataset,
  checkOddsSchema,
  checkStatsSchema,
  classifyOutcome,
  configurationLabel,
  judge,
  normalizeOdds,
  normalizeStats,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  unanimousChromeVersion
} from "@ssda/agent";

// ── Result shapes ────────────────────────────────────────────────────────────

export type VerifyCheck = "schema" | "provenance" | "completeness" | "grading";

/** The five frozen engine policies (PROTOCOL_2A §1). */
export type Policy = "A" | "B" | "B2" | "C" | "D";

/** The expected experiment grid the caller certifies against (see verifySuite). */
export interface ExpectGrid {
  policies: Policy[];
  trials: number;
  /**
   * The record format version every trial must DECLARE (docs/RECORD_FORMAT.md),
   * from `--expect-record-version`. Mandatory for Phase 2B and later campaigns
   * (PROTOCOL_2B §Gates), which run with `2`: without it a v2 record can be
   * downgraded to v1 — rows and canonical block deleted — and re-graded from its
   * own attested counters. Absent means the caller declares no expectation, which
   * is how the version-1 Phase-1/2A bundles keep verifying.
   */
  recordVersion?: number;
}

export interface Violation {
  check: VerifyCheck;
  message: string;
}

/** One (scenario × policy) prediction outcome — report-only (§4a). */
export interface PredictionScore {
  scenarioId: string;
  policy: Policy;
  predicted: Prediction;
  /** Judged pass count / trial count for the mapped configuration, or null if it never ran. */
  observed: { pass: number; total: number } | null;
  status: "hit" | "miss" | "not-run";
}

/**
 * How each trial record was graded, so a MIXED bundle is legible at a glance
 * (docs/RECORD_FORMAT.md). Three classes:
 *  - `recomputed`: version-2 records whose ENTIRE grading chain this verifier
 *    re-derived from the raw payloads the record ships — extraction checks,
 *    normalization, domain assessment, both pipeline identities, accuracy against
 *    the oracle re-derived from the supplied suite, and the judge.
 *  - `v2NoRows`: version-2 HARD-FAILURE records — the pipeline produced no
 *    payload and no normalized dataset, so there is nothing to recompute. They
 *    are not trusted blindly: the record is consistency-checked (no raw, both row
 *    pages null, `accuracy: null`, neither success flag claimed, and its judged
 *    verdict re-derived) before it lands here.
 *  - `attestedV1`: version-1 records, which ship only the OUTPUTS of grading and
 *    can therefore be re-graded from their counters but never checked against
 *    raw output.
 * The three need not sum to `total`: a v2 record whose recompute was BLOCKED by a
 * violation (no canonical block, no oracle, a single null page, …) is counted in
 * none of them — claiming it as recomputed would be the M1 overcount. The report
 * names that remainder explicitly.
 */
export interface RecordProvenance {
  total: number;
  recomputed: number;
  v2NoRows: number;
  attestedV1: number;
}

export interface VerifyReport {
  ok: boolean;
  violations: Violation[];
  predictions: PredictionScore[];
  notes: string[];
  records: RecordProvenance;
}

/** A run paired with the source label used in messages. */
export interface VerifyInput {
  source: string;
  raw: unknown;
}

const ALL_POLICIES: readonly Policy[] = ["A", "B", "B2", "C", "D"];

/**
 * Policy → its SINGLE admissible configuration label (see campaign.configurationLabel),
 * matched by string equality — NO predicates. Phase 2A is cold-only, so C admits only
 * `C-hybrid-repair-cold` (persistence/warm/seeded C labels are inadmissible). Note
 * `hybrid-keyless` is the image of NO policy: it can never count toward C (or anything).
 */
const POLICY_LABEL: Record<Policy, string> = {
  A: "A-baseline",
  B: "B-structural",
  B2: "B2-deterministic-repair",
  C: "C-hybrid-repair-cold",
  D: "D-full-semantic"
};

const AUTH_ERROR_PATTERNS = /401|authentication|invalid x-api-key|unauthorized/i;

function reason(check: VerifyCheck, message: string): Violation {
  return { check, message };
}

/** Join source labels for a message: `"a" and "b"`, or `"a", "b" and "c"`. */
function joinSources(sources: string[]): string {
  const quoted = sources.map((s) => `"${s}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Deep-walk a JSON-serializable value and, in every STRING value, replace each id
 * in `ids` with the single literal placeholder "«benchId»". `ids` MUST be sorted by
 * length DESCENDING so an id that is a substring of another is replaced only after
 * the longer one. Arrays and plain objects are rebuilt in place (keys untouched);
 * numbers, booleans and null pass through unchanged. Pure — returns a fresh value.
 * Used by c.4 to normalize run-identity strings before hashing trial content, so a
 * copy whose benchId was consistently rewritten through its artifact paths hashes
 * identically to its original. benchId is schema-guaranteed non-empty, so split() is
 * safe.
 */
function canonicalizeRunIdentity(value: unknown, ids: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const id of ids) s = s.split(id).join("«benchId»");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => canonicalizeRunIdentity(v, ids));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = canonicalizeRunIdentity(v, ids);
    return out;
  }
  return value;
}

/**
 * The record format version a trial DECLARES. An absent `recordVersion` IS
 * version 1 (v1 records predate the field); an explicit `1` says the same thing
 * (docs/RECORD_FORMAT.md).
 */
function declaredRecordVersion(t: TrialResult): number {
  return t.recordVersion ?? 1;
}

/**
 * Deterministic JSON for DEEP EQUALITY: object keys are emitted in sorted order,
 * so key ORDER can never masquerade as a value difference when a shipped oracle
 * (round-tripped through JSON and a zod parse) is compared against a freshly
 * re-derived one. Array order is preserved — the generator's row order is part of
 * the value.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Per-entry LOGICAL invariants of a step trace. The four repair facts are
 * separate fields precisely so they can disagree — but only in the directions
 * the engines can actually produce. These five implications are structural: a
 * trace that breaks one is describing a sequence of events that cannot have
 * happened, whatever the numbers around it say.
 *
 * Verified empirically before being enforced: 67 trace entries from a keyless
 * baseline+hybrid sweep over nine scenarios (clean, class-drift, layout-variant,
 * hidden-tab, pagination, cookie-banner, modal, delayed-render, column-shuffle)
 * satisfy all five. Stagehand is key-gated and could not be swept; its trace
 * sites were read instead and produce the same shapes.
 */
function traceEntryInvariants(e: StepTraceEntry): string[] {
  const out: string[] = [];
  if (e.repairSucceeded === true && e.repairAttempted !== true) {
    out.push("repairSucceeded is true but repairAttempted is not — nothing can succeed unattempted");
  }
  if (e.repairAttempted === true && e.escalationTriggered !== true) {
    out.push("repairAttempted is true but escalationTriggered is not — a repair only runs once a trigger fired");
  }
  if (e.downstreamRecovered !== undefined && e.repairSucceeded !== true) {
    out.push("downstreamRecovered is recorded but no repair succeeded — there is nothing for the step to have recovered from");
  }
  if (e.repairSucceeded === true && e.repairKind === "llm" && (e.modelCallsAtStep ?? 0) < 1) {
    out.push(`a successful llm repair records ${e.modelCallsAtStep ?? 0} model call(s) — the repair IS the call`);
  }
  if (e.cachedSelectorMatched === true && e.escalationTriggered === true) {
    out.push("cachedSelectorMatched and escalationTriggered are both true — the cached selector working is exactly what does NOT trigger escalation");
  }
  return out;
}

/** Sorted, de-duplicated set rendering, so a message names steps deterministically. */
function stepSet(names: Iterable<string>): string {
  const sorted = [...new Set(names)].sort();
  return sorted.length === 0 ? "(none)" : sorted.join(", ");
}

/**
 * Cross-check a v2 record's `stepTrace` against the record's OTHER evidence for
 * the same events (docs/RECORD_FORMAT.md). A trace nobody checks is free text an
 * engine could write anything into; reconciled against the token count and the
 * repair lists, it becomes a claim that can be wrong:
 *
 *  - Σ `modelCallsAtStep` must equal `tokens.llmCalls`. Engines record the count
 *    at the same place they increment the counter, including on calls that then
 *    throw, so the identity holds across retries too (both are trial-scoped).
 *    Checked only when the record ships both.
 *  - Steps with a SUCCEEDED llm repair must be exactly `healedSteps`.
 *  - Steps with a SUCCEEDED deterministic repair must be exactly the union of
 *    `deterministicRepairSteps` (hybrid's B2 ladder) and `deterministicFallbacks`
 *    (stagehand's hand-written guards) — the two engines' names for the same
 *    "a deterministic tier fixed this step" fact; no engine writes both.
 *
 * Returns one message per divergence.
 */
function traceReconciliation(t: TrialResult): string[] {
  const messages: string[] = [];
  const trace = t.stepTrace ?? [];
  const repairLists = [
    ...(t.healedSteps ?? []),
    ...(t.deterministicRepairSteps ?? []),
    ...(t.deterministicFallbacks ?? [])
  ];

  // ── The reconciliation is NOT opt-in ───────────────────────────────────────
  // Every check below reads the trace, the token block, or both, so deleting
  // either silences it. Each strip is therefore itself a violation:
  //  (a) an engine that HAS escalation machinery must ship both, with a
  //      per-entry model-call count;
  //  (b) whatever the engine, a record whose OWN other fields claim model calls
  //      or repairs must ship the trace and counters that account for them.
  // (b) is engine-agnostic on purpose: it constrains the record against itself,
  // so a mislabelled engine cannot buy silence.
  const counted = trace.filter((e) => e.modelCallsAtStep !== undefined);
  const uncounted = trace.length - counted.length;
  if (t.engine !== "baseline") {
    if (t.tokens == null) {
      messages.push(
        `engine "${t.engine}" makes model calls but the record ships no tokens block — the model-call reconciliation cannot run`
      );
    }
    if (trace.length === 0) {
      messages.push(
        `engine "${t.engine}" owns an escalation path but the record ships no stepTrace — the repair reconciliation cannot run`
      );
    } else if (uncounted > 0) {
      messages.push(
        `engine "${t.engine}": ${uncounted} of ${trace.length} stepTrace entr(y/ies) omit modelCallsAtStep — the model-call reconciliation cannot run`
      );
    }
  }
  if ((t.tokens?.llmCalls ?? 0) > 0 && (trace.length === 0 || uncounted > 0)) {
    messages.push(
      `tokens.llmCalls records ${t.tokens?.llmCalls} model call(s) but the stepTrace does not account for them (${
        trace.length === 0 ? "no trace shipped" : `${uncounted} entr(y/ies) omit modelCallsAtStep`
      })`
    );
  }
  if (counted.length > 0 && t.tokens == null) {
    messages.push(
      "stepTrace accounts for model calls but the record ships no tokens block to reconcile them against"
    );
  }
  if (repairLists.length > 0 && trace.length === 0) {
    messages.push(
      `the record claims repair(s) at [${stepSet(repairLists)}] but ships no stepTrace to account for them`
    );
  }

  if (trace.length === 0) return messages;

  // ── Per-entry logical invariants ───────────────────────────────────────────
  for (const [i, entry] of trace.entries()) {
    for (const breach of traceEntryInvariants(entry)) {
      messages.push(`stepTrace[${i}] (step "${entry.step}"): ${breach}`);
    }
  }

  // ── Σ model calls ──────────────────────────────────────────────────────────
  if (counted.length > 0 && t.tokens) {
    const traced = counted.reduce((sum, e) => sum + (e.modelCallsAtStep ?? 0), 0);
    if (traced !== t.tokens.llmCalls) {
      messages.push(
        `stepTrace accounts for ${traced} model call(s) but tokens.llmCalls records ${t.tokens.llmCalls}`
      );
    }
  }

  const traced = (kind: "llm" | "deterministic", field: "repairSucceeded" | "repairAttempted") =>
    stepSet(trace.filter((e) => e[field] === true && e.repairKind === kind).map((e) => e.step));

  // ── Repair lists, each under ITS OWN semantics ─────────────────────────────
  // `healedSteps` and `deterministicRepairSteps` are written on SUCCESS;
  // `deterministicFallbacks` is pushed when a hand-written guard FIRES, before
  // anyone knows whether it cleared the blocker — so an honest stagehand record
  // of a guard that fired and failed has an ATTEMPTED trace entry and a
  // populated fallback list, and equating the two notions flags it as a forgery.
  // The lists are also engine-specific: hybrid writes deterministicRepairSteps
  // and never deterministicFallbacks, stagehand the reverse, so each is checked
  // only against the engine that writes it — otherwise a successful stagehand
  // guard reads as a missing deterministicRepairSteps entry and vice versa.
  const heals = traced("llm", "repairSucceeded");
  const recordedHeals = stepSet(t.healedSteps ?? []);
  if (heals !== recordedHeals) {
    messages.push(
      `stepTrace reports successful llm repair(s) at [${heals}] but healedSteps records [${recordedHeals}]`
    );
  }
  if (t.engine !== "stagehand") {
    const succeeded = traced("deterministic", "repairSucceeded");
    const recorded = stepSet(t.deterministicRepairSteps ?? []);
    if (succeeded !== recorded) {
      messages.push(
        `stepTrace reports SUCCESSFUL deterministic repair(s) at [${succeeded}] but deterministicRepairSteps records [${recorded}]`
      );
    }
  } else {
    const attempted = traced("deterministic", "repairAttempted");
    const recorded = stepSet(t.deterministicFallbacks ?? []);
    if (attempted !== recorded) {
      messages.push(
        `stepTrace reports ATTEMPTED deterministic guard(s) at [${attempted}] but deterministicFallbacks records [${recorded}] (a fallback records that a guard FIRED, not that it succeeded)`
      );
    }
  }

  return messages;
}

/**
 * Reconstruct the minimal PipelineResult the frozen judge reads from a recorded
 * TrialResult. The recorded trial data is the raw evidence; the judge reads
 * success, failureCategory/Detail, and (for reuse sessions / success-with-warnings
 * only) steps/normalized — neither of which is recorded. Phase-2A is fresh-session
 * and `expected: success` throughout (§3), so those unreconstructable branches
 * never fire; a reuse or success-with-warnings scenario would be out of scope.
 */
function pseudoResult(t: TrialResult): Parameters<typeof judge>[1] {
  const partial = {
    success: t.pipelineSuccess,
    steps: [] as never[],
    ...(t.failureCategory ? { failureCategory: t.failureCategory } : {}),
    ...(t.failureDetail ? { failureDetail: t.failureDetail } : {})
  };
  return partial as unknown as Parameters<typeof judge>[1];
}

/**
 * Every graded field of an AccuracyReport. A recomputation runs the SAME code on
 * the SAME inputs, and JSON round-trips doubles exactly, so a faithful record
 * matches on every one of these EXACTLY — no tolerance is warranted or applied.
 */
const ACCURACY_FIELDS = [
  "expectedRows",
  "matchedRows",
  "fieldChecks",
  "fieldMatches",
  "rowCoverage",
  "fieldAccuracy",
  "duplicateRows",
  "unexpectedRows",
  "score"
] as const;

/** First field on which a recorded accuracy report diverges from a recomputed one. */
function accuracyDivergence(
  page: "stats" | "odds",
  recorded: AccuracyReport | undefined,
  recomputed: AccuracyReport
): string | null {
  if (!recorded) {
    return `${page}: no accuracy report recorded, but the shipped rows recompute to one`;
  }
  for (const field of ACCURACY_FIELDS) {
    if (recorded[field] !== recomputed[field]) {
      return `${page}.${field}: recorded ${recorded[field]} ≠ recomputed ${recomputed[field]}`;
    }
  }
  return null;
}

/**
 * The oracle-defining fields of a scenario, normalized so absent chaos/params and
 * key ordering never masquerade as divergence: chaos is order-insensitive and
 * params collapses to null when absent. Used to cross-check a run's recorded
 * scenario against the supplied suite (check d).
 */
function oracleFields(s: ScenarioSpec): Record<string, unknown> {
  return {
    id: s.id,
    seed: s.seed,
    chaos: [...s.chaos].sort(),
    params: s.params ?? null,
    session: s.session,
    expected: s.expected
  };
}

/** First oracle field on which `recorded` diverges from `suiteSpec`, or null. */
function firstOracleDivergence(recorded: ScenarioSpec, suiteSpec: ScenarioSpec): string | null {
  const a = oracleFields(recorded);
  const b = oracleFields(suiteSpec);
  for (const field of ["id", "seed", "chaos", "params", "session", "expected"] as const) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return field;
  }
  return null;
}

/**
 * The pure verification core. Accepts already-read run inputs (source + raw
 * results.json content), the loaded suite, and the EXPECTED grid the caller
 * certifies against (which policies must be present, and how many distinct sweeps
 * per cell). Returns every gate violation plus the report-only prediction scores.
 * Never throws on a policy failure or a prediction miss.
 */
export function verifySuite(
  inputs: VerifyInput[],
  suite: LoadedScenarioSuite,
  expect: ExpectGrid
): VerifyReport {
  const violations: Violation[] = [];
  const notes: string[] = [];

  // The expected policies in canonical order (deterministic output), and the set
  // of configuration labels those policies may legitimately appear under.
  const expectedPolicies = ALL_POLICIES.filter((p) => expect.policies.includes(p));
  const imageLabels = new Set(expectedPolicies.map((p) => POLICY_LABEL[p]));

  // (a) SCHEMA — parse each run; a failure excludes it from later checks.
  const runs: { source: string; results: BenchmarkResults }[] = [];
  for (const input of inputs) {
    const parsed = BenchmarkResultsSchema.safeParse(input.raw);
    if (!parsed.success) {
      violations.push(
        reason(
          "schema",
          `${input.source}: results.json failed BenchmarkResultsSchema — ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        )
      );
      continue;
    }
    runs.push({ source: input.source, results: parsed.data });
  }

  if (runs.length === 0) {
    return {
      ok: violations.length === 0,
      violations,
      predictions: [],
      notes,
      records: { total: 0, recomputed: 0, v2NoRows: 0, attestedV1: 0 }
    };
  }

  // A run halted by the pre-trial budget stop (PROTOCOL_2A §7) carries `stopped`.
  // Surface it as a NOTE for the human reader — never a violation. The
  // completeness checks below already catch the shortfall a stopped run leaves in
  // the grid; this note just explains WHY the campaign is incomplete evidence.
  for (const { source, results } of runs) {
    if (results.stopped) {
      notes.push(
        `${source}: run is marked stopped (${results.stopped.reason}) — incomplete campaign evidence`
      );
    }
  }

  // (b) PROVENANCE — per-run presence + cross-run uniformity + suite match.
  const stampSets = {
    gitCommit: new Set<string>(),
    promptsHash: new Set<string>(),
    lockfileHash: new Set<string>(),
    protocolId: new Set<string>(),
    suiteHash: new Set<string>()
  };
  for (const { source, results } of runs) {
    const env = results.environment;
    if (env.gitCommit == null) violations.push(reason("provenance", `${source}: gitCommit is missing`));
    else stampSets.gitCommit.add(env.gitCommit);
    if (env.gitDirty !== false) {
      violations.push(reason("provenance", `${source}: gitDirty must be false (got ${env.gitDirty})`));
    }
    if (!env.promptsHash) violations.push(reason("provenance", `${source}: promptsHash is missing`));
    else stampSets.promptsHash.add(env.promptsHash);
    if (!env.lockfileHash) violations.push(reason("provenance", `${source}: lockfileHash is missing`));
    else stampSets.lockfileHash.add(env.lockfileHash);
    if (!env.protocolId) violations.push(reason("provenance", `${source}: protocolId is missing`));
    else stampSets.protocolId.add(env.protocolId);
    if (!env.suiteHash) violations.push(reason("provenance", `${source}: suiteHash is missing`));
    else stampSets.suiteHash.add(env.suiteHash);
    // repairMode is required where applicable: a run that exercised the hybrid engine.
    const hasHybrid = results.trials.some((t) => t.engine === "hybrid");
    if (hasHybrid && env.repairMode === undefined) {
      violations.push(reason("provenance", `${source}: repairMode is missing for a hybrid run`));
    }
    if (env.protocolId !== undefined && env.protocolId !== suite.protocolId) {
      violations.push(
        reason(
          "provenance",
          `${source}: protocolId "${env.protocolId}" does not match the supplied suite "${suite.protocolId}"`
        )
      );
    }
    if (env.suiteHash !== undefined && env.suiteHash !== suite.suiteHash) {
      violations.push(
        reason(
          "provenance",
          `${source}: suiteHash "${env.suiteHash}" does not match the supplied suite hash "${suite.suiteHash}"`
        )
      );
    }
    // ── v2 PROVENANCE PRESENCE (docs/RECORD_FORMAT.md) ───────────────────────
    // Provenance is part of the record, not an optional garnish. The v2 fields
    // are schema-OPTIONAL so version-1 bundles keep parsing byte-for-byte, which
    // means the schema alone lets a v2 run drop every one of them and still
    // validate — the stamps would be present exactly when a producer felt like
    // it. Presence is therefore required HERE, for v2 runs only. A key whose
    // honest value is unknown says so with null; it never says so by omission,
    // because an absent key and a null one are different claims and only one of
    // them is checkable.
    const runIsV2 = results.trials.some((t) => declaredRecordVersion(t) === 2);
    if (runIsV2) {
      // modelConfig — what the model was configured to do. Re-validated
      // structurally rather than assumed from the parse: the check the verifier
      // makes should not depend on a schema branch elsewhere staying optional.
      const modelConfig = env.modelConfig;
      const temperatureSources = ["explicit", "provider-default", "n/a-no-model"];
      if (!Object.hasOwn(env, "modelConfig") || modelConfig === undefined) {
        violations.push(
          reason("provenance", `${source}: environment.modelConfig is missing (record version 2 requires it)`)
        );
      } else if (
        !(modelConfig.temperature === null || typeof modelConfig.temperature === "number") ||
        !temperatureSources.includes(modelConfig.temperatureSource)
      ) {
        violations.push(
          reason(
            "provenance",
            `${source}: environment.modelConfig is malformed — temperature must be a number or null and temperatureSource one of ${temperatureSources.join(
              ", "
            )} (got ${JSON.stringify(modelConfig)})`
          )
        );
      } else {
        // ── modelConfig SEMANTIC CONSISTENCY ─────────────────────────────────
        // Presence is not consistency: a well-formed modelConfig can still
        // describe a run that cannot exist — "no model was configured" on a run
        // that names one, or "the provider's default" on a run with no model to
        // have a default. The recorder derives the source from ONE condition
        // (runner.ts:552, `envConfig.stagehandModel ? "provider-default" :
        // "n/a-no-model"`), and stamps `environment.stagehandModel` from the
        // IDENTICAL expression three lines above it (runner.ts:540) — so the
        // presence of that key is the same notion, in the portable record, and
        // honest output cannot violate these rules by construction.
        //
        // `modelProvider` is deliberately NOT used: it is a different notion
        // (config.ts:29 lets STAGEHAND_MODEL name a model with no provider key
        // set), so keying on it would reject an honest record.
        const modelConfigured = Object.hasOwn(env, "stagehandModel");
        const named = modelConfigured ? `"${env.stagehandModel}"` : "(none)";
        const temperature = modelConfig.temperature;
        if (modelConfigured && modelConfig.temperatureSource === "n/a-no-model") {
          violations.push(
            reason(
              "provenance",
              `${source}: environment.modelConfig.temperatureSource is "n/a-no-model" but the run configured the model ${named} — a run cannot both name a model and record that the temperature question did not arise`
            )
          );
        }
        if (!modelConfigured && modelConfig.temperatureSource !== "n/a-no-model") {
          violations.push(
            reason(
              "provenance",
              `${source}: environment.modelConfig.temperatureSource is "${modelConfig.temperatureSource}" but the run configured no model (environment.stagehandModel absent) — with no model there is no temperature source to report but "n/a-no-model"`
            )
          );
        }
        if (modelConfig.temperatureSource !== "explicit" && temperature !== null) {
          violations.push(
            reason(
              "provenance",
              `${source}: environment.modelConfig records temperature ${JSON.stringify(
                temperature
              )} with temperatureSource "${modelConfig.temperatureSource}" — a temperature this repo did not choose is recorded as null`
            )
          );
        }
        if (modelConfig.temperatureSource === "explicit" && typeof temperature !== "number") {
          violations.push(
            reason(
              "provenance",
              `${source}: environment.modelConfig.temperatureSource is "explicit" but temperature is ${JSON.stringify(
                temperature
              )} — an explicitly set temperature is the number that was set`
            )
          );
        }
      }
      // ── A MODELLESS RUN CANNOT HAVE SPENT INFERENCE ────────────────────────
      // The consistency rules above bind modelConfig to the model signal, which
      // leaves one way to launder a keyed record into a keyless-looking one:
      // delete `stagehandModel`, null `modelProvider`, stamp "n/a-no-model" —
      // internally consistent, and free of the "this run used a model" evidence
      // a reader would weigh. The trials still say otherwise. A run that
      // configured no model has nothing to call, so every trial must report no
      // spend: `tokens === null` (the baseline, which never has a model client at
      // all) or a token block whose every usage and cost counter is zero (a
      // Stagehand-backed engine whose repair path was key-gated shut). Verified
      // against real keyless output, where the baseline records null and hybrid
      // records an all-zero block.
      //
      // ONE-DIRECTIONAL by design: a run that DID configure a model is free to
      // spend nothing — a keyed sweep in which no step ever escalated is an
      // ordinary, and rather good, result. Only calls-without-a-model is a
      // contradiction.
      if (!Object.hasOwn(env, "stagehandModel")) {
        for (const t of results.trials) {
          // `tokens: null` is the baseline's honest record — it has no model
          // client to ask for metrics — and says nothing to contradict.
          if (t.tokens == null) continue;
          // EVERY counter, not just llmCalls: the token block's fields are
          // independent in the schema, so zeroing only the call count while
          // keeping the usage leaves an impossible record that the narrower
          // check waved through. Read off the BLOCK ITSELF rather than a
          // hardcoded field list — every field TokensUsageSchema admits is a
          // usage or cost counter, so one added later is covered the day it
          // first appears in a record, with no edit here.
          const nonzero = Object.entries(t.tokens)
            .filter(([, value]) => typeof value === "number" && value !== 0)
            .map(([field, value]) => `${field} ${value}`);
          if (nonzero.length > 0) {
            violations.push(
              reason(
                "provenance",
                `${source}/${t.runId}: the run configured no model (environment.stagehandModel absent) yet this trial records ${nonzero.join(
                  ", "
                )} — a run with no model cannot have spent inference, so every usage and cost counter must be zero`
              )
            );
          }
        }
      }
      // pricesPinnedAt — which price table the run's costs are derived from.
      if (!Object.hasOwn(env, "pricesPinnedAt") || env.pricesPinnedAt === undefined) {
        violations.push(
          reason("provenance", `${source}: environment.pricesPinnedAt is missing (record version 2 requires it)`)
        );
      } else if (typeof env.pricesPinnedAt !== "string" || env.pricesPinnedAt.length === 0) {
        violations.push(
          reason(
            "provenance",
            `${source}: environment.pricesPinnedAt must be a non-empty date string (got ${JSON.stringify(
              env.pricesPinnedAt
            )})`
          )
        );
      }
      // chromeVersion, per trial: the KEY must be there. Its VALUE may be null —
      // that is the recorder's honest "the read failed", and a legitimate record.
      for (const t of results.trials) {
        if (!Object.hasOwn(t, "chromeVersion")) {
          violations.push(
            reason(
              "provenance",
              `${source}/${t.runId}: chromeVersion is missing (record version 2 requires the key; null is the value for an unknown build)`
            )
          );
        }
      }
      // …and at the run level, where the key is required even though unanimity
      // legitimately re-derives null on a mixed-engine run.
      if (!Object.hasOwn(env, "chromeVersion")) {
        violations.push(
          reason(
            "provenance",
            `${source}: environment.chromeVersion is missing (record version 2 requires the key; null is the value when the run's trials do not agree on one build)`
          )
        );
      }
    }
    // The run-level browser build is a SUMMARY of the per-trial values, so its
    // VALUE is re-derived with the recorder's own rule rather than trusted. It is
    // checked only where the per-trial facts exist to derive it from — a v1 run
    // records neither. (Deriving null from a v2 run that reported nothing is
    // correct: the rule already says silence is not a vote.)
    if (runIsV2) {
      const derivedChrome = unanimousChromeVersion(results.trials);
      const recordedChrome = env.chromeVersion ?? null;
      if (derivedChrome !== recordedChrome) {
        violations.push(
          reason(
            "provenance",
            `${source}: environment.chromeVersion ${
              recordedChrome === null ? "null" : `"${recordedChrome}"`
            } ≠ ${
              derivedChrome === null ? "null" : `"${derivedChrome}"`
            } re-derived from the per-trial values (a run is labelled with a build only when every trial reported the same one)`
          )
        );
      }
    }
    // ── Record format version (docs/RECORD_FORMAT.md) ────────────────────────
    // INTRA-RUN UNIFORMITY: one execution writes one record format, so every
    // trial in a results.json must declare the same version (absent ≡ 1). A run
    // whose trials disagree has had records rewritten — the exact tell of a
    // single v2 trial downgraded to v1 (its rows and canonical block deleted) so
    // its counters are re-graded from themselves instead of from raw output,
    // while its siblings still look recomputable.
    const declaredVersions = [...new Set(results.trials.map(declaredRecordVersion))].sort(
      (a, b) => a - b
    );
    if (declaredVersions.length > 1) {
      violations.push(
        reason(
          "provenance",
          `${source}: trials declare mixed record versions (${declaredVersions.join(
            ", "
          )}) — every trial in one run must declare the same record version (an absent recordVersion IS version 1)`
        )
      );
    }
    // DECLARED EXPECTATION: when the caller passes --expect-record-version, every
    // trial must declare exactly it. Phase 2B and later campaigns pass 2
    // (PROTOCOL_2B §Gates), so no trial in a certified bundle can sit on the
    // attested-v1 path at all.
    if (expect.recordVersion !== undefined) {
      for (const t of results.trials) {
        const declared = declaredRecordVersion(t);
        if (declared !== expect.recordVersion) {
          violations.push(
            reason(
              "provenance",
              `${source}/${t.runId}: trial declares record version ${declared}${
                t.recordVersion === undefined ? " (recordVersion absent)" : ""
              }, but --expect-record-version ${expect.recordVersion} was given`
            )
          );
        }
      }
    }
  }
  for (const [field, values] of Object.entries(stampSets)) {
    if (values.size > 1) {
      violations.push(
        reason("provenance", `runs disagree on environment.${field}: ${[...values].join(", ")}`)
      );
    }
  }

  // (c) COMPLETENESS — the observed runs must realise the declared expect-grid.
  const suiteIds = suite.scenarios.map((s) => s.id);
  const suiteIdSet = new Set(suiteIds);

  // Per-cell tallies keyed by (scenarioId, configurationLabel).
  const cellKey = (scenarioId: string, config: string) => `${scenarioId} ${config}`;
  const cellTrials = new Map<string, number>(); // trial count in the cell
  const cellBenchIds = new Map<string, Set<string>>(); // distinct source runs contributing
  const observedConfigCount = new Map<string, number>(); // total trials per observed label
  const reportedForeign = new Set<string>(); // dedupe the not-in-suite message per (source, id)
  for (const { source, results } of runs) {
    let artifactsMismatch = 0;
    let firstBadArtifactsDir: string | undefined;
    for (const t of results.trials) {
      const config = configurationLabel(t.engine, results.environment);
      observedConfigCount.set(config, (observedConfigCount.get(config) ?? 0) + 1);
      const key = cellKey(t.scenarioId, config);
      cellTrials.set(key, (cellTrials.get(key) ?? 0) + 1);
      let ids = cellBenchIds.get(key);
      if (!ids) {
        ids = new Set<string>();
        cellBenchIds.set(key, ids);
      }
      ids.add(results.benchId);
      // c.5 — every trial's scenario must be in the supplied suite.
      if (!suiteIdSet.has(t.scenarioId)) {
        const fk = `${source} ${t.scenarioId}`;
        if (!reportedForeign.has(fk)) {
          reportedForeign.add(fk);
          violations.push(
            reason("completeness", `${source}: trial for scenario "${t.scenarioId}" not present in the supplied suite`)
          );
        }
      }
      // c.6 — internal consistency: every trial's artifactsDir embeds the run's own
      // benchId (the runner writes each trial under runs/<benchId>/...; verified to
      // hold on every real results.json). A trial whose artifactsDir omits the
      // recorded benchId means the file is self-inconsistent — the exact tell of a
      // relabeled copy whose benchId field was edited but whose trial artifact paths
      // were not.
      if (!t.artifactsDir.includes(results.benchId)) {
        artifactsMismatch += 1;
        if (firstBadArtifactsDir === undefined) firstBadArtifactsDir = t.artifactsDir;
      }
    }
    if (artifactsMismatch > 0) {
      violations.push(
        reason(
          "completeness",
          `${source}: ${artifactsMismatch} of ${results.trials.length} trial(s) have an artifactsDir not containing the run's benchId "${results.benchId}" (e.g. "${firstBadArtifactsDir}") — a relabeled copy whose benchId was edited but whose trial artifact paths were not`
        )
      );
    }
  }

  // c.1 exact per-cell trial count + c.2 distinct-run sweep count, per expected policy.
  for (const policy of expectedPolicies) {
    const label = POLICY_LABEL[policy];
    let policyTotal = 0;
    for (const id of suiteIds) policyTotal += cellTrials.get(cellKey(id, label)) ?? 0;
    // A policy entirely absent gets ONE aggregated line — never one per scenario.
    if (policyTotal === 0) {
      violations.push(reason("completeness", `policy ${policy} ("${label}"): no trials for any suite scenario`));
      continue;
    }
    // c.1 — exact trial count per (scenario, policy) cell.
    for (const id of suiteIds) {
      const got = cellTrials.get(cellKey(id, label)) ?? 0;
      if (got !== expect.trials) {
        violations.push(
          reason("completeness", `policy ${policy} ("${label}") scenario "${id}": got ${got} trial(s), want ${expect.trials}`)
        );
      }
    }
    // c.2 — the trials in each correctly-counted cell must come from expect.trials
    // DISTINCT runs (one sweep each). Cells that already fail c.1 are c.1's to report.
    const badDistinct: { id: string; distinct: number }[] = [];
    for (const id of suiteIds) {
      const got = cellTrials.get(cellKey(id, label)) ?? 0;
      if (got !== expect.trials) continue;
      const distinct = cellBenchIds.get(cellKey(id, label))?.size ?? 0;
      if (distinct !== expect.trials) badDistinct.push({ id, distinct });
    }
    if (badDistinct.length > 0) {
      if (badDistinct.length === suiteIds.length) {
        // Holds for every scenario → aggregate to one readable line.
        const distincts = [...new Set(badDistinct.map((b) => b.distinct))].sort((a, b) => a - b).join("/");
        violations.push(
          reason(
            "completeness",
            `policy ${policy} ("${label}"): each scenario's ${expect.trials} trials come from ${distincts} distinct run(s), need ${expect.trials} distinct sweep(s) (a single run's repeated trials are not separate sweeps)`
          )
        );
      } else {
        for (const b of badDistinct) {
          violations.push(
            reason(
              "completeness",
              `policy ${policy} ("${label}") scenario "${b.id}": ${expect.trials} trials come from ${b.distinct} distinct run(s), need ${expect.trials} distinct sweep(s)`
            )
          );
        }
      }
    }
  }

  // c.3 — any observed configuration that is not the image of an expected policy.
  // Catches hybrid-keyless presented as C, seeded/warm C variants, smoke prefixes, etc.
  for (const config of [...observedConfigCount.keys()].sort()) {
    if (imageLabels.has(config)) continue;
    const n = observedConfigCount.get(config) ?? 0;
    violations.push(
      reason(
        "completeness",
        `unexpected configuration "${config}" (${n} trial(s)) — not among expected policies [${expectedPolicies.join(", ")}]`
      )
    );
  }

  // c.4 — duplicate-run rejection: shared benchId, or identical TRIAL CONTENT after
  // NORMALIZING RUN-IDENTITY STRINGS. Before hashing, each run's {scenarios, trials}
  // is canonicalized by replacing every occurrence of EVERY input run's benchId (all
  // inputs', not just the run's own — see below) in every string with the single
  // placeholder "«benchId»", so identity-only edits cannot change the hash. This
  // SUBSUMES the old raw-content hash (byte-identical trial content still collides)
  // and catches two forgeries:
  //   (a) a relabel-only copy — benchId edited, trial artifact paths untouched (also
  //       caught by c.6, which sees the paths still carry the ORIGINAL benchId); and
  //   (b) a consistent-replacement copy — benchId edited AND rewritten inside every
  //       artifactsDir / derived string: c.6 stays silent because the file is now
  //       self-consistent, so ONLY this canonical hash catches it (found by the
  //       external audit of freeze-v2).
  // We normalize ALL inputs' benchIds rather than each run's OWN because a
  // relabel-only copy's paths still embed the ORIGINAL's benchId; own-id-only
  // replacement would be asymmetric and un-catch that case (adversarial (g)). Ids are
  // applied longest-first so a benchId that is a substring of another is replaced only
  // after the longer one. Genuine separate sweeps still differ (distinct wall-clock
  // durationMs at minimum), so this never false-positives on real runs.
  const allBenchIds = [...new Set(runs.map((r) => r.results.benchId))].sort((a, b) => b.length - a.length);
  const benchIdCounts = new Map<string, number>();
  const trialContentSources = new Map<string, string[]>();
  const createdAtSources = new Map<string, string[]>();
  for (const { source, results } of runs) {
    benchIdCounts.set(results.benchId, (benchIdCounts.get(results.benchId) ?? 0) + 1);
    const canonical = canonicalizeRunIdentity({ scenarios: results.scenarios, trials: results.trials }, allBenchIds);
    const trialHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const tBucket = trialContentSources.get(trialHash);
    if (tBucket) tBucket.push(source);
    else trialContentSources.set(trialHash, [source]);
    const cBucket = createdAtSources.get(results.createdAt);
    if (cBucket) cBucket.push(source);
    else createdAtSources.set(results.createdAt, [source]);
  }
  for (const [benchId, count] of benchIdCounts) {
    if (count > 1) {
      violations.push(
        reason("completeness", `duplicate benchId "${benchId}" appears in ${count} run inputs — each sweep must be a distinct run`)
      );
    }
  }
  for (const sources of trialContentSources.values()) {
    if (sources.length > 1) {
      violations.push(
        reason(
          "completeness",
          `inputs ${joinSources(sources)} contain identical trial content (after normalizing run-identity strings) — a relabeled copy of one run is not a distinct sweep`
        )
      );
    }
  }
  // c.4 advisory (NEVER a violation): a top-level createdAt shared across inputs is
  // suspicious — independent sweeps start at different wall-clock times — but not
  // conclusive on its own, so it is surfaced as a NOTE only.
  for (const [createdAt, sources] of createdAtSources) {
    if (sources.length > 1) {
      notes.push(
        `NOTE: inputs ${joinSources(sources)} share an identical createdAt "${createdAt}" — suspicious for independent sweeps, but not conclusive`
      );
    }
  }

  // (d) GRADING — recompute the judge + classifier from raw trial data against the
  // SUPPLIED SUITE's oracle (never the run's own recorded scenario), and cross-check
  // that the run's recorded oracle agrees with the suite.
  const oracleById = new Map<string, ScenarioSpec>(suite.scenarios.map((s) => [s.id, suiteScenarioToSpec(s)]));
  // The ground-truth oracle a scenario's trials MUST have been graded against,
  // RE-DERIVED from the SUPPLIED SUITE's scenario rather than read from the run.
  // The lab derives its truth and overrides deterministically from the seed and
  // nothing else (apps/lab/src/state.ts: generateGroundTruth(seed) then
  // computeDisplayOverrides(truth, chaos, seed) — `params` are presentation-only
  // and never touch truth or overrides, so they are deliberately not passed
  // here), so this reproduces exactly what the lab served. Memoized: it is a pure
  // function of the suite, identical for every run and every trial.
  const derivedOracles = new Map<string, TrialOracle>();
  const deriveOracle = (spec: ScenarioSpec): TrialOracle => {
    let derived = derivedOracles.get(spec.id);
    if (!derived) {
      const truth = generateGroundTruth(spec.seed);
      derived = { truth, overrides: computeDisplayOverrides(truth, spec.chaos, spec.seed) };
      derivedOracles.set(spec.id, derived);
    }
    return derived;
  };
  const records: RecordProvenance = { total: 0, recomputed: 0, v2NoRows: 0, attestedV1: 0 };
  for (const { source, results } of runs) {
    const recordedById = new Map<string, ScenarioSpec>(results.scenarios.map((s) => [s.id, s]));
    const crossChecked = new Set<string>(); // once per scenario per run
    const oracleChecked = new Set<string>(); // once per scenario per run
    for (const t of results.trials) {
      // Provenance tally covers EVERY trial in a schema-valid run, including one
      // whose scenario is foreign to the suite (already a completeness violation).
      // v1 is settled here; a v2 record's class depends on what the recompute
      // below could actually do, so it is counted there and NOWHERE else.
      records.total += 1;
      const isV2 = declaredRecordVersion(t) === 2;
      if (!isV2) records.attestedV1 += 1;

      const suiteSpec = oracleById.get(t.scenarioId);
      // A trial whose scenario is not in the suite is a completeness violation
      // already; there is no oracle to grade it against, so skip grading.
      if (!suiteSpec) continue;

      // Cross-check the run's recorded oracle against the supplied suite (once).
      if (!crossChecked.has(t.scenarioId)) {
        crossChecked.add(t.scenarioId);
        const recorded = recordedById.get(t.scenarioId);
        if (!recorded) {
          violations.push(
            reason("grading", `${source}: no scenario "${t.scenarioId}" in the run's recorded scenarios`)
          );
        } else {
          const field = firstOracleDivergence(recorded, suiteSpec);
          if (field) {
            violations.push(
              reason("grading", `run-recorded scenario oracle for "${t.scenarioId}" diverges from the supplied suite (${field})`)
            );
          }
        }
      }

      // A v1 record ships only the OUTPUTS of grading, so the counter-based
      // re-grade below is all it can support (unchanged behaviour). A v2 record
      // ships the INPUTS, so the counters themselves are recomputed here from
      // `canonical` × the RE-DERIVED oracle using the runner's own scoring
      // module, and the judge is then fed the RECOMPUTED reports — so a tampered
      // row surfaces both as a counter divergence and as any judged-outcome
      // change it causes.
      let overall = t.accuracy?.overall;
      let reports = t.accuracy ? { stats: t.accuracy.stats, odds: t.accuracy.odds } : undefined;
      if (isV2) {
        // ── CERTIFIED SCOPE ──────────────────────────────────────────────────
        // The recompute replays the frozen judge against a RECONSTRUCTED
        // PipelineResult (see pseudoResult), which carries no steps and no
        // normalized dataset. Two scenario modes read exactly those fields, so
        // the replay cannot reproduce their branches faithfully:
        //   · session "reuse" — the success branch asks whether a `login` step
        //     ran (runner.ts, `noLoginOk`); with no steps the answer is always
        //     "no login", which silently turns the check off.
        //   · expected "success-with-warnings" — that branch counts
        //     `result.normalized.warnings`; with no dataset the count is always
        //     0, which always fails.
        // Rather than grade them wrongly in either direction, the verifier
        // REFUSES them. Fresh/expired sessions with `success` or
        // `validation-failure` expectations are the certified scope, and cover
        // every scenario in every suite shipped to date.
        if (suiteSpec.session === "reuse" || suiteSpec.expected === "success-with-warnings") {
          const mode =
            suiteSpec.session === "reuse"
              ? `session "reuse"`
              : `expected "success-with-warnings"`;
          violations.push(
            reason(
              "grading",
              `${source}/${t.runId}: scenario "${t.scenarioId}" declares ${mode}, which is OUTSIDE the record-version-2 recompute's certified scope — the replayed judge reads pipeline state (steps / dataset warnings) that a record does not ship, so this trial cannot be re-graded faithfully`
            )
          );
        }
        // The oracle used for GRADING is always the re-derived one — never the
        // run's. The run's own `oracles` entry is evidence to be checked, exactly
        // as the run's recorded scenario is checked against the suite above.
        const derived = deriveOracle(suiteSpec);
        // `oracles` is a plain JSON object, so a scenario id that names an
        // Object.prototype member ("constructor", "toString", …) would otherwise
        // resolve up the prototype chain and pass as a shipped oracle.
        const oracle =
          results.oracles !== undefined && Object.hasOwn(results.oracles, t.scenarioId)
            ? results.oracles[t.scenarioId]
            : undefined;
        const canonical = t.canonical;
        // THE SHIPPED ORACLE IS NEVER TRUSTED (docs/RECORD_FORMAT.md). Rewriting
        // rows and oracle together — or injecting `kind: "corrupt"` overrides that
        // make the scorer skip the tampered cells — recomputes perfectly against
        // the run's own oracle, so the run's oracle must itself equal the one
        // re-derived from the supplied suite's seed. Same principle as the frozen
        // "grade against the suite's oracle, never the run's own" rule. Once per
        // scenario per run: every trial of a scenario shares the entry.
        if (oracle && !oracleChecked.has(t.scenarioId)) {
          oracleChecked.add(t.scenarioId);
          for (const field of ["truth", "overrides"] as const) {
            if (stableJson(oracle[field]) !== stableJson(derived[field])) {
              violations.push(
                reason(
                  "grading",
                  `${source}: the run's recorded oracle for scenario "${t.scenarioId}" diverges from the oracle re-derived from the supplied suite's seed (${field}) — a v2 record cannot be forged by editing rows and oracle together`
                )
              );
            }
          }
        }
        if (!canonical) {
          violations.push(
            reason(
              "grading",
              `${source}/${t.runId}: record version 2 but no canonical rows — accuracy cannot be recomputed`
            )
          );
        } else if (!oracle) {
          violations.push(
            reason(
              "grading",
              `${source}/${t.runId}: record version 2 but the run ships no oracles entry for scenario "${t.scenarioId}" — accuracy cannot be recomputed`
            )
          );
        } else if (canonical.stats === null && canonical.odds === null) {
          // No normalized dataset was produced, so nothing was scored. This is the
          // honest v2 HARD-FAILURE shape: there are no rows to recompute from, so
          // it is counted as its own provenance class — never as "recomputed". It
          // is not trusted blindly either: the record must be CONSISTENT with the
          // claim it makes. A trial that produced no dataset claims no accuracy…
          let consistent = true;
          // …and produced no raw payload either. The pipeline builds a dataset
          // from WHATEVER a completed attempt returned — an unparseable page still
          // yields empty rows — so the only way to have no rows at all is for the
          // attempt never to have completed, which means no payload either.
          if (canonical.raw.stats !== null || canonical.raw.odds !== null) {
            consistent = false;
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: canonical ships no normalized rows for either page, yet ships a raw payload (stats ${
                  canonical.raw.stats === null ? "null" : "present"
                }, odds ${
                  canonical.raw.odds === null ? "null" : "present"
                }) — a completed attempt always builds a dataset, so raw without rows is malformed`
              )
            );
          }
          if (t.accuracy !== null) {
            consistent = false;
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: canonical ships no rows for either page, yet an accuracy report is recorded`
              )
            );
          }
          // …and it cannot have SUCCEEDED at ANY stage. The pipeline derives all
          // three flags from a dataset it never built (runPipeline's no-outcome
          // path hard-codes `validation: { extractOk: false, domainOk: false }`
          // and `success: false`), so any of them set true on a no-rows record is
          // a claim the record's own contents refute — extractionSuccess
          // included: there was no payload to run an extraction check over.
          const claimed = [
            ...(t.pipelineSuccess ? ["pipelineSuccess"] : []),
            ...(t.extractionSuccess ? ["extractionSuccess"] : []),
            ...(t.validationSuccess ? ["validationSuccess"] : [])
          ];
          if (claimed.length > 0) {
            consistent = false;
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: canonical ships no rows for either page, yet the record claims ${claimed.join(
                  " and "
                )} true — a trial that produced no normalized dataset succeeded at none of them`
              )
            );
          }
          // …and it annotated nothing, because normalization never ran. Non-empty
          // failures/warnings on a no-payload record are invented: there is no
          // dataset for them to describe and nothing to re-derive them from.
          const annotated = [
            ...(canonical.failures.length > 0 ? [`${canonical.failures.length} failure(s)`] : []),
            ...(canonical.warnings.length > 0 ? [`${canonical.warnings.length} warning(s)`] : [])
          ];
          if (annotated.length > 0) {
            consistent = false;
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: canonical ships no rows for either page, yet records ${annotated.join(
                  " and "
                )} — normalization never ran, so both lists must be empty`
              )
            );
          }
          // …and it cannot claim the one category the pipeline derives ONLY after
          // a dataset exists. `"validation"` is emitted at exactly one site —
          // runPipeline.ts:289, on the completed-outcome path, as
          // `!extractOk ? "extraction" : "validation"` — so a record with no
          // payload cannot honestly carry it.
          //
          // This is the difference between a degradation and a forgery. Deleting
          // evidence normally degrades a record toward FAIL, which the format
          // accepts as an offline limit. But `validation-failure` scenarios judge
          // PASS on exactly `failureCategory === "validation"` (the judge's
          // validation-failure branch, runner.ts:870), so on those scenarios
          // deletion plus that one word would manufacture the expected outcome and
          // reach a judged PASS with no evidence at all. That path is closed here.
          //
          // NARROWED DELIBERATELY to "validation": `"extraction"` IS honestly
          // reachable with no payload — an extract step that throws carries it out
          // of runPipeline's no-outcome path (hybrid/engine.ts:530,540 and the
          // runStep fallbacks at hybrid:782,854 / stagehand:579,630). A keyless
          // layout-variant hybrid trial produces exactly that record, so banning it
          // would reject real evidence — and it closes nothing, because the judge
          // fails an `extraction` category on every expected mode.
          if (t.failureCategory === "validation") {
            consistent = false;
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: canonical ships no rows for either page, yet failureCategory is "validation" — the pipeline derives that category only from a dataset it built (runPipeline's completed-outcome path), so a record with no payload cannot have earned it`
              )
            );
          }
          if (consistent) records.v2NoRows += 1;
        } else if (canonical.stats === null || canonical.odds === null) {
          violations.push(
            reason(
              "grading",
              `${source}/${t.runId}: canonical ships rows for only one page (stats ${
                canonical.stats === null ? "null" : "present"
              }, odds ${canonical.odds === null ? "null" : "present"}) — the scorer consumed both, so accuracy cannot be recomputed`
            )
          );
        } else {
          // ── The grading chain, re-run from `canonical.raw` ──────────────────
          // Stage 1: the EXTRACTION SCHEMA CHECKS. `extractionSuccess` is the
          // verdict of running these over the raw payloads, so with raw shipped it
          // is recomputed, not attested. runPipeline only checks a page it was
          // ASKED for, so the requested set is part of the verdict's definition:
          // the record states it in `pagesRequested` (absent = both, which every
          // bench run to date is) and the recomputation honours exactly that.
          const requested = t.pagesRequested ?? ["stats", "odds"];
          const statsCheck = requested.includes("stats")
            ? checkStatsSchema(canonical.raw.stats)
            : undefined;
          const oddsCheck = requested.includes("odds")
            ? checkOddsSchema(canonical.raw.odds)
            : undefined;
          const checkIssues = [...(statsCheck?.issues ?? []), ...(oddsCheck?.issues ?? [])];
          const recomputedExtract = (statsCheck?.ok ?? true) && (oddsCheck?.ok ?? true);
          if (recomputedExtract !== t.extractionSuccess) {
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: recorded extractionSuccess ${t.extractionSuccess} ≠ recomputed ${recomputedExtract} from the shipped raw payloads${
                  checkIssues[0] ? ` (first issue: ${checkIssues[0]})` : ""
                }`
              )
            );
          }

          // Stage 2: NORMALIZATION. The shipped rows and the dataset annotations
          // must be exactly what the runner's normalizers produce from that raw —
          // otherwise a forger could ship genuine-looking rows with, say, the
          // failures array stripped so the domain validator has nothing to fire on.
          const derivedDataset = buildDataset({
            engine: t.engine,
            source: results.labUrl,
            ...(statsCheck?.parsed ? { stats: normalizeStats(statsCheck.parsed) } : {}),
            ...(oddsCheck?.parsed ? { odds: normalizeOdds(oddsCheck.parsed) } : {})
          });
          for (const [field, shipped, derivedValue] of [
            ["stats rows", canonical.stats, derivedDataset.teams],
            ["odds rows", canonical.odds, derivedDataset.markets],
            ["failures", canonical.failures, derivedDataset.failures],
            ["warnings", canonical.warnings, derivedDataset.warnings]
          ] as const) {
            if (stableJson(shipped) !== stableJson(derivedValue)) {
              violations.push(
                reason(
                  "grading",
                  `${source}/${t.runId}: shipped canonical ${field} do not follow from the shipped raw payloads (normalization derives ${
                    Array.isArray(derivedValue) ? derivedValue.length : 0
                  } entr(y/ies), the record ships ${Array.isArray(shipped) ? shipped.length : 0})`
                )
              );
            }
          }

          // Every stage below consumes the DERIVED values, never the shipped ones:
          // where they agree this is equivalent, and where they do not the shipped
          // claim has already been rejected above and must not silently feed the
          // rest of the chain.
          // Stage 5: accuracy, graded against the RE-DERIVED oracle.
          const statsReport = scoreStats(derivedDataset.teams, derived.truth, derived.overrides);
          const oddsReport = scoreOdds(derivedDataset.markets, derived.truth, derived.overrides);
          const recomputedOverall = overallAccuracy(statsReport, oddsReport);
          for (const divergence of [
            accuracyDivergence("stats", t.accuracy?.stats, statsReport),
            accuracyDivergence("odds", t.accuracy?.odds, oddsReport)
          ]) {
            if (divergence) {
              violations.push(
                reason(
                  "grading",
                  `${source}/${t.runId}: recorded accuracy does not follow from the shipped raw payloads — ${divergence}`
                )
              );
            }
          }
          if (t.accuracy?.overall !== recomputedOverall) {
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: recorded overall accuracy ${
                  t.accuracy?.overall ?? "(absent)"
                } ≠ recomputed ${recomputedOverall ?? "(absent)"}`
              )
            );
          }
          // Stages 3 and 4: the DOMAIN ASSESSMENT and the pipeline identities,
          // both re-derived over the DERIVED dataset by the same validator the
          // pipeline ran — so neither verdict can be flipped into a pass while the
          // rows stay genuine (the booleans the judge reads are otherwise pure
          // attestation).
          //
          // The pipeline computes, in order (runPipeline):
          //     domainOk = extractOk && assessDataset(dataset).ok
          //     success  = extractOk && domainOk
          // and records them as validationSuccess and pipelineSuccess. Both
          // identities are re-derived here from the RECOMPUTED extractOk (stage 1),
          // and each is reported on its own so a forgery that flips ONLY ONE of
          // them is named precisely.
          const assessment = assessDataset(derivedDataset);
          const assessmentNote =
            `recomputed extractionSuccess ${recomputedExtract}; ` +
            `assessDataset reports ${assessment.failures.length} failure(s)` +
            (assessment.failures[0] ? ` — first: ${assessment.failures[0]}` : "");
          const recomputedDomainOk = recomputedExtract && assessment.ok;
          const recomputedPipeline = recomputedExtract && recomputedDomainOk;
          if (recomputedDomainOk !== t.validationSuccess) {
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: recorded validationSuccess ${t.validationSuccess} ≠ recomputed ${recomputedDomainOk} from the shipped raw payloads (${assessmentNote})`
              )
            );
          }
          if (recomputedPipeline !== t.pipelineSuccess) {
            violations.push(
              reason(
                "grading",
                `${source}/${t.runId}: recorded pipelineSuccess ${t.pipelineSuccess} ≠ recomputed ${recomputedPipeline} from the shipped raw payloads (${assessmentNote}; recomputed domainOk ${recomputedDomainOk})`
              )
            );
          }
          // Stage 7: FAILURE ATTRIBUTION. For a record whose payloads exist, the
          // pipeline does not choose a category — it derives one (runPipeline):
          //     failureCategory: !extractOk ? "extraction" : "validation"
          //     failureDetail:   issues.slice(0, 5).join(" | ") || "validation failed"
          // where `issues` is the extraction-check issues followed by the domain
          // assessment's failures. Leaving those attested let a graded extraction
          // failure be re-labelled a navigation crash — a taxonomy launder that
          // moves a trial out of the safe-failure column without touching a single
          // recomputable number. Both are therefore recomputed here. (A crash-class
          // record — no payload at all — keeps an ATTESTED category: nothing was
          // produced to derive one from, which is the format's stated boundary.)
          if (!recomputedPipeline) {
            const derivedCategory = !recomputedExtract ? "extraction" : "validation";
            const derivedDetail =
              [...checkIssues, ...assessment.failures].slice(0, 5).join(" | ") || "validation failed";
            if (t.failureCategory !== derivedCategory) {
              violations.push(
                reason(
                  "grading",
                  `${source}/${t.runId}: recorded failureCategory "${
                    t.failureCategory ?? "(absent)"
                  }" ≠ recomputed "${derivedCategory}" — with payloads shipped the category follows from the recomputed extraction/domain verdicts, it is not the record's to choose`
                )
              );
            }
            if (t.failureDetail !== derivedDetail) {
              violations.push(
                reason(
                  "grading",
                  `${source}/${t.runId}: recorded failureDetail ≠ recomputed from the shipped raw payloads.\n    recorded:   ${
                    t.failureDetail ?? "(absent)"
                  }\n    recomputed: ${derivedDetail}`
                )
              );
            }
          }
          // Judge from the RECOMPUTED reports: a tampered row that changes the
          // verdict must fail here too, not merely as a counter mismatch.
          overall = recomputedOverall;
          reports = { stats: statsReport, odds: oddsReport };
          // Only NOW is the record genuinely recomputed-from-raw: every earlier
          // branch above pushed a violation and recomputed nothing.
          records.recomputed += 1;
        }
        // TRACE RECONCILIATION — applies to EVERY v2 record that ships a trace,
        // including a hard-failure one (a keyless trial that died still traces its
        // trigger evaluations and still reports its token count).
        for (const message of traceReconciliation(t)) {
          violations.push(reason("grading", `${source}/${t.runId}: ${message}`));
        }
      }
      const recomputed = judge(suiteSpec, pseudoResult(t), overall, reports);
      const recomputedClass = classifyOutcome({
        pipelineSuccess: t.pipelineSuccess,
        overall,
        expected: suiteSpec.expected,
        ...(t.healedSteps ? { healedSteps: t.healedSteps } : {}),
        ...(t.failureCategory ? { failureCategory: t.failureCategory } : {})
      });
      if (recomputed.outcome !== t.outcome) {
        violations.push(
          reason("grading", `${source}/${t.runId}: recorded outcome "${t.outcome}" ≠ recomputed "${recomputed.outcome}"`)
        );
      }
      if (recomputed.reason !== t.outcomeReason) {
        violations.push(
          reason(
            "grading",
            `${source}/${t.runId}: recorded outcomeReason ≠ recomputed.\n    recorded:   ${t.outcomeReason}\n    recomputed: ${recomputed.reason}`
          )
        );
      }
      if (recomputedClass !== t.outcomeClass) {
        violations.push(
          reason("grading", `${source}/${t.runId}: recorded outcomeClass "${t.outcomeClass}" ≠ recomputed "${recomputedClass}"`)
        );
      }
      // Advisory only (never a gate): a policy/auth error should never appear.
      if (t.failureDetail && AUTH_ERROR_PATTERNS.test(t.failureDetail)) {
        notes.push(`${source}/${t.runId}: NOTE failureDetail mentions a provider/auth error — ${t.failureDetail}`);
      }
    }
  }

  // (e) PREDICTIONS — report-only scoring (§4a). Never a violation. Scored with the
  // same EXACT-match map; policies not in expect.policies typically show not-run.
  const predictions: PredictionScore[] = [];
  const passTotalFor = (scenarioId: string, label: string) => {
    let pass = 0;
    let total = 0;
    for (const { results } of runs) {
      for (const t of results.trials) {
        if (t.scenarioId !== scenarioId) continue;
        if (configurationLabel(t.engine, results.environment) !== label) continue;
        total += 1;
        if (t.outcome === "pass") pass += 1;
      }
    }
    return total === 0 ? null : { pass, total };
  };
  for (const scenario of suite.scenarios) {
    for (const policy of ALL_POLICIES) {
      const predicted = scenario.predictions[policy];
      const observed = passTotalFor(scenario.id, POLICY_LABEL[policy]);
      let status: PredictionScore["status"];
      if (observed === null) status = "not-run";
      else {
        const allPass = observed.pass === observed.total; // observed N/N
        const hit = predicted === "all-pass" ? allPass : !allPass;
        status = hit ? "hit" : "miss";
      }
      predictions.push({ scenarioId: scenario.id, policy, predicted, observed, status });
    }
  }

  return { ok: violations.length === 0, violations, predictions, notes, records };
}

/** Render a VerifyReport to a deterministic, human-readable block. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push("# Suite verification");
  lines.push("");
  const byCheck = (check: VerifyCheck) => report.violations.filter((v) => v.check === check);
  for (const check of ["schema", "provenance", "completeness", "grading"] as const) {
    const vs = byCheck(check);
    lines.push(`## ${check}: ${vs.length === 0 ? "OK" : `${vs.length} violation(s)`}`);
    for (const v of vs) lines.push(`  - ${v.message}`);
  }
  lines.push("");
  // Grading provenance, so a MIXED bundle is legible at a glance: which records
  // were checked against their own raw output, and which could only be attested.
  const r = report.records;
  lines.push("## grading provenance");
  lines.push(
    `  ${r.total} trial record(s): ` +
      `${r.recomputed} recomputed from shipped raw payloads (v2) · ` +
      `${r.v2NoRows} hard-failure (v2, no payload produced — consistency-checked) · ` +
      `${r.attestedV1} attested (v1, raw payloads not shipped)`
  );
  // Say plainly which facts a v2 record proves and which it still asserts, so the
  // recompute is never read as covering more than it does.
  if (r.recomputed > 0 || r.v2NoRows > 0) {
    lines.push(
      "  v2 records: the whole grading chain — extraction checks, normalization, domain" +
        " assessment, accuracy, judge — RE-DERIVED from the shipped raw payloads against an" +
        " oracle re-derived from the supplied suite, and the step trace reconciled against the" +
        " record's token and repair evidence."
    );
    lines.push(
      "  Still attested: the raw payloads' own authenticity, the facts of a crash that produced" +
        " no payload, and timing/token measurements."
    );
  }
  // A v2 record whose recompute was BLOCKED by a violation belongs to no class
  // above — name it rather than let the classes silently under-sum.
  const unrecomputable = r.total - r.recomputed - r.v2NoRows - r.attestedV1;
  if (unrecomputable > 0) {
    lines.push(
      `  ${unrecomputable} v2 record(s) could NOT be recomputed (see the grading violations above)`
    );
  }
  lines.push("");
  lines.push("## predictions (report-only — never a gate)");
  const hits = report.predictions.filter((p) => p.status === "hit").length;
  const misses = report.predictions.filter((p) => p.status === "miss");
  const notRun = report.predictions.filter((p) => p.status === "not-run").length;
  lines.push(`  ${hits} hit · ${misses.length} miss · ${notRun} not-run`);
  for (const p of misses) {
    const obs = p.observed ? `${p.observed.pass}/${p.observed.total}` : "—";
    lines.push(`  - MISS ${p.scenarioId} policy ${p.policy}: predicted ${p.predicted}, observed ${obs}`);
  }
  if (report.notes.length > 0) {
    lines.push("");
    lines.push("## notes");
    for (const n of report.notes) lines.push(`  - ${n}`);
  }
  lines.push("");
  lines.push(report.ok ? "VERIFY: PASS" : "VERIFY: FAIL");
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage: pnpm verify:suite <runDir...> --suite <scenario-suite.json> " +
  "--expect-policies <A,B,B2,C,D subset> --expect-trials <n> " +
  "[--expect-record-version <1|2>]";

/** The record format versions that exist (docs/RECORD_FORMAT.md). */
const RECORD_VERSIONS = [1, 2] as const;

function bail(message: string): never {
  console.error(message);
  process.exit(2); // 2 = usage error (distinct from a verification FAIL exit 1)
}

interface CliArgs {
  runDirs: string[];
  suiteFile: string;
  expect: ExpectGrid;
}

/**
 * Parse + validate --expect-policies / --expect-trials / --expect-record-version
 * into an ExpectGrid (bails on invalid). `recordVersionRaw` is undefined when the
 * flag was not given, and the returned grid then declares no version expectation.
 */
export function parseExpectGrid(
  policiesCsv: string,
  trialsRaw: string,
  recordVersionRaw?: string
): ExpectGrid {
  const tokens = policiesCsv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    bail(`--expect-policies must be a nonempty subset of ${ALL_POLICIES.join(",")}`);
  }
  const policies: Policy[] = [];
  for (const tok of tokens) {
    if (!ALL_POLICIES.includes(tok as Policy)) {
      bail(`--expect-policies has an unknown policy "${tok}" (valid: ${ALL_POLICIES.join(", ")})`);
    }
    if (policies.includes(tok as Policy)) {
      bail(`--expect-policies has a duplicate policy "${tok}"`);
    }
    policies.push(tok as Policy);
  }
  if (!/^\d+$/.test(trialsRaw)) {
    bail(`--expect-trials must be a positive integer (got "${trialsRaw}")`);
  }
  const trials = Number.parseInt(trialsRaw, 10);
  if (!Number.isInteger(trials) || trials <= 0) {
    bail(`--expect-trials must be a positive integer (got "${trialsRaw}")`);
  }
  if (recordVersionRaw === undefined) return { policies, trials };
  const recordVersion = /^\d+$/.test(recordVersionRaw)
    ? Number.parseInt(recordVersionRaw, 10)
    : Number.NaN;
  if (!RECORD_VERSIONS.includes(recordVersion as (typeof RECORD_VERSIONS)[number])) {
    bail(
      `--expect-record-version must be one of ${RECORD_VERSIONS.join(", ")} (got "${recordVersionRaw}")`
    );
  }
  return { policies, trials, recordVersion };
}

export function parseVerifyArgs(argv: string[]): CliArgs {
  const runDirs: string[] = [];
  let suiteFile: string | undefined;
  let policiesCsv: string | undefined;
  let trialsRaw: string | undefined;
  let recordVersionRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--suite") {
      suiteFile = argv[++i];
      if (!suiteFile) bail("--suite needs a path to a scenario-suite JSON");
    } else if (arg === "--expect-policies") {
      policiesCsv = argv[++i];
      if (policiesCsv === undefined) bail("--expect-policies needs a comma-separated subset of A,B,B2,C,D");
    } else if (arg === "--expect-trials") {
      trialsRaw = argv[++i];
      if (trialsRaw === undefined) bail("--expect-trials needs a positive integer");
    } else if (arg === "--expect-record-version") {
      recordVersionRaw = argv[++i];
      if (recordVersionRaw === undefined) {
        bail(`--expect-record-version needs one of ${RECORD_VERSIONS.join(", ")}`);
      }
    } else if (!arg.startsWith("--")) {
      runDirs.push(arg);
    } else {
      bail(`Unexpected flag "${arg}". ${USAGE}`);
    }
  }
  if (!suiteFile) bail(USAGE);
  if (runDirs.length === 0) bail(USAGE);
  if (policiesCsv === undefined) bail(USAGE);
  if (trialsRaw === undefined) bail(USAGE);
  const expect = parseExpectGrid(policiesCsv, trialsRaw, recordVersionRaw);
  return { runDirs: runDirs.map((d) => path.resolve(d)), suiteFile: path.resolve(suiteFile), expect };
}

function main(): void {
  const args = parseVerifyArgs(process.argv.slice(2));
  let suite: LoadedScenarioSuite;
  try {
    suite = loadScenarioSuite(args.suiteFile);
  } catch (error) {
    bail(`Could not load --suite ${args.suiteFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const inputs: VerifyInput[] = [];
  for (const dir of args.runDirs) {
    const file = path.join(dir, "results.json");
    if (!existsSync(file)) bail(`No results.json at ${file}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      bail(`results.json at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    inputs.push({ source: path.relative(process.cwd(), file), raw });
  }

  const report = verifySuite(inputs, suite!, args.expect);
  console.log(formatReport(report));
  // Exit nonzero ONLY on (a)-(d) violations — never on a prediction miss or a
  // judged policy failure.
  process.exit(report.ok ? 0 : 1);
}

const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) main();
