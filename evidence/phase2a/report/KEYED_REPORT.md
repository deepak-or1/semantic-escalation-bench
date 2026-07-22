# Phase 2A final campaign report (for sol's review)

Date: 2026-07-21 (completed 2026-07-22 UTC). Status: **campaign complete —
final pooled verification PASS (exit 0).** Full output at
`runs/phase2a/verify.final.txt`.

## Verification

`pnpm verify:suite <15 keyless dirs + 10 replacement keyed dirs>
--suite data/phase2a/scenario-suite.json --expect-policies A,B,B2,C,D
--expect-trials 5`

```
## schema: OK
## provenance: OK
## completeness: OK
## grading: OK
## predictions (report-only — never a gate)
  141 hit · 19 miss · 0 not-run
VERIFY: PASS
```

Scope per sol's restart ruling: keyless directories plus ONLY the ten
replacement keyed directories (`campaign-state.keyed.restart1.json`). The
aborted attempt's five runs and all partials are excluded. Stamps uniform
across all 25 runs: execution commit `867723c`, gitDirty false, suiteHash
`a3e77433869ff77f…`, promptsHash `5c07ce1fbc35…`; suite definition frozen
at `phase2a-suite-freeze-v1`.

## Replacement grid execution

- 10 entries (C, D × 5 sweeps, ABBA), 320 trials, zero transport poison:
  the live watchdog scanned every completed entry against the predeclared
  criterion and exited clean; a final independent scan confirms all 10.
- One interruption: the operator's terminal window closed mid-sweep-4 C
  (SIGTERM, exit 143), killing trial 27/32. The partial
  (`bench-2026-07-22T00-18-27-028Z`) is preserved, unledgered, and
  excluded; the entry reran from scratch per the driver's resume
  semantics. A read-only integrity audit after the interruption confirmed
  all completed entries untouched (32 trials each, benchId/artifact
  consistency, uniform stamps, unchanged mtimes, and identical
  cross-sweep outcome maps).

## Determinism: absolute, both phases

- Keyed: **C fails exactly 12/32 in every sweep; D exactly 5/32 in every
  sweep** — outcome maps identical scenario-by-scenario across all 5
  sweeps per policy (320/320 trials consistent).
- Keyless (previously verified): every cell 0/5 or 5/5, 480/480 identical
  across two full grid runs.

## Results (pass cells of 32)

| Policy | Pass | Sol predicted | Cost / sweep |
| --- | ---: | ---: | ---: |
| A (baseline) | 15 | 15/17 — **exact** | $0 |
| B (structural) | 11 | 15/17 | $0 |
| B2 (deterministic repair) | 17 | 22/10 | $0 |
| C (LLM repair) | 20 | 25/7 | ≈$0.119 |
| D (full semantic) | 27 | 32/0 | ≈$1.057 |

C failing cells: 6 decoys (llmCalls 0 — trigger-blind, predicted), 4 F3,
`x-class-l2-decoy-l2` (predicted), `x-class-l3-page-size-2`. D failing
cells: 4 F3 + `x-class-l3-page-size-2`, burning 10 calls per failing
trial. C's per-sweep cost is ~8.9× cheaper than D's, echoing Phase 1's
~8.6× cold ratio.

## Prediction scorecard: 141 hit · 19 miss · 0 not-run

**All 19 misses are one cluster** — the five F3-bearing columns
(f3-page-size-3-a/b, f3-page-size-2-a/b, x-class-l3-page-size-2) across
B, B2, C, D (B's x-column miss excluded: its failure there was predicted
via login drift). Everything else — 141 of 160 cells — landed exactly as
predicted, including A's instance-specific F1-L1 split.

## The headline finding — now reportable per sol's reproduction condition

The aborted attempt's clean sweep-1 observation reproduced independently
in all five replacement sweeps: **the shared readiness heuristic
(`waitForContent`, ≥5 visible rows) defeats every readiness-gated policy
at page sizes 3 and 2.** Deterministic repair finds no candidate (nothing
hidden exists); C's LLM repair is asked to click an absent control and
fails in 1 call; D's full semantic execution burns 10 calls and still
fails. Only A — which never consults the heuristic — passes F3. A single
hard-coded harness assumption poisons the entire policy ladder above it,
and no amount of semantics (or spend) recovers it, because every policy
re-checks readiness through the same broken predicate. This is Phase 2A's
answer to "when should web automation pay for semantics?": paying more
does not help when the failure lives in a shared pre-semantic gate.

## Ledger close-out (incident exception reconciliation, as ruled)

- Replacement entry costs sum: **$5.878303**. Final `spendUsd`:
  **$8.213774**. Gap: **$2.335471** = the approved carry-forward
  `$2.2746209999999993` + `$0.060850` banked by the window-close partial
  sweep-4 C (derived as gap − carry; the driver banks per-trial spend
  before an entry completes). Both components disclosed; threshold $39.90
  never approached (pre-trial recorded-spend threshold, not a total-cost
  bound).
- Inert partials preserved and excluded: keyless
  `bench-2026-07-21T20-12-48-088Z`, aborted-attempt D3
  `bench-2026-07-21T22-11-02-244Z`, window-close C4
  `bench-2026-07-22T00-18-27-028Z`.

## Next steps

1. Sol reviews (and, if desired, re-verifies from artifacts — no key
   needed).
2. **Key revocation now recommended**: the campaign is complete and
   verified; §8.4 prescribes revocation after the campaign, and this key
   is chat-transcript-exposed.
3. On sol's acceptance: commit freeze lifts — evidence commits at
   `867723c` lineage, §9 analysis document, then Phase-1 + 2A publication
   sequencing (operator's call) and Phase 2B.
