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
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
  ChromeVersionUnavailableError,
  MissingChromeVersionError,
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

/**
 * The Phase-2A keyless evidence Arm F must REPLICATE (§Gates items 4 and 6).
 * Cells are `keyless-s{sweep}-{policy}`; each results.json carries exactly one
 * trial per scenario per sweep.
 */
export const PHASE2A_KEYLESS_RUNS_DIR = "evidence/phase2a/runs";
/** The policies whose Arm-F trials are replication-checked. */
export const REPLICATION_POLICIES = ["A", "B", "B2"] as const;

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
  entryCount: z.number().int().nonnegative(),
  /**
   * The Arm-F replication result (§Gates item 6). Recorded so the pre-spend
   * recheck can require it: a verdict that verified the bundle internally but
   * never replicated Phase 2A does not authorise keyed spend.
   */
  replication: z
    .object({
      pass: z.literal(true),
      cellsCompared: z.number().int().nonnegative(),
      trialsCompared: z.number().int().nonnegative()
    })
    .optional()
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
  /**
   * WHICH PHASE THIS LEDGER IS — identity, not inference. The protocol's "never
   * shared between phases" rule (§State files) is only enforceable if the file
   * itself says which phase it belongs to. Deriving it from `entries` fails on
   * exactly the state where it matters most: an ENTRY-LESS one. Since the smoke
   * moved into the ledger, an entry-less KEYED state can already carry paid
   * smoke spend and a recorded smoke pass, and an auditor fed precisely that to
   * `--phase keyless` and had it accepted.
   *
   * REQUIRED, deliberately not optional: no legitimate Phase-2B state can
   * predate the freeze tag, which has never been created, so there is nothing to
   * migrate — and a file that does not say which phase it is, is not a
   * Phase-2B ledger.
   */
  phase: z.enum(["keyless", "keyed"]),
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
  /**
   * The keyed smoke's banked spend. The smoke makes PAID calls that belong in no
   * schedule entry, so the ledger invariant is
   * `sum(entries.costUsd) + (smokeSpendUsd ?? 0) === spendUsd`. Absent reads as
   * zero, which is what every keyless state (and every pre-existing state file)
   * means — additive-optional so an old ledger still parses.
   */
  smokeSpendUsd: z.number().nonnegative().optional(),
  /**
   * A PASSING keyed smoke, recorded so a resume does not pay for it again. Only a
   * pass is ever written: a failed or crashed smoke leaves this absent and is
   * re-attempted (subject to the stop threshold). The identity fields let the
   * next invocation prove the recorded pass belongs to THIS freeze rather than
   * inheriting a stale go-ahead from another one.
   */
  smoke: z
    .object({
      pass: z.literal(true),
      protocolId: z.string(),
      suiteHash: z.string(),
      cId: z.string(),
      dId: z.string(),
      gitCommit: z.string().nullable(),
      spendUsd: z.number().nonnegative()
    })
    .optional(),
  /**
   * A browser-provenance abort's own channel (§Operational machinery). It is
   * DELIBERATELY not `stoppedReason`: that field is the budget stop's, it is
   * never cleared, and reusing it made a later real budget stop surface a stale
   * browser error as its reason. `recordedCrashed` states which branch the abort
   * took, so the CLI never has to guess whether the entry kept its rerun.
   */
  provenanceAbort: z
    .object({ reason: z.string(), recordedCrashed: z.boolean() })
    .optional(),
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
    /**
     * Pinned to `true`: the frozen file states the criterion, it cannot switch it
     * off. A gate that an operator can disable in the file it is checked against
     * is not a gate.
     */
    cMustHealLogin: z.literal(true),
    dId: z.string().min(1),
    dMustPass: z.literal(true)
  })
});
export type FrozenExpectations = z.infer<typeof FrozenExpectationsSchema>;

export function initCampaign2bState(
  protocolId: string,
  suiteHash: string,
  phase: CampaignPhase
): Campaign2bState {
  return {
    version: 1,
    phase,
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
 * campaign must never be resumed into this one — plus the phase stamp and the
 * keyless-purity rule the phase stamp makes checkable.
 */
export function assertState2bMatches(
  state: Campaign2bState,
  provenance: { protocolId: string; suiteHash: string },
  phase: CampaignPhase
): void {
  // THE FILE'S OWN PHASE CLAIM, checked FIRST and by exact match. Every check
  // below this one was previously the whole story, and none of them could see a
  // cross-phase state that had not yet recorded an entry — which, since the
  // keyed smoke banks into the ledger before the first entry, is a state that
  // can already hold real money and a recorded go-ahead.
  if (state.phase !== phase) {
    throw new Error(
      `is a "${state.phase}"-phase ledger but --phase is "${phase}": the keyless and keyed ` +
        `phases have different schedules and MUST NOT share a state file, and an entry-less ` +
        `keyed ledger can already carry paid smoke spend and a recorded smoke pass. Use ` +
        `${defaultStateFile(phase)} for the "${phase}" phase.`
    );
  }
  // KEYLESS PURITY. The keyless phase makes no provider calls at all, so the
  // protocol pins its smoke spend to zero (§Operational machinery) and no smoke
  // marker can honestly exist in it. A keyless ledger carrying either is a keyed
  // ledger wearing the wrong label, or a hand-edit.
  if (phase === "keyless" && (state.smoke !== undefined || (state.smokeSpendUsd ?? 0) > 0)) {
    throw new Error(
      `is labelled "keyless" but carries keyed-smoke accounting (smokeSpendUsd=$${(
        state.smokeSpendUsd ?? 0
      ).toFixed(6)}, smoke marker ${state.smoke ? "PRESENT" : "absent"}): the keyless phase makes ` +
        `no paid calls, so its smoke spend is zero and no smoke pass can exist in it ` +
        `(PROTOCOL_2B §Operational machinery).`
    );
  }
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
  // The entries-derived check is KEPT, now as an internal-consistency backstop
  // rather than the phase rule itself: with the stamp checked above, an entry
  // whose phase differs from its own ledger's is corruption, not a mix-up.
  const foreign = state.entries.find((e) => e.phase !== phase);
  if (foreign) {
    throw new Error(
      `records a "${foreign.phase}"-phase entry but --phase is "${phase}": the keyless and ` +
        `keyed phases have different schedules and MUST NOT share a state file. Use ` +
        `${defaultStateFile(phase)} for the "${phase}" phase.`
    );
  }
  // …and the IN-FLIGHT marker is phase-bearing too. It was the one such field
  // nothing validated: a state stamped for one phase carrying a pending marker
  // for the other passes every check above (the marker is not an entry yet), and
  // `reconcilePendingEntry` then mints a foreign-phase entry INTO this ledger —
  // which the very next load refuses, permanently bricking the file.
  if (state.pendingEntry && state.pendingEntry.phase !== phase) {
    throw new Error(
      `records an in-flight "${state.pendingEntry.phase}"-phase entry but --phase is "${phase}": ` +
        `the keyless and keyed phases have different schedules and MUST NOT share a state file, ` +
        `and reconciling this marker would mint a foreign-phase entry into the ledger. Use ` +
        `${defaultStateFile(phase)} for the "${phase}" phase.`
    );
  }
}

/**
 * Floating-point tolerance for the ledger invariant. Costs are sums of priced
 * per-trial amounts, so exact equality is not available; a micro-dollar is far
 * below any real trial's cost and far above accumulated float drift.
 */
export const LEDGER_EPSILON_USD = 1e-6;

/**
 * THE LEDGER INVARIANT, VALIDATED — not merely advertised.
 *
 * `sum(entries.costUsd) + smokeSpendUsd === spendUsd` was documented, maintained
 * on every write path, and asserted by tests, but never checked on LOAD. An
 * auditor handed the driver a schema-valid state claiming `spendUsd: 1` with no
 * entries and no smoke spend and it was accepted — which is the shape of the
 * attack that matters: an edited or corrupted ledger can UNDERSTATE recorded
 * spend, and the $39.90 stop rule is enforced against exactly that number.
 *
 * FAILS CLOSED. The one tolerated discrepancy is the documented mid-entry
 * orphan: with `pendingEntry` set, spend banked before the entry could be
 * recorded shows up as a POSITIVE gap that `reconcilePendingEntry` assigns to
 * the crashed slot. A NEGATIVE gap has no honest explanation on any path —
 * recorded spend below what the accounting already claims — so it is refused
 * even mid-entry.
 *
 * A CONSISTENT rewrite — every field lowered together so the ledger still
 * reconciles — is invisible to any in-file check; that class belongs to the
 * freeze tag and the frozen verification commands, not to this function.
 */
export function assertLedgerReconciles(state: Campaign2bState): void {
  const entrySum = state.entries.reduce((sum, e) => sum + e.costUsd, 0);
  const smokeSpend = state.smokeSpendUsd ?? 0;
  const gap = state.spendUsd - entrySum - smokeSpend;
  const numbers =
    `spendUsd=$${state.spendUsd.toFixed(6)}, sum(entries.costUsd)=$${entrySum.toFixed(6)}, ` +
    `smokeSpendUsd=$${smokeSpend.toFixed(6)}, gap=$${gap.toFixed(6)}`;
  const failsClosed =
    `The ledger fails CLOSED: a hand-edited or corrupted state could otherwise understate ` +
    `recorded spend, slip back under the $${CAMPAIGN_BUDGET_THRESHOLD_USD.toFixed(2)} stop ` +
    `threshold, and keep spending.`;

  // A recorded pass cannot claim more than the cumulative smoke bank it came out
  // of — that would be a receipt for money the ledger never saw.
  if (state.smoke && state.smoke.spendUsd > smokeSpend + LEDGER_EPSILON_USD) {
    throw new Error(
      `ledger does not reconcile: the recorded smoke pass claims $${state.smoke.spendUsd.toFixed(
        6
      )} but the cumulative smoke bank is only $${smokeSpend.toFixed(6)} (${numbers}). ` +
        `${failsClosed}`
    );
  }

  if (state.pendingEntry) {
    if (gap < -LEDGER_EPSILON_USD) {
      throw new Error(
        `ledger does not reconcile: recorded spend is LOWER than the accounted total while an ` +
          `entry is in flight (${numbers}). A pending entry may leave a POSITIVE orphan — spend ` +
          `banked before the entry could be recorded — never a negative one. ${failsClosed}`
      );
    }
    return;
  }

  if (Math.abs(gap) > LEDGER_EPSILON_USD) {
    throw new Error(
      `ledger does not reconcile: sum(entries.costUsd) + smokeSpendUsd ≠ spendUsd (${numbers}). ` +
        `With no entry in flight there is no orphan to explain a gap. ${failsClosed}`
    );
  }
}

/**
 * Reconcile a state whose process died MID-ENTRY (F10). The pending marker names
 * the slot that was in flight; its spend is already banked in `spendUsd` but has
 * no entry to account for it, so the slot is recorded as CRASHED carrying exactly
 * the orphaned amount (spendUsd − sum(entries.costUsd) − smokeSpendUsd). The
 * SMOKE'S banked spend is subtracted because it belongs to no schedule entry:
 * counting it as orphaned would charge the keyed smoke's cost to whichever slot
 * happened to be in flight. The ledger invariant
 * `sum(entries.costUsd) + smokeSpendUsd === spendUsd` holds afterwards, the
 * orphaned run dir is preserved for forensics, and the crash counts against the
 * rerun-once rule — an entry that dies mid-flight twice is not silently
 * attempted a third time.
 *
 * Idempotent: with no pending marker it does nothing. Returns whether it acted.
 */
export function reconcilePendingEntry(state: Campaign2bState): boolean {
  const pending = state.pendingEntry;
  if (!pending) return false;
  const banked = state.entries.reduce((sum, e) => sum + e.costUsd, 0);
  const orphaned = Math.max(0, state.spendUsd - banked - (state.smokeSpendUsd ?? 0));
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

/**
 * Enforce key discipline for the phase (throws; the shell maps to a usage bail).
 *
 * The keyless phase refuses unless BOTH the provider key and the model config are
 * absent. Checking the key alone was not enough: `STAGEHAND_MODEL` set without a
 * key still yields a non-null `stagehandModel` (config.ts:29-30 defaults from it
 * directly), which arms the hybrid engine's repair dispatch — so a "keyless" run
 * could carry a configured model. The error names exactly which variable is set,
 * because "a key is present" is unhelpful when the culprit is the model.
 */
export function enforceKeyDiscipline2b(
  phase: CampaignPhase,
  env: { modelProvider: string | null; stagehandModel: string | null }
): void {
  const hasKey = env.modelProvider !== null;
  if (phase === "keyless") {
    const set: string[] = [];
    if (hasKey) set.push(`a provider key (modelProvider "${env.modelProvider}")`);
    if (env.stagehandModel !== null) set.push(`STAGEHAND_MODEL ("${env.stagehandModel}")`);
    if (set.length > 0) {
      throw new Error(
        `--phase keyless refuses to run while ${set.join(" and ")} is set: the keyless grid must ` +
          `complete with no model configured at all (PROTOCOL_2B §Schedule).`
      );
    }
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
  verify: typeof verifySuite = verifySuite,
  /** The Phase-2A baseline reader — injectable exactly like `verify` above. */
  readPhase2aCellFn: Phase2aCellReader = readPhase2aCell
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
  // IDENTITY FIRST, THEN ARITHMETIC — the same order as loadOrInitState, so both
  // load paths refuse a state that fails both for the same stated reason. "This
  // is not the ledger you asked for" is the more useful answer than "its sums do
  // not add up", and an operator comparing the two paths' output should never
  // have to wonder which check they hit.
  try {
    assertState2bMatches(state, suite, "keyless");
  } catch (error) {
    throw new Error(`keyless campaign state ${error instanceof Error ? error.message : String(error)}`);
  }
  // The keyless ledger the KEYED phase gates on must itself reconcile: this gate
  // is the last read of that file before any paid call, and a bundle whose
  // spend accounting does not add up is not evidence of a completed grid.
  try {
    assertLedgerReconciles(state);
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
  // ARM-F REPLICATION (§Gates item 6): the 2B keyless bundle verifying against
  // ITSELF is not enough — Arm F must reproduce Phase 2A trial-for-trial, or
  // there is no baseline for the ablation to measure against. Checked AFTER the
  // frozen keyless verification and BEFORE the verdict is returned.
  const replication = assertArmFReplicatesPhase2a(
    state.entries,
    (dir) => readRunInput(dir).raw as { trials: TrialResult[] },
    readPhase2aCellFn
  );

  // The PASS verdict is RETURNED so the shell can record it against the keyless
  // state file (§Schedule) — the pre-spend recheck reads it from there, so the
  // verdict is ledger evidence rather than a line in a scrolled-away terminal.
  return {
    pass: true,
    at: new Date().toISOString(),
    violations: 0,
    entryCount: state.entries.length,
    replication: { pass: true, ...replication }
  };
}

// ── Arm-F replication of Phase 2A (§Gates items 4 and 6) ─────────────────────

/**
 * The FROZEN PROJECTION (§Gates item 4), verbatim and exhaustive. Arm F is the
 * replication control: if it does not reproduce Phase 2A trial-for-trial on these
 * fields, the ablation has no baseline and the keyed phase must not start.
 *
 * `accuracy` is compared as a WHOLE OBJECT by deep equality — never by
 * enumerating its keys — so a counter nested inside it cannot drift unnoticed.
 * `llmCalls` lives in the tokens block (keyless records carry `tokens: null`, so
 * it is legitimately absent on both sides).
 */
export const REPLICATION_FIELDS = [
  "outcome",
  "outcomeClass",
  "outcomeReason",
  "pipelineSuccess",
  "extractionSuccess",
  "validationSuccess",
  "accuracy",
  "failureCategory",
  "failureDetail",
  "retries",
  "recoveredAfterFailure",
  "healedSteps",
  "deterministicRepairSteps",
  "deterministicFallbacks",
  "llmCalls"
] as const;

export type ReplicationProjection = Record<(typeof REPLICATION_FIELDS)[number], unknown>;

/** Project a trial onto the frozen fields. Absent stays absent (undefined). */
export function projectForReplication(
  t: Pick<
    TrialResult,
    | "outcome"
    | "outcomeClass"
    | "outcomeReason"
    | "pipelineSuccess"
    | "extractionSuccess"
    | "validationSuccess"
    | "accuracy"
    | "failureCategory"
    | "failureDetail"
    | "retries"
    | "recoveredAfterFailure"
    | "healedSteps"
    | "deterministicRepairSteps"
    | "deterministicFallbacks"
    | "tokens"
  >
): ReplicationProjection {
  return {
    outcome: t.outcome,
    outcomeClass: t.outcomeClass,
    outcomeReason: t.outcomeReason,
    pipelineSuccess: t.pipelineSuccess,
    extractionSuccess: t.extractionSuccess,
    validationSuccess: t.validationSuccess,
    accuracy: t.accuracy,
    failureCategory: t.failureCategory,
    failureDetail: t.failureDetail,
    retries: t.retries,
    recoveredAfterFailure: t.recoveredAfterFailure,
    healedSteps: t.healedSteps,
    deterministicRepairSteps: t.deterministicRepairSteps,
    deterministicFallbacks: t.deterministicFallbacks,
    // Keyless records have `tokens: null`, so this is absent on both sides —
    // which the equal-absence rule accepts.
    llmCalls: t.tokens == null ? undefined : t.tokens.llmCalls
  };
}

/**
 * Deep, KEY-ORDER-INSENSITIVE equality. `JSON.stringify` of raw objects would
 * make two identical records differ on key order alone, so structures are
 * canonicalised (keys sorted, undefined-valued keys dropped) before comparison.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalise(v);
    }
    return out;
  }
  return value;
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b));
}

export interface ReplicationMismatch {
  cell: string;
  scenarioId: string;
  field: string;
  phase2b: unknown;
  phase2a: unknown;
}

/**
 * Compare one paired trial across the frozen projection. The EQUAL-ABSENCE rule
 * is generic, not per-field: a field undefined on BOTH sides matches; present on
 * exactly one side is a mismatch — so neither side can quietly gain or drop a
 * field (a dropped `healedSteps` would otherwise read as "no repairs" and match
 * an honest run that genuinely had none).
 */
export function compareProjections(
  cell: string,
  scenarioId: string,
  b: ReplicationProjection,
  a: ReplicationProjection
): ReplicationMismatch[] {
  const out: ReplicationMismatch[] = [];
  for (const field of REPLICATION_FIELDS) {
    const bv = b[field];
    const av = a[field];
    if (bv === undefined && av === undefined) continue; // equal absence
    if (bv === undefined || av === undefined || !deepEqual(bv, av)) {
      out.push({ cell, scenarioId, field, phase2b: bv, phase2a: av });
    }
  }
  return out;
}

/** How the gate reads a Phase-2A cell. Injectable so tests need no filesystem. */
export type Phase2aCellReader = (cell: string) => { trials: TrialResult[] };

/**
 * The repository root, derived from THIS script's own location (scripts/ → ..).
 * The Phase-2A baseline must resolve identically from any working directory —
 * resolving it against process.cwd() made the gate silently unfindable whenever
 * the driver was invoked from anywhere but the repo root.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The real reader: <repo>/evidence/phase2a/runs/<cell>/results.json. */
export function readPhase2aCell(cell: string): { trials: TrialResult[] } {
  const file = path.join(REPO_ROOT, PHASE2A_KEYLESS_RUNS_DIR, cell, "results.json");
  if (!existsSync(file)) {
    throw new Error(`Phase-2A replication baseline missing: no results.json at ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as { trials: TrialResult[] };
}

export interface ReplicationOutcome {
  cellsCompared: number;
  trialsCompared: number;
}

/**
 * ARM-F REPLICATION (§Gates item 6). Each 2B Arm-F keyless trial is paired by
 * (scenario, policy, sweep) with the trial of the same scenarioId in
 * `evidence/phase2a/runs/keyless-s{sweep}-{policy}/results.json`, restricted to
 * the five allowlisted scenarios, policies A/B/B2, sweeps 1–5 → 75 paired trials.
 *
 * A MISSING PAIR IS A VIOLATION, NOT A SKIP: a scenario absent from either side
 * means the replication claim is unproven for that cell, and silently comparing
 * fewer trials is exactly how a gate stops gating. Likewise EXACTLY ONE trial is
 * required per scenario per side: comparing only the first element would let a
 * side ship [good, bad, bad] and pass on the strength of its first row.
 *
 * HONEST SCOPE: duplicate or collapsed runs are rejected by the frozen keyless
 * verification that `keyedPhaseGate2b` runs immediately BEFORE this check; this
 * gate's counts are not 75 independent measurements.
 */
export function assertArmFReplicatesPhase2a(
  /**
   * The keyless ledger's entries — they carry the (policy, sweep, arm) identity
   * the pairing rule is written in, so the pairing is read off the schedule
   * rather than inferred from run contents.
   */
  entries: readonly Campaign2bEntryState[],
  /** Reads a 2B run's trials from its recorded dir. */
  read2bRun: (dir: string) => { trials: TrialResult[] },
  readCell: Phase2aCellReader = readPhase2aCell
): ReplicationOutcome {
  const mismatches: ReplicationMismatch[] = [];
  let cellsCompared = 0;
  let trialsCompared = 0;

  for (const policy of REPLICATION_POLICIES) {
    for (const sweep of [1, 2, 3, 4, 5] as const) {
      const cell = `keyless-s${sweep}-${policy}`;
      // The 2B side: the Arm-F entry for exactly this (policy, sweep).
      const entry = entries.find(
        (e) => e.arm === "frozen" && e.policy === policy && e.sweep === sweep
      );
      if (!entry) {
        mismatches.push({
          cell,
          scenarioId: "(all)",
          field: "(paired run)",
          phase2b: "no Arm-F entry for this policy and sweep",
          phase2a: cell
        });
        cellsCompared += 1;
        continue;
      }
      const twoB = read2bRun(entry.dir).trials;
      const twoA = readCell(cell).trials;
      cellsCompared += 1;

      for (const scenarioId of PHASE2B_SCENARIO_IDS) {
        const bTrials = twoB.filter((t) => t.scenarioId === scenarioId);
        const aTrials = twoA.filter((t) => t.scenarioId === scenarioId);
        // EXACTLY one per side. Zero means the pair does not exist; more than one
        // means the pairing is ambiguous and comparing [0] would let the extras
        // ride along unchecked.
        if (bTrials.length !== 1 || aTrials.length !== 1) {
          mismatches.push({
            cell,
            scenarioId,
            field: "(paired trial)",
            phase2b: `${bTrials.length} trial(s)`,
            phase2a: `${aTrials.length} trial(s)`
          });
          continue;
        }
        trialsCompared += 1;
        mismatches.push(
          ...compareProjections(
            cell,
            scenarioId,
            projectForReplication(bTrials[0]!),
            projectForReplication(aTrials[0]!)
          )
        );
      }
    }
  }

  if (mismatches.length > 0) {
    const shown = mismatches
      .slice(0, 5)
      .map(
        (m) =>
          `    ${m.cell} / ${m.scenarioId} / ${m.field}: 2B ${JSON.stringify(m.phase2b)} ≠ 2A ${JSON.stringify(m.phase2a)}`
      )
      .join("\n");
    throw new Error(
      `Arm F does NOT replicate Phase 2A (${mismatches.length} mismatch(es) over ${trialsCompared} ` +
        `paired trial(s) in ${cellsCompared} cell(s)):\n${shown}` +
        (mismatches.length > 5 ? `\n    …and ${mismatches.length - 5} more` : "") +
        `\nArm F is the replication control; without it the ablation has no baseline and the keyed ` +
        `phase refuses to start (PROTOCOL_2B §Gates items 4 and 6).`
    );
  }
  // FIX 4 — the counts are the gate's own report of how much it checked, and
  // every consumer trusts them. Assert them against the frozen expectation
  // DERIVED FROM THE CONSTANTS, so a reader that quietly compared nothing cannot
  // return a passing verdict carrying zeros.
  const expectedCells = REPLICATION_POLICIES.length * 5;
  const expectedTrials = expectedCells * PHASE2B_SCENARIO_IDS.length;
  if (cellsCompared !== expectedCells || trialsCompared !== expectedTrials) {
    throw new Error(
      `Arm-F replication did not cover the frozen grid: compared ${cellsCompared}/${expectedCells} ` +
        `cell(s) and ${trialsCompared}/${expectedTrials} trial(s). A replication gate that checked ` +
        `less than the whole grid has not replicated it (PROTOCOL_2B §Gates item 6).`
    );
  }
  return { cellsCompared, trialsCompared };
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
  /**
   * WHAT THIS SMOKE RAN UNDER. Without these the record cannot be tied to a
   * suite, a campaign or a commit — a smoke.json from any run would look like a
   * smoke.json for this one.
   */
  protocolId: string;
  suiteHash: string;
  campaignProtocolId: string;
  gitCommit: string | null;
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
/**
 * The budget threshold crossed DURING the smoke (§Schedule). THROWN rather than
 * folded into the SmokeResult, because the two are different claims and the
 * driver used to conflate them: the runner answers a mid-run stop with zero
 * trials plus a `stopped` block, and grading that produced a smoke.json durably
 * recording "C failed to heal the login / D failed to complete the flow" about
 * two trials that never ran — then exited 2 (usage) instead of 3 (budget).
 */
export class SmokeBudgetStopError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "SmokeBudgetStopError";
    this.reason = reason;
  }
}

/**
 * The frozen-suite refusal, shared by BOTH smoke entry points. A smoke against
 * the wrong suite proves nothing about the campaign it is supposed to gate — and
 * `ensureKeyedSmoke`'s recorded-pass skip returns before `runKeyedSmoke` is ever
 * reached, so a check that lives only on the inner function is absent on exactly
 * the path that runs nothing and reports success.
 */
function assertFrozenSmokeSuite(provenance: { protocolId: string; suiteHash: string }): void {
  if (
    provenance.protocolId !== PHASE2B_SUITE_PROTOCOL_ID ||
    provenance.suiteHash !== PHASE2B_SUITE_HASH
  ) {
    throw new Error(
      `keyed smoke refuses to run: suite protocolId "${provenance.protocolId}" / suiteHash ` +
        `${provenance.suiteHash.slice(0, 16)}… ≠ the frozen "${PHASE2B_SUITE_PROTOCOL_ID}" / ` +
        `${PHASE2B_SUITE_HASH.slice(0, 16)}…`
    );
  }
}

export type KeyedSmokeDeps = Pick<
  Campaign2bDeps,
  "runBenchmark" | "prepareRun" | "headless" | "log"
> & {
  /**
   * The budget hooks, when the caller is accounting for the smoke's spend
   * (`ensureKeyedSmoke` always is). Forwarded VERBATIM to both runBenchmark
   * calls, so the smoke's paid trials bank through exactly the path an entry's
   * do. Optional only so the criteria-focused tests can drive this function
   * without a ledger.
   */
  hooks?: Parameters<typeof runBenchmark>[0]["hooks"];
};

export async function runKeyedSmoke(
  frozen: FrozenExpectations,
  suiteScenarios: readonly ScenarioSpec[],
  deps: KeyedSmokeDeps,
  /** The loaded suite's provenance, plus the commit, for the stamps and the refusal. */
  provenance: { protocolId: string; suiteHash: string; gitCommit: string | null }
): Promise<SmokeResult> {
  // REFUSE BEFORE RUNNING ANYTHING: a smoke against the wrong suite proves
  // nothing about the campaign it is supposed to gate.
  //
  // DEFENCE IN DEPTH, not an independent barrier: main() pins the suite against
  // these same constants before calling this, so in production this refusal is a
  // second copy of an earlier check.
  assertFrozenSmokeSuite(provenance);
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
        // THE SMOKE'S OWN RECORDS CARRY THE FROZEN SUITE IDENTITY. Omitting these
        // let the runner stamp the smoke's results.json with its built-in
        // phase1-catalog identity, so the trial records disagreed with the
        // smoke.json summary written around them — a smoke that cannot be tied to
        // the suite it gates proves nothing about it. The provenance refusal at
        // the top of this function has already pinned both to the frozen values.
        protocolId: provenance.protocolId,
        suiteHash: provenance.suiteHash,
        readinessMode: "frozen",
        campaignProtocolId: PHASE2B_CAMPAIGN_ID,
        requireChromeVersion: true,
        ...(deps.hooks ? { hooks: deps.hooks } : {})
      });
    } finally {
      await ctx.dispose();
    }
    // A BUDGET STOP IS NOT A SMOKE FAILURE — checked BEFORE any grading. The
    // runner reports a mid-run stop as zero trials plus a `stopped` block, and
    // the grading below reads `trials[0]` as undefined: C then "did not heal the
    // login", D "did not complete the flow", and smoke.json records both as
    // scientific findings about trials that never executed.
    if (results.stopped) throw new SmokeBudgetStopError(results.stopped.reason);
    const t = results.trials[0];
    const healedSteps = t?.healedSteps ?? [];
    // Both criteria are pinned true by the schema, so there is no "disabled"
    // branch to take.
    const criterion =
      policy === "C"
        ? "must heal the login step via its repair path"
        : "must complete the full flow (outcome pass)";
    const passedCriteria =
      policy === "C"
        ? // EXACT step name. `includes("login")` also accepted "relogin" and
          // "login-retry"; the canonical healed-step vocabulary in the real
          // Phase-2A evidence is login / reveal-table / extract-stats /
          // extract-odds, so the criterion names the step it means.
          healedSteps.some((step) => step === "login")
        : t?.outcome === "pass";
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
    protocolId: provenance.protocolId,
    suiteHash: provenance.suiteHash,
    campaignProtocolId: PHASE2B_CAMPAIGN_ID,
    gitCommit: provenance.gitCommit,
    trials,
    ok: trials.every((t) => t.passedCriteria)
  };
}

/** What `ensureKeyedSmoke` decided. Every branch is explicit; none is silent. */
export type EnsureKeyedSmokeOutcome =
  /** A passing smoke for THIS freeze is already recorded — nothing was run. */
  | { kind: "skipped" }
  | { kind: "passed"; smoke: SmokeResult }
  /** The stop threshold was already reached — no smoke call was made. */
  | { kind: "budget-stopped"; reason: string }
  /**
   * The machine could not report its browser build during the smoke. An
   * ENVIRONMENT fault, routed through the same state channel as the entry
   * loop's — never a smoke verdict.
   */
  | { kind: "provenance-abort"; reason: string }
  | { kind: "failed"; smoke: SmokeResult };

/**
 * The keyed smoke AS A LEDGER OPERATION, not a free pre-flight.
 *
 * The smoke makes PAID calls. Running it outside the state file (as this driver
 * originally did) meant three things at once: a resume paid for it again on every
 * invocation, its spend was invisible to the $39.90 stop rule, and a state
 * already at the threshold could incur more paid calls before any stop check ran.
 * So the smoke is ordered like an entry — recorded-pass check, stop check, then
 * run with budget hooks — and its spend banks into `smokeSpendUsd`, inside the
 * extended ledger invariant `sum(entries.costUsd) + smokeSpendUsd === spendUsd`.
 *
 * THE INVARIANT HOLDS AT EVERY PERSIST, not merely at the end: the persist
 * callback handed to the hooks re-derives `smokeSpendUsd` from the hooks' own
 * running total BEFORE writing, so a `kill -9` between two smoke trials leaves a
 * consistent snapshot. No `state.smoke` is written until the smoke has actually
 * passed, so that crash re-runs the smoke rather than inheriting a pass it never
 * earned.
 */
export async function ensureKeyedSmoke(
  state: Campaign2bState,
  frozen: FrozenExpectations,
  suiteScenarios: readonly ScenarioSpec[],
  deps: Pick<Campaign2bDeps, "runBenchmark" | "prepareRun" | "headless" | "log" | "persist">,
  /** The loaded suite's provenance, plus the commit, for the stamps and the refusal. */
  provenance: { protocolId: string; suiteHash: string; gitCommit: string | null }
): Promise<EnsureKeyedSmokeOutcome> {
  // (0) THE FROZEN-SUITE REFUSAL, before the skip path can bypass it. The same
  // check lives inside runKeyedSmoke, but the recorded-pass branch below returns
  // without ever calling it — so as an exported API this would happily report
  // "skipped" for a campaign pointed at the wrong suite.
  assertFrozenSmokeSuite(provenance);

  // THE LEDGER MUST ADD UP BEFORE THE KEYED PHASE'S FIRST PAID CALL — which is
  // the smoke, not the first entry. runCampaign2b guards its own loop for
  // exactly this reason; applying it there and not here left the earlier of the
  // two spend sites unguarded.
  assertLedgerReconciles(state);

  /**
   * A NEW INVOCATION SUPERSEDES A STALE ABORT NOTE — the same rule, rationale
   * and only-write-when-present pattern as the entry loop's.
   *
   * Called only on paths that actually proceed. It used to run before the
   * recorded-pass check, which meant a different-freeze REFUSAL — a path that
   * runs nothing and changes nothing — first erased the previous run's
   * provenance note from disk, destroying the evidence of why that run stopped
   * while refusing to do any work of its own.
   */
  const clearStaleAbortNote = async (): Promise<void> => {
    if (state.provenanceAbort !== undefined) {
      delete state.provenanceAbort;
      await deps.persist(state);
    }
  };

  // (1) A RECORDED PASS IS NOT REPEATED — but only if it is THIS freeze's. A
  // recorded smoke naming other scenario ids, another suite or another COMMIT is
  // a go-ahead earned somewhere else; honouring it would let a re-frozen
  // campaign start keyed spend on the strength of a smoke that never ran
  // against it.
  const recorded = state.smoke;
  if (recorded) {
    // gitCommit carries the weight here. protocolId and suiteHash are frozen
    // CONSTANTS for this campaign — every freeze of it agrees on them — and the
    // two smoke scenario ids can legitimately repeat across freezes. The commit
    // is the only field that actually separates one freeze from the next.
    const sameFreeze =
      recorded.protocolId === frozen.protocolId &&
      recorded.suiteHash === frozen.suiteHash &&
      recorded.gitCommit === frozen.gitCommit &&
      recorded.cId === frozen.smoke.cId &&
      recorded.dId === frozen.smoke.dId;
    if (!sameFreeze) {
      throw new Error(
        `the campaign state's recorded keyed smoke belongs to a DIFFERENT freeze: it recorded ` +
          `protocolId "${recorded.protocolId}" / suiteHash ${recorded.suiteHash.slice(0, 16)}… / ` +
          `gitCommit ${recorded.gitCommit ?? "(none)"} / C=${recorded.cId} / D=${recorded.dId}, ` +
          `but the frozen expectations name protocolId "${frozen.protocolId}" / suiteHash ` +
          `${frozen.suiteHash.slice(0, 16)}… / gitCommit ${frozen.gitCommit} / ` +
          `C=${frozen.smoke.cId} / D=${frozen.smoke.dId}. A smoke that gated another freeze does ` +
          `not gate this one — start this campaign from a fresh state file ` +
          `(PROTOCOL_2B §Schedule).`
      );
    }
    // A matching recorded pass IS a proceeding path: the campaign goes on to its
    // entries, so a note from the previous invocation is superseded here too.
    await clearStaleAbortNote();
    deps.log?.("keyed smoke already PASSED (recorded in state) — not repeated");
    return { kind: "skipped" };
  }
  await clearStaleAbortNote();

  /**
   * Stop the campaign at the smoke gate, LEAVING A TRACE. The CLI tells the
   * operator "State preserved at <file>"; without this the preserved state said
   * nothing whatever about why the campaign stopped. Mirrors the entry loop's
   * stop path, which persists the same field for the same reason.
   */
  const budgetStopped = async (reason: string): Promise<EnsureKeyedSmokeOutcome> => {
    state.stoppedReason = reason;
    await deps.persist(state);
    return { kind: "budget-stopped", reason };
  };

  // (2) THE STOP THRESHOLD APPLIES TO THE SMOKE. Checked before the first smoke
  // call, exactly as it is before every entry: a state at or past the threshold
  // incurs no further paid calls of any kind.
  const preStop = shouldStop(state as unknown as CampaignState);
  if (preStop) return budgetStopped(preStop);

  // (3) Run it WITH spend accounting, through the same hooks an entry uses.
  const smokeBase = state.smokeSpendUsd ?? 0;
  const budget = makeBudgetHooks(
    state as unknown as CampaignState,
    loadAgentEnvConfig().stagehandModel,
    async (s) => {
      // Every banking persist re-derives the smoke's share FIRST, so the
      // snapshot that reaches disk always satisfies the extended invariant.
      const snapshot = s as unknown as Campaign2bState;
      snapshot.smokeSpendUsd = smokeBase + budget.entryCostUsd();
      await deps.persist(snapshot);
    }
  );

  // A throw here propagates: the hooks have already persisted whatever was
  // banked, and no `state.smoke` exists, so the next invocation re-runs the smoke.
  let smoke: SmokeResult;
  try {
    smoke = await runKeyedSmoke(
      frozen,
      suiteScenarios,
      {
        runBenchmark: deps.runBenchmark,
        prepareRun: deps.prepareRun,
        headless: deps.headless,
        ...(deps.log ? { log: deps.log } : {}),
        hooks: budget.hooks
      },
      provenance
    );
  } catch (error) {
    // THE THRESHOLD CROSSED MID-SMOKE. It is a budget stop, not a scientific
    // result: the hooks have already banked and persisted what was spent, no
    // `state.smoke` is written, and the interrupted smoke is never graded. Every
    // other error still propagates.
    if (error instanceof SmokeBudgetStopError) return budgetStopped(error.reason);
    // A BROWSER-PROVENANCE FAULT IS NOT A SMOKE VERDICT EITHER, and it now uses
    // the same state channel the entry loop does. It previously escaped to
    // main()'s generic bail: exit 2 (usage), no channel, and a state file that
    // said nothing about why the campaign stopped. `recordedCrashed` is false
    // because there is no entry to record — the smoke banks into
    // `smokeSpendUsd`, so whatever was spent is already accounted for and the
    // ledger reconciles without any crash entry.
    if (isProvenanceAbortError(error)) {
      const reason =
        `browser provenance unavailable during the keyed smoke: ${asError(error).message} ` +
        `This is an ENVIRONMENT fault, not a smoke verdict — fix the browser and re-run; ` +
        `any banked smoke spend is already in the ledger and no pass was recorded.`;
      state.provenanceAbort = { reason, recordedCrashed: false };
      await deps.persist(state);
      return { kind: "provenance-abort", reason };
    }
    throw error;
  }

  // Bring the in-memory share current even when no hook fired (a zero-trial
  // smoke): harmless when redundant, and the failed-path persist below then
  // writes a complete snapshot.
  const spent = budget.entryCostUsd();
  state.smokeSpendUsd = smokeBase + spent;

  if (!smoke.ok) {
    // A FAILED smoke keeps its spend banked and records NO pass — it is
    // re-attempted next invocation, subject to the stop threshold.
    await deps.persist(state);
    return { kind: "failed", smoke };
  }

  state.smoke = {
    pass: true,
    protocolId: frozen.protocolId,
    suiteHash: frozen.suiteHash,
    cId: frozen.smoke.cId,
    dId: frozen.smoke.dId,
    gitCommit: provenance.gitCommit,
    spendUsd: spent
  };
  await deps.persist(state);
  return { kind: "passed", smoke };
}

// ── Freeze guard (§Gates) ────────────────────────────────────────────────────

/**
 * No entry of either phase may run unless gate 5's freeze tag points at HEAD.
 * There is deliberately NO override flag: the whole point of a freeze is that the
 * code executing the campaign is the code the protocol was frozen against.
 * `--print-schedule` is exempt — it runs nothing.
 */
/**
 * The freeze tag pinning HEAD is not enough: uncommitted edits would execute
 * under it, so the code that ran would not be the code the protocol was frozen
 * against. Untracked files count as dirty — the same standard as gate 1, and for
 * the same reason (an untracked module can be imported).
 */
/**
 * The pre-flight guards, in order, over INJECTED readers. Extracted so the
 * sequence itself is testable: with the checks inlined in main(), deleting one
 * of them broke no test at all — the guards were covered but their WIRING was
 * not. The order matters: the freeze tag is checked first, so a repo at the
 * wrong commit is refused without the worktree ever being read.
 */
export function runPreflightGuards(deps: {
  readTags: () => string[];
  readStatus: () => string;
}): void {
  assertFrozenAtHead(deps.readTags());
  // …and nothing uncommitted: the freeze tag is only meaningful if the code at
  // HEAD is the code that runs.
  assertCleanWorktree(deps.readStatus());
}

export function assertCleanWorktree(porcelain: string): void {
  const lines = porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length > 0) {
    const shown = lines.slice(0, 5).map((l) => `    ${l}`).join("\n");
    throw new Error(
      `refusing to execute any campaign entry: the worktree is DIRTY (${lines.length} path(s), ` +
        `untracked included — an untracked module can still be imported):\n${shown}` +
        (lines.length > 5 ? `\n    …and ${lines.length - 5} more` : "") +
        `\nPhase 2B runs only at its frozen commit with nothing uncommitted (PROTOCOL_2B §Gates).`
    );
  }
}

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
    mismatches.push(
      "keylessVerdictPass: the keyless bundle has not recorded a PASS verdict WITH a passing " +
        "Arm-F replication block (§Gates item 6)"
    );
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
  | { kind: "poisoned"; reason: string; entry: Campaign2bEntry }
  /** The machine could not report its browser build — an environment fault. */
  | { kind: "provenance-abort"; reason: string; entry: Campaign2bEntry };

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Is this throw a BROWSER-PROVENANCE abort rather than a trial failure? Either
 * class counts: the engine's acquisition-time abort, and the runner's
 * post-attempt strict check. The cause chain is walked because both can arrive
 * wrapped by an intermediate layer.
 */
export function isProvenanceAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (
      current instanceof ChromeVersionUnavailableError ||
      current instanceof MissingChromeVersionError
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  // THE LEDGER MUST ADD UP BEFORE ANYTHING IS SPENT AGAINST IT — checked here as
  // well as on load, so no caller of this loop (test or shell) can drive a
  // campaign from a ledger whose recorded spend the stop rule cannot trust.
  // Before reconcilePendingEntry, which is the one operation licensed to consume
  // a gap: checking afterwards would validate its own output.
  assertLedgerReconciles(state);
  // A resumed state whose process died mid-entry is reconciled before the first
  // schedule decision, so the ledger the loop reads is already consistent.
  reconcilePendingEntry(state);
  // A NEW RUN SUPERSEDES A STALE ABORT NOTE — ON DISK, not merely in memory.
  // The previous invocation's browser fault describes that invocation; leaving
  // it set is how a later, unrelated outcome ended up reported with a browser
  // error as its reason. Letting the deletion ride the "next existing persist"
  // was not enough: a campaign whose schedule is already complete returns
  // without ever persisting, so the archival snapshot kept the stale note
  // forever. Written immediately, and ONLY when the field was actually present
  // — the happy path still adds no extra write.
  if (state.provenanceAbort !== undefined) {
    delete state.provenanceAbort;
    await deps.persist(state);
  }
  for (;;) {
    const entry = nextEntry2b(state, deps.schedule);
    if (entry === null) return { kind: "complete" };

    const preStop = shouldStop(state as unknown as CampaignState);
    if (preStop) {
      // `stoppedReason` is now the BUDGET's field alone. A provenance abort used
      // to write it too, and it is never cleared — so this `??` could hand a real
      // budget stop a stale browser error as its explanation. Aborts record into
      // `provenanceAbort` instead and never touch this one.
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

      // ── PROVENANCE ABORT ≠ TRIAL CRASH ──────────────────────────────────
      // A browser-provenance abort says the MACHINE could not report its Chrome
      // build; it says nothing about the trial. Recording it as a crash spends
      // the entry's one permitted rerun on an environment fault, so a second
      // invocation while Chrome is still broken kills the cell permanently and
      // the operator has to hand-edit the ledger. Both classes are caught: the
      // engine-init abort (ChromeVersionUnavailableError) and the runner's
      // post-attempt strict check (MissingChromeVersionError). The cause chain
      // is walked, since either can arrive wrapped.
      if (isProvenanceAbortError(error)) {
        const spent = budget.entryCostUsd();
        const reason =
          `browser provenance unavailable at ${entryLabel(entry)}: ${asError(error).message} ` +
          `This is an ENVIRONMENT fault, not a trial fault — fix the browser and re-run; ` +
          (spent > 0
            ? `the completed attempt banked $${spent.toFixed(4)}, so the entry is recorded as ` +
              `crashed carrying that cost (the ledger invariant is non-negotiable).`
            : `the entry is not marked crashed and keeps its rerun allowance.`);
        if (spent > 0) {
          // The runner's strict check banks a completed attempt's spend before
          // throwing (batch 13, 4b). That spend is already in state.spendUsd, so
          // the entry MUST be recorded carrying it — the ledger invariant
          // sum(entries.costUsd) === spendUsd is non-negotiable, and it is the
          // only reason this path records anything at all.
          recordEntry(state, entry, {
            status: "crashed",
            benchId: ctx?.benchId ?? "",
            dir: ctx?.benchDir ?? "",
            costUsd: spent,
            completedTrials: budget.entryTrials()
          });
        }
        delete state.pendingEntry;
        // ITS OWN CHANNEL, carrying which branch was taken. `stoppedReason` is
        // the budget's; writing an abort there left a note nothing ever cleared,
        // and the CLI could not tell whether an entry had been marked crashed.
        state.provenanceAbort = { reason, recordedCrashed: spent > 0 };
        await deps.persist(state);
        return { kind: "provenance-abort", reason, entry };
      }

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

/**
 * EVERY git read below is pinned to THIS repository along BOTH routes git offers
 * for choosing one, because pinning either alone is no defence at all.
 *
 *  - `cwd: REPO_ROOT` — with no cwd these answered about whatever repository the
 *    operator happened to be standing in, so running the driver from an
 *    unrelated checkout carrying a tag named `phase2b-ablation-freeze-v1`
 *    satisfied the freeze guard.
 *  - `env: gitCleanEnv()` — and cwd alone does NOT close that hole, because git
 *    resolves `GIT_DIR` / `GIT_WORK_TREE` IN PREFERENCE TO the working
 *    directory. Reproduced: with `GIT_DIR=<fake>/.git GIT_WORK_TREE=<fake>` set,
 *    `git tag --points-at HEAD` run *from this repository root* still returns the
 *    fake repo's tags, and `git status --porcelain` reports the fake repo's clean
 *    tree while ours is dirty. Both guards were bypassable from the right cwd.
 *
 * The freeze would then be attested by a repository containing none of this
 * code. The cwd gate in main() is the third layer: the driver refuses to run
 * from anywhere but the repo in the first place.
 */

/**
 * The process environment with EVERY `GIT_*` variable removed — the environment
 * every git read below runs under.
 *
 * The WHOLE PREFIX is stripped rather than just `GIT_DIR` and `GIT_WORK_TREE`:
 * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_INDEX_FILE`,
 * `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM` redirect the
 * same reads by other routes, and an allowlist of the two names known to be
 * exploitable today is exactly the kind of guard that stops guarding.
 */
function gitCleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("GIT_")) delete clean[name];
  }
  return clean;
}

/**
 * The tags pointing at HEAD, for the freeze guard. Empty on any git failure.
 *
 * EXPORTED FOR TESTS. On the CLI path this is reached only from the repository
 * root (main()'s working-directory gate runs first), but proving the pinning
 * actually holds requires calling it from a hostile cwd AND a hostile
 * environment — which only a test can do.
 */
export function readTagsAtHead(): string[] {
  const out = spawnSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: REPO_ROOT,
    env: gitCleanEnv(),
    encoding: "utf8"
  });
  if (out.status !== 0 || typeof out.stdout !== "string") return [];
  return out.stdout.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * `git status --porcelain`, for the clean-worktree guard. Dirty on git failure.
 * Exported for tests, for the reason given on readTagsAtHead.
 */
export function readWorktreeStatus(): string {
  const out = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    env: gitCleanEnv(),
    encoding: "utf8"
  });
  if (out.status !== 0 || typeof out.stdout !== "string") {
    return "?? (git status unavailable — treating the worktree as dirty)";
  }
  return out.stdout;
}

/**
 * The commit HEAD points at, for the pre-spend recheck. Exported for tests, for
 * the reason given on readTagsAtHead.
 */
export function readGitCommit(): string | null {
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    env: gitCleanEnv(),
    encoding: "utf8"
  });
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

/**
 * Load a state file, or initialise a fresh one stamped with THIS phase.
 *
 * EXPORTED FOR TESTS. The CLI path is unchanged — main() is its only production
 * caller. The fresh-init half is the WRITE side of the phase stamp, and it was
 * untestable while private: a mutant passing a literal phase here would stamp a
 * first keyed run's state "keyless", bank real smoke spend into it, and lock the
 * operator out on the next resume.
 *
 * NOTE FOR CALLERS: every refusal below goes through `bail`, which calls
 * `process.exit`. Only the fresh-init and happy-load paths are exercisable
 * in-process.
 */
export function loadOrInitState(
  stateFile: string,
  suite: LoadedScenarioSuite,
  phase: CampaignPhase
): Campaign2bState {
  if (!existsSync(stateFile)) {
    return initCampaign2bState(suite.protocolId, suite.suiteHash, phase);
  }
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
  try {
    assertLedgerReconciles(parsed.data);
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

  // THE WORKING-DIRECTORY GATE, before every other guard. The freeze guard reads
  // git; git answers about the repository you are standing in. Standing in an
  // unrelated repository that happens to carry a tag named
  // `phase2b-ablation-freeze-v1` therefore bought a pass — the guard's own
  // reads are now pinned to REPO_ROOT, and this refuses the situation outright
  // so no other repo-relative path (state files, run dirs, evidence) can be
  // half-resolved either. `--print-schedule` stays exempt: it runs nothing.
  // realpath on both sides so a symlinked checkout is not mistaken for a
  // different tree.
  const cwdReal = realpathSync(process.cwd());
  const rootReal = realpathSync(REPO_ROOT);
  if (cwdReal !== rootReal) {
    bail(
      `campaign must run from the repository root ${rootReal} — current working directory is ` +
        `${cwdReal}. The freeze and worktree guards read this repository's git history, and the ` +
        `default state, smoke and run paths resolve relative to it; running from elsewhere would ` +
        `let another checkout answer for this one (PROTOCOL_2B §Gates, gate 5).`
    );
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
    runPreflightGuards({ readTags: readTagsAtHead, readStatus: readWorktreeStatus });
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  try {
    const envConfig = loadAgentEnvConfig();
    enforceKeyDiscipline2b(args.phase, {
      modelProvider: envConfig.modelProvider,
      stagehandModel: envConfig.stagehandModel
    });
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  // THE LEDGER IS LOADED BEFORE THE KEYED PRE-FLIGHT, not after it. The keyed
  // smoke spends real money, so it has to bank into this state — and be skipped
  // when this state already records a pass, and be refused when this state is
  // already at the stop threshold. Loading it afterwards made all three
  // impossible. Both phases share this unchanged.
  const state = loadOrInitState(args.stateFile, suite!, args.phase);
  await writeStateAtomic(args.stateFile, state);

  let frozen: FrozenExpectations | undefined;
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
    // F1(a) — RECORD the PASS verdict against the keyless state file (§Schedule).
    //
    // WHAT ENFORCES WHAT, stated plainly: the control that REFUSES a keyless
    // bundle which does not replicate Phase 2A is keyedPhaseGate2b's throw,
    // above — by the time execution reaches here the gate has already passed.
    // Writing and re-reading the verdict is a CROSS-CHECK that the recorded
    // evidence actually persisted to disk, nothing more. It is not a second
    // opinion on the replication itself.
    const keylessState = Campaign2bStateSchema.parse(keylessRaw);
    keylessState.verdict = verdict!;
    await writeStateAtomic(args.keylessStateFile, keylessState);
    // Re-read from DISK. Reading back the same in-memory object would make the
    // conjunct below tautological — its `replication.pass` is a literal `true`
    // assigned three lines earlier, so it could never be false and the on-disk
    // ledger would never be consulted at all.
    let persistedVerdict: KeylessVerdict | undefined;
    try {
      const reread = Campaign2bStateSchema.parse(
        JSON.parse(readFileSync(args.keylessStateFile, "utf8"))
      );
      persistedVerdict = reread.verdict;
    } catch (error) {
      bail(
        `keyless verdict did not persist to ${args.keylessStateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
          // Read from the DISK copy: this conjunct cross-checks that the
          // verdict — including its Arm-F replication block — actually reached
          // the ledger. The replication itself was enforced by the gate above.
          keylessVerdictPass:
            persistedVerdict?.pass === true && persistedVerdict.replication?.pass === true,
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

    // F2 — the KEYED SMOKE runs before any evidence entry, accounted for in the
    // ledger it gates: skipped when already passed, refused at the threshold,
    // and its spend banked as it accrues.
    let smokeOutcome: EnsureKeyedSmokeOutcome;
    try {
      smokeOutcome = await ensureKeyedSmoke(
        state,
        frozen,
        allowlistedSuiteScenarios(suite!),
        {
          runBenchmark,
          prepareRun,
          headless: true,
          log: (line) => console.log(line),
          persist: (s) => writeStateAtomic(args.stateFile, s)
        },
        {
          protocolId: suite!.protocolId,
          suiteHash: suite!.suiteHash,
          gitCommit: readGitCommit()
        }
      );
    } catch (error) {
      bail(`keyed smoke failed to run: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (smokeOutcome!.kind === "budget-stopped") {
      console.error(
        `\nCampaign STOPPED (budget): ${smokeOutcome!.reason}\n` +
          `State preserved at ${args.stateFile}. The grid is INCOMPLETE and supports no claims.\n` +
          `When complete, verify with:\n  ${operatorVerifyHint(
            args.phase,
            state.entries.map((e) => e.dir).filter(Boolean),
            args.suiteFile
          )}`
      );
      process.exit(3);
    }
    if (smokeOutcome!.kind === "provenance-abort") {
      // Same shape as the campaign-loop abort, and deliberately NO smoke.json:
      // the machine could not report its browser build, so there is no smoke
      // verdict to record.
      console.error(
        `\nCampaign ABORTED (browser provenance) during the keyed smoke: ${smokeOutcome!.reason}\n` +
          `State preserved at ${args.stateFile} — fix the browser and re-run this command.` +
          ` Any existing ${SMOKE_RECORD_FILE} describes an EARLIER attempt, not this one.`
      );
      process.exit(1);
    }
    if (smokeOutcome!.kind !== "skipped") {
      const smoke = smokeOutcome!.smoke;
      mkdirSync(path.dirname(SMOKE_RECORD_FILE), { recursive: true });
      await writeFile(SMOKE_RECORD_FILE, JSON.stringify(smoke, null, 2) + "\n", "utf8");
      if (smokeOutcome!.kind === "failed") {
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
  }

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
  if (outcome.kind === "provenance-abort") {
    // The reason is already branch-aware — it states whether the completed
    // attempt banked spend and was therefore recorded as crashed. This block
    // used to append a flat "the entry was NOT marked crashed", which was a lie
    // on exactly the branch that HAD recorded one. The CLI now claims nothing
    // about crash marking; only the reason speaks to it.
    console.error(
      `\nCampaign ABORTED (browser provenance): ${outcome.reason}\n` +
        `State preserved at ${args.stateFile} — fix the browser and re-run this command.`
    );
    process.exit(1);
  }
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
