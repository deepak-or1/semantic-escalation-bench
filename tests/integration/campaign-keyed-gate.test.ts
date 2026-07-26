import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedScenarioSuite } from "@ssda/shared";
import {
  CAMPAIGN_BUDGET_THRESHOLD_USD,
  buildSchedule,
  type CampaignEntryState,
  type CampaignState
} from "@ssda/agent";
// The gate + arg parser live at the repo-root script; importing never runs main()
// (the file's isEntrypoint guard is false under vitest, exactly like verify-suite).
import { keyedPhaseGate, parseCampaignArgs } from "../../scripts/run-campaign-2a";
import { verifySuite, type ExpectGrid, type VerifyInput, type VerifyReport } from "../../scripts/verify-suite";

/**
 * §8 gate-3 tests (PROTOCOL_2A): the machine-enforced prerequisite that the keyless
 * A/B/B2 grid is COMPLETE and VERIFIER-PASSED before any keyed trial runs. The
 * expensive verification path is stubbed (keyedPhaseGate takes an injectable `verify`
 * ONLY for this) so these exercise the state-machine + expect-grid derivation with the
 * real frozen nextEntry/assertStateMatches/buildSchedule, plus the parse of the new
 * --keyless-state flag (success paths only — the bail paths call process.exit).
 */

const PROTOCOL_ID = "phase2a-v1";
const SUITE_HASH = "suitehash-abcdef0123456789";

/** A minimal, type-correct LoadedScenarioSuite (the gate reads only protocolId/suiteHash). */
function fakeSuite(suiteHash: string = SUITE_HASH): LoadedScenarioSuite {
  return { protocolId: PROTOCOL_ID, suiteHash, scenarios: [] };
}

/**
 * A valid keyless CampaignState whose first `n` schedule entries are all recorded
 * "complete", with the fields the driver writes (benchId/dir/costUsd/completedTrials/reruns).
 */
function makeKeylessState(n: number): CampaignState {
  const schedule = buildSchedule("keyless");
  const entries: CampaignEntryState[] = schedule.slice(0, n).map(
    (e, i): CampaignEntryState => ({
      phase: e.phase,
      sweep: e.sweep,
      policy: e.policy,
      status: "complete",
      benchId: `bench-${i}`,
      dir: `runs/bench-${i}`,
      costUsd: 0,
      completedTrials: 32,
      reruns: 0
    })
  );
  return {
    version: 1,
    protocolId: PROTOCOL_ID,
    suiteHash: SUITE_HASH,
    thresholdUsd: CAMPAIGN_BUDGET_THRESHOLD_USD,
    spendUsd: 0,
    entries
  };
}

/** A verifySuite stub that records each call's arguments and returns a fixed report. */
function stubVerify(report: VerifyReport): {
  fn: typeof verifySuite;
  calls: { inputs: VerifyInput[]; suite: LoadedScenarioSuite; expect: ExpectGrid }[];
} {
  const calls: { inputs: VerifyInput[]; suite: LoadedScenarioSuite; expect: ExpectGrid }[] = [];
  const fn: typeof verifySuite = (inputs, suite, expect) => {
    calls.push({ inputs, suite, expect });
    return report;
  };
  return { fn, calls };
}

/** No records: the gate never inspects the provenance tally, only ok/violations. */
const NO_RECORDS = { total: 0, recomputed: 0, v2NoRows: 0, attestedV1: 0 };

const OK_REPORT: VerifyReport = {
  ok: true,
  violations: [],
  predictions: [],
  notes: [],
  records: NO_RECORDS
};

/** Stub reader used when the read itself is not under test (one VerifyInput per dir). */
const passReader = (dir: string): VerifyInput => ({ source: dir, raw: {} });

describe("keyedPhaseGate (§8 gate 3)", () => {
  it("passes a COMPLETE 15-entry grid and calls the verifier with 15 inputs, the suite, and the schedule-derived expect-grid", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(15);
    const { fn, calls } = stubVerify(OK_REPORT);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs).toHaveLength(15);
    expect(calls[0]!.suite).toBe(suite); // the SAME suite object, unmodified
    expect(calls[0]!.expect).toEqual({ policies: ["A", "B", "B2"], trials: 5 });
  });

  it("throws on an incomplete grid (14 entries), naming the next unfinished entry, without calling the verifier", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(14);
    const { fn, calls } = stubVerify(OK_REPORT);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/incomplete/);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/keyless\/sweep-5\/B2/);
    expect(calls).toHaveLength(0); // rejected before the expensive verification path
  });

  it("throws when the last of 15 entries is 'crashed' (nextEntry returns it → incomplete)", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(15);
    state.entries[14]!.status = "crashed";
    const { fn, calls } = stubVerify(OK_REPORT);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/incomplete/);
    expect(calls).toHaveLength(0);
  });

  it("throws /different suite/ when the keyless state's suiteHash does not match the suite", () => {
    const suite = fakeSuite("a-totally-different-hash");
    const state = makeKeylessState(15); // built with SUITE_HASH
    const { fn } = stubVerify(OK_REPORT);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/different suite/);
  });

  it("throws /keyed/ when the keyless state contains a keyed-phase entry (phase mismatch via assertStateMatches)", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(2);
    state.entries.push({
      phase: "keyed",
      sweep: 1,
      policy: "C",
      status: "complete",
      benchId: "bench-keyed",
      dir: "runs/bench-keyed",
      costUsd: 0,
      completedTrials: 32,
      reruns: 0
    });
    const { fn } = stubVerify(OK_REPORT);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/keyed/);
  });

  it("throws when the verifier reports ok:false, surfacing the violation messages and 'refuses to start'", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(15);
    const failReport: VerifyReport = {
      ok: false,
      violations: [
        { check: "completeness", message: "FIRST-VIOLATION policy A got 1 trial want 5" },
        { check: "grading", message: "SECOND-VIOLATION recorded outcome mismatch" }
      ],
      predictions: [],
      notes: [],
      records: NO_RECORDS
    };
    const { fn } = stubVerify(failReport);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/FIRST-VIOLATION policy A got 1 trial want 5/);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/SECOND-VIOLATION recorded outcome mismatch/);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/refuses to start/);
    expect(() => keyedPhaseGate(state, suite, passReader, fn)).toThrow(/2 violation\(s\)/);
  });

  it("propagates a reader throw, with the failing dir in the message", () => {
    const suite = fakeSuite();
    const state = makeKeylessState(15);
    const { fn } = stubVerify(OK_REPORT);
    const throwingReader = (dir: string): VerifyInput => {
      if (dir === "runs/bench-3") throw new Error(`cannot read results.json under ${dir}`);
      return { source: dir, raw: {} };
    };
    expect(() => keyedPhaseGate(state, suite, throwingReader, fn)).toThrow(/runs\/bench-3/);
  });
});

describe("parseCampaignArgs — --keyless-state flag (success paths only)", () => {
  it("defaults keylessStateFile to the keyless per-phase state when omitted for --phase keyed", () => {
    const args = parseCampaignArgs(["--suite", "s.json", "--phase", "keyed"]);
    expect(args.keylessStateFile).toBe(path.resolve("runs/phase2a/campaign-state.keyless.json"));
  });

  it("honors an explicit --keyless-state override for --phase keyed", () => {
    const args = parseCampaignArgs([
      "--suite",
      "s.json",
      "--phase",
      "keyed",
      "--keyless-state",
      "custom/keyless.json"
    ]);
    expect(args.keylessStateFile).toBe(path.resolve("custom/keyless.json"));
  });
});
