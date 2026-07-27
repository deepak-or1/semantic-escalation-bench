# Phase 2B — gate-7 verification record

Campaign: `phase2b-ablation-v1`, frozen at `phase2b-ablation-freeze-v1`
(commit `22e0e49b37763ce6298c7cd9a9c1ca75ac65a79d`). Executed 2026-07-26
(UTC 22:25–23:57 keyless + keyed). All 50 run entries completed with no
crash, no rerun, no budget stop, no provenance abort, and no transport
poisoning.

## The three frozen verification commands (PROTOCOL_2B §Schedule)

Run against the evidence copies in `evidence/phase2b/runs/` exactly as
shipped. Shared flags:

```
--suite data/phase2a/scenario-suite.json --expect-trials 5
--expect-record-version 2
--expect-scenarios f3-page-size-3-a,f3-page-size-3-b,f3-page-size-2-a,f3-page-size-2-b,x-class-l3-page-size-2
--expect-arms frozen,any-row --expect-campaign phase2b-ablation-v1
--expect-model anthropic/claude-haiku-4-5 --expect-prices-pinned-at 2026-07-14
```

| Bundle | Dirs | Extra flag | Result |
| --- | --- | --- | --- |
| Keyless (150 trials) | `evidence/phase2b/runs/keyless-*` | `--expect-policies A,B,B2` | **VERIFY: PASS** |
| Keyed (100 trials) | `evidence/phase2b/runs/keyed-*` | `--expect-policies C,D` | **VERIFY: PASS** |
| Final pooled (250 trials) | `evidence/phase2b/runs/*` | `--expect-policies A,B,B2,C,D` | **VERIFY: PASS** |

Pooled grading provenance: 250 trial records — 135 recomputed from
shipped raw payloads (v2), 115 hard-failure (v2, no payload produced —
consistency-checked), 0 attested.

The same three commands also passed against the original run
directories before bundling, and the keyless bundle passed at campaign
time (gate 6) before any keyed trial.

## Arm-F replication (gate 6, machine-enforced)

The keyed-phase gate compared every 2B Arm-F keyless trial against its
Phase-2A `keyless-s{sweep}-{policy}` record on the frozen 15-field
projection: **pass, 15 cells, 75 paired trials, 0 violations**. The
verdict is persisted in
`evidence/phase2b/states/campaign-state.keyless.json` (`verdict` block)
and was re-checked from disk by the pre-spend recheck.

## Registered-expectations scorecard

All 50 cells (5 scenarios × 5 policies × 2 arms), each uniform across
its 5 sweeps: **50/50 exact, 0 misses, 0 mixed cells**, against the
table frozen at gate 5 (PROTOCOL_2B §Expectations).

The bounded claim, per the protocol's language rules: within the five
pre-registered Phase-2B scenarios, relaxing the shared five-row
readiness predicate caused the predicted recoveries with zero
cross-sweep variance — B2, C, and D recovered exactly where registered,
while the negative control (A) did not move. This establishes causality
inside the benchmark; it does not generalize to other predicates,
suites, or models.

## Transport poisoning

The frozen outcome-blind criterion
(`(llmCalls > 0 ∧ both token sides 0) ∨ failureDetail matches the
frozen transport pattern`) matched **0 of 250 trials**.

## Ledger reconciliation

`evidence/phase2b/states/campaign-state.keyed.json`:
`spendUsd = 2.0889` = sum(entries.costUsd) `2.0515` + `smokeSpendUsd`
`0.0375`; invariant gap exactly 0. Keyless ledger: 30 entries,
`spendUsd = 0`. Costs are recorded provider tokens priced at the pinned
2026-07-14 table; the $39.90 figure is the pre-trial recorded-spend
stop threshold, not a hard spending bound, and was never approached.
Gate-5 projection was $1.75 expected / $4.55 conservative bound;
observed $2.09 — the overshoot is D's Arm-R trials walking the full
pager on the compound cell (~31% above the `f3-page-size-5` proxy used
in the projection).
