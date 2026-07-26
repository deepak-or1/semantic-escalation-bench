import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BenchmarkResults,
  LoadedScenarioSuite,
  ScenarioSpec,
  TrialResult
} from "@ssda/shared";
import {
  CAMPAIGN_BUDGET_THRESHOLD_USD,
  ChromeVersionUnavailableError,
  MissingChromeVersionError,
  trialCost,
  type BenchmarkRunConfig
} from "@ssda/agent";
import {
  Campaign2bStateSchema,
  PHASE2B_CAMPAIGN_ID,
  PHASE2B_MODEL,
  PHASE2B_PRICES_PINNED_AT,
  PHASE2B_SCENARIO_IDS,
  assertLedgerReconciles,
  assertPreSpendExpectations,
  assertState2bMatches,
  buildSchedule2b,
  LEDGER_EPSILON_USD,
  enforceKeyDiscipline2b,
  entryLabel,
  initCampaign2bState,
  FrozenExpectationsSchema,
  PHASE2B_FREEZE_TAG,
  PHASE2B_SUITE_HASH,
  PHASE2B_SUITE_PROTOCOL_ID,
  assertAllowlistedScenarios,
  assertFrozenAtHead,
  REPLICATION_FIELDS,
  REPLICATION_POLICIES,
  assertArmFReplicatesPhase2a,
  assertCleanWorktree,
  compareProjections,
  ensureKeyedSmoke,
  isPoisonedError,
  isPoisonedTrial,
  projectForReplication,
  readPhase2aCell,
  keyedPhaseGate2b,
  loadOrInitState,
  runKeyedSmoke,
  nextEntry2b,
  operatorVerifyHint,
  parseCampaign2bArgs,
  reconcilePendingEntry,
  runPreflightGuards,
  renderSchedule,
  runCampaign2b,
  verifyGridFor,
  type Campaign2bDeps,
  type Campaign2bEntry,
  type Campaign2bEntryState,
  type Campaign2bState,
  type PreSpendExpectations
} from "../../scripts/run-campaign-2b";
import type { VerifyInput, VerifyReport } from "../../scripts/verify-suite";

/**
 * The Phase-2B campaign driver (docs/PROTOCOL_2B.md §Schedule). Everything here
 * runs over INJECTED effects — stubbed runners, readers and verifiers — so not a
 * single trial, lab, browser or paid call is involved. That is deliberate: the
 * five allowlisted scenarios must not be observed under `any-row` before the
 * expectations are registered at gate 5.
 */

// ── The frozen schedule, asserted entry by entry ─────────────────────────────

/**
 * F6 — the expected schedule, hand-typed from docs/PROTOCOL_2B.md §Schedule and
 * deriving NOTHING from the implementation: not the policy order, not the
 * nesting, not a single arm cell. If PHASE_POLICIES, the sweep-major nesting, or
 * any cell of the arm table drifts, this list disagrees and the test fails.
 *
 * Sweep-major (carried from Phase 2A): sweep 1 runs every policy of the phase in
 * frozen order, each policy running its two arms back-to-back per its sweep's arm
 * order; then sweep 2, and so on.
 *
 *   | Policy | Sweep 1 | Sweep 2 | Sweep 3 | Sweep 4 | Sweep 5 |
 *   | A      | F,R | R,F | F,R | R,F | F,R |
 *   | B      | R,F | F,R | R,F | F,R | R,F |
 *   | B2     | F,R | R,F | F,R | R,F | F,R |
 *   | C      | R,F | F,R | R,F | F,R | R,F |
 *   | D      | F,R | R,F | F,R | R,F | F,R |
 */
type Row = { phase: string; policy: string; sweep: number; arm: string };
const f = "frozen";
const r = "any-row";
const EXPECTED_KEYLESS: Row[] = [
  // sweep 1 — A(F,R) B(R,F) B2(F,R)
  { phase: "keyless", policy: "A", sweep: 1, arm: f },
  { phase: "keyless", policy: "A", sweep: 1, arm: r },
  { phase: "keyless", policy: "B", sweep: 1, arm: r },
  { phase: "keyless", policy: "B", sweep: 1, arm: f },
  { phase: "keyless", policy: "B2", sweep: 1, arm: f },
  { phase: "keyless", policy: "B2", sweep: 1, arm: r },
  // sweep 2 — A(R,F) B(F,R) B2(R,F)
  { phase: "keyless", policy: "A", sweep: 2, arm: r },
  { phase: "keyless", policy: "A", sweep: 2, arm: f },
  { phase: "keyless", policy: "B", sweep: 2, arm: f },
  { phase: "keyless", policy: "B", sweep: 2, arm: r },
  { phase: "keyless", policy: "B2", sweep: 2, arm: r },
  { phase: "keyless", policy: "B2", sweep: 2, arm: f },
  // sweep 3 — A(F,R) B(R,F) B2(F,R)
  { phase: "keyless", policy: "A", sweep: 3, arm: f },
  { phase: "keyless", policy: "A", sweep: 3, arm: r },
  { phase: "keyless", policy: "B", sweep: 3, arm: r },
  { phase: "keyless", policy: "B", sweep: 3, arm: f },
  { phase: "keyless", policy: "B2", sweep: 3, arm: f },
  { phase: "keyless", policy: "B2", sweep: 3, arm: r },
  // sweep 4 — A(R,F) B(F,R) B2(R,F)
  { phase: "keyless", policy: "A", sweep: 4, arm: r },
  { phase: "keyless", policy: "A", sweep: 4, arm: f },
  { phase: "keyless", policy: "B", sweep: 4, arm: f },
  { phase: "keyless", policy: "B", sweep: 4, arm: r },
  { phase: "keyless", policy: "B2", sweep: 4, arm: r },
  { phase: "keyless", policy: "B2", sweep: 4, arm: f },
  // sweep 5 — A(F,R) B(R,F) B2(F,R)
  { phase: "keyless", policy: "A", sweep: 5, arm: f },
  { phase: "keyless", policy: "A", sweep: 5, arm: r },
  { phase: "keyless", policy: "B", sweep: 5, arm: r },
  { phase: "keyless", policy: "B", sweep: 5, arm: f },
  { phase: "keyless", policy: "B2", sweep: 5, arm: f },
  { phase: "keyless", policy: "B2", sweep: 5, arm: r }
];
const EXPECTED_KEYED: Row[] = [
  // sweep 1 — C(R,F) D(F,R)
  { phase: "keyed", policy: "C", sweep: 1, arm: r },
  { phase: "keyed", policy: "C", sweep: 1, arm: f },
  { phase: "keyed", policy: "D", sweep: 1, arm: f },
  { phase: "keyed", policy: "D", sweep: 1, arm: r },
  // sweep 2 — C(F,R) D(R,F)
  { phase: "keyed", policy: "C", sweep: 2, arm: f },
  { phase: "keyed", policy: "C", sweep: 2, arm: r },
  { phase: "keyed", policy: "D", sweep: 2, arm: r },
  { phase: "keyed", policy: "D", sweep: 2, arm: f },
  // sweep 3 — C(R,F) D(F,R)
  { phase: "keyed", policy: "C", sweep: 3, arm: r },
  { phase: "keyed", policy: "C", sweep: 3, arm: f },
  { phase: "keyed", policy: "D", sweep: 3, arm: f },
  { phase: "keyed", policy: "D", sweep: 3, arm: r },
  // sweep 4 — C(F,R) D(R,F)
  { phase: "keyed", policy: "C", sweep: 4, arm: f },
  { phase: "keyed", policy: "C", sweep: 4, arm: r },
  { phase: "keyed", policy: "D", sweep: 4, arm: r },
  { phase: "keyed", policy: "D", sweep: 4, arm: f },
  // sweep 5 — C(R,F) D(F,R)
  { phase: "keyed", policy: "C", sweep: 5, arm: r },
  { phase: "keyed", policy: "C", sweep: 5, arm: f },
  { phase: "keyed", policy: "D", sweep: 5, arm: f },
  { phase: "keyed", policy: "D", sweep: 5, arm: r }
];

describe("Phase-2B frozen schedule", () => {
  it("matches the protocol's SWEEP-MAJOR table entry-by-entry, all 50 entries", () => {
    const expected = [...EXPECTED_KEYLESS, ...EXPECTED_KEYED];
    expect(expected).toHaveLength(50);
    const actual = [...buildSchedule2b("keyless"), ...buildSchedule2b("keyed")];
    expect(actual).toHaveLength(50);
    for (let i = 0; i < expected.length; i++) {
      expect(
        { phase: actual[i]!.phase, policy: actual[i]!.policy, sweep: actual[i]!.sweep, arm: actual[i]!.arm },
        `entry ${i}`
      ).toEqual(expected[i]);
    }
    // Ordinals are dense and 0-based within each phase.
    expect(buildSchedule2b("keyless").map((e) => e.ordinal)).toEqual([...Array(30).keys()]);
    expect(buildSchedule2b("keyed").map((e) => e.ordinal)).toEqual([...Array(20).keys()]);
  });

  it("is SWEEP-MAJOR, not policy-major: sweep 1 touches every policy before sweep 2 begins", () => {
    const keyless = buildSchedule2b("keyless");
    // The first six entries are all sweep 1, covering all three policies.
    expect(keyless.slice(0, 6).every((e) => e.sweep === 1)).toBe(true);
    expect([...new Set(keyless.slice(0, 6).map((e) => e.policy))]).toEqual(["A", "B", "B2"]);
    // Sweeps are non-decreasing across the schedule — the drift-confounding
    // clustering the contract forbids would break this.
    const sweeps = keyless.map((e) => e.sweep);
    expect([...sweeps].sort((a, b) => a - b)).toEqual(sweeps);
  });

  it("has the protocol's shape: 30 keyless + 20 keyed entries, 250 trials over the five scenarios", () => {
    expect(buildSchedule2b("keyless")).toHaveLength(30);
    expect(buildSchedule2b("keyed")).toHaveLength(20);
    expect(PHASE2B_SCENARIO_IDS).toHaveLength(5);
    expect((30 + 20) * PHASE2B_SCENARIO_IDS.length).toBe(250);
    for (const policy of ["A", "B", "B2"] as const) {
      const mine = buildSchedule2b("keyless").filter((e) => e.policy === policy);
      expect(mine.filter((e) => e.arm === "frozen")).toHaveLength(5);
      expect(mine.filter((e) => e.arm === "any-row")).toHaveLength(5);
    }
  });
});

// ── Resume: order and arm refusal ────────────────────────────────────────────

const SUITE = { protocolId: "phase2a-v1", suiteHash: "a".repeat(64) };

function stateWith(entries: Partial<Campaign2bEntryState>[]): Campaign2bState {
  const base = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
  base.entries = entries.map((e) => ({
    phase: "keyless",
    sweep: 1,
    policy: "A",
    arm: "frozen",
    status: "complete",
    benchId: "bench-x",
    dir: "runs/x",
    costUsd: 0,
    completedTrials: 5,
    reruns: 0,
    ...e
  })) as Campaign2bEntryState[];
  return base;
}

describe("Phase-2B resume state machine", () => {
  const schedule = buildSchedule2b("keyless");

  it("starts at the first entry and advances in schedule order", () => {
    expect(nextEntry2b(stateWith([]), schedule)).toEqual(schedule[0]);
    expect(nextEntry2b(stateWith([{ ...schedule[0]! }]), schedule)).toEqual(schedule[1]);
  });

  it("REFUSES an entry recorded with the WRONG ARM for its slot", () => {
    // Slot 0 is A/sweep-1/frozen. Recording it as any-row is not that slot's work.
    const wrongArm = stateWith([{ ...schedule[0]!, arm: "any-row" }]);
    expect(() => nextEntry2b(wrongArm, schedule)).toThrow(/the wrong arm for this slot/);
  });

  it("REFUSES an out-of-order entry", () => {
    const outOfOrder = stateWith([{ ...schedule[2]! }]);
    expect(() => nextEntry2b(outOfOrder, schedule)).toThrow(/out-of-order entry/);
  });

  it("reruns a crashed entry ONCE and then refuses a silent third attempt", () => {
    const crashedOnce = stateWith([{ ...schedule[0]!, status: "crashed", reruns: 0 }]);
    expect(nextEntry2b(crashedOnce, schedule)).toEqual(schedule[0]);
    const crashedTwice = stateWith([{ ...schedule[0]!, status: "crashed", reruns: 1 }]);
    expect(() => nextEntry2b(crashedTwice, schedule)).toThrow(/no silent third attempt/);
  });

  it("refuses a state from another campaign or another phase", () => {
    const foreign = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    foreign.campaignProtocolId = "phase2c-something";
    expect(() => assertState2bMatches(foreign, SUITE, "keyless")).toThrow(/belongs to campaign/);
    const mixed = stateWith([{ phase: "keyed", policy: "C" }]);
    expect(() => assertState2bMatches(mixed, SUITE, "keyless")).toThrow(/MUST NOT share a state file/);
  });
});

// ── State identity: the phase is stamped, not inferred ───────────────────────
//
// The finding: the state file carried no phase of its own, so the "never shared
// between phases" rule was enforced by scanning `entries` — which says nothing
// at all before the first entry is recorded. And since the keyed smoke moved
// into the ledger, an ENTRY-LESS keyed state can already hold real paid spend
// and a recorded go-ahead. An auditor fed exactly that to `--phase keyless` and
// it was accepted.

describe("Phase-2B state phase identity", () => {
  /** The auditor's artifact: keyed money and a keyed go-ahead, but NO entries. */
  const auditorsKeyedState = (): Campaign2bState => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    state.smokeSpendUsd = 0.25;
    state.spendUsd = 0.25;
    state.smoke = {
      pass: true,
      protocolId: SUITE.protocolId,
      suiteHash: SUITE.suiteHash,
      cId: "f3-page-size-3-a",
      dId: "f3-page-size-3-b",
      gitCommit: "0".repeat(40),
      spendUsd: 0.25
    };
    return state;
  };

  it("THE REPRO: an entry-less KEYED ledger carrying smoke spend is refused by --phase keyless", () => {
    const state = auditorsKeyedState();
    // Nothing about it is malformed — it is a perfectly valid keyed ledger…
    expect(Campaign2bStateSchema.safeParse(state).success).toBe(true);
    expect(state.entries).toHaveLength(0);
    // …and the entries-derived check could never have seen it.
    expect(state.entries.some((e) => e.phase !== "keyless")).toBe(false);
    expect(() => assertState2bMatches(state, SUITE, "keyless")).toThrow(
      /is a "keyed"-phase ledger but --phase is "keyless"/
    );
    expect(() => assertState2bMatches(state, SUITE, "keyless")).toThrow(
      /MUST NOT share a state file/
    );
  });

  it("THE REPRO, through a real load path: keyedPhaseGate2b refuses it as the keyless ledger", () => {
    expect(() =>
      keyedPhaseGate2b(auditorsKeyedState(), fakeSuite(), reader, "s.json", () => okReport)
    ).toThrow(/is a "keyed"-phase ledger but --phase is "keyless"/);
  });

  it("an empty KEYLESS ledger is refused by --phase keyed", () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    expect(() => assertState2bMatches(state, SUITE, "keyed")).toThrow(
      /is a "keyless"-phase ledger but --phase is "keyed"/
    );
  });

  it("ITEM 1: the IN-FLIGHT pendingEntry marker is phase-bound too, in both directions", () => {
    // The one phase-bearing field nothing validated. The marker is not an entry
    // yet, so every other check passes — and reconcilePendingEntry would then
    // mint a foreign-phase entry INTO this ledger, which the very next load
    // refuses, permanently bricking the file.
    const keyedWithKeylessMarker = initCampaign2bState(
      SUITE.protocolId,
      SUITE.suiteHash,
      "keyed"
    );
    keyedWithKeylessMarker.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "frozen",
      benchId: "bench-x",
      benchDir: "runs/x"
    };
    // It is schema-valid, entry-less, and its ledger reconciles — nothing else
    // in the driver can see the problem.
    expect(Campaign2bStateSchema.safeParse(keyedWithKeylessMarker).success).toBe(true);
    expect(keyedWithKeylessMarker.entries).toHaveLength(0);
    expect(() => assertLedgerReconciles(keyedWithKeylessMarker)).not.toThrow();
    expect(() => assertState2bMatches(keyedWithKeylessMarker, SUITE, "keyed")).toThrow(
      /records an in-flight "keyless"-phase entry but --phase is "keyed"/
    );

    // …and the mirror image, which is the direction that reaches disk: a
    // keyless CLI run reconciling a keyed marker into a keyless file.
    const keylessWithKeyedMarker = initCampaign2bState(
      SUITE.protocolId,
      SUITE.suiteHash,
      "keyless"
    );
    keylessWithKeyedMarker.pendingEntry = {
      phase: "keyed",
      sweep: 1,
      policy: "C",
      arm: "any-row",
      benchId: "bench-y",
      benchDir: "runs/y"
    };
    expect(() => assertState2bMatches(keylessWithKeyedMarker, SUITE, "keyless")).toThrow(
      /records an in-flight "keyed"-phase entry but --phase is "keyless"/
    );
    expect(() => assertState2bMatches(keylessWithKeyedMarker, SUITE, "keyless")).toThrow(
      /MUST NOT share a state file/
    );
  });

  it("ITEM 1: an HONEST matching pendingEntry is still accepted", () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "frozen",
      benchId: "bench-x",
      benchDir: "runs/x"
    };
    expect(() => assertState2bMatches(state, SUITE, "keyless")).not.toThrow();
  });

  it("KEYLESS PURITY: a ledger labelled keyless carrying smoke accounting is refused", () => {
    // The keyless phase makes no provider calls at all, so neither field can
    // honestly exist in it — this is a keyed ledger wearing the wrong label, or
    // a hand-edit.
    const withMarker = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    withMarker.smoke = auditorsKeyedState().smoke;
    withMarker.smokeSpendUsd = 0.25;
    withMarker.spendUsd = 0.25;
    expect(() => assertState2bMatches(withMarker, SUITE, "keyless")).toThrow(
      /labelled "keyless" but carries keyed-smoke accounting/
    );

    // …and spend alone, with no marker, is refused for the same reason.
    const spendOnly = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    spendOnly.smokeSpendUsd = 0.25;
    spendOnly.spendUsd = 0.25;
    expect(() => assertState2bMatches(spendOnly, SUITE, "keyless")).toThrow(
      /smoke marker absent/
    );
  });

  it("ITEM 2: the smoke MARKER alone is enough to fail keyless purity — no spend required", () => {
    // Every other purity case pairs the marker with nonzero smokeSpendUsd, so
    // the `state.smoke !== undefined` half of the predicate was carrying no
    // weight: dropping it left the suite green. A recorded go-ahead with no
    // spend attached is exactly the artifact a zero-cost or hand-written smoke
    // marker produces, and it must not ride into a keyless ledger.
    const markerOnly = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    markerOnly.smoke = {
      pass: true,
      protocolId: SUITE.protocolId,
      suiteHash: SUITE.suiteHash,
      cId: "f3-page-size-3-a",
      dId: "f3-page-size-3-b",
      gitCommit: "0".repeat(40),
      spendUsd: 0
    };
    // No smoke spend at all, and the ledger reconciles perfectly.
    expect(markerOnly.smokeSpendUsd).toBeUndefined();
    expect(markerOnly.spendUsd).toBe(0);
    expect(markerOnly.entries).toHaveLength(0);
    expect(() => assertLedgerReconciles(markerOnly)).not.toThrow();

    expect(() => assertState2bMatches(markerOnly, SUITE, "keyless")).toThrow(
      /labelled "keyless" but carries keyed-smoke accounting/
    );
    expect(() => assertState2bMatches(markerOnly, SUITE, "keyless")).toThrow(
      /smoke marker PRESENT/
    );
  });

  it("honest states of BOTH phases still pass", () => {
    expect(() =>
      assertState2bMatches(
        initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless"),
        SUITE,
        "keyless"
      )
    ).not.toThrow();
    expect(() => assertState2bMatches(auditorsKeyedState(), SUITE, "keyed")).not.toThrow();
    expect(() => assertState2bMatches(completeKeylessState(), SUITE, "keyless")).not.toThrow();
  });

  it("ITEM 3: loadOrInitState STAMPS the requested phase onto a fresh state, for both phases", () => {
    // The WRITE half of the phase rule, and the half nothing exercised: a mutant
    // passing a literal phase here would stamp a first KEYED run's state
    // "keyless", bank real smoke spend into it, and lock the operator out on the
    // next resume — after the money was already gone.
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssda-2b-state-"));
    for (const phase of ["keyless", "keyed"] as const) {
      const file = path.join(dir, `fresh-${phase}.json`);
      const state = loadOrInitState(file, fakeSuite(), phase);
      expect(state.phase, `fresh ${phase} init`).toBe(phase);
      // …and the stamp it wrote is the one the matching load accepts.
      expect(() => assertState2bMatches(state, SUITE, phase)).not.toThrow();
      const other = phase === "keyless" ? "keyed" : "keyless";
      expect(() => assertState2bMatches(state, SUITE, other)).toThrow(
        /-phase ledger but --phase is/
      );
    }
  });

  it("ITEM 3: an honest keyed state file round-trips through loadOrInitState", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ssda-2b-state-"));
    const file = path.join(dir, "campaign-state.keyed.json");
    const written = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    written.smokeSpendUsd = 0.25;
    written.spendUsd = 0.25;
    writeFileSync(file, JSON.stringify(written, null, 2) + "\n", "utf8");

    const loaded = loadOrInitState(file, fakeSuite(), "keyed");
    expect(loaded.phase).toBe("keyed");
    expect(loaded.smokeSpendUsd).toBeCloseTo(0.25, 10);
    expect(loaded.spendUsd).toBeCloseTo(0.25, 10);
    // (The mismatched-phase direction bails via process.exit and cannot be
    // driven in-process; assertState2bMatches covers that refusal directly.)
  });

  it("the phase is REQUIRED: a state file without it is not a Phase-2B ledger", () => {
    // No migration path is owed — no legitimate Phase-2B state can predate the
    // freeze tag, which has never been created.
    const { phase: _dropped, ...noPhase } = initCampaign2bState(
      SUITE.protocolId,
      SUITE.suiteHash,
      "keyless"
    );
    const parsed = Campaign2bStateSchema.safeParse(noPhase);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((iss) => iss.path.join(".") === "phase")).toBe(true);
    }
    // …and an unknown phase value is refused too.
    expect(
      Campaign2bStateSchema.safeParse({ ...noPhase, phase: "pooled" }).success
    ).toBe(false);
  });
});

// ── The ledger invariant is VALIDATED, not merely advertised ─────────────────
//
// It was documented, maintained on every write path and asserted by tests — but
// never checked on LOAD. The auditor handed the driver a schema-valid state
// claiming `spendUsd: 1` with no entries and no smoke spend, and it was
// accepted. That is the attack that matters: an edited ledger can UNDERSTATE
// recorded spend, and the $39.90 stop rule is enforced against exactly that
// number.

describe("Phase-2B ledger reconciliation", () => {
  const honest = (): Campaign2bState =>
    initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");

  it("THE REPRO: spendUsd with nothing to account for it is refused, and the message shows the gap", () => {
    const state = honest();
    state.spendUsd = 1;
    expect(() => assertLedgerReconciles(state)).toThrow(/ledger does not reconcile/);
    expect(() => assertLedgerReconciles(state)).toThrow(/gap=\$1\.000000/);
    // The message states WHY it fails closed rather than tolerating the drift.
    expect(() => assertLedgerReconciles(state)).toThrow(/fails CLOSED/);
    expect(() => assertLedgerReconciles(state)).toThrow(/stop threshold/);
  });

  it("an honest ledger reconciles: entries, smoke spend, and both together", () => {
    expect(() => assertLedgerReconciles(honest())).not.toThrow();

    const withEntries = stateWith([{ costUsd: 1.5 }]);
    withEntries.spendUsd = 1.5;
    expect(() => assertLedgerReconciles(withEntries)).not.toThrow();

    const withSmoke = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    withSmoke.smokeSpendUsd = 0.25;
    withSmoke.spendUsd = 0.25;
    expect(() => assertLedgerReconciles(withSmoke)).not.toThrow();

    const both = stateWith([{ costUsd: 1.5 }]);
    both.smokeSpendUsd = 0.25;
    both.spendUsd = 1.75;
    expect(() => assertLedgerReconciles(both)).not.toThrow();
  });

  it("a PENDING entry may leave a POSITIVE orphan — that is the documented mid-entry window", () => {
    // Slot 0 completed and is banked; slot 1 was IN FLIGHT when the process
    // died, having banked $0.40 that no entry accounts for yet.
    const state = stateWith([{ costUsd: 1 }]);
    state.spendUsd = 1.4;
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "any-row", // schedule[1] — the slot that was running, not the recorded one
      benchId: "bench-orphan",
      benchDir: "runs/phase2b/orphan"
    };
    expect(() => assertLedgerReconciles(state)).not.toThrow();
    // …and reconcilePendingEntry is the operation licensed to consume it,
    // after which the ledger is exact again.
    reconcilePendingEntry(state);
    expect(() => assertLedgerReconciles(state)).not.toThrow();
  });

  it("a NEGATIVE gap is refused even mid-entry — recorded spend below the accounting has no honest cause", () => {
    const state = stateWith([{ costUsd: 1 }]);
    state.spendUsd = 0.6; // LOWER than what the entries already claim
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "any-row",
      benchId: "bench-orphan",
      benchDir: "runs/phase2b/orphan"
    };
    expect(() => assertLedgerReconciles(state)).toThrow(/recorded spend is LOWER/);
    expect(() => assertLedgerReconciles(state)).toThrow(/never a negative one/);
  });

  it("float drift within the tolerance is accepted; a real discrepancy is not", () => {
    const drifting = stateWith([{ costUsd: 1 }]);
    drifting.spendUsd = 1 + 1e-9;
    expect(() => assertLedgerReconciles(drifting)).not.toThrow();
    expect(LEDGER_EPSILON_USD).toBe(1e-6);

    const real = stateWith([{ costUsd: 1 }]);
    real.spendUsd = 1 + 1e-4;
    expect(() => assertLedgerReconciles(real)).toThrow(/ledger does not reconcile/);
  });

  it("a recorded smoke pass cannot claim more spend than the cumulative smoke bank", () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    state.smokeSpendUsd = 0.25;
    state.spendUsd = 0.25;
    state.smoke = {
      pass: true,
      protocolId: SUITE.protocolId,
      suiteHash: SUITE.suiteHash,
      cId: "c",
      dId: "d",
      gitCommit: null,
      spendUsd: 0.9 // ← a receipt for money the ledger never saw
    };
    expect(() => assertLedgerReconciles(state)).toThrow(/recorded smoke pass claims/);
    // The honest case — a pass costing no more than the bank — is fine.
    state.smoke.spendUsd = 0.25;
    expect(() => assertLedgerReconciles(state)).not.toThrow();
  });

  it("WIRING: keyedPhaseGate2b refuses a keyless ledger that does not reconcile", () => {
    // The gate is the last read of the keyless file before any paid call.
    const broken = { ...completeKeylessState(), spendUsd: 5 };
    expect(() =>
      keyedPhaseGate2b(broken, fakeSuite(), reader, "s.json", () => okReport)
    ).toThrow(/ledger does not reconcile/);
  });

  it("ITEM 9: the reconcile check runs BEFORE reconcilePendingEntry, not after its own output", async () => {
    // Order matters and was unpinned. Swapped, reconcilePendingEntry would run
    // first — minting a crashed entry out of a corrupt gap and, on a NEGATIVE
    // gap, clamping the orphan to $0 so the ledger "reconciles" and the check
    // then passes. The corruption would be laundered into a recorded entry.
    const state = stateWith([{ costUsd: 1 }]);
    state.spendUsd = 0.6; // recorded spend BELOW what the entries already claim
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "any-row",
      benchId: "bench-orphan",
      benchDir: "runs/phase2b/orphan"
    };
    const deps = {
      schedule: buildSchedule2b("keyless"),
      scenarios: FIVE,
      model: null,
      headless: true,
      runBenchmark: vi.fn(async () => ({ trials: [] }) as unknown as BenchmarkResults),
      prepareRun: async (e: Campaign2bEntry) => ({
        labUrl: "http://127.0.0.1:0",
        benchDir: `runs/${e.ordinal}`,
        benchId: `bench-${e.ordinal}`,
        dispose: async () => undefined
      }),
      persist: async () => undefined
    };

    await expect(runCampaign2b(state, deps)).rejects.toThrow(/recorded spend is LOWER/);
    // THE PROOF OF ORDER: the marker is untouched and no entry was minted from
    // it. A swapped order would have consumed the marker and added an entry.
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.status).toBe("complete");
    expect(state.pendingEntry).toBeDefined();
    expect(deps.runBenchmark).not.toHaveBeenCalled();
  });

  it("WIRING: runCampaign2b refuses to drive a campaign from a ledger that does not reconcile", async () => {
    const state = honest();
    state.spendUsd = 1;
    const deps = {
      schedule: buildSchedule2b("keyless"),
      scenarios: FIVE,
      model: null,
      headless: true,
      runBenchmark: vi.fn(async () => ({ trials: [] }) as unknown as BenchmarkResults),
      prepareRun: async (e: Campaign2bEntry) => ({
        labUrl: "http://127.0.0.1:0",
        benchDir: `runs/${e.ordinal}`,
        benchId: `bench-${e.ordinal}`,
        dispose: async () => undefined
      }),
      persist: async () => undefined
    };
    await expect(runCampaign2b(state, deps)).rejects.toThrow(/ledger does not reconcile/);
    expect(deps.runBenchmark).not.toHaveBeenCalled();
  });
});

// ── Phase gating, all four refusals, no key required ─────────────────────────

function fakeSuite(): LoadedScenarioSuite {
  return {
    protocolId: SUITE.protocolId,
    suiteHash: SUITE.suiteHash,
    scenarios: PHASE2B_SCENARIO_IDS.map((id, i) => ({
      id,
      name: id,
      description: id,
      chaos: [],
      seed: 2201 + i,
      session: "fresh",
      expected: "success",
      stratum: "F3",
      stratumId: `f3-${i}`,
      predictions: { A: "all-pass", B: "all-pass", B2: "all-pass", C: "all-pass", D: "all-pass" }
    })) as LoadedScenarioSuite["scenarios"]
  };
}

/** A COMPLETE 30-entry keyless ledger, exactly matching the frozen schedule. */
function completeKeylessState(): Campaign2bState {
  const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
  state.entries = buildSchedule2b("keyless").map((e) => ({
    phase: e.phase,
    sweep: e.sweep,
    policy: e.policy,
    arm: e.arm,
    status: "complete" as const,
    benchId: `bench-${e.ordinal}`,
    dir: `runs/phase2b/${e.ordinal}`,
    costUsd: 0,
    completedTrials: 5,
    reruns: 0
  }));
  return state;
}

/** The five allowlisted scenarios as stub specs — what every entry must run. */
const FIVE: ScenarioSpec[] = PHASE2B_SCENARIO_IDS.map((id, i) => ({
  id,
  name: id,
  description: id,
  chaos: [],
  seed: 2201 + i,
  session: "fresh",
  expected: "success",
  group: "core"
}));

/** The frozen suite provenance the smoke must run under (item 3a). */
const FROZEN_PROVENANCE = {
  protocolId: PHASE2B_SUITE_PROTOCOL_ID,
  suiteHash: PHASE2B_SUITE_HASH,
  gitCommit: "0".repeat(40)
};

const okReport: VerifyReport = {
  ok: true,
  violations: [],
  predictions: [],
  notes: [],
  records: { total: 150, recomputed: 150, v2NoRows: 0, attestedV1: 0 }
};
/**
 * The 2B-side reader used by the gate. Arm-F entries are served the REAL
 * Phase-2A trials for their (policy, sweep) cell — i.e. a faithful replication —
 * so the honest path exercises the real projection comparison against real
 * evidence rather than a hand-written stand-in. `mutate` lets a probe perturb
 * exactly one thing.
 */
function replicatingReader(
  mutate: (trials: TrialResult[], cell: string) => TrialResult[] = (t) => t
): (dir: string) => VerifyInput {
  const byDir = new Map<string, string>();
  for (const e of completeKeylessState().entries) {
    if (e.arm === "frozen") byDir.set(e.dir, `keyless-s${e.sweep}-${e.policy}`);
  }
  return (dir: string): VerifyInput => {
    const cell = byDir.get(dir);
    if (!cell) return { source: dir, raw: { trials: [] } };
    const real = readPhase2aCell(cell).trials.filter((t) =>
      (PHASE2B_SCENARIO_IDS as readonly string[]).includes(t.scenarioId)
    );
    return { source: dir, raw: { trials: mutate(structuredClone(real), cell) } };
  };
}
const reader = replicatingReader();

describe("Phase-2B phase gating (machine-enforced, no key needed to test)", () => {
  it("(a) keyless refuses a provider KEY, and names it", () => {
    expect(() =>
      enforceKeyDiscipline2b("keyless", { modelProvider: "anthropic", stagehandModel: null })
    ).toThrow(/a provider key \(modelProvider "anthropic"\)/);
  });

  it("(a) keyless ALSO refuses STAGEHAND_MODEL with no key — it arms the repair path", () => {
    // config.ts defaults stagehandModel straight from STAGEHAND_MODEL, so a
    // "keyless" run could carry a configured model and an armed hybrid repair
    // dispatch while the key check saw nothing.
    expect(() =>
      enforceKeyDiscipline2b("keyless", {
        modelProvider: null,
        stagehandModel: "anthropic/claude-haiku-4-5"
      })
    ).toThrow(/STAGEHAND_MODEL \("anthropic\/claude-haiku-4-5"\)/);
    // Both set → the message names both.
    expect(() =>
      enforceKeyDiscipline2b("keyless", {
        modelProvider: "anthropic",
        stagehandModel: "anthropic/claude-haiku-4-5"
      })
    ).toThrow(/a provider key .* and STAGEHAND_MODEL/);
  });

  it("(a) keyless passes only when BOTH are null", () => {
    expect(() =>
      enforceKeyDiscipline2b("keyless", { modelProvider: null, stagehandModel: null })
    ).not.toThrow();
  });

  it("(b) the keyed phase refuses to start without a key", () => {
    expect(() =>
      enforceKeyDiscipline2b("keyed", { modelProvider: null, stagehandModel: null })
    ).toThrow(/keyed refuses to run without a model provider key/);
    expect(() =>
      enforceKeyDiscipline2b("keyed", { modelProvider: "anthropic", stagehandModel: "m" })
    ).not.toThrow();
  });

  it("(c) the keyed phase refuses an INCOMPLETE keyless ledger", () => {
    const partial = completeKeylessState();
    partial.entries = partial.entries.slice(0, 17);
    expect(() =>
      keyedPhaseGate2b(partial, fakeSuite(), reader, "suite.json", () => okReport)
    ).toThrow(/keyless grid incomplete — next unfinished entry is keyless\//);
  });

  it("(c) the keyed phase refuses when the keyless bundle FAILS its frozen verification", () => {
    const failing: VerifyReport = {
      ...okReport,
      ok: false,
      violations: [{ check: "completeness", message: "KEYLESS-GRID-BROKEN" }]
    };
    expect(() =>
      keyedPhaseGate2b(completeKeylessState(), fakeSuite(), reader, "suite.json", () => failing)
    ).toThrow(/KEYLESS-GRID-BROKEN/);
  });

  it("(c) a COMPLETE, verified keyless ledger passes the gate, and it is verified with the frozen KEYLESS command", () => {
    const calls: { inputs: VerifyInput[]; grid: unknown }[] = [];
    expect(() =>
      keyedPhaseGate2b(completeKeylessState(), fakeSuite(), reader, "suite.json", (inputs, _s, grid) => {
        calls.push({ inputs, grid });
        return okReport;
      })
    ).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs).toHaveLength(30);
    // The frozen keyless command: all five 2B flags, --expect-model INCLUDED (it is
    // policy-aware, so on a keyless bundle it requires A/B/B2 to record NO model).
    expect(calls[0]!.grid).toEqual({
      policies: ["A", "B", "B2"],
      trials: 5,
      recordVersion: 2,
      scenarios: [...PHASE2B_SCENARIO_IDS],
      arms: ["frozen", "any-row"],
      campaign: PHASE2B_CAMPAIGN_ID,
      model: PHASE2B_MODEL,
      pricesPinnedAt: PHASE2B_PRICES_PINNED_AT
    });
  });

  it("(c) a POISONED keyless ledger can never gate the keyed phase", () => {
    const poisoned = completeKeylessState();
    poisoned.poisonedReason = "transport poisoning detected in keyless/A/sweep-1/frozen";
    expect(() =>
      keyedPhaseGate2b(poisoned, fakeSuite(), reader, "suite.json", () => okReport)
    ).toThrow(/keyless grid is POISONED/);
  });

  it("(d) the pre-spend recheck stops the campaign before any paid call on ANY mismatch", () => {
    const frozen: PreSpendExpectations = {
      suiteHash: SUITE.suiteHash,
      protocolId: SUITE.protocolId,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "abc123",
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      keylessVerdictPass: true,
      scheduleLength: 20
    };
    expect(() => assertPreSpendExpectations({ ...frozen }, frozen)).not.toThrow();
    for (const [field, bad] of [
      ["suiteHash", { suiteHash: "b".repeat(64) }],
      ["protocolId", { protocolId: "other" }],
      ["campaignProtocolId", { campaignProtocolId: "phase2c" }],
      ["gitCommit", { gitCommit: "deadbee" }],
      ["recordVersion", { recordVersion: 1 }],
      ["arms", { arms: ["frozen"] as const }],
      ["scheduleLength", { scheduleLength: 19 }]
    ] as const) {
      expect(() => assertPreSpendExpectations({ ...frozen, ...bad }, frozen), field).toThrow(
        /pre-spend recheck FAILED/
      );
    }
    expect(() =>
      assertPreSpendExpectations({ ...frozen, keylessVerdictPass: false }, frozen)
    ).toThrow(/has not recorded a PASS verdict/);
  });
});

// ── Transport poisoning ──────────────────────────────────────────────────────

const trial = (over: Partial<TrialResult>): TrialResult =>
  ({
    scenarioId: "f3-page-size-2-a",
    engine: "hybrid",
    trial: 1,
    runId: "t1",
    outcome: "pass",
    outcomeReason: "ok",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: { overall: 1 },
    durationMs: 1,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "runs/x",
    tokens: null,
    ...over
  }) as TrialResult;

describe("Phase-2B transport poisoning", () => {
  it("criterion half 1: model calls with BOTH token sides zero", () => {
    expect(isPoisonedTrial(trial({ tokens: { llmCalls: 3, inputTokens: 0, outputTokens: 0 } }))).toBe(true);
    // Not poisoned: real usage, or no calls at all.
    expect(isPoisonedTrial(trial({ tokens: { llmCalls: 3, inputTokens: 10, outputTokens: 2 } }))).toBe(false);
    expect(isPoisonedTrial(trial({ tokens: { llmCalls: 0, inputTokens: 0, outputTokens: 0 } }))).toBe(false);
    expect(isPoisonedTrial(trial({ tokens: null }))).toBe(false);
  });

  it("criterion half 2: a failureDetail matching the frozen transport pattern", () => {
    for (const detail of [
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "Cannot connect to API",
      "read ECONNRESET",
      "connect ETIMEDOUT 1.2.3.4:443",
      "getaddrinfo EAI_AGAIN api",
      "TypeError: fetch failed"
    ]) {
      expect(isPoisonedTrial(trial({ failureDetail: detail })), detail).toBe(true);
    }
    expect(isPoisonedTrial(trial({ failureDetail: "standings table not found" }))).toBe(false);
  });

  it("isPoisonedError walks the CAUSE CHAIN, so a wrapped transport fault is still caught", () => {
    expect(isPoisonedError(new Error("read ECONNRESET"))).toBe(true);
    expect(
      isPoisonedError(new Error("engine failed", { cause: new Error("getaddrinfo EAI_AGAIN api") }))
    ).toBe(true);
    expect(
      isPoisonedError(
        new Error("outer", { cause: new Error("middle", { cause: new Error("fetch failed") }) })
      )
    ).toBe(true);
    expect(isPoisonedError(new Error("standings table not found"))).toBe(false);
    expect(isPoisonedError("not an error")).toBe(false);
    expect(isPoisonedError(undefined)).toBe(false);
  });

  it("is OUTCOME-BLIND: a PASSING trial with poisoned transport still counts as poisoned", () => {
    expect(
      isPoisonedTrial(trial({ outcome: "pass", tokens: { llmCalls: 2, inputTokens: 0, outputTokens: 0 } }))
    ).toBe(true);
  });

  it("a poisoned entry invalidates the FULL grid and halts the campaign", async () => {
    const schedule = buildSchedule2b("keyless");
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const persisted: Campaign2bState[] = [];
    const outcome = await runCampaign2b(state, {
      schedule,
      scenarios: FIVE,
      model: null,
      headless: true,
      runBenchmark: async () =>
        ({
          trials: [trial({ runId: "poisoned-t1", failureDetail: "getaddrinfo ENOTFOUND api" })],
          stopped: undefined
        }) as unknown as BenchmarkResults,
      prepareRun: async (e: Campaign2bEntry) => ({
        labUrl: "http://127.0.0.1:0",
        benchDir: `runs/${e.ordinal}`,
        benchId: `bench-${e.ordinal}`,
        dispose: async () => undefined
      }),
      persist: async (s) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
      }
    });
    expect(outcome.kind).toBe("poisoned");
    // It halted on the FIRST entry — no accumulating results around a network fault.
    expect(state.entries).toHaveLength(1);
    expect(state.poisonedReason).toMatch(/transport poisoning detected in keyless\/A\/sweep-1\/frozen/);
    expect(state.poisonedReason).toMatch(/FULL keyless grid is invalidated/);
    expect(persisted.length).toBeGreaterThan(0);
  });
});


// ── ITEM 1: Arm-F replication of Phase 2A (§Gates items 4 and 6) ────────────
// The 2A side of every probe below is the REAL evidence, read through the real
// reader; the 2B side starts as a faithful copy of it and each probe perturbs
// exactly one thing. So a passing probe proves the gate accepts genuine
// replication, and a failing one proves it catches that specific divergence.

describe("Arm-F replication gate", () => {
  const entries = completeKeylessState().entries;
  const run2b = (mutate: (t: TrialResult[], cell: string) => TrialResult[]) => {
    const read = replicatingReader(mutate);
    return (dir: string) => read(dir).raw as { trials: TrialResult[] };
  };

  it("PASS-PIN: an Arm F that faithfully reproduces Phase 2A passes, 15 cells / 75 trials", () => {
    const outcome = assertArmFReplicatesPhase2a(entries, run2b((t) => t), readPhase2aCell);
    expect(outcome).toEqual({ cellsCompared: 15, trialsCompared: 75 });
  });

  it("ARMF-DIVERGE: one altered projected scalar is refused, and the message names the field", () => {
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        run2b((trials, cell) =>
          cell === "keyless-s3-B"
            ? trials.map((t) =>
                t.scenarioId === "f3-page-size-2-b" ? { ...t, retries: t.retries + 1 } : t
              )
            : trials
        ),
        readPhase2aCell
      )
    ).toThrow(/keyless-s3-B \/ f3-page-size-2-b \/ retries/);
  });

  it("ARMF-ACCURACY-DEEP: an accuracy object differing only in ONE NESTED counter is refused", () => {
    // Same top-level keys, same shape — only a counter buried inside changes. A
    // subset or key-name comparison would wave this through; deep equality does not.
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        run2b((trials) =>
          trials.map((t) =>
            t.accuracy?.stats
              ? {
                  ...t,
                  accuracy: {
                    ...t.accuracy,
                    stats: { ...t.accuracy.stats, fieldMatches: t.accuracy.stats.fieldMatches - 1 }
                  }
                }
              : t
          )
        ),
        readPhase2aCell
      )
    ).toThrow(/\/ accuracy:/);
  });

  it("ARMF-ONE-SIDED-FIELD: a field present on exactly one side is refused (equal-absence is generic)", () => {
    // The real keyless records carry NO healedSteps. Adding one on the 2B side
    // must fail even though the value looks innocuous — "absent" and "empty" are
    // different claims, and only one of them is what 2A recorded.
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        run2b((trials, cell) =>
          cell === "keyless-s1-A"
            ? trials.map((t, i) => (i === 0 ? { ...t, healedSteps: [] } : t))
            : trials
        ),
        readPhase2aCell
      )
    ).toThrow(/\/ healedSteps:/);
  });

  it("ARMF-MISSING-SCENARIO: a scenario absent from the 2B side is a VIOLATION, not a skip", () => {
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        run2b((trials, cell) =>
          cell === "keyless-s2-B2"
            ? trials.filter((t) => t.scenarioId !== "x-class-l3-page-size-2")
            : trials
        ),
        readPhase2aCell
      )
    ).toThrow(/keyless-s2-B2 \/ x-class-l3-page-size-2 \/ \(paired trial\)/);
  });


  it("FIX 4: a gate that compared NOTHING refuses, and the coverage floor is derived from the constants", () => {
    // Empty cells are refused — the important property.
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        () => ({ trials: [] }),
        () => ({ trials: [] })
      )
    ).toThrow(/Arm F does NOT replicate Phase 2A/);

    // HONEST NOTE ON REACHABILITY: the coverage assertion added for this finding
    // is defence in depth, not a separately reachable branch. Any shortfall in
    // trialsCompared today coincides with a "(paired trial)" mismatch, which
    // throws first — so the message above is what an operator sees. The
    // assertion exists so a future refactor that stops counting (or stops
    // comparing) cannot return a passing verdict carrying zeros. What IS
    // independently checkable is that the floor tracks the constants rather than
    // a hardcoded 15/75:
    const expectedCells = REPLICATION_POLICIES.length * 5;
    const expectedTrials = expectedCells * PHASE2B_SCENARIO_IDS.length;
    expect({ expectedCells, expectedTrials }).toEqual({ expectedCells: 15, expectedTrials: 75 });
    // …and the honest path reports exactly that floor.
    expect(assertArmFReplicatesPhase2a(entries, run2b((t) => t), readPhase2aCell)).toEqual({
      cellsCompared: expectedCells,
      trialsCompared: expectedTrials
    });
  });

  it("FIX 6: a DUPLICATED scenario on the 2B side is refused even when the first trial matches", () => {
    // [good, bad, bad] used to pass on the strength of element [0].
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries,
        run2b((trials, cell) => {
          if (cell !== "keyless-s1-B") return trials;
          const dupe = trials.find((t) => t.scenarioId === "f3-page-size-3-a")!;
          return [...trials, { ...dupe, outcome: "fail" as const }];
        }),
        readPhase2aCell
      )
    ).toThrow(/keyless-s1-B \/ f3-page-size-3-a \/ \(paired trial\).*2 trial\(s\)/s);
  });

  it("FIX 5: EVERY frozen projection field is divergence-checked", () => {
    // One probe per field, over REAL 2A records: perturb exactly that field on
    // the 2B side and require the gate to name it. A field that silently stopped
    // being compared fails here.
    const perturb = (t: TrialResult, field: string): TrialResult => {
      const c = structuredClone(t) as Record<string, unknown>;
      switch (field) {
        case "outcome":
          c.outcome = t.outcome === "pass" ? "fail" : "pass";
          break;
        case "outcomeClass":
          c.outcomeClass = "recovered";
          break;
        case "outcomeReason":
          c.outcomeReason = `${t.outcomeReason} (tampered)`;
          break;
        case "pipelineSuccess":
        case "extractionSuccess":
        case "validationSuccess":
        case "recoveredAfterFailure":
          c[field] = !(t as unknown as Record<string, boolean>)[field];
          break;
        case "accuracy":
          c.accuracy = t.accuracy === null ? { overall: 1 } : null;
          break;
        case "failureCategory":
          c.failureCategory = t.failureCategory === "timeout" ? "internal" : "timeout";
          break;
        case "failureDetail":
          c.failureDetail = `${t.failureDetail ?? ""} (tampered)`;
          break;
        case "retries":
          c.retries = t.retries + 1;
          break;
        // Arrays: append an element (absent → one-sided presence, which the
        // equal-absence rule also refuses).
        case "healedSteps":
        case "deterministicRepairSteps":
        case "deterministicFallbacks":
          c[field] = [...((t as unknown as Record<string, string[]>)[field] ?? []), "tampered-step"];
          break;
        case "llmCalls":
          // Lives in the tokens block; keyless records carry tokens: null, so
          // this is a one-sided presence.
          c.tokens = { llmCalls: 1 };
          break;
        default:
          throw new Error(`unhandled field ${field}`);
      }
      return c as unknown as TrialResult;
    };

    for (const field of REPLICATION_FIELDS) {
      expect(() =>
        assertArmFReplicatesPhase2a(
          entries,
          run2b((trials, cell) =>
            cell === "keyless-s1-A"
              ? trials.map((t) =>
                  t.scenarioId === "f3-page-size-3-a" ? perturb(t, field) : t
                )
              : trials
          ),
          readPhase2aCell
        ),
        `field ${field} is not divergence-checked`
      ).toThrow(new RegExp(`keyless-s1-A / f3-page-size-3-a / ${field}`));
    }
  });

  it("ARMF-MISSING-RUN: an Arm-F entry missing for a (policy, sweep) is refused", () => {
    expect(() =>
      assertArmFReplicatesPhase2a(
        entries.filter((e) => !(e.arm === "frozen" && e.policy === "B" && e.sweep === 4)),
        run2b((t) => t),
        readPhase2aCell
      )
    ).toThrow(/\(paired run\)/);
  });

  it("the projection is exhaustive and compared key-order-insensitively", () => {
    const a = { outcome: "pass", accuracy: { stats: { x: 1 }, odds: { y: 2 } } } as never;
    const b = { outcome: "pass", accuracy: { odds: { y: 2 }, stats: { x: 1 } } } as never;
    // Same content, different key order — not a mismatch.
    expect(compareProjections("c", "s", projectForReplication(a), projectForReplication(b))).toEqual([]);
    // Every frozen field is projected.
    expect(Object.keys(projectForReplication(a)).sort()).toEqual(
      [
        "accuracy",
        "deterministicFallbacks",
        "deterministicRepairSteps",
        "extractionSuccess",
        "failureCategory",
        "failureDetail",
        "healedSteps",
        "llmCalls",
        "outcome",
        "outcomeClass",
        "outcomeReason",
        "pipelineSuccess",
        "recoveredAfterFailure",
        "retries",
        "validationSuccess"
      ].sort()
    );
  });


  // ── FIX 1: the WIRING of the replication check into the gate ──────────────
  // These go through keyedPhaseGate2b, never through assertArmFReplicatesPhase2a
  // directly: the mutation that motivated them replaced the call with a
  // hardcoded {cellsCompared:15, trialsCompared:75} and every existing test
  // still passed, because nothing exercised the gate's use of it.

  it("WIRING: a perturbed 2A-side reader makes the GATE throw, naming the field", () => {
    expect(() =>
      keyedPhaseGate2b(
        completeKeylessState(),
        fakeSuite(),
        reader, // honest 2B side
        "s.json",
        () => okReport,
        // …but the BASELINE is perturbed: one scalar differs.
        (cell) => {
          const real = readPhase2aCell(cell);
          if (cell !== "keyless-s2-A") return real;
          return {
            trials: structuredClone(real.trials).map((t) =>
              t.scenarioId === "f3-page-size-3-b" ? { ...t, retries: t.retries + 5 } : t
            )
          };
        }
      )
    ).toThrow(/keyless-s2-A \/ f3-page-size-3-b \/ retries/);
  });

  it("WIRING: a perturbed 2B-side reader makes the GATE throw, naming the field", () => {
    expect(() =>
      keyedPhaseGate2b(
        completeKeylessState(),
        fakeSuite(),
        replicatingReader((trials, cell) =>
          cell === "keyless-s5-B2"
            ? trials.map((t) =>
                t.scenarioId === "f3-page-size-2-a" ? { ...t, outcomeClass: "recovered" } : t
              )
            : trials
        ),
        "s.json",
        () => okReport,
        readPhase2aCell
      )
    ).toThrow(/keyless-s5-B2 \/ f3-page-size-2-a \/ outcomeClass/);
  });

  it("WIRING: the gate's returned counts come from the real check, not a constant", () => {
    // A 2B reader that serves NOTHING must make the gate throw on coverage —
    // a hardcoded {15, 75} would sail through this.
    expect(() =>
      keyedPhaseGate2b(
        completeKeylessState(),
        fakeSuite(),
        (dir) => ({ source: dir, raw: { trials: [] } }),
        "s.json",
        () => okReport,
        readPhase2aCell
      )
    ).toThrow(/Arm F does NOT replicate Phase 2A/);
  });

  it("the verdict carries the replication block, and the pre-spend recheck requires it", () => {
    const verdict = keyedPhaseGate2b(completeKeylessState(), fakeSuite(), reader, "s.json", () => okReport);
    expect(verdict.replication).toEqual({ pass: true, cellsCompared: 15, trialsCompared: 75 });
    expect(Campaign2bStateSchema.safeParse({ ...completeKeylessState(), verdict }).success).toBe(true);
  });
});

// ── ITEM 2: the freeze tag alone is not enough ──────────────────────────────

describe("clean-worktree guard", () => {

  it("FIX 2a: the guard SEQUENCE is wired — tag first, and a missing tag short-circuits before the worktree is read", () => {
    // The mutation that motivated this deleted the assertCleanWorktree call from
    // main() and broke no test: the guards were covered, their wiring was not.
    const statusSpy = vi.fn(() => "");
    expect(() =>
      runPreflightGuards({ readTags: () => ["some-other-tag"], readStatus: statusSpy })
    ).toThrow(/does not point at HEAD/);
    // Order matters: a repo at the wrong commit is refused without reading the
    // worktree at all.
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("FIX 2a: tag present but worktree DIRTY still refuses, through the same sequence", () => {
    expect(() =>
      runPreflightGuards({
        readTags: () => [PHASE2B_FREEZE_TAG],
        readStatus: () => " M scripts/run-campaign-2b.ts\n"
      })
    ).toThrow(/worktree is DIRTY/);
  });

  it("FIX 2a: tag present and worktree clean passes", () => {
    expect(() =>
      runPreflightGuards({ readTags: () => [PHASE2B_FREEZE_TAG], readStatus: () => "" })
    ).not.toThrow();
  });

  it("a clean worktree passes", () => {
    expect(() => assertCleanWorktree("")).not.toThrow();
    expect(() => assertCleanWorktree("\n  \n")).not.toThrow();
  });

  it("modified files refuse, and the message lists them", () => {
    expect(() => assertCleanWorktree(" M scripts/run-campaign-2b.ts\n")).toThrow(
      /worktree is DIRTY \(1 path\(s\)/
    );
    expect(() => assertCleanWorktree(" M a.ts\n M b.ts\n")).toThrow(/scripts|a\.ts/);
  });

  it("UNTRACKED-only also refuses — an untracked module can still be imported", () => {
    expect(() => assertCleanWorktree("?? scripts/sneaky-override.ts\n")).toThrow(
      /untracked included/
    );
  });
});

// ── Budget stop, run config, and operator hints ──────────────────────────────

describe("Phase-2B run loop", () => {
  const baseDeps = (results: BenchmarkResults) => ({
    schedule: buildSchedule2b("keyless"),
    scenarios: FIVE,
    model: null,
    headless: true,
    runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
      void config;
      return results;
    }),
    prepareRun: async (e: Campaign2bEntry) => ({
      labUrl: "http://127.0.0.1:0",
      benchDir: `runs/${e.ordinal}`,
      benchId: `bench-${e.ordinal}`,
      dispose: async () => undefined
    }),
    persist: async () => undefined
  });

  it("stops at the frozen threshold BEFORE preparing anything", async () => {
    // The threshold is reached by a RECORDED entry rather than an out-of-band
    // poke at spendUsd. The ledger is validated on entry to the loop now, and in
    // the KEYLESS phase spend can only come from entries — there is no honest
    // keyless state with $39.90 recorded and nothing to account for it.
    const state = stateWith([{ costUsd: CAMPAIGN_BUDGET_THRESHOLD_USD }]);
    state.spendUsd = CAMPAIGN_BUDGET_THRESHOLD_USD;
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const outcome = await runCampaign2b(state, deps);
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.reason).toMatch(/budget stop/);
      // It stopped AT the next slot, without touching it.
      expect(outcome.entry).toEqual(buildSchedule2b("keyless")[1]);
    }
    // Nothing was run: the short-circuit precedes prepareRun.
    expect(deps.runBenchmark).not.toHaveBeenCalled();
    expect(state.entries).toHaveLength(1); // nothing new recorded
  });

  it("passes every Phase-2B flag into each entry's bench invocation, including a NON-frozen slot", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    // The first TWO slots: sweep-1 A frozen, then sweep-1 A any-row. Covering the
    // second is what makes a literal "frozen" — or a dropped field — fail here.
    await runCampaign2b(state, { ...deps, schedule: buildSchedule2b("keyless").slice(0, 2) });
    expect(deps.runBenchmark).toHaveBeenCalledTimes(2);

    const armOf = (i: number) =>
      (deps.runBenchmark.mock.calls[i]![0] as unknown as Record<string, unknown>).readinessMode;
    expect(armOf(0)).toBe("frozen");
    expect(armOf(1)).toBe("any-row");

    for (const i of [0, 1]) {
      const config = deps.runBenchmark.mock.calls[i]![0] as unknown as Record<string, unknown>;
      expect(config.campaignProtocolId, `call ${i}`).toBe(PHASE2B_CAMPAIGN_ID);
      expect(config.requireChromeVersion, `call ${i}`).toBe(true);
      expect(config.trialsPerScenario, `call ${i}`).toBe(1);
      expect(config.runPurpose, `call ${i}`).toBe("cold");
      expect(config.protocolId, `call ${i}`).toBe(SUITE.protocolId);
      expect(config.suiteHash, `call ${i}`).toBe(SUITE.suiteHash);
      // Policy A → the baseline engine and its repair-mode mapping, reused from 2A.
      expect(config.engines, `call ${i}`).toEqual(["baseline"]);
      expect(config.repairMode, `call ${i}`).toBe("off");
      // Exactly the five allowlisted scenarios, every entry.
      expect(
        (config.scenarios as ScenarioSpec[]).map((sc) => sc.id).sort(),
        `call ${i}`
      ).toEqual([...PHASE2B_SCENARIO_IDS].sort());
    }
  });

  it("F4: refuses a smuggled sixth scenario, and a missing one", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const sixth: ScenarioSpec = { ...FIVE[0]!, id: "f1-class-l0-a" };
    await expect(runCampaign2b(state, { ...deps, scenarios: [...FIVE, sixth] })).rejects.toThrow(
      /unexpected: f1-class-l0-a/
    );
    await expect(runCampaign2b(state, { ...deps, scenarios: FIVE.slice(0, 4) })).rejects.toThrow(
      /missing: x-class-l3-page-size-2/
    );
    expect(deps.runBenchmark).not.toHaveBeenCalled();
  });

  it("F7: a THROWN transport error poisons the keyed grid instead of laundering into a crash-rerun", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const outcome = await runCampaign2b(state, {
      ...deps,
      schedule: buildSchedule2b("keyed"),
      runBenchmark: vi.fn(async () => {
        throw new Error("engine failed", { cause: new Error("getaddrinfo ENOTFOUND api.anthropic.com") });
      })
    });
    expect(outcome.kind).toBe("poisoned");
    expect(state.poisonedReason).toMatch(/matches the frozen transport-error pattern/);
    // The attempt is preserved, and the grid is void rather than rerunnable.
    expect(state.entries[0]!.status).toBe("crashed");
  });

  it("F7: a NON-transport throw is still an ordinary crash-rerun", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyed");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const outcome = await runCampaign2b(state, {
      ...deps,
      schedule: buildSchedule2b("keyed"),
      runBenchmark: vi.fn(async () => {
        throw new Error("standings table not found");
      })
    });
    expect(outcome.kind).toBe("crashed");
    expect(state.poisonedReason).toBeUndefined();
    expect(state.entries[0]!.status).toBe("crashed");
    expect(state.entries[0]!.reruns).toBe(0); // rerunnable once
  });

  it("F7: the keyless phase cannot be transport-poisoned — it makes no provider calls", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const outcome = await runCampaign2b(state, {
      ...deps,
      runBenchmark: vi.fn(async () => {
        throw new Error("fetch failed");
      })
    });
    expect(outcome.kind).toBe("crashed");
  });


  it("FIX 7: a pre-spend provenance abort does NOT consume the entry's rerun", async () => {
    // ChromeVersionUnavailableError is thrown at engine init, before any spend.
    // Recording it as a crash would spend the cell's one permitted rerun on a
    // broken machine, so a second invocation would kill the cell for good.
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);
    const outcome = await runCampaign2b(state, {
      ...deps,
      schedule: buildSchedule2b("keyless").slice(0, 1),
      runBenchmark: vi.fn(async () => {
        throw new ChromeVersionUnavailableError("CDP /json/version did not answer");
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(outcome.kind).toBe("provenance-abort");
    if (outcome.kind === "provenance-abort") {
      expect(outcome.reason).toMatch(/browser provenance unavailable/);
      expect(outcome.reason).toMatch(/ENVIRONMENT fault, not a trial fault/);
    }
    // FIX (abort channel): the note lands in `provenanceAbort`, saying plainly
    // that NO entry was recorded — and `stoppedReason` (the budget's field) is
    // untouched, so a later real budget stop cannot inherit this explanation.
    expect(state.provenanceAbort).toEqual({
      reason: expect.stringMatching(/browser provenance unavailable/) as unknown as string,
      recordedCrashed: false
    });
    expect(state.stoppedReason).toBeUndefined();
    // NOTHING recorded: the slot is untouched and fully runnable again.
    expect(state.entries).toEqual([]);
    expect(state.pendingEntry).toBeUndefined();
    expect(nextEntry2b(state, buildSchedule2b("keyless"))).toEqual(buildSchedule2b("keyless")[0]);
    // Ledger invariant holds trivially (nothing spent, nothing recorded).
    expect(state.entries.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(state.spendUsd, 10);
  });

  it("FIX 7: a post-attempt provenance abort that BANKED spend records it — the ledger invariant is non-negotiable", async () => {
    // MissingChromeVersionError arrives after the runner banked the completed
    // trial's spend (batch 13, 4b). That money is already in spendUsd, so the
    // entry must carry it or sum(entries) and spendUsd diverge forever.
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const model = PHASE2B_MODEL;
    const tokens = { llmCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const spend = trialCost({ tokens }, "hybrid", model)!;
    expect(spend).toBeGreaterThan(0);

    const outcome = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule: buildSchedule2b("keyless").slice(0, 1),
      model,
      runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
        await config.hooks!.afterTrial!({
          engine: "hybrid",
          runId: "t1",
          tokens
        } as unknown as TrialResult);
        throw new MissingChromeVersionError("hybrid", "t1");
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(outcome.kind).toBe("provenance-abort");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.costUsd).toBeCloseTo(spend, 10);
    expect(state.entries.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(state.spendUsd, 10);
    // FIX (abort channel): the note lands in `provenanceAbort` and states that
    // this branch DID record a crashed entry — the CLI no longer has to guess,
    // and it no longer prints the opposite. `stoppedReason` stays the budget's.
    expect(state.provenanceAbort).toEqual({
      reason: expect.stringMatching(/browser provenance unavailable/) as unknown as string,
      recordedCrashed: true
    });
    expect(state.provenanceAbort!.reason).toMatch(/recorded as crashed carrying that cost/);
    expect(state.stoppedReason).toBeUndefined();
  });

  it("FIX 7: a WRAPPED provenance abort is still recognised through the cause chain", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const outcome = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule: buildSchedule2b("keyless").slice(0, 1),
      runBenchmark: vi.fn(async () => {
        throw new Error("engine wrapper", {
          cause: new ChromeVersionUnavailableError("no answer")
        });
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(outcome.kind).toBe("provenance-abort");
  });

  it("FIX 7: an ORDINARY crash still records exactly as before", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const outcome = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule: buildSchedule2b("keyless").slice(0, 1),
      runBenchmark: vi.fn(async () => {
        throw new Error("standings table not found");
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(outcome.kind).toBe("crashed");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.status).toBe("crashed");
    expect(state.entries[0]!.reruns).toBe(0);
    expect(state.stoppedReason).toBeUndefined();
  });

  it("F8: a crash then a rerun ACCUMULATES cost, and sum(entries.costUsd) === spendUsd", async () => {
    // Cost is banked through the SAME hook path production uses — afterTrial
    // prices the record and mutates spendUsd — with a priced, nonzero cost on
    // BOTH attempts. No out-of-band spendUsd mutation, so the invariant under
    // test is actually exercised rather than assumed.
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const schedule = buildSchedule2b("keyless").slice(0, 1);
    // The pricing model is pinned, and a hybrid trial with these tokens prices to
    // a definite nonzero amount under the pinned table.
    const model = PHASE2B_MODEL;
    const tokens = { llmCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const spendPerTrial = trialCost({ tokens }, "hybrid", model)!;
    expect(spendPerTrial).toBeGreaterThan(0);

    const bankOneTrial = async (config: BenchmarkRunConfig) => {
      await config.hooks!.afterTrial!({
        engine: "hybrid",
        runId: "t1",
        tokens
      } as unknown as TrialResult);
    };

    // Attempt 1: bank one trial's cost through the hook, then crash.
    const crashed = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule,
      model,
      runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
        await bankOneTrial(config);
        throw new Error("engine died mid-entry");
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(crashed.kind).toBe("crashed");
    expect(state.entries[0]!.costUsd).toBeCloseTo(spendPerTrial, 10);

    // Attempt 2 (the permitted rerun): bank another trial's cost, then complete.
    await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule,
      model,
      runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
        await bankOneTrial(config);
        return { trials: [], stopped: undefined } as unknown as BenchmarkResults;
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });

    const entry = state.entries[0]!;
    expect(entry.reruns).toBe(1);
    // (a) the entry's cost is the LITERAL sum of both attempts…
    expect(entry.costUsd).toBeCloseTo(spendPerTrial * 2, 10);
    // …and (b) the ledger invariant holds against the accumulated spend.
    expect(state.entries.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(state.spendUsd, 10);
    expect(state.spendUsd).toBeCloseTo(spendPerTrial * 2, 10);
  });

  it("F10: a process killed MID-ENTRY resumes as a crash with the orphaned spend reconciled", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const schedule = buildSchedule2b("keyless");
    // Simulate the kill: the pre-entry marker was persisted and $0.42 of spend was
    // banked, but the process died before the entry could be recorded.
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "frozen",
      benchId: "bench-orphan",
      benchDir: "runs/phase2b/orphan"
    };
    state.spendUsd = 0.42;

    expect(reconcilePendingEntry(state)).toBe(true);
    expect(state.pendingEntry).toBeUndefined();
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0]!;
    expect(entry.status).toBe("crashed");
    expect(entry.dir).toBe("runs/phase2b/orphan"); // the orphaned dir is preserved
    // The ledger invariant survives the kill: the orphaned spend is accounted for.
    expect(entry.costUsd).toBeCloseTo(0.42, 10);
    expect(state.entries.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(state.spendUsd, 10);
    // The slot is rerunnable once…
    expect(nextEntry2b(state, schedule)).toEqual(schedule[0]);
    // …and a SECOND mid-entry death consumes that rerun, after which a third
    // execution is refused rather than silently attempted.
    state.pendingEntry = {
      phase: "keyless",
      sweep: 1,
      policy: "A",
      arm: "frozen",
      benchId: "bench-orphan-2",
      benchDir: "runs/phase2b/orphan-2"
    };
    state.spendUsd = 0.5;
    reconcilePendingEntry(state);
    expect(state.entries[0]!.reruns).toBe(1);
    expect(state.entries.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(state.spendUsd, 10);
    expect(() => nextEntry2b(state, schedule)).toThrow(/no silent third attempt/);
  });

  it("FIX (abort channel): a stale abort note NEVER becomes a later budget stop's reason", async () => {
    // THE AUDITOR'S SEQUENCE, end to end. The abort used to write its browser
    // explanation into `stoppedReason`, nothing ever cleared it, and the budget
    // path preferred whatever was already there — so this exact run finished by
    // telling the operator a $39.90 budget stop was a broken browser.
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const model = PHASE2B_MODEL;
    const tokens = { llmCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const perTrial = trialCost({ tokens }, "hybrid", model)!;
    expect(perTrial).toBeGreaterThan(0);
    const bank = async (config: BenchmarkRunConfig) => {
      await config.hooks!.afterTrial!({
        engine: "hybrid",
        runId: "t",
        tokens
      } as unknown as TrialResult);
    };
    // Two slots: the first aborts then reruns, the second is where the budget
    // check that used to lie actually runs.
    const schedule = buildSchedule2b("keyless").slice(0, 2);

    // (1) A provenance abort that BANKED spend — the crashed-entry branch.
    const aborted = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule,
      model,
      runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
        await bank(config);
        throw new MissingChromeVersionError("hybrid", "t");
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });
    expect(aborted.kind).toBe("provenance-abort");
    expect(state.provenanceAbort?.recordedCrashed).toBe(true);
    expect(state.stoppedReason).toBeUndefined();
    expect(state.entries[0]!.status).toBe("crashed");

    // (2) RESUME with a working browser: the crashed entry reruns and completes,
    // and this attempt drives recorded spend past the frozen threshold.
    const trialsToCross = Math.ceil(CAMPAIGN_BUDGET_THRESHOLD_USD / perTrial) + 1;
    const stopped = await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule,
      model,
      runBenchmark: vi.fn(async (config: BenchmarkRunConfig) => {
        for (let i = 0; i < trialsToCross; i++) await bank(config);
        return { trials: [], stopped: undefined } as unknown as BenchmarkResults;
      }) as unknown as Campaign2bDeps["runBenchmark"]
    });

    // The rerun completed, and the next slot hit the budget.
    expect(state.entries[0]!.status).toBe("complete");
    expect(state.entries[0]!.reruns).toBe(1);
    expect(state.spendUsd).toBeGreaterThanOrEqual(CAMPAIGN_BUDGET_THRESHOLD_USD);
    expect(stopped.kind).toBe("stopped");
    if (stopped.kind === "stopped") {
      expect(stopped.reason).toMatch(/budget stop/);
      expect(stopped.reason).not.toMatch(/browser provenance/);
    }
    expect(state.stoppedReason).toMatch(/budget stop/);
    expect(state.stoppedReason).not.toMatch(/browser provenance/);
    // …and the superseded abort note is gone: a new run clears it.
    expect(state.provenanceAbort).toBeUndefined();
  });

  it("FIX F: a superseded provenanceAbort note is removed FROM DISK, even with nothing else to persist", async () => {
    // Deleting it in memory and waiting for "the next existing persist" was not
    // enough: a campaign whose schedule is already complete returns without ever
    // persisting, so the archival snapshot kept a browser error that no longer
    // describes anything — and that snapshot is the evidence artifact.
    const schedule = buildSchedule2b("keyless").slice(0, 1);
    const state = stateWith([{}]); // slot 0 already recorded complete
    state.provenanceAbort = {
      reason: "browser provenance unavailable at keyless/A/sweep-1/frozen: CDP did not answer",
      recordedCrashed: false
    };
    const persisted: Campaign2bState[] = [];
    const deps = baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults);

    const outcome = await runCampaign2b(state, {
      ...deps,
      schedule,
      persist: async (s) => {
        persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
      }
    });

    expect(outcome.kind).toBe("complete");
    expect(deps.runBenchmark).not.toHaveBeenCalled(); // nothing left to run
    expect(state.provenanceAbort).toBeUndefined();
    // The point of the fix: a snapshot WITHOUT the stale note actually reached
    // the persist function.
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1]!.provenanceAbort).toBeUndefined();
  });

  it("F10: the run loop writes a pendingEntry marker BEFORE the entry and clears it after", async () => {
    const state = initCampaign2bState(SUITE.protocolId, SUITE.suiteHash, "keyless");
    const seen: (boolean | undefined)[] = [];
    await runCampaign2b(state, {
      ...baseDeps({ trials: [], stopped: undefined } as unknown as BenchmarkResults),
      schedule: buildSchedule2b("keyless").slice(0, 1),
      persist: async (snapshot) => {
        seen.push(snapshot.pendingEntry !== undefined);
      }
    });
    // At least one persist saw the marker set, and the last saw it cleared.
    expect(seen.some((hadMarker) => hadMarker === true)).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    expect(state.pendingEntry).toBeUndefined();
  });
});

describe("Phase-2B operator hints and CLI", () => {
  it("every frozen verification command carries --expect-record-version 2 and all five 2B flags", () => {
    for (const phase of ["keyless", "keyed", "pooled"] as const) {
      const hint = operatorVerifyHint(phase, ["runs/a", "runs/b"], "data/phase2a/scenario-suite.json");
      expect(hint).toContain("--expect-record-version 2");
      expect(hint).toContain(`--expect-scenarios ${PHASE2B_SCENARIO_IDS.join(",")}`);
      expect(hint).toContain("--expect-arms frozen,any-row");
      expect(hint).toContain(`--expect-campaign ${PHASE2B_CAMPAIGN_ID}`);
      expect(hint).toContain(`--expect-model ${PHASE2B_MODEL}`);
      expect(hint).toContain(`--expect-prices-pinned-at ${PHASE2B_PRICES_PINNED_AT}`);
      expect(hint).toContain("--expect-trials 5");
    }
    expect(operatorVerifyHint("keyless", [], "s")).toContain("--expect-policies A,B,B2");
    expect(operatorVerifyHint("keyed", [], "s")).toContain("--expect-policies C,D");
    expect(operatorVerifyHint("pooled", [], "s")).toContain("--expect-policies A,B,B2,C,D");
  });

  it("the printed schedule shows the frozen entries and the verification commands", () => {
    const printed = renderSchedule();
    expect(printed).toContain("Phase-2B keyless schedule — 30 run entries × 5 scenarios = 150 trials");
    // Sweep-major: sweep 1 covers A, B and B2 before sweep 2 starts.
    expect(printed).toContain("[ 1/30] A  sweep-1 arm=frozen");
    expect(printed).toContain("[ 2/30] A  sweep-1 arm=any-row");
    expect(printed).toContain("[ 3/30] B  sweep-1 arm=any-row");
    expect(printed).toContain("[ 4/30] B  sweep-1 arm=frozen");
    expect(printed).toContain("[ 5/30] B2 sweep-1 arm=frozen");
    expect(printed).toContain("[ 6/30] B2 sweep-1 arm=any-row");
    expect(printed).toContain("[ 7/30] A  sweep-2 arm=any-row");
    expect(printed).toContain("Phase-2B keyed schedule — 20 run entries × 5 scenarios = 100 trials");
    expect(printed).toContain("--expect-record-version 2");
  });

  it("--frozen-expectations has NO default: the keyed phase refuses to guess gate-5 values", () => {
    const parsed = parseCampaign2bArgs(["--suite", "s.json", "--phase", "keyed"]);
    expect(parsed.frozenExpectationsFile).toBeUndefined();
    const withFile = parseCampaign2bArgs([
      "--suite",
      "s.json",
      "--phase",
      "keyed",
      "--frozen-expectations",
      "data/phase2b/frozen.json"
    ]);
    expect(withFile.frozenExpectationsFile).toMatch(/data\/phase2b\/frozen\.json$/);
  });

  it("the frozen-expectations schema requires every pre-spend field and the smoke block", () => {
    const good = {
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: "c-heal", cMustHealLogin: true, dId: "d-flow", dMustPass: true }
    };
    expect(FrozenExpectationsSchema.safeParse(good).success).toBe(true);
    for (const drop of ["gitCommit", "arms", "scheduleLength", "smoke"] as const) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[drop];
      expect(FrozenExpectationsSchema.safeParse(bad).success, drop).toBe(false);
    }
    // recordVersion is pinned to 2 — a 2B bundle is v2 by definition.
    expect(FrozenExpectationsSchema.safeParse({ ...good, recordVersion: 1 }).success).toBe(false);
  });

  it("F9: the frozen suite identity is pinned to the Phase-2A suite", () => {
    expect(PHASE2B_SUITE_PROTOCOL_ID).toBe("phase2a-v1");
    expect(PHASE2B_SUITE_HASH).toMatch(/^[0-9a-f]{64}$/);
    // Set-equality helper refuses a doctored scenario list.
    expect(() => assertAllowlistedScenarios(FIVE)).not.toThrow();
    expect(() => assertAllowlistedScenarios([...FIVE, { id: "smuggled" }])).toThrow(/unexpected: smuggled/);
  });

  it("F12: no entry runs unless the gate-5 freeze tag points at HEAD, and there is no override", () => {
    expect(() => assertFrozenAtHead([PHASE2B_FREEZE_TAG])).not.toThrow();
    expect(() => assertFrozenAtHead(["some-other-tag"])).toThrow(/does not point at HEAD/);
    expect(() => assertFrozenAtHead([])).toThrow(/There is no override/);
    expect(() => assertFrozenAtHead([])).toThrow(/gate 5/);
  });

  it("F1: the keyed gate RETURNS a PASS verdict for the shell to record against the state file", () => {
    const verdict = keyedPhaseGate2b(completeKeylessState(), fakeSuite(), reader, "s.json", () => okReport);
    expect(verdict.pass).toBe(true);
    expect(verdict.violations).toBe(0);
    expect(verdict.entryCount).toBe(30);
    expect(Date.parse(verdict.at)).not.toBeNaN();
    // …and the state schema accepts it, so it can be persisted as ledger evidence.
    const withVerdict = { ...completeKeylessState(), verdict };
    expect(Campaign2bStateSchema.safeParse(withVerdict).success).toBe(true);
  });

  it("F2: the keyed smoke runs C then D as smoke-purpose Arm-F trials and never enters the ledger", async () => {
    const frozen = FrozenExpectationsSchema.parse({
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: FIVE[0]!.id, cMustHealLogin: true, dId: FIVE[1]!.id, dMustPass: true }
    });
    const configs: Record<string, unknown>[] = [];
    const result = await runKeyedSmoke(
      frozen,
      FIVE,
      {
      headless: true,
      prepareRun: async () => ({
        labUrl: "http://127.0.0.1:0",
        benchDir: "runs/smoke",
        benchId: "bench-smoke",
        dispose: async () => undefined
      }),
      runBenchmark: (async (config: Record<string, unknown>) => {
        configs.push(config);
        const isC = (config.engines as string[])[0] === "hybrid";
        return {
          trials: [
            {
              runId: "smoke-t1",
              outcome: "pass",
              healedSteps: isC ? ["login"] : [],
              chromeVersion: "149.0.0.1"
            }
          ]
        } as unknown as BenchmarkResults;
      }) as unknown as Campaign2bDeps["runBenchmark"]
      },
      FROZEN_PROVENANCE
    );
    expect(result.ok).toBe(true);
    expect(result.trials.map((t) => t.policy)).toEqual(["C", "D"]);
    expect(configs).toHaveLength(2);
    for (const config of configs) {
      // NEVER evidence: smoke purpose, Arm F, browser build required.
      expect(config.runPurpose).toBe("smoke");
      expect(config.readinessMode).toBe("frozen");
      expect(config.requireChromeVersion).toBe(true);
      expect(config.campaignProtocolId).toBe(PHASE2B_CAMPAIGN_ID);
      expect(config.trialsPerScenario).toBe(1);
    }
    // C runs the hybrid repair path; D the full-semantic engine.
    expect(configs[0]!.engines).toEqual(["hybrid"]);
    expect(configs[0]!.repairMode).toBe("llm");
    expect(configs[1]!.engines).toEqual(["stagehand"]);
  });

  it("ITEM 3a: the smoke REFUSES a suite that is not the frozen one, before running anything", async () => {
    const frozen = FrozenExpectationsSchema.parse({
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: FIVE[0]!.id, cMustHealLogin: true, dId: FIVE[1]!.id, dMustPass: true }
    });
    const runBenchmarkStub = vi.fn();
    await expect(
      runKeyedSmoke(
        frozen,
        FIVE,
        {
          headless: true,
          prepareRun: async () => {
            throw new Error("prepareRun must not be reached");
          },
          runBenchmark: runBenchmarkStub as unknown as Campaign2bDeps["runBenchmark"]
        },
        { protocolId: "phase2a-v1", suiteHash: "b".repeat(64), gitCommit: null }
      )
    ).rejects.toThrow(/keyed smoke refuses to run: suite protocolId/);
    expect(runBenchmarkStub).not.toHaveBeenCalled();
  });

  it("ITEM 3a: the smoke record carries the suite/campaign/commit stamps", async () => {
    const frozen = FrozenExpectationsSchema.parse({
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: FIVE[0]!.id, cMustHealLogin: true, dId: FIVE[1]!.id, dMustPass: true }
    });
    const result = await runKeyedSmoke(
      frozen,
      FIVE,
      {
        headless: true,
        prepareRun: async () => ({
          labUrl: "http://127.0.0.1:0",
          benchDir: "runs/smoke",
          benchId: "bench-smoke",
          dispose: async () => undefined
        }),
        runBenchmark: (async () =>
          ({
            trials: [{ runId: "t", outcome: "pass", healedSteps: ["login"], chromeVersion: "1" }]
          }) as unknown as BenchmarkResults) as unknown as Campaign2bDeps["runBenchmark"]
      },
      FROZEN_PROVENANCE
    );
    expect(result.protocolId).toBe(PHASE2B_SUITE_PROTOCOL_ID);
    expect(result.suiteHash).toBe(PHASE2B_SUITE_HASH);
    expect(result.campaignProtocolId).toBe(PHASE2B_CAMPAIGN_ID);
    expect(result.gitCommit).toBe(FROZEN_PROVENANCE.gitCommit);
  });

  it("ITEM 3b: the frozen file cannot DISABLE either smoke criterion", () => {
    const base = {
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20
    };
    for (const smoke of [
      { cId: "c", cMustHealLogin: false, dId: "d", dMustPass: true },
      { cId: "c", cMustHealLogin: true, dId: "d", dMustPass: false },
      { cId: "c", dId: "d", dMustPass: true },
      { cId: "c", cMustHealLogin: true, dId: "d" }
    ]) {
      expect(FrozenExpectationsSchema.safeParse({ ...base, smoke }).success, JSON.stringify(smoke)).toBe(
        false
      );
    }
  });

  it("ITEM 3c: the C criterion needs the EXACT step \"login\", not a prefix match", async () => {
    const frozen = FrozenExpectationsSchema.parse({
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: FIVE[0]!.id, cMustHealLogin: true, dId: FIVE[1]!.id, dMustPass: true }
    });
    const withHealed = async (healed: string[]) =>
      (
        await runKeyedSmoke(
          frozen,
          FIVE,
          {
            headless: true,
            prepareRun: async () => ({
              labUrl: "http://127.0.0.1:0",
              benchDir: "runs/smoke",
              benchId: "bench-smoke",
              dispose: async () => undefined
            }),
            runBenchmark: (async () =>
              ({
                trials: [{ runId: "t", outcome: "pass", healedSteps: healed, chromeVersion: "1" }]
              }) as unknown as BenchmarkResults) as unknown as Campaign2bDeps["runBenchmark"]
          },
          FROZEN_PROVENANCE
        )
      ).trials.find((t) => t.policy === "C")!.passedCriteria;
    expect(await withHealed(["relogin"])).toBe(false);
    expect(await withHealed(["login-retry"])).toBe(false);
    expect(await withHealed(["login"])).toBe(true);
    expect(await withHealed(["reveal-table", "login"])).toBe(true);
  });

  it("F2: either smoke trial failing its frozen criterion blocks the keyed phase", async () => {
    const base = {
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2 as const,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: { cId: FIVE[0]!.id, cMustHealLogin: true, dId: FIVE[1]!.id, dMustPass: true }
    };
    const frozen = FrozenExpectationsSchema.parse(base);
    const deps = (healed: string[], outcome: string) => ({
      headless: true,
      prepareRun: async () => ({
        labUrl: "http://127.0.0.1:0",
        benchDir: "runs/smoke",
        benchId: "bench-smoke",
        dispose: async () => undefined
      }),
      runBenchmark: (async () =>
        ({
          trials: [{ runId: "t", outcome, healedSteps: healed, chromeVersion: "1" }]
        }) as unknown as BenchmarkResults) as unknown as Campaign2bDeps["runBenchmark"]
    });
    // C did not heal the login → the C criterion fails.
    const noHeal = await runKeyedSmoke(frozen, FIVE, deps([], "pass"), FROZEN_PROVENANCE);
    expect(noHeal.ok).toBe(false);
    expect(noHeal.trials.find((t) => t.policy === "C")!.passedCriteria).toBe(false);
    // D did not complete the flow → the D criterion fails.
    const dFailed = await runKeyedSmoke(frozen, FIVE, deps(["login"], "fail"), FROZEN_PROVENANCE);
    expect(dFailed.ok).toBe(false);
    expect(dFailed.trials.find((t) => t.policy === "D")!.passedCriteria).toBe(false);
  });

  it("--print-schedule needs no suite and runs nothing", () => {
    const parsed = parseCampaign2bArgs(["--print-schedule"]);
    expect(parsed.printSchedule).toBe(true);
  });

  it("per-phase state files never collide", () => {
    const keyless = parseCampaign2bArgs(["--suite", "s.json", "--phase", "keyless"]);
    const keyed = parseCampaign2bArgs(["--suite", "s.json", "--phase", "keyed"]);
    expect(keyless.stateFile).toMatch(/runs\/phase2b\/campaign-state\.keyless\.json$/);
    expect(keyed.stateFile).toMatch(/runs\/phase2b\/campaign-state\.keyed\.json$/);
    expect(keyless.stateFile).not.toBe(keyed.stateFile);
  });

  it("entryLabel names the full cell identity including the arm", () => {
    expect(entryLabel(buildSchedule2b("keyed")[0]!)).toBe("keyed/C/sweep-1/any-row");
  });

  it("verifyGridFor covers all three frozen bundle shapes", () => {
    expect(verifyGridFor("keyless").policies).toEqual(["A", "B", "B2"]);
    expect(verifyGridFor("keyed").policies).toEqual(["C", "D"]);
    expect(verifyGridFor("pooled").policies).toEqual(["A", "B", "B2", "C", "D"]);
  });
});

// ── The keyed smoke: frozen stamps, and spend that is accounted for ──────────
//
// Two findings live here. (1) The smoke's own trial records were stamped with
// the runner's built-in catalog identity, not the frozen suite's — so a
// smoke.json summary claimed a suite its own results.json did not. (2) The
// smoke ran entirely outside the ledger: before the state file was even loaded,
// with no budget hooks, recording no cost, and re-running on every keyed
// resume. A state already at $39.90 could therefore incur more paid calls
// before any stop check.

describe("keyed smoke: frozen stamps and ledger accounting", () => {
  // The smoke prices through the same pinned table an entry does, so the model
  // NAME must be the frozen one. The suite's credential isolation scrubs it to
  // "" before any module loads; this restores the name only — no key is
  // involved and every runBenchmark below is a stub.
  beforeEach(() => {
    vi.stubEnv("STAGEHAND_MODEL", PHASE2B_MODEL);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const SMOKE_TOKENS = { llmCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
  /** One smoke trial's priced cost under the pinned table — definitely nonzero. */
  const perTrial = trialCost({ tokens: SMOKE_TOKENS }, "hybrid", PHASE2B_MODEL)!;

  const frozenFor = (over: { cId?: string; dId?: string } = {}) =>
    FrozenExpectationsSchema.parse({
      suiteHash: PHASE2B_SUITE_HASH,
      protocolId: PHASE2B_SUITE_PROTOCOL_ID,
      campaignProtocolId: PHASE2B_CAMPAIGN_ID,
      gitCommit: "0".repeat(40),
      recordVersion: 2,
      arms: ["frozen", "any-row"],
      scheduleLength: 20,
      smoke: {
        cId: over.cId ?? FIVE[0]!.id,
        cMustHealLogin: true,
        dId: over.dId ?? FIVE[1]!.id,
        dMustPass: true
      }
    });

  const keyedState = (): Campaign2bState =>
    initCampaign2bState(PHASE2B_SUITE_PROTOCOL_ID, PHASE2B_SUITE_HASH, "keyed");

  const prepareRun = async () => ({
    labUrl: "http://127.0.0.1:0",
    benchDir: "runs/smoke",
    benchId: "bench-smoke",
    dispose: async () => undefined
  });

  /** The EXTENDED ledger invariant: entries + smoke spend reconcile to spendUsd. */
  const invariantGap = (s: Campaign2bState): number =>
    s.entries.reduce((sum, e) => sum + e.costUsd, 0) + (s.smokeSpendUsd ?? 0) - s.spendUsd;

  /**
   * A smoke runBenchmark stub. `plan(call)` says what each of the two calls
   * does: how many priced trials it banks THROUGH THE HOOKS (the same path
   * production banks on), and whether it then throws or returns a trial. Call 1
   * is C, call 2 is D.
   */
  const smokeRunner = (
    plan: (call: number) => { banks: number; throws?: true; healed?: string[]; outcome?: string }
  ) => {
    let call = 0;
    return vi.fn(async (config: BenchmarkRunConfig) => {
      call += 1;
      const step = plan(call);
      for (let i = 0; i < step.banks; i++) {
        await config.hooks!.afterTrial!({
          engine: "hybrid",
          runId: `smoke-t${call}-${i}`,
          tokens: SMOKE_TOKENS
        } as unknown as TrialResult);
      }
      if (step.throws) throw new Error("engine died mid-smoke");
      return {
        trials: [
          {
            runId: `smoke-t${call}`,
            outcome: step.outcome ?? "pass",
            healedSteps: step.healed ?? (call === 1 ? ["login"] : []),
            chromeVersion: "149.0.0.1"
          }
        ]
      } as unknown as BenchmarkResults;
    });
  };

  it("FIX: the smoke's OWN trial records carry the frozen suite stamps, not a catalog default", async () => {
    // The outer smoke.json summary was already stamped; the RECORDS the runner
    // wrote were not, so results.json claimed the built-in phase1 catalog.
    // Re-asserting the summary is exactly what missed this — these assertions
    // read the options each runBenchmark call actually received.
    const configs: BenchmarkRunConfig[] = [];
    const result = await runKeyedSmoke(
      frozenFor(),
      FIVE,
      {
        headless: true,
        prepareRun,
        runBenchmark: (async (config: BenchmarkRunConfig) => {
          configs.push(config);
          const isC = (config.engines as string[])[0] === "hybrid";
          return {
            trials: [
              {
                runId: "smoke-t",
                outcome: "pass",
                healedSteps: isC ? ["login"] : [],
                chromeVersion: "149.0.0.1"
              }
            ]
          } as unknown as BenchmarkResults;
        }) as unknown as Campaign2bDeps["runBenchmark"]
      },
      FROZEN_PROVENANCE
    );
    expect(result.ok).toBe(true);
    // BOTH smoke trials — C and D — not just the first.
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.engines)).toEqual([["hybrid"], ["stagehand"]]);
    for (const [i, config] of configs.entries()) {
      expect(config.protocolId, `call ${i}`).toBe(PHASE2B_SUITE_PROTOCOL_ID);
      expect(config.suiteHash, `call ${i}`).toBe(PHASE2B_SUITE_HASH);
      expect(config.runPurpose, `call ${i}`).toBe("smoke");
    }
  });

  it("a PASSING smoke recorded for THIS freeze is not repeated, and costs nothing on resume", async () => {
    const frozen = frozenFor();
    const state = keyedState();
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: "0".repeat(40),
      spendUsd: perTrial * 2
    };
    state.smokeSpendUsd = perTrial * 2;
    state.spendUsd = perTrial * 2;
    const runBenchmark = smokeRunner(() => ({ banks: 1 }));
    const lines: string[] = [];

    const out = await ensureKeyedSmoke(
      state,
      frozen,
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        log: (line) => lines.push(line),
        persist: async () => undefined
      },
      FROZEN_PROVENANCE
    );

    expect(out).toEqual({ kind: "skipped" });
    expect(runBenchmark).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/already PASSED[\s\S]*not repeated/);
    expect(invariantGap(state)).toBeCloseTo(0, 10);
  });

  it("a recorded smoke belonging to ANOTHER freeze is REFUSED, not honoured", async () => {
    // A go-ahead earned against different scenario ids does not gate this
    // campaign. Silently accepting it would let a re-freeze start keyed spend
    // on the strength of a smoke that never ran against it.
    const frozen = frozenFor();
    const state = keyedState();
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: "some-other-scenario",
      dId: frozen.smoke.dId,
      gitCommit: "0".repeat(40),
      spendUsd: 0
    };
    const runBenchmark = smokeRunner(() => ({ banks: 1 }));

    await expect(
      ensureKeyedSmoke(
        state,
        frozen,
        FIVE,
        {
          runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
          prepareRun,
          headless: true,
          persist: async () => undefined
        },
        FROZEN_PROVENANCE
      )
    ).rejects.toThrow(/belongs to a DIFFERENT freeze/);
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("a state AT the stop threshold incurs NO smoke call at all, and the stop is RECORDED", async () => {
    // The defect in one line: the smoke ran before any stop check, so a ledger
    // already at $39.90 could still buy two more paid trials.
    const state = keyedState();
    // Seeded through the smoke channel so the extended invariant holds going in.
    state.smokeSpendUsd = CAMPAIGN_BUDGET_THRESHOLD_USD;
    state.spendUsd = CAMPAIGN_BUDGET_THRESHOLD_USD;
    const runBenchmark = smokeRunner(() => ({ banks: 1 }));
    const persisted: Campaign2bState[] = [];

    const out = await ensureKeyedSmoke(
      state,
      frozenFor(),
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async (s) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
        }
      },
      FROZEN_PROVENANCE
    );

    expect(out.kind).toBe("budget-stopped");
    if (out.kind === "budget-stopped") expect(out.reason).toMatch(/budget stop/);
    expect(runBenchmark).not.toHaveBeenCalled();
    expect(state.smoke).toBeUndefined();
    // THE STOP LEAVES A TRACE. The CLI tells the operator "State preserved at
    // <file>"; without this the preserved state said nothing about why.
    expect(state.stoppedReason).toMatch(/budget stop/);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1]!.stoppedReason).toMatch(/budget stop/);
  });

  it("FIX C: a threshold crossed MID-SMOKE is a budget stop, never a smoke FAILURE", async () => {
    // The repro: spend just under the threshold, C banks and crosses it, and the
    // runner answers D's beforeTrial with a stop — returning ZERO trials plus a
    // `stopped` block. The grading path read trials[0] as undefined and wrote
    // "C failed to heal the login / D failed to complete the flow" into
    // smoke.json as a durable scientific claim about two trials, one of which
    // never ran — and the CLI exited 2 (usage) rather than 3 (budget).
    const state = keyedState();
    const base = CAMPAIGN_BUDGET_THRESHOLD_USD - perTrial / 2;
    state.smokeSpendUsd = base;
    state.spendUsd = base;
    const persisted: Campaign2bState[] = [];

    let call = 0;
    const runner = vi.fn(async (config: BenchmarkRunConfig) => {
      call += 1;
      if (call === 1) {
        // C runs and banks, pushing recorded spend past the threshold.
        await config.hooks!.afterTrial!({
          engine: "hybrid",
          runId: "smoke-c",
          tokens: SMOKE_TOKENS
        } as unknown as TrialResult);
        return {
          trials: [
            { runId: "smoke-c", outcome: "pass", healedSteps: ["login"], chromeVersion: "1" }
          ]
        } as unknown as BenchmarkResults;
      }
      // D: the REAL runner contract — beforeTrial at the top of the iteration,
      // and on a stop decision it breaks out and returns what it has (nothing).
      const decision = await config.hooks!.beforeTrial!({
        scenarioId: FIVE[1]!.id,
        engine: "stagehand",
        trial: 1,
        completed: 0,
        total: 1
      });
      expect(decision, "the D call should have been told to stop").toBeTruthy();
      return {
        trials: [],
        stopped: { reason: decision!.stop, completedTrials: 0, plannedTrials: 1 }
      } as unknown as BenchmarkResults;
    });

    const out = await ensureKeyedSmoke(
      state,
      frozenFor(),
      FIVE,
      {
        runBenchmark: runner as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async (s) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
        }
      },
      FROZEN_PROVENANCE
    );

    // A BUDGET STOP, not a graded smoke result.
    expect(out.kind).toBe("budget-stopped");
    if (out.kind === "budget-stopped") expect(out.reason).toMatch(/budget stop/);
    expect(runner).toHaveBeenCalledTimes(2);
    // Nothing was graded and nothing was blessed: no pass recorded, so the smoke
    // is re-attempted once the operator raises or resets the budget.
    expect(state.smoke).toBeUndefined();
    // C's money was really spent, so it stays banked — inside the invariant.
    expect(state.spendUsd).toBeGreaterThanOrEqual(CAMPAIGN_BUDGET_THRESHOLD_USD);
    expect(state.smokeSpendUsd).toBeCloseTo(base + perTrial, 10);
    expect(invariantGap(state)).toBeCloseTo(0, 10);
    // …and the stop is on disk, matching what the CLI claims it preserved.
    expect(state.stoppedReason).toMatch(/budget stop/);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1]!.stoppedReason).toMatch(/budget stop/);
    expect(invariantGap(persisted[persisted.length - 1]!)).toBeCloseTo(0, 10);
  });

  it("FIX D: a recorded smoke from a DIFFERENT COMMIT of the same suite is refused", async () => {
    // protocolId and suiteHash are frozen CONSTANTS of this campaign and the two
    // scenario ids can repeat across freezes, so the commit is the only field
    // that actually separates one freeze from the next. Omitting it made the
    // identity check unable to detect the case it exists for.
    const frozen = frozenFor();
    const state = keyedState();
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: "1".repeat(40), // ← the ONLY difference
      spendUsd: 0
    };
    const runBenchmark = smokeRunner(() => ({ banks: 1 }));

    const call = ensureKeyedSmoke(
      state,
      frozen,
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async () => undefined
      },
      FROZEN_PROVENANCE
    );
    await expect(call).rejects.toThrow(/belongs to a DIFFERENT freeze/);
    // The message names BOTH commits, so the operator can see which is which.
    await expect(call).rejects.toThrow(new RegExp("1".repeat(40)));
    await expect(call).rejects.toThrow(new RegExp(frozen.gitCommit));
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("FIX J: a wrong-suite provenance is refused even on the recorded-pass SKIP path", async () => {
    // The skip path returns before runKeyedSmoke — where the frozen-suite
    // refusal lived — so as an exported API this reported a cheerful "skipped"
    // for a campaign pointed at the wrong suite entirely.
    const frozen = frozenFor();
    const state = keyedState();
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: frozen.gitCommit,
      spendUsd: 0
    };
    const runBenchmark = smokeRunner(() => ({ banks: 1 }));

    await expect(
      ensureKeyedSmoke(
        state,
        frozen,
        FIVE,
        {
          runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
          prepareRun,
          headless: true,
          persist: async () => undefined
        },
        { protocolId: PHASE2B_SUITE_PROTOCOL_ID, suiteHash: "b".repeat(64), gitCommit: null }
      )
    ).rejects.toThrow(/keyed smoke refuses to run: suite protocolId/);
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("a fresh PASSING smoke banks its spend, records the pass, and keeps the extended invariant", async () => {
    const frozen = frozenFor();
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    const runBenchmark = smokeRunner((call) => ({
      banks: 1,
      healed: call === 1 ? ["login"] : []
    }));

    const out = await ensureKeyedSmoke(
      state,
      frozen,
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async (s) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
        }
      },
      FROZEN_PROVENANCE
    );

    expect(out.kind).toBe("passed");
    // The spend is REAL and it is banked: two priced trials, C and D. (A zero
    // per-trial price would make every amount assertion below vacuous.)
    expect(perTrial).toBeGreaterThan(0);
    expect(state.spendUsd).toBeCloseTo(perTrial * 2, 10);
    expect(state.smokeSpendUsd).toBeCloseTo(perTrial * 2, 10);
    // The pass is recorded with THIS freeze's identity, so a resume can check it.
    expect(state.smoke).toEqual({
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: FROZEN_PROVENANCE.gitCommit,
      spendUsd: state.smoke!.spendUsd
    });
    expect(state.smoke!.spendUsd).toBeCloseTo(perTrial * 2, 10);
    // The schema accepts it, so it survives a write/reload cycle.
    expect(Campaign2bStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true);
    // The invariant holds on the FINAL persisted snapshot, not merely in memory.
    expect(persisted.length).toBeGreaterThan(0);
    expect(invariantGap(persisted[persisted.length - 1]!)).toBeCloseTo(0, 10);
  });

  it("a MID-SMOKE crash leaves every snapshot consistent, records no pass, and re-runs next time", async () => {
    const frozen = frozenFor();
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    const persist = async (s: Campaign2bState) => {
      persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
    };
    // C banks two priced trials; D dies before returning.
    const crashing = smokeRunner((call) =>
      call === 1 ? { banks: 2, healed: ["login"] } : { banks: 0, throws: true }
    );

    await expect(
      ensureKeyedSmoke(
        state,
        frozen,
        FIVE,
        {
          runBenchmark: crashing as unknown as Campaign2bDeps["runBenchmark"],
          prepareRun,
          headless: true,
          persist
        },
        FROZEN_PROVENANCE
      )
    ).rejects.toThrow(/engine died mid-smoke/);

    // EVERY snapshot that reached disk satisfies the extended invariant — a
    // kill -9 anywhere in the smoke leaves a ledger that reconciles.
    expect(persisted.length).toBeGreaterThan(0);
    for (const [i, snapshot] of persisted.entries()) {
      expect(invariantGap(snapshot), `snapshot ${i}`).toBeCloseTo(0, 10);
      expect(snapshot.smoke, `snapshot ${i}`).toBeUndefined();
    }
    expect(state.smoke).toBeUndefined();
    expect(state.spendUsd).toBeCloseTo(perTrial * 2, 10);
    expect(state.smokeSpendUsd).toBeCloseTo(perTrial * 2, 10);

    // …and because no pass was recorded, the next invocation runs it again.
    const retry = smokeRunner((call) => ({ banks: 1, healed: call === 1 ? ["login"] : [] }));
    const out = await ensureKeyedSmoke(
      state,
      frozen,
      FIVE,
      {
        runBenchmark: retry as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist
      },
      FROZEN_PROVENANCE
    );
    expect(retry).toHaveBeenCalledTimes(2); // C and D, run again
    expect(out.kind).toBe("passed");
    // The retry's spend ACCUMULATES onto the crashed attempt's — none is lost.
    expect(state.smokeSpendUsd).toBeCloseTo(perTrial * 4, 10);
    expect(invariantGap(state)).toBeCloseTo(0, 10);
  });

  it("a FAILING smoke keeps its spend banked and records NO pass", async () => {
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    // C heals the login; D does not complete the flow → the D criterion fails.
    const runBenchmark = smokeRunner((call) =>
      call === 1 ? { banks: 1, healed: ["login"] } : { banks: 1, outcome: "fail" }
    );

    const out = await ensureKeyedSmoke(
      state,
      frozenFor(),
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async (s) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
        }
      },
      FROZEN_PROVENANCE
    );

    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.smoke.ok).toBe(false);
      expect(out.smoke.trials.find((t) => t.policy === "D")!.passedCriteria).toBe(false);
    }
    // The money was spent, so it stays banked — but no pass is recorded, so the
    // smoke is re-attempted rather than skipped.
    expect(state.spendUsd).toBeCloseTo(perTrial * 2, 10);
    expect(state.smokeSpendUsd).toBeCloseTo(perTrial * 2, 10);
    expect(state.smoke).toBeUndefined();
    expect(invariantGap(persisted[persisted.length - 1]!)).toBeCloseTo(0, 10);
  });

  // ── FIX 3: smoke provenance failures use the provenanceAbort channel ──────
  //
  // ensureKeyedSmoke caught only SmokeBudgetStopError, so a browser-provenance
  // fault during the smoke escaped to main()'s generic bail: exit 2 (usage),
  // no state channel, and a preserved state file that said nothing about why.
  // It is an ENVIRONMENT fault exactly as it is in the entry loop, and it now
  // reports through the same channel.

  /** A smoke runner that banks `banks` priced trials per call, then may throw. */
  const throwingSmokeRunner = (plan: (call: number) => { banks: number; throw?: unknown }) => {
    let call = 0;
    return vi.fn(async (config: BenchmarkRunConfig) => {
      call += 1;
      const step = plan(call);
      for (let i = 0; i < step.banks; i++) {
        await config.hooks!.afterTrial!({
          engine: "hybrid",
          runId: `smoke-t${call}-${i}`,
          tokens: SMOKE_TOKENS
        } as unknown as TrialResult);
      }
      if (step.throw) throw step.throw;
      return {
        trials: [
          {
            runId: `smoke-t${call}`,
            outcome: "pass",
            healedSteps: call === 1 ? ["login"] : [],
            chromeVersion: "149.0.0.1"
          }
        ]
      } as unknown as BenchmarkResults;
    });
  };

  const runSmokeWith = async (
    state: Campaign2bState,
    runBenchmark: ReturnType<typeof throwingSmokeRunner>,
    persisted: Campaign2bState[]
  ) =>
    ensureKeyedSmoke(
      state,
      frozenFor(),
      FIVE,
      {
        runBenchmark: runBenchmark as unknown as Campaign2bDeps["runBenchmark"],
        prepareRun,
        headless: true,
        persist: async (s) => {
          persisted.push(JSON.parse(JSON.stringify(s)) as Campaign2bState);
        }
      },
      FROZEN_PROVENANCE
    );

  it("FIX 3: a provenance fault DURING the smoke reports through the provenanceAbort channel", async () => {
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    // C banks and completes; D cannot report its browser build.
    const runner = throwingSmokeRunner((call) =>
      call === 1 ? { banks: 1 } : { banks: 0, throw: new MissingChromeVersionError("stagehand", "d") }
    );

    const out = await runSmokeWith(state, runner, persisted);

    expect(out.kind).toBe("provenance-abort");
    if (out.kind === "provenance-abort") {
      expect(out.reason).toMatch(/browser provenance unavailable during the keyed smoke/);
      expect(out.reason).toMatch(/ENVIRONMENT fault, not a smoke verdict/);
    }
    // The channel, on disk — and NOT the budget's field.
    expect(state.provenanceAbort).toEqual({
      reason: expect.stringMatching(
        /browser provenance unavailable during the keyed smoke/
      ) as unknown as string,
      // No entry exists to mark crashed: the smoke banks into smokeSpendUsd.
      recordedCrashed: false
    });
    expect(state.stoppedReason).toBeUndefined();
    // No verdict was reached, so no pass is recorded and the smoke re-runs.
    expect(state.smoke).toBeUndefined();
    // C's money was really spent and stays banked, inside the invariant.
    expect(state.smokeSpendUsd).toBeCloseTo(perTrial, 10);
    expect(state.spendUsd).toBeCloseTo(perTrial, 10);
    expect(persisted.length).toBeGreaterThan(0);
    for (const [i, snapshot] of persisted.entries()) {
      expect(invariantGap(snapshot), `snapshot ${i}`).toBeCloseTo(0, 10);
    }
    expect(persisted[persisted.length - 1]!.provenanceAbort?.recordedCrashed).toBe(false);
  });

  it("FIX 3: a WRAPPED provenance abort is recognised through the cause chain", async () => {
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    const runner = throwingSmokeRunner((call) =>
      call === 1
        ? { banks: 1 }
        : {
            banks: 0,
            throw: new Error("engine wrapper", {
              cause: new ChromeVersionUnavailableError("CDP /json/version did not answer")
            })
          }
    );

    const out = await runSmokeWith(state, runner, persisted);
    expect(out.kind).toBe("provenance-abort");
    expect(state.provenanceAbort?.recordedCrashed).toBe(false);
    expect(state.smoke).toBeUndefined();
  });

  it("FIX 3: a ZERO-SPEND provenance abort leaves the smoke bank untouched", async () => {
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    // The very first call dies before banking anything.
    const runner = throwingSmokeRunner(() => ({
      banks: 0,
      throw: new ChromeVersionUnavailableError("CDP /json/version did not answer")
    }));

    const out = await runSmokeWith(state, runner, persisted);
    expect(out.kind).toBe("provenance-abort");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(state.smokeSpendUsd ?? 0).toBe(0);
    expect(state.spendUsd).toBe(0);
    expect(state.smoke).toBeUndefined();
    expect(state.provenanceAbort?.recordedCrashed).toBe(false);
    expect(invariantGap(state)).toBeCloseTo(0, 10);
  });

  it("FIX 3: a stale abort note is cleared and persisted even on the SKIPPED path", async () => {
    // Same rule as the entry loop's: a new invocation supersedes the note. The
    // skip path returns early, so the clear has to happen before it.
    const frozen = frozenFor();
    const state = keyedState();
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: frozen.gitCommit,
      spendUsd: 0
    };
    state.provenanceAbort = { reason: "a fault from the previous invocation", recordedCrashed: false };
    const persisted: Campaign2bState[] = [];
    const runner = throwingSmokeRunner(() => ({ banks: 0 }));

    const out = await runSmokeWith(state, runner, persisted);

    expect(out.kind).toBe("skipped");
    expect(runner).not.toHaveBeenCalled();
    expect(state.provenanceAbort).toBeUndefined();
    // …and a snapshot WITHOUT the note actually reached disk.
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[persisted.length - 1]!.provenanceAbort).toBeUndefined();
  });

  it("ITEM 5: a DIFFERENT-FREEZE refusal leaves the previous run's abort note INTACT", async () => {
    // The clear used to run before the recorded-pass check, so a refusal — a
    // path that runs nothing and changes nothing — first erased the previous
    // run's provenance note from disk, destroying the record of why THAT run
    // stopped while declining to do any work of its own.
    const frozen = frozenFor();
    const state = keyedState();
    const note = { reason: "a fault from the previous invocation", recordedCrashed: false };
    state.provenanceAbort = { ...note };
    state.smoke = {
      pass: true,
      protocolId: frozen.protocolId,
      suiteHash: frozen.suiteHash,
      cId: frozen.smoke.cId,
      dId: frozen.smoke.dId,
      gitCommit: "1".repeat(40), // ← a DIFFERENT freeze
      spendUsd: 0
    };
    const persisted: Campaign2bState[] = [];
    const runner = throwingSmokeRunner(() => ({ banks: 0 }));

    await expect(runSmokeWith(state, runner, persisted)).rejects.toThrow(
      /belongs to a DIFFERENT freeze/
    );
    expect(runner).not.toHaveBeenCalled();
    // The note SURVIVES — in memory, and in every snapshot that reached disk.
    expect(state.provenanceAbort).toEqual(note);
    for (const [i, snapshot] of persisted.entries()) {
      expect(snapshot.provenanceAbort, `snapshot ${i}`).toEqual(note);
    }
  });

  it("ITEM 7: the smoke is the keyed phase's FIRST paid call, so it guards the ledger too", async () => {
    // runCampaign2b guards its own loop for exactly this reason. Applying it
    // there and not here left the EARLIER of the two spend sites unguarded.
    const state = keyedState();
    state.entries = [
      {
        phase: "keyed",
        sweep: 1,
        policy: "C",
        arm: "any-row",
        status: "complete",
        benchId: "bench-0",
        dir: "runs/phase2b/0",
        costUsd: 1,
        completedTrials: 5,
        reruns: 0
      }
    ];
    state.spendUsd = 0.5; // understated against the entry it already records
    const persisted: Campaign2bState[] = [];
    const runner = throwingSmokeRunner(() => ({ banks: 1 }));

    await expect(runSmokeWith(state, runner, persisted)).rejects.toThrow(
      /ledger does not reconcile/
    );
    expect(runner).not.toHaveBeenCalled();
    expect(state.smoke).toBeUndefined();
  });

  it("FIX 3: a GENERIC error is still not converted — it propagates", async () => {
    const state = keyedState();
    const persisted: Campaign2bState[] = [];
    const runner = throwingSmokeRunner((call) =>
      call === 1 ? { banks: 1 } : { banks: 0, throw: new Error("standings table not found") }
    );

    await expect(runSmokeWith(state, runner, persisted)).rejects.toThrow(
      /standings table not found/
    );
    expect(state.provenanceAbort).toBeUndefined();
    expect(state.smoke).toBeUndefined();
  });

  it("reconcilePendingEntry does NOT charge the smoke's spend to the crashed slot", async () => {
    // The orphan is spendUsd MINUS banked entries MINUS the smoke's share.
    // Without the last term, a mid-entry kill after a paid smoke would record
    // the smoke's cost against whichever slot happened to be in flight.
    const state = keyedState();
    const entrySum = 1.25;
    const smokeSpend = 0.75;
    const orphan = 0.4;
    state.entries = [
      {
        phase: "keyed",
        sweep: 1,
        policy: "C",
        arm: "any-row",
        status: "complete",
        benchId: "bench-0",
        dir: "runs/phase2b/0",
        costUsd: entrySum,
        completedTrials: 5,
        reruns: 0
      }
    ];
    state.smokeSpendUsd = smokeSpend;
    state.spendUsd = entrySum + smokeSpend + orphan;
    state.pendingEntry = {
      phase: "keyed",
      sweep: 1,
      policy: "C",
      arm: "frozen",
      benchId: "bench-orphan",
      benchDir: "runs/phase2b/orphan"
    };

    expect(reconcilePendingEntry(state)).toBe(true);
    const crashed = state.entries[1]!;
    expect(crashed.status).toBe("crashed");
    expect(crashed.dir).toBe("runs/phase2b/orphan");
    // EXACTLY the orphan — the smoke's $0.75 is not laundered into this slot.
    expect(crashed.costUsd).toBeCloseTo(orphan, 10);
    expect(invariantGap(state)).toBeCloseTo(0, 10);
  });
});
