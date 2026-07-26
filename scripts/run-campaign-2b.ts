/**
 * Phase-2B campaign driver — the readiness-mode ablation (docs/PROTOCOL_2B.md).
 *
 *   pnpm campaign:2b --suite <scenario-suite.json> --phase keyless
 *   pnpm campaign:2b --suite <scenario-suite.json> --phase keyed [--keyless-state <file>]
 *   pnpm campaign:2b --print-schedule            # dry run: print the frozen table, run nothing
 *
 * It follows the Phase-2A driver (scripts/run-campaign-2a.ts) mechanism for
 * mechanism — per-phase state files, crash-rerun-once ledger accounting, the
 * frozen $39.90 pre-trial stop, the injectable-reader keyed-phase gate — and adds
 * exactly what 2B needs on top:
 *
 *  - The ARM is part of a schedule entry, so the frozen arm-order table is
 *    executed rather than interpreted, and an entry run in the wrong arm for its
 *    slot is refused rather than reordered. This is why the schedule, the resume
 *    state machine, and the entry state are 2B-local rather than reused verbatim
 *    from campaignDriver: a 2A `CampaignEntry` cannot express an arm, and the
 *    cell identity the protocol freezes is scenario × policy × ARM × sweep. Every
 *    arm-agnostic mechanism — pricing, the budget hooks, the threshold, the
 *    per-policy engine mapping — IS reused from that module unchanged.
 *  - Each entry runs only the five allowlisted scenarios (§Subset semantics).
 *  - Transport poisoning is detected outcome-blind and invalidates the FULL grid.
 *
 * Exit codes match 2A: 0 complete, 1 crash, 2 usage, 3 budget stop.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LabClient,
  createRunDir,
  loadScenarioSuite,
  suiteScenarioToSpec,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type ReadinessMode,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import {
  CAMPAIGN_BUDGET_THRESHOLD_USD,
  PINNED_PRICES,
  loadAgentEnvConfig,
  makeBudgetHooks,
  policyRunConfig,
  runBenchmark,
  shouldStop,
  type CampaignPhase,
  type CampaignPolicy,
  type CampaignState,
  type EntryRunContext,
  type Sweep
} from "@ssda/agent";
import { verifySuite, type ExpectGrid, type VerifyInput } from "./verify-suite";
import { killAndVerify, pickFreePort, spawnPrivateLab } from "./labControl";

// ── Frozen campaign constants (docs/PROTOCOL_2B.md) ──────────────────────────

/** The campaign identity every 2B run stamps and every 2B command expects. */
export const PHASE2B_CAMPAIGN_ID = "phase2b-ablation-v1";

/**
 * The five allowlisted scenarios (§Subset semantics). The suite stays the full
 * frozen 32-scenario Phase-2A file — these ids restrict the grid, and the other
 * 27 are excluded by this allowlist, never by editing the suite.
 */
export const PHASE2B_SCENARIO_IDS = [
  "f3-page-size-3-a",
  "f3-page-size-3-b",
  "f3-page-size-2-a",
  "f3-page-size-2-b",
  "x-class-l3-page-size-2"
] as const;

/** The frozen model the verification commands pin (§Schedule). */
export const PHASE2B_MODEL = "anthropic/claude-haiku-4-5";
/**
 * The pinned price-table date. Deliberately duplicated from the recorder's own
 * PRICES_PINNED_AT rather than imported: this is the PROTOCOL side of the freeze,
 * frozen independently at gate 5. If the code's table date ever moves, the two
 * disagree and every 2B verification fails loudly — which is the point. Importing
 * it would make drift silent agreement.
 */
export const PHASE2B_PRICES_PINNED_AT = "2026-07-14";

/**
 * The frozen Phase-2A suite this campaign reuses (§Subset semantics: the suite
 * bytes are held fixed and only the allowlist restricts the grid). Hardcoded so a
 * campaign pointed at an edited or regenerated suite is refused before any state
 * is created, rather than producing a bundle that verifies against the wrong file.
 * Read from data/phase2a/scenario-suite.json via loadScenarioSuite.
 */
export const PHASE2B_SUITE_PROTOCOL_ID = "phase2a-v1";
export const PHASE2B_SUITE_HASH =
  "a3e77433869ff77f513a0cdb435c5c46fd6627e6b0905be50fc20e1c129ab722";

/** The tag gate 5 places at the campaign commit; no entry may run without it. */
export const PHASE2B_FREEZE_TAG = "phase2b-ablation-freeze-v1";

/** The arms, in the protocol's notation. */
const F: ReadinessMode = "frozen";
const R: ReadinessMode = "any-row";

/**
 * The frozen per-sweep arm order (§Schedule), as DATA — a table to execute, not a
 * rule to interpret. Balanced so that time and network conditions cannot align
 * with one arm: within each policy every sweep runs both arms back-to-back, and
 * the leading arm alternates.
 *
 *   | Policy | Sweep 1 | Sweep 2 | Sweep 3 | Sweep 4 | Sweep 5 |
 *   | A      | F,R | R,F | F,R | R,F | F,R |
 *   | B      | R,F | F,R | R,F | F,R | R,F |
 *   | B2     | F,R | R,F | F,R | R,F | F,R |
 *   | C      | R,F | F,R | R,F | F,R | R,F |
 *   | D      | F,R | R,F | F,R | R,F | F,R |
 */
const F_FIRST: readonly (readonly [ReadinessMode, ReadinessMode])[] = [
  [F, R],
  [R, F],
  [F, R],
  [R, F],
  [F, R]
];
const R_FIRST: readonly (readonly [ReadinessMode, ReadinessMode])[] = [
  [R, F],
  [F, R],
  [R, F],
  [F, R],
  [R, F]
];
export const ARM_ORDER: Readonly<
  Record<CampaignPolicy, readonly (readonly [ReadinessMode, ReadinessMode])[]>
> = {
  A: F_FIRST,
  B: R_FIRST,
  B2: F_FIRST,
  C: R_FIRST,
  D: F_FIRST
};

/** Policy execution order per phase, frozen (§Schedule). */
export const PHASE_POLICIES: Readonly<Record<CampaignPhase, readonly CampaignPolicy[]>> = {
  keyless: ["A", "B", "B2"],
  keyed: ["C", "D"]
};

const SWEEPS: readonly Sweep[] = [1, 2, 3, 4, 5];

/** One scheduled unit of work: a policy × sweep × ARM, run over the five scenarios. */
export interface Campaign2bEntry {
  phase: CampaignPhase;
  sweep: Sweep;
  policy: CampaignPolicy;
  arm: ReadinessMode;
  /** 0-based order within the phase's schedule. */
  ordinal: number;
}

/**
 * The frozen schedule for a phase, SWEEP-MAJOR (§Schedule, carried from Phase
 * 2A): sweep 1 runs every policy of the phase in its frozen order, each policy
 * running its two arms back-to-back in that sweep's frozen arm order; then sweep
 * 2, and so on. The nesting is load-bearing — clustering all of one policy's
 * sweeps together would let monotone drift over the campaign's wall-clock (a
 * warming machine, a degrading network) align with policy and confound it.
 *
 * 30 keyless entries (A, B, B2 × 5 sweeps × 2 arms) and 20 keyed (C, D × …).
 */
export function buildSchedule2b(phase: CampaignPhase): Campaign2bEntry[] {
  const entries: Campaign2bEntry[] = [];
  let ordinal = 0;
  for (const sweep of SWEEPS) {
    for (const policy of PHASE_POLICIES[phase]) {
      for (const arm of ARM_ORDER[policy][sweep - 1]!) {
        entries.push({ phase, sweep, policy, arm, ordinal: ordinal++ });
      }
    }
  }
  return entries;
}

// ── Campaign state (per-phase, resumable — the 2A ledger plus the arm) ───────

const SweepSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const ArmSchema = z.enum(["frozen", "any-row"]);

export const Campaign2bEntryStateSchema = z.object({
  phase: z.enum(["keyless", "keyed"]),
  sweep: SweepSchema,
  policy: z.enum(["A", "B", "B2", "C", "D"]),
  /** The ARM this entry ran — part of the cell identity, never inferred on resume. */
  arm: ArmSchema,
  status: z.enum(["complete", "stopped", "crashed"]),
  benchId: z.string(),
  dir: z.string(),
  /** Accumulated across a crash+rerun, so sum(entries.costUsd) === spendUsd exactly. */
  costUsd: z.number().nonnegative(),
  completedTrials: z.number().int().nonnegative(),
  reruns: z.number().int().nonnegative()
});
export type Campaign2bEntryState = z.infer<typeof Campaign2bEntryStateSchema>;

/**
 * The verifier's verdict on this bundle, RECORDED AGAINST THE STATE FILE
 * (§Schedule: "a PASS verdict recorded against the keyless state file"). The
 * keyed phase's pre-spend recheck reads it, so the verdict is evidence in the
 * ledger rather than a fact that existed only in a terminal that has scrolled.
 */
export const KeylessVerdictSchema = z.object({
  pass: z.boolean(),
  /** ISO timestamp of the verification. */
  at: z.string(),
  violations: z.number().int().nonnegative(),
  /** The bundle the verdict covers, so a verdict cannot be reused for another. */
  entryCount: z.number().int().nonnegative()
});
export type KeylessVerdict = z.infer<typeof KeylessVerdictSchema>;

/**
 * A marker written BEFORE an entry starts and cleared when it is recorded. Its
 * presence on load means the process died mid-entry — between the pre-entry
 * persist and the entry record — which is exactly the window in which spend can
 * be banked in `spendUsd` with no entry to account for it. Resume treats the slot
 * as crashed and reconciles the orphaned spend onto it, so the ledger invariant
 * sum(entries.costUsd) === spendUsd survives a kill -9.
 */
export const PendingEntrySchema = z.object({
  phase: z.enum(["keyless", "keyed"]),
  sweep: SweepSchema,
  policy: z.enum(["A", "B", "B2", "C", "D"]),
  arm: ArmSchema,
  benchId: z.string(),
  benchDir: z.string()
});
export type PendingEntry = z.infer<typeof PendingEntrySchema>;

export const Campaign2bStateSchema = z.object({
  version: z.literal(1),
  protocolId: z.string(),
  suiteHash: z.string(),
  /** The campaign this ledger belongs to — refused if it is not this one. */
  campaignProtocolId: z.string(),
  thresholdUsd: z.number(),
  spendUsd: z.number().nonnegative(),
  entries: z.array(Campaign2bEntryStateSchema),
  stoppedReason: z.string().optional(),
  /** Set when a poisoned entry invalidated the grid (§Transport poisoning). */
  poisonedReason: z.string().optional(),
  /** The recorded verifier verdict for this bundle (additive-optional). */
  verdict: KeylessVerdictSchema.optional(),
  /** Present only while an entry is in flight (additive-optional). */
  pendingEntry: PendingEntrySchema.optional()
});
export type Campaign2bState = z.infer<typeof Campaign2bStateSchema>;

/**
 * The gate-5 frozen expectations, authored as a checked-in JSON and re-checked
 * immediately before the first paid call. Values are frozen at gate 5; this
 * schema is the mechanism, available now.
 */
export const FrozenExpectationsSchema = z.object({
  suiteHash: z.string().min(1),
  protocolId: z.string().min(1),
  campaignProtocolId: z.string().min(1),
  /** The commit the campaign is frozen at; observed via `git rev-parse HEAD`. */
  gitCommit: z.string().min(1),
  recordVersion: z.literal(2),
  arms: z.array(ArmSchema).min(1),
  scheduleLength: z.number().int().positive(),
  /**
   * The keyed smoke (§Schedule): one C trial that must heal a class-drift-broken
   * login with its repair path, one D trial that must complete the full flow.
   * The two scenario ids are frozen at gate 5 — the driver refuses to guess them.
   */
  smoke: z.object({
    cId: z.string().min(1),
    cMustHealLogin: z.boolean(),
    dId: z.string().min(1),
    dMustPass: z.boolean()
  })
});
export type FrozenExpectations = z.infer<typeof FrozenExpectationsSchema>;

export function initCampaign2bState(protocolId: string, suiteHash: string): Campaign2bState {
  return {
    version: 1,
    protocolId,
    suiteHash,
    campaignProtocolId: PHASE2B_CAMPAIGN_ID,
    thresholdUsd: CAMPAIGN_BUDGET_THRESHOLD_USD,
    spendUsd: 0,
    entries: []
  };
}

function sameEntry(
  a: { phase: CampaignPhase; sweep: Sweep; policy: CampaignPolicy; arm: ReadinessMode },
  b: Campaign2bEntry
): boolean {
  return a.phase === b.phase && a.sweep === b.sweep && a.policy === b.policy && a.arm === b.arm;
}

export function entryLabel(e: {
  phase: CampaignPhase;
  sweep: Sweep;
  policy: CampaignPolicy;
  arm: ReadinessMode;
}): string {
  return `${e.phase}/${e.policy}/sweep-${e.sweep}/${e.arm}`;
}

/**
 * Validate a loaded state against the suite, the phase, and the campaign. Same
 * three refusals as 2A plus the campaign identity — a ledger from another
 * campaign must never be resumed into this one.
 */
export function assertState2bMatches(
  state: Campaign2bState,
  provenance: { protocolId: string; suiteHash: string },
  phase: CampaignPhase
): void {
  if (state.protocolId !== provenance.protocolId || state.suiteHash !== provenance.suiteHash) {
    throw new Error(
      `belongs to a different suite (state protocolId=${state.protocolId} ` +
        `suiteHash=${state.suiteHash.slice(0, 12)}…; supplied suite ` +
        `protocolId=${provenance.protocolId} suiteHash=${provenance.suiteHash.slice(0, 12)}…)`
    );
  }
  if (state.campaignProtocolId !== PHASE2B_CAMPAIGN_ID) {
    throw new Error(
      `belongs to campaign "${state.campaignProtocolId}", not "${PHASE2B_CAMPAIGN_ID}"`
    );
  }
  const foreign = state.entries.find((e) => e.phase !== phase);
  if (foreign) {
    throw new Error(
      `records a "${foreign.phase}"-phase entry but --phase is "${phase}": the keyless and ` +
        `keyed phases have different schedules and MUST NOT share a state file. Use ` +
        `${defaultStateFile(phase)} for the "${phase}" phase.`
    );
  }
}

/**
 * Reconcile a state whose process died MID-ENTRY (F10). The pending marker names
 * the slot that was in flight; its spend is already banked in `spendUsd` but has
 * no entry to account for it, so the slot is recorded as CRASHED carrying exactly
 * the orphaned amount (spendUsd − sum(entries.costUsd)). The ledger invariant
 * holds afterwards, the orphaned run dir is preserved for forensics, and the
 * crash counts against the rerun-once rule — an entry that dies mid-flight twice
 * is not silently attempted a third time.
 *
 * Idempotent: with no pending marker it does nothing. Returns whether it acted.
 */
export function reconcilePendingEntry(state: Campaign2bState): boolean {
  const pending = state.pendingEntry;
  if (!pending) return false;
  const banked = state.entries.reduce((sum, e) => sum + e.costUsd, 0);
  const orphaned = Math.max(0, state.spendUsd - banked);
  recordEntry(
    state,
    { ...pending, ordinal: -1 },
    {
      status: "crashed",
      benchId: pending.benchId,
      dir: pending.benchDir,
      costUsd: orphaned,
      completedTrials: 0
    }
  );
  delete state.pendingEntry;
  return true;
}

/**
 * The next schedule entry to run, or null when the phase is complete. Identical
 * resume semantics to 2A — strict prefix alignment, crash-rerun-once, a stopped
 * entry re-checked against the budget — with the ARM included in the alignment
 * test, so a run executed in the wrong arm for its slot is REFUSED rather than
 * silently accepted as that slot's work.
 */
export function nextEntry2b(
  state: Campaign2bState,
  schedule: Campaign2bEntry[]
): Campaign2bEntry | null {
  const recorded = state.entries;
  if (recorded.length > schedule.length) {
    throw new Error(
      `campaign state has ${recorded.length} entries but the schedule has only ${schedule.length} — state does not match this schedule`
    );
  }
  for (let i = 0; i < recorded.length; i++) {
    const rec = recorded[i]!;
    const sched = schedule[i]!;
    if (!sameEntry(rec, sched)) {
      throw new Error(
        `campaign state entry ${i} (${entryLabel(rec)}) does not match the frozen schedule position ${i} (${entryLabel(sched)}) — out-of-order entry, or the wrong arm for this slot`
      );
    }
    if (i < recorded.length - 1 && rec.status !== "complete") {
      throw new Error(
        `campaign state entry ${i} (${entryLabel(rec)}) is "${rec.status}" but is not the last recorded entry — the resume prefix is corrupt`
      );
    }
  }
  if (recorded.length === 0) return schedule[0] ?? null;
  const last = recorded[recorded.length - 1]!;
  const lastPos = schedule[recorded.length - 1]!;
  if (last.status === "complete") return schedule[recorded.length] ?? null;
  if (last.status === "crashed") {
    if (last.reruns === 0) return lastPos;
    throw new Error(
      `campaign entry ${entryLabel(last)} crashed again after its one permitted rerun (reruns=${last.reruns}) — operator must intervene; no silent third attempt`
    );
  }
  return lastPos;
}

// ── Transport poisoning (§Operational machinery) ─────────────────────────────

/**
 * The frozen transport-poisoning regex. Outcome-blind by design: a poisoned
 * trial is diagnosed from the TRANSPORT evidence, never from whether the trial
 * happened to pass — otherwise a network fault that produced a plausible-looking
 * failure would be scored as a result.
 */
export const POISON_DETAIL_PATTERN =
  /ENOTFOUND|Cannot connect to API|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/;

/**
 * Is this trial transport-poisoned? Either half of the frozen criterion:
 *  (a) it recorded model calls but BOTH token sides came back zero — the shape of
 *      a request that never reached the provider; or
 *  (b) its failure detail matches the frozen transport-error pattern.
 */
export function isPoisonedTrial(t: Pick<TrialResult, "tokens" | "failureDetail">): boolean {
  const tokens = t.tokens;
  // `?? 0` is deliberately CONSERVATIVE: an absent token side reads as zero, so
  // this over-detects rather than under-detects. Over-detection costs a restart;
  // under-detection pools a network fault into the evidence, which is worse.
  if (
    tokens &&
    tokens.llmCalls > 0 &&
    (tokens.inputTokens ?? 0) === 0 &&
    (tokens.outputTokens ?? 0) === 0
  ) {
    return true;
  }
  return t.failureDetail !== undefined && POISON_DETAIL_PATTERN.test(t.failureDetail);
}

/**
 * Does a THROWN error look like transport poisoning? An engine that dies on a
 * network fault throws rather than recording a trial, so without this the same
 * fault that poisons a completed entry would launder into an ordinary "crash" and
 * be silently rerun — the campaign would pool results around it. The whole cause
 * chain is tested, since transport errors are usually wrapped.
 */
export function isPoisonedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (POISON_DETAIL_PATTERN.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The poisoned trials in a completed entry's results, if any. */
export function poisonedTrials(results: Pick<BenchmarkResults, "trials">): TrialResult[] {
  return results.trials.filter((t) => isPoisonedTrial(t));
}

// ── The frozen verification commands (§Schedule) ─────────────────────────────

/**
 * The expect-grid for a phase's frozen verification command. All five Phase-2B
 * flags are present in EVERY command — `--expect-model` included on the keyless
 * command, where it is a real check rather than a no-op: being policy-aware, it
 * requires A, B and B2 to record NO model at all.
 */
export function verifyGridFor(phase: CampaignPhase | "pooled"): ExpectGrid {
  const policies: ExpectGrid["policies"] =
    phase === "keyless" ? ["A", "B", "B2"] : phase === "keyed" ? ["C", "D"] : ["A", "B", "B2", "C", "D"];
  return {
    policies,
    trials: 5,
    recordVersion: 2,
    scenarios: [...PHASE2B_SCENARIO_IDS],
    arms: ["frozen", "any-row"],
    campaign: PHASE2B_CAMPAIGN_ID,
    model: PHASE2B_MODEL,
    pricesPinnedAt: PHASE2B_PRICES_PINNED_AT
  };
}

/**
 * The exact operator command for a bundle — printed on every failure path so an
 * operator never has to reconstruct the flags by hand, and never omits
 * `--expect-record-version 2` (a protocol requirement the 2A driver's hints
 * predate).
 */
export function operatorVerifyHint(phase: CampaignPhase | "pooled", dirs: string[], suiteFile: string): string {
  const grid = verifyGridFor(phase);
  return (
    `pnpm verify:suite ${dirs.join(" ")} --suite ${suiteFile} ` +
    `--expect-policies ${grid.policies.join(",")} --expect-trials ${grid.trials} ` +
    `--expect-record-version ${grid.recordVersion} ` +
    `--expect-scenarios ${grid.scenarios!.join(",")} ` +
    `--expect-arms ${grid.arms!.join(",")} ` +
    `--expect-campaign ${grid.campaign} ` +
    `--expect-model ${grid.model} ` +
    `--expect-prices-pinned-at ${grid.pricesPinnedAt}`
  );
}

// ── Gating (§Schedule: machine-enforced phase gating) ────────────────────────

/** Enforce key discipline for the phase (throws; the shell maps to a usage bail). */
export function enforceKeyDiscipline2b(phase: CampaignPhase, hasKey: boolean): void {
  if (phase === "keyless" && hasKey) {
    throw new Error(
      "--phase keyless refuses to run while a model provider key is present: the keyless " +
        "grid must complete before any key exists (PROTOCOL_2B §Schedule)."
    );
  }
  if (phase === "keyed" && !hasKey) {
    throw new Error(
      "--phase keyed refuses to run without a model provider key: set ANTHROPIC_API_KEY " +
        "or OPENAI_API_KEY (PROTOCOL_2B §Schedule)."
    );
  }
}

/**
 * The keyed-phase gate (§Schedule): the keyed phase refuses to start until the
 * complete 30-entry keyless ledger has been read AND the keyless bundle
 * re-verified with the frozen KEYLESS command, whose PASS verdict is what this
 * function records by returning normally.
 *
 * `verify` is injectable ONLY so tests can stub the expensive verification path;
 * every state-machine check below always runs the real frozen code.
 */
export function keyedPhaseGate2b(
  keylessStateRaw: unknown,
  suite: LoadedScenarioSuite,
  readRunInput: (dir: string) => VerifyInput,
  suiteFile: string,
  verify: typeof verifySuite = verifySuite
): KeylessVerdict {
  const parsed = Campaign2bStateSchema.safeParse(keylessStateRaw);
  if (!parsed.success) {
    throw new Error(
      `keyless campaign state failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")}`
    );
  }
  const state = parsed.data;
  try {
    assertState2bMatches(state, suite, "keyless");
  } catch (error) {
    throw new Error(`keyless campaign state ${error instanceof Error ? error.message : String(error)}`);
  }
  if (state.poisonedReason !== undefined) {
    throw new Error(
      `keyless grid is POISONED and cannot gate the keyed phase: ${state.poisonedReason}`
    );
  }

  const schedule = buildSchedule2b("keyless");
  let next: Campaign2bEntry | null;
  try {
    next = nextEntry2b(state, schedule);
  } catch (error) {
    throw new Error(
      `keyless campaign state is not a valid schedule prefix: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (next !== null) {
    const completed = state.entries.filter((e) => e.status === "complete").length;
    throw new Error(
      `keyless grid incomplete — next unfinished entry is ${entryLabel(next)}, ` +
        `${completed}/${schedule.length} entries complete; the keyed phase refuses to start before the ` +
        `keyless grid is complete and verified (PROTOCOL_2B §Schedule)`
    );
  }

  const inputs = state.entries.map((e) => readRunInput(e.dir));
  const report = verify(inputs, suite, verifyGridFor("keyless"));
  if (!report.ok) {
    const firstMessages = report.violations.slice(0, 5).map((v) => `\n  - ${v.message}`).join("");
    throw new Error(
      `keyless grid failed the frozen keyless verification (${report.violations.length} violation(s)) — first messages:${firstMessages}\n` +
        `Full report: ${operatorVerifyHint("keyless", state.entries.map((e) => e.dir), suiteFile)}\n` +
        `The keyed phase refuses to start (PROTOCOL_2B §Schedule).`
    );
  }
  // The PASS verdict is RETURNED so the shell can record it against the keyless
  // state file (§Schedule) — the pre-spend recheck reads it from there, so the
  // verdict is ledger evidence rather than a line in a scrolled-away terminal.
  return {
    pass: true,
    at: new Date().toISOString(),
    violations: 0,
    entryCount: state.entries.length
  };
}

// ── The keyed smoke (§Schedule) ──────────────────────────────────────────────

export interface SmokeTrialOutcome {
  scenarioId: string;
  policy: "C" | "D";
  benchId: string;
  dir: string;
  outcome: string;
  healedSteps: string[];
  chromeVersion: string | null;
  passedCriteria: boolean;
  criterion: string;
}

export interface SmokeResult {
  at: string;
  arm: ReadinessMode;
  trials: SmokeTrialOutcome[];
  ok: boolean;
}

/**
 * The keyed smoke (§Schedule): before ANY evidence entry, one C trial that must
 * heal a class-drift-broken login with its repair path, and one D trial that must
 * complete the full flow. Arm F, `runPurpose: "smoke"`, browser build required,
 * and NEVER written into the evidence ledger — its record is its own file. Either
 * trial failing its criterion blocks the keyed phase.
 *
 * The two scenario ids and the criteria are DATA from the frozen-expectations
 * file: the mechanism is here, the values are frozen at gate 5.
 */
export async function runKeyedSmoke(
  frozen: FrozenExpectations,
  suiteScenarios: readonly ScenarioSpec[],
  deps: Pick<Campaign2bDeps, "runBenchmark" | "prepareRun" | "headless" | "log">
): Promise<SmokeResult> {
  const byId = new Map(suiteScenarios.map((s) => [s.id, s]));
  const plan: { policy: "C" | "D"; id: string }[] = [
    { policy: "C", id: frozen.smoke.cId },
    { policy: "D", id: frozen.smoke.dId }
  ];
  const trials: SmokeTrialOutcome[] = [];
  for (const { policy, id } of plan) {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(
        `keyed smoke: scenario "${id}" (policy ${policy}) is not in the supplied suite — the ` +
          `frozen expectations name a scenario this suite does not contain`
      );
    }
    const cfg = policyRunConfig(policy);
    const ctx = await deps.prepareRun({
      phase: "keyed",
      sweep: 1,
      policy,
      arm: "frozen",
      ordinal: -1
    });
    let results: BenchmarkResults;
    try {
      results = await deps.runBenchmark({
        labUrl: ctx.labUrl,
        engines: cfg.engines,
        scenarios: [scenario],
        trialsPerScenario: 1,
        headless: deps.headless,
        benchDir: ctx.benchDir,
        benchId: ctx.benchId,
        // NEVER evidence: the smoke is a go/no-go check, and `smoke` is the
        // machine-enforced separation that keeps it out of every campaign bundle.
        runPurpose: "smoke",
        repairMode: cfg.repairMode,
        readinessMode: "frozen",
        campaignProtocolId: PHASE2B_CAMPAIGN_ID,
        requireChromeVersion: true
      });
    } finally {
      await ctx.dispose();
    }
    const t = results.trials[0];
    const healedSteps = t?.healedSteps ?? [];
    const criterion =
      policy === "C"
        ? frozen.smoke.cMustHealLogin
          ? "must heal the login step via its repair path"
          : "(no criterion)"
        : frozen.smoke.dMustPass
          ? "must complete the full flow (outcome pass)"
          : "(no criterion)";
    const passedCriteria =
      policy === "C"
        ? !frozen.smoke.cMustHealLogin || healedSteps.some((step) => step.includes("login"))
        : !frozen.smoke.dMustPass || t?.outcome === "pass";
    trials.push({
      scenarioId: id,
      policy,
      benchId: ctx.benchId,
      dir: ctx.benchDir,
      outcome: t?.outcome ?? "(no trial)",
      healedSteps,
      chromeVersion: t?.chromeVersion ?? null,
      passedCriteria,
      criterion
    });
    deps.log?.(
      `keyed smoke ${policy} (${id}): outcome=${t?.outcome ?? "(none)"} ` +
        `healed=[${healedSteps.join(", ")}] → ${passedCriteria ? "PASS" : "FAIL"} (${criterion})`
    );
  }
  return {
    at: new Date().toISOString(),
    arm: "frozen",
    trials,
    ok: trials.every((t) => t.passedCriteria)
  };
}

// ── Freeze guard (§Gates) ────────────────────────────────────────────────────

/**
 * No entry of either phase may run unless gate 5's freeze tag points at HEAD.
 * There is deliberately NO override flag: the whole point of a freeze is that the
 * code executing the campaign is the code the protocol was frozen against.
 * `--print-schedule` is exempt — it runs nothing.
 */
export function assertFrozenAtHead(tagsAtHead: readonly string[]): void {
  if (!tagsAtHead.includes(PHASE2B_FREEZE_TAG)) {
    throw new Error(
      `refusing to execute any campaign entry: the freeze tag "${PHASE2B_FREEZE_TAG}" does not ` +
        `point at HEAD (tags here: ${tagsAtHead.length > 0 ? tagsAtHead.join(", ") : "(none)"}). ` +
        `Phase 2B runs only at its frozen commit (PROTOCOL_2B §Gates, gate 5). There is no override.`
    );
  }
}

/**
 * The pre-spend recheck (§Schedule): immediately before the first paid call, the
 * driver re-checks its frozen expectations. Any mismatch stops the campaign
 * BEFORE any spend. Pure and fully injectable so it is testable without a key.
 */
export interface PreSpendExpectations {
  suiteHash: string;
  protocolId: string;
  campaignProtocolId: string;
  gitCommit: string | null;
  recordVersion: number;
  arms: readonly ReadinessMode[];
  keylessVerdictPass: boolean;
  scheduleLength: number;
}

export function assertPreSpendExpectations(
  observed: PreSpendExpectations,
  frozen: PreSpendExpectations
): void {
  const mismatches: string[] = [];
  const check = (name: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches.push(`${name}: observed ${JSON.stringify(a)} ≠ frozen ${JSON.stringify(b)}`);
    }
  };
  check("suiteHash", observed.suiteHash, frozen.suiteHash);
  check("protocolId", observed.protocolId, frozen.protocolId);
  check("campaignProtocolId", observed.campaignProtocolId, frozen.campaignProtocolId);
  check("gitCommit", observed.gitCommit, frozen.gitCommit);
  check("recordVersion", observed.recordVersion, frozen.recordVersion);
  check("arms", observed.arms, frozen.arms);
  check("scheduleLength", observed.scheduleLength, frozen.scheduleLength);
  if (!observed.keylessVerdictPass) {
    mismatches.push("keylessVerdictPass: the keyless bundle has not recorded a PASS verdict");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `pre-spend recheck FAILED — the campaign stops before any paid call (PROTOCOL_2B §Schedule):\n  - ${mismatches.join(
        "\n  - "
      )}`
    );
  }
}

// ── The injected run-loop ────────────────────────────────────────────────────

export interface Campaign2bDeps {
  schedule: Campaign2bEntry[];
  /** The five allowlisted scenarios, already projected to ScenarioSpec. */
  scenarios: ScenarioSpec[];
  model: string | undefined | null;
  headless: boolean;
  runBenchmark: (config: Parameters<typeof runBenchmark>[0]) => Promise<BenchmarkResults>;
  prepareRun: (entry: Campaign2bEntry) => Promise<EntryRunContext>;
  persist: (state: Campaign2bState) => Promise<void>;
  log?: (line: string) => void;
}

export type Campaign2bOutcome =
  | { kind: "complete" }
  | { kind: "stopped"; reason: string; entry: Campaign2bEntry }
  | { kind: "crashed"; entry: Campaign2bEntry; error: Error }
  | { kind: "poisoned"; reason: string; entry: Campaign2bEntry };

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Refuse anything but EXACTLY the five allowlisted scenarios — set equality, so
 * both a smuggled extra and a silently dropped one are caught.
 */
export function assertAllowlistedScenarios(scenarios: readonly { id: string }[]): void {
  const got = [...new Set(scenarios.map((s) => s.id))].sort();
  const want: string[] = [...PHASE2B_SCENARIO_IDS].sort();
  if (got.length !== want.length || got.some((id, i) => id !== want[i])) {
    const extra = got.filter((id) => !want.includes(id));
    const missing = want.filter((id) => !got.includes(id));
    throw new Error(
      `Phase-2B entries must run EXACTLY the five allowlisted scenarios; got ${got.length}` +
        (extra.length > 0 ? `, unexpected: ${extra.join(", ")}` : "") +
        (missing.length > 0 ? `, missing: ${missing.join(", ")}` : "") +
        ` (PROTOCOL_2B §Subset semantics)`
    );
  }
}

function recordEntry(
  state: Campaign2bState,
  entry: Campaign2bEntry,
  fields: Pick<Campaign2bEntryState, "status" | "benchId" | "dir" | "costUsd" | "completedTrials">
): void {
  const idx = state.entries.findIndex((e) => sameEntry(e, entry));
  const identity = { phase: entry.phase, sweep: entry.sweep, policy: entry.policy, arm: entry.arm };
  if (idx === -1) {
    state.entries.push({ ...identity, reruns: 0, ...fields });
    return;
  }
  const prev = state.entries[idx]!;
  const wasCrashed = prev.status === "crashed";
  state.entries[idx] = {
    ...identity,
    status: fields.status,
    benchId: fields.benchId,
    dir: fields.dir,
    // A crashed attempt's spend is already banked in state.spendUsd, so ACCUMULATE
    // rather than replace — sum(entries.costUsd) must reconcile with spendUsd exactly.
    costUsd: wasCrashed ? prev.costUsd + fields.costUsd : fields.costUsd,
    completedTrials: wasCrashed
      ? prev.completedTrials + fields.completedTrials
      : fields.completedTrials,
    reruns: wasCrashed ? prev.reruns + 1 : prev.reruns
  };
}

/**
 * Drive one phase to completion, a budget stop, a crash, or a poisoning — over
 * injected effects only. Each entry runs the five allowlisted scenarios once,
 * under its slot's arm, stamped with the campaign identity and refusing to
 * produce evidence without a browser build.
 */
export async function runCampaign2b(
  state: Campaign2bState,
  deps: Campaign2bDeps
): Promise<Campaign2bOutcome> {
  // F4 — the allowlist is enforced HERE, not only at the CLI: every entry must
  // run exactly the five registered scenarios. A sixth smuggled in would put a
  // scenario outside the campaign's declared scope into its evidence; a missing
  // one would silently shrink the grid while every count still looked right.
  assertAllowlistedScenarios(deps.scenarios);
  // A resumed state whose process died mid-entry is reconciled before the first
  // schedule decision, so the ledger the loop reads is already consistent.
  reconcilePendingEntry(state);
  for (;;) {
    const entry = nextEntry2b(state, deps.schedule);
    if (entry === null) return { kind: "complete" };

    const preStop = shouldStop(state as unknown as CampaignState);
    if (preStop) {
      const reason = state.stoppedReason ?? preStop;
      state.stoppedReason = reason;
      await deps.persist(state);
      return { kind: "stopped", reason, entry };
    }

    const cfg = policyRunConfig(entry.policy);
    const budget = makeBudgetHooks(state as unknown as CampaignState, deps.model, (s) =>
      deps.persist(s as unknown as Campaign2bState)
    );

    let ctx: EntryRunContext | undefined;
    let results: BenchmarkResults;
    try {
      ctx = await deps.prepareRun(entry);
      // F10 — mark the slot IN FLIGHT before any trial runs. If the process dies
      // between here and the entry record, resume finds this marker and knows
      // which slot the banked spend belongs to.
      state.pendingEntry = {
        phase: entry.phase,
        sweep: entry.sweep,
        policy: entry.policy,
        arm: entry.arm,
        benchId: ctx.benchId,
        benchDir: ctx.benchDir
      };
      await deps.persist(state);
      results = await deps.runBenchmark({
        labUrl: ctx.labUrl,
        engines: cfg.engines,
        scenarios: deps.scenarios,
        trialsPerScenario: 1,
        headless: deps.headless,
        benchDir: ctx.benchDir,
        benchId: ctx.benchId,
        runPurpose: "cold",
        repairMode: cfg.repairMode,
        protocolId: state.protocolId,
        suiteHash: state.suiteHash,
        // ── The Phase-2B additions ────────────────────────────────────────────
        readinessMode: entry.arm,
        campaignProtocolId: PHASE2B_CAMPAIGN_ID,
        requireChromeVersion: true,
        hooks: budget.hooks,
        ...(deps.log ? { onProgress: deps.log } : {})
      });
    } catch (error) {
      if (ctx) await ctx.dispose();
      recordEntry(state, entry, {
        status: "crashed",
        benchId: ctx?.benchId ?? "",
        dir: ctx?.benchDir ?? "",
        costUsd: budget.entryCostUsd(),
        completedTrials: budget.entryTrials()
      });
      delete state.pendingEntry;
      // F7 — a THROWN transport fault must not launder into a rerunnable crash.
      // Rerunning it would pool results around the very network fault the
      // incident rule exists to void. Only the KEYED phase can be transport-
      // poisoned: the keyless phase makes no provider calls at all.
      if (entry.phase === "keyed" && isPoisonedError(error)) {
        const reason =
          `transport poisoning detected in ${entryLabel(entry)}: the entry threw ` +
          `${JSON.stringify(asError(error).message)}, which matches the frozen transport-error ` +
          `pattern. The FULL keyed grid is invalidated: restart it; this attempt is preserved ` +
          `as evidence and must never be pooled (PROTOCOL_2B §Transport poisoning).`;
        state.poisonedReason = reason;
        await deps.persist(state);
        return { kind: "poisoned", reason, entry };
      }
      await deps.persist(state);
      return { kind: "crashed", entry, error: asError(error) };
    }

    await ctx.dispose();
    const status: Campaign2bEntryState["status"] = results.stopped ? "stopped" : "complete";
    recordEntry(state, entry, {
      status,
      benchId: ctx.benchId,
      dir: ctx.benchDir,
      costUsd: budget.entryCostUsd(),
      completedTrials: budget.entryTrials()
    });
    delete state.pendingEntry; // the slot is accounted for; the marker is spent
    await deps.persist(state);

    deps.log?.(
      `${entryLabel(entry)} [${entry.ordinal + 1}/${deps.schedule.length}] bench=${ctx.benchId} ` +
        `status=${status} cost=$${budget.entryCostUsd().toFixed(4)} ` +
        `spend=$${state.spendUsd.toFixed(4)}/$${CAMPAIGN_BUDGET_THRESHOLD_USD.toFixed(2)}`
    );

    // TRANSPORT POISONING (§Transport poisoning): outcome-blind, checked on every
    // completed entry. A poisoned entry invalidates the FULL grid — the attempt is
    // preserved as evidence and never pooled, and the campaign stops here rather
    // than accumulating results around a network fault.
    const poisoned = poisonedTrials(results);
    if (poisoned.length > 0) {
      const reason =
        `transport poisoning detected in ${entryLabel(entry)}: ` +
        `${poisoned.length} trial(s), e.g. ${poisoned[0]!.runId} ` +
        `(tokens=${JSON.stringify(poisoned[0]!.tokens)}, failureDetail=${JSON.stringify(
          poisoned[0]!.failureDetail ?? null
        )}). The FULL ${entry.phase} grid is invalidated: restart it; this attempt is ` +
        `preserved as evidence and must never be pooled (PROTOCOL_2B §Transport poisoning).`;
      state.poisonedReason = reason;
      await deps.persist(state);
      return { kind: "poisoned", reason, entry };
    }

    if (results.stopped) {
      state.stoppedReason = results.stopped.reason;
      await deps.persist(state);
      return { kind: "stopped", reason: results.stopped.reason, entry };
    }
  }
}

// ── I/O shell ────────────────────────────────────────────────────────────────

function defaultStateFile(phase: CampaignPhase): string {
  return `runs/phase2b/campaign-state.${phase}.json`;
}
/** The keyed smoke's own record — never part of any evidence bundle. */
const SMOKE_RECORD_FILE = "runs/phase2b/smoke.json";

/** The suite's scenarios projected to specs (all of them; the smoke may name any). */
function allowlistedSuiteScenarios(suite: LoadedScenarioSuite): ScenarioSpec[] {
  return suite.scenarios.map(suiteScenarioToSpec);
}

/** The tags pointing at HEAD, for the freeze guard. Empty on any git failure. */
function readTagsAtHead(): string[] {
  const out = spawnSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8" });
  if (out.status !== 0 || typeof out.stdout !== "string") return [];
  return out.stdout.split("\n").map((t) => t.trim()).filter(Boolean);
}

/** The commit HEAD points at, for the pre-spend recheck. */
function readGitCommit(): string | null {
  const out = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (out.status !== 0 || typeof out.stdout !== "string") return null;
  return out.stdout.trim() || null;
}
const PHASES: readonly CampaignPhase[] = ["keyless", "keyed"];

const USAGE =
  "Usage: pnpm campaign:2b --suite <scenario-suite.json> --phase <keyless|keyed> " +
  "[--state <file>] [--keyless-state <file> (keyed only)] " +
  "--frozen-expectations <file> (REQUIRED for --phase keyed) | --print-schedule";

function bail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

export interface Campaign2bCliArgs {
  suiteFile: string;
  phase: CampaignPhase;
  stateFile: string;
  keylessStateFile: string;
  /**
   * The gate-5 frozen expectations file (REQUIRED for --phase keyed). It carries
   * the pre-spend recheck's expected values AND the keyed smoke's scenario ids and
   * criteria. NO DEFAULT: the protocol freezes them at gate 5, so the driver takes
   * them as an explicit input and refuses to guess.
   */
  frozenExpectationsFile?: string;
  printSchedule: boolean;
}

export function parseCampaign2bArgs(argv: string[]): Campaign2bCliArgs {
  let suiteFile: string | undefined;
  let phase: CampaignPhase | undefined;
  let stateFile: string | undefined;
  let keylessStateFile: string | undefined;
  let frozenExpectationsFile: string | undefined;
  let printSchedule = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--print-schedule") {
      printSchedule = true;
    } else if (arg === "--suite") {
      suiteFile = argv[++i];
      if (!suiteFile) bail("--suite needs a path to a scenario-suite JSON");
    } else if (arg === "--phase") {
      const raw = argv[++i];
      if (!raw || !(PHASES as readonly string[]).includes(raw)) {
        bail(`--phase must be one of: ${PHASES.join(", ")}`);
      }
      phase = raw as CampaignPhase;
    } else if (arg === "--state") {
      stateFile = argv[++i];
      if (!stateFile) bail("--state needs a path to a campaign-state JSON");
    } else if (arg === "--keyless-state") {
      keylessStateFile = argv[++i];
      if (!keylessStateFile) bail("--keyless-state needs a path to the keyless campaign-state JSON");
    } else if (arg === "--frozen-expectations") {
      frozenExpectationsFile = argv[++i];
      if (!frozenExpectationsFile) {
        bail("--frozen-expectations needs a path to the gate-5 frozen-expectations JSON");
      }
    } else {
      bail(`Unknown flag "${arg}"`);
    }
  }
  if (printSchedule) {
    return {
      suiteFile: suiteFile ? path.resolve(suiteFile) : "",
      phase: phase ?? "keyless",
      stateFile: "",
      keylessStateFile: "",
      ...(frozenExpectationsFile ? { frozenExpectationsFile: path.resolve(frozenExpectationsFile) } : {}),
      printSchedule
    };
  }
  if (!suiteFile) bail("--suite is required");
  if (!phase) bail("--phase is required");
  if (keylessStateFile !== undefined && phase === "keyless") {
    bail("--keyless-state only applies to --phase keyed");
  }
  return {
    suiteFile: path.resolve(suiteFile),
    phase,
    stateFile: path.resolve(stateFile ?? defaultStateFile(phase)),
    keylessStateFile: path.resolve(keylessStateFile ?? defaultStateFile("keyless")),
    ...(frozenExpectationsFile ? { frozenExpectationsFile: path.resolve(frozenExpectationsFile) } : {}),
    printSchedule: false
  };
}

/** The dry-run schedule print: the frozen table, executed, with nothing run. */
export function renderSchedule(): string {
  const lines: string[] = [];
  for (const phase of PHASES) {
    const schedule = buildSchedule2b(phase);
    lines.push(
      `Phase-2B ${phase} schedule — ${schedule.length} run entries × ${PHASE2B_SCENARIO_IDS.length} scenarios = ${
        schedule.length * PHASE2B_SCENARIO_IDS.length
      } trials`
    );
    for (const e of schedule) {
      lines.push(
        `  [${String(e.ordinal + 1).padStart(2)}/${schedule.length}] ${e.policy.padEnd(2)} sweep-${e.sweep} arm=${e.arm}`
      );
    }
    lines.push("");
  }
  lines.push(`Scenarios (allowlist): ${PHASE2B_SCENARIO_IDS.join(", ")}`);
  lines.push(`Campaign: ${PHASE2B_CAMPAIGN_ID}   budget: $${CAMPAIGN_BUDGET_THRESHOLD_USD.toFixed(2)}`);
  lines.push("");
  lines.push("Verification (frozen; run after each phase):");
  for (const phase of ["keyless", "keyed", "pooled"] as const) {
    lines.push(`  ${phase}: ${operatorVerifyHint(phase, ["<run dirs>"], "<suite-file>")}`);
  }
  return lines.join("\n");
}

async function writeStateAtomic(stateFile: string, state: Campaign2bState): Promise<void> {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, stateFile);
}

function loadOrInitState(
  stateFile: string,
  suite: LoadedScenarioSuite,
  phase: CampaignPhase
): Campaign2bState {
  if (!existsSync(stateFile)) return initCampaign2bState(suite.protocolId, suite.suiteHash);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    bail(`campaign state at ${stateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = Campaign2bStateSchema.safeParse(raw);
  if (!parsed.success) {
    bail(
      `campaign state at ${stateFile} failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")}`
    );
  }
  if (parsed.data.poisonedReason !== undefined) {
    bail(
      `campaign state at ${stateFile} records a POISONED grid: ${parsed.data.poisonedReason}\n` +
        `The grid must be restarted from a fresh state file; the poisoned attempt is preserved evidence.`
    );
  }
  try {
    assertState2bMatches(parsed.data, suite, phase);
  } catch (error) {
    bail(`campaign state at ${stateFile} ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed.data;
}

async function prepareRun(entry: Campaign2bEntry): Promise<EntryRunContext> {
  const port = await pickFreePort();
  const labUrl = `http://127.0.0.1:${port}`;
  const child = spawnPrivateLab(port);
  try {
    await new LabClient(labUrl).waitUntilReady(20_000);
    const { runId, dir } = await createRunDir({
      kind: "bench",
      labUrl,
      description: `phase2b ${entry.phase} ${entry.policy} sweep-${entry.sweep} ${entry.arm}`
    });
    return { labUrl, benchDir: dir, benchId: runId, dispose: () => killAndVerify(child) };
  } catch (error) {
    await killAndVerify(child);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseCampaign2bArgs(process.argv.slice(2));
  if (args.printSchedule) {
    console.log(renderSchedule());
    process.exit(0);
  }

  let suite: LoadedScenarioSuite;
  try {
    suite = loadScenarioSuite(args.suiteFile);
  } catch (error) {
    bail(`Could not load --suite ${args.suiteFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // F9 — the suite is PINNED: a campaign pointed at an edited or regenerated file
  // is refused before any state exists, not after it has produced a bundle that
  // verifies against the wrong bytes.
  if (suite!.protocolId !== PHASE2B_SUITE_PROTOCOL_ID || suite!.suiteHash !== PHASE2B_SUITE_HASH) {
    bail(
      `--suite ${args.suiteFile} is not the frozen Phase-2B suite: protocolId ` +
        `"${suite!.protocolId}" / suiteHash ${suite!.suiteHash.slice(0, 16)}… ≠ frozen ` +
        `"${PHASE2B_SUITE_PROTOCOL_ID}" / ${PHASE2B_SUITE_HASH.slice(0, 16)}…`
    );
  }
  // F4 — EXACT set equality against the allowlist, not mere presence.
  const allowlistedScenarios: ScenarioSpec[] = suite!.scenarios
    .filter((s) => (PHASE2B_SCENARIO_IDS as readonly string[]).includes(s.id))
    .map(suiteScenarioToSpec);
  try {
    assertAllowlistedScenarios(allowlistedScenarios);
  } catch (error) {
    bail(`--suite ${args.suiteFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // F12 — the freeze guard: no entry of either phase runs unless gate 5's tag
  // points at HEAD. Checked before key discipline so the refusal is the same
  // whichever phase was requested.
  try {
    assertFrozenAtHead(readTagsAtHead());
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  try {
    enforceKeyDiscipline2b(args.phase, loadAgentEnvConfig().modelProvider !== null);
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  let frozen: FrozenExpectations | undefined;
  let smoke: SmokeResult | undefined;
  if (args.phase === "keyed") {
    // F11 — the keyed pre-flight pins the EXACT model and provider, not merely
    // "something in the price table": a different pinned model would price fine
    // and still not be the campaign the protocol froze.
    const env = loadAgentEnvConfig();
    if (env.stagehandModel !== PHASE2B_MODEL) {
      bail(
        `--phase keyed refuses to run: pricing model ${env.stagehandModel ?? "(none)"} ≠ the frozen ` +
          `Phase-2B model ${PHASE2B_MODEL}. Set STAGEHAND_MODEL to the frozen model.`
      );
    }
    if (!Object.keys(PINNED_PRICES).includes(PHASE2B_MODEL)) {
      bail(`internal: the frozen model ${PHASE2B_MODEL} is not in the pinned price table`);
    }
    if (env.modelProvider !== "anthropic") {
      bail(
        `--phase keyed refuses to run: provider ${env.modelProvider ?? "(none)"} ≠ anthropic. ` +
          `Phase 2B runs Anthropic with the frozen model (PROTOCOL_2B §Design).`
      );
    }

    // F1(b) — the gate-5 frozen expectations are required and never defaulted.
    if (!args.frozenExpectationsFile) {
      bail(
        "--phase keyed requires --frozen-expectations <file>: the pre-spend recheck and the keyed " +
          "smoke read their expected values from it, and they are frozen at gate 5 — this driver " +
          "refuses to guess them."
      );
    }
    if (!existsSync(args.frozenExpectationsFile)) {
      bail(`no frozen-expectations file at ${args.frozenExpectationsFile}`);
    }
    let frozenRaw: unknown;
    try {
      frozenRaw = JSON.parse(readFileSync(args.frozenExpectationsFile, "utf8"));
    } catch (error) {
      bail(
        `frozen expectations at ${args.frozenExpectationsFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const parsedFrozen = FrozenExpectationsSchema.safeParse(frozenRaw);
    if (!parsedFrozen.success) {
      bail(
        `frozen expectations at ${args.frozenExpectationsFile} failed validation: ${parsedFrozen.error.issues
          .slice(0, 3)
          .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
          .join("; ")}`
      );
    }
    frozen = parsedFrozen.data;

    if (!existsSync(args.keylessStateFile)) {
      bail(
        `--phase keyed refuses to run: no keyless campaign state at ${args.keylessStateFile} — the ` +
          `keyless grid must be complete and verifier-passed first (PROTOCOL_2B §Schedule).`
      );
    }
    let keylessRaw: unknown;
    try {
      keylessRaw = JSON.parse(readFileSync(args.keylessStateFile, "utf8"));
    } catch (error) {
      bail(
        `keyless campaign state at ${args.keylessStateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const reader = (dir: string): VerifyInput => {
      const file = path.join(dir, "results.json");
      if (!existsSync(file)) {
        throw new Error(`no results.json at ${file} (recorded keyless run dir moved or deleted?)`);
      }
      return { source: path.relative(process.cwd(), file), raw: JSON.parse(readFileSync(file, "utf8")) };
    };
    let verdict: KeylessVerdict;
    try {
      verdict = keyedPhaseGate2b(keylessRaw, suite!, reader, args.suiteFile);
    } catch (error) {
      bail(error instanceof Error ? error.message : String(error));
    }
    // F1(a) — RECORD the PASS verdict against the keyless state file (§Schedule),
    // so the pre-spend recheck below reads ledger evidence rather than a fact that
    // existed only in this process.
    const keylessState = Campaign2bStateSchema.parse(keylessRaw);
    keylessState.verdict = verdict!;
    await writeStateAtomic(args.keylessStateFile, keylessState);
    console.log(
      `Keyed-phase gate PASSED: the ${verdict!.entryCount}-entry keyless ledger is complete and the ` +
        `keyless bundle re-verified with the frozen keyless command; verdict recorded at ` +
        `${args.keylessStateFile}.\n`
    );

    // F1(c) — the PRE-SPEND RECHECK, immediately before the first paid call.
    try {
      assertPreSpendExpectations(
        {
          suiteHash: suite!.suiteHash,
          protocolId: suite!.protocolId,
          campaignProtocolId: PHASE2B_CAMPAIGN_ID,
          gitCommit: readGitCommit(),
          recordVersion: 2,
          arms: ["frozen", "any-row"],
          keylessVerdictPass: keylessState.verdict?.pass === true,
          scheduleLength: buildSchedule2b("keyed").length
        },
        {
          suiteHash: frozen.suiteHash,
          protocolId: frozen.protocolId,
          campaignProtocolId: frozen.campaignProtocolId,
          gitCommit: frozen.gitCommit,
          recordVersion: frozen.recordVersion,
          arms: frozen.arms,
          keylessVerdictPass: true,
          scheduleLength: frozen.scheduleLength
        }
      );
    } catch (error) {
      bail(error instanceof Error ? error.message : String(error));
    }
    console.log("Pre-spend recheck PASSED against the frozen expectations.\n");

    // F2 — the KEYED SMOKE runs before any evidence entry.
    try {
      smoke = await runKeyedSmoke(frozen, allowlistedSuiteScenarios(suite!), {
        runBenchmark,
        prepareRun,
        headless: true,
        log: (line) => console.log(line)
      });
    } catch (error) {
      bail(`keyed smoke failed to run: ${error instanceof Error ? error.message : String(error)}`);
    }
    mkdirSync(path.dirname(SMOKE_RECORD_FILE), { recursive: true });
    await writeFile(SMOKE_RECORD_FILE, JSON.stringify(smoke, null, 2) + "\n", "utf8");
    if (!smoke.ok) {
      const failed = smoke.trials.filter((t) => !t.passedCriteria);
      bail(
        `keyed smoke FAILED (${failed.length} of ${smoke.trials.length} trial(s)): ` +
          failed
            .map((t) => `${t.policy}/${t.scenarioId} — ${t.criterion}, got outcome=${t.outcome}`)
            .join("; ") +
          `\nRecord at ${SMOKE_RECORD_FILE}. The keyed phase produces no evidence (PROTOCOL_2B §Schedule).`
      );
    }
    console.log(`Keyed smoke PASSED (record: ${SMOKE_RECORD_FILE}).\n`);
  }

  const state = loadOrInitState(args.stateFile, suite!, args.phase);
  await writeStateAtomic(args.stateFile, state);

  const schedule = buildSchedule2b(args.phase);
  const scenarios: ScenarioSpec[] = allowlistedScenarios;

  console.log(
    `Phase-2B ${args.phase} campaign (${PHASE2B_CAMPAIGN_ID}): ${schedule.length} entrie(s) × ` +
      `${scenarios.length} scenario(s) = ${schedule.length * scenarios.length} trials; ` +
      `state ${args.stateFile}; threshold $${state.thresholdUsd.toFixed(2)}\n`
  );

  let outcome: Campaign2bOutcome;
  try {
    outcome = await runCampaign2b(state, {
      schedule,
      scenarios,
      model: loadAgentEnvConfig().stagehandModel,
      headless: true,
      runBenchmark,
      prepareRun,
      persist: (s) => writeStateAtomic(args.stateFile, s),
      log: (line) => console.log(line)
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const dirs = state.entries.map((e) => e.dir).filter(Boolean);
  if (outcome.kind === "poisoned") {
    console.error(
      `\nCampaign POISONED at ${entryLabel(outcome.entry)}: ${outcome.reason}\n` +
        `This grid is VOID. It will NOT be rerun entry-by-entry: restart the whole ${args.phase} ` +
        `grid from a fresh state file per the incident rule. The aborted attempt is preserved at ` +
        `${args.stateFile} as evidence and must never be pooled.`
    );
    process.exit(4); // 4 = transport poisoning (distinct from crash 1 / usage 2 / budget 3)
  }
  if (outcome.kind === "stopped") {
    console.error(
      `\nCampaign STOPPED (budget): ${outcome.reason}\n` +
        `State preserved at ${args.stateFile}. The grid is INCOMPLETE and supports no claims.\n` +
        `When complete, verify with:\n  ${operatorVerifyHint(args.phase, dirs, args.suiteFile)}`
    );
    process.exit(3);
  }
  if (outcome.kind === "crashed") {
    console.error(
      `\nCampaign CRASHED at ${entryLabel(outcome.entry)}: ${outcome.error.message}\n` +
        `Lab killed, state preserved at ${args.stateFile} (the crashed entry will rerun once).`
    );
    process.exit(1);
  }

  console.log(
    `\nCampaign COMPLETE: all ${schedule.length} entrie(s) ran. State at ${args.stateFile}.\n` +
      `Verify with:\n  ${operatorVerifyHint(args.phase, dirs, args.suiteFile)}`
  );
  process.exit(0);
}

const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
