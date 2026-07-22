# Phase 2A keyless report (for sol's review before any keyed spending)

Date: 2026-07-21. Status: **keyless grid complete and verifier-PASSED;
keyless gate accepted by sol.** Revised same day per sol's review: the
causal interpretation of the 9-miss cluster is corrected below (readiness
misclassification, not selector resolution at pagination depth) — an
interpretation change only; suite, code, and campaign are untouched.
This file lives under the gitignored `runs/` tree because a commit freeze is
in effect (see "Provenance incident" below); it will be committed with the
rest of the evidence after the keyed grid completes.

## Verification (frozen verifier, exit 0)

Command: `pnpm verify:suite <15 run dirs from campaign-state.keyless.json>
--suite data/phase2a/scenario-suite.json --expect-policies A,B,B2
--expect-trials 5`

```
## schema: OK
## provenance: OK
## completeness: OK
## grading: OK

## predictions (report-only — never a gate)
  87 hit · 9 miss · 64 not-run

VERIFY: PASS
```

Full output preserved at `runs/phase2a/verify.keyless.attempt2.txt`.
Environment stamps uniform across all 15 runs: gitCommit `867723c`,
gitDirty `false`, suiteHash `a3e77433869ff77f…` (= sol's published package
SHA-256), promptsHash `5c07ce1fbc35…` (Phase-1 frozen value, unchanged).
`867723c` is the **execution commit**; the suite definition remains frozen
at tag `phase2a-suite-freeze-v1`.
Recorded spend: **$0.00** (all keyless). 15 entries (A, B, B2 × sweeps 1–5),
32 scenarios × 5 sweeps × 3 policies = 480 trials, 0 crashes, 0 reruns.

## Provenance incident and remedy (the reason there were two grid runs)

The first full grid run (attempt 1) FAILED verification on provenance only:
runs 2–15 recorded `gitDirty: true`. Root cause: the frozen runner mirrors
every completed run into `runs/latest/`, whose three files were tracked
(Phase-1 evidence committed at `a7c9cf5`); chaining 15 runs in one process
meant run 1's mirror write dirtied the tree for every later provenance read.
Completeness and grading were clean; the runs truthfully reported a dirty tree.

Remedy (commit `867723c`, pushed; zero frozen code touched):

- `runs/` fully gitignored (only `runs/.gitkeep` tracked); the runner still
  mirrors on disk.
- Phase-1 keyless evidence byte-preserved (SHA-256-verified from
  `git show a7c9cf5:runs/latest/<f>`, git-recorded renames) at
  `evidence/phase1/keyless-tier/` with a provenance README; top-level README
  pointers updated.

Attempt 1 is preserved intact: state at
`runs/phase2a/campaign-state.keyless.attempt1-dirty-provenance.json`, verify
output at `runs/phase2a/verify.keyless.attempt1.txt`, all bench dirs on disk.

**Commit freeze:** the verifier enforces cross-run `gitCommit` uniformity and
the final verification pools keyless + keyed. Both grids must record
`867723c`; nothing lands on `main` until the keyed grid completes.

## Determinism check (attempt 1 vs attempt 2)

**480/480 trials produced identical judged outcomes** across the two grids —
separately executed full reruns under the same frozen environment
(~2 h apart). Every scenario×policy cell is
**0/5 or 5/5** — zero cross-sweep variance, now observed on near-boundary
cases, not just at the suite ceiling as in Phase 1.

## Results (judged pass cells of 32, per policy)

| Policy | Pass cells | Pass trials (of 160) |
| --- | ---: | ---: |
| A (baseline) | 15/32 | 75 |
| B (structural, no repair) | 11/32 | 55 |
| B2 (deterministic repair) | 17/32 | 85 |

Failing cells (all 0/5): A fails F1 drift from L1-instance-b upward, decoys
L2+, `k-column-order`, `k-layout-cards`, and 4 of the X compositions (passes
`f1-class-l1-a`, F2 L0–L1, all F3, `k-header-vocabulary`, `k-ui-copy`). B
fails F1 L2+, all decoys L1+, F3 page sizes 3/2, `k-header-vocabulary`,
`k-layout-cards`, and all X except `x-wrapped-column-copy`. B2 fails all
decoys L1+, F3 page sizes 3/2, `k-header-vocabulary`, `k-layout-cards`,
`x-cards-header-vocabulary`, `x-class-l2-decoy-l2`, `x-class-l3-page-size-2`.

## Prediction scorecard (87 hit / 9 miss / 64 not-run)

- **A: 32/32 hits — perfect**, including the instance-specific F1-L1 split
  (passes seed 2209, fails 2213) and JSON-island survival of decoy L1.
- **The 9 misses are one cluster:** B and B2 hard-fail F3 page sizes 3 and 2
  (passing 5), and B2 additionally fails `x-class-l3-page-size-2` — all
  predicted all-pass. Root cause (code-verified; corrects this report's
  earlier draft, which misattributed it to selector resolution at pagination
  depth): the shared readiness check — `waitForContent`,
  `packages/agent/src/core/domReady.ts` — treats stats content as ready only
  when a visible table has **>= 5 body rows** (or >= 8 card-like blocks).
  Page sizes 3 and 2 render fully valid tables whose DOM holds only 3 or 2
  rows per page, so the page is misclassified as "not ready" and the engine
  enters the reveal-table path. F3 scenarios carry no hidden-tab chaos
  (`chaos: []`), so `#tab-table` genuinely does not exist. Recorded
  failures match exactly: B — `reveal-table (#tab-table): cached selector
  failed; semantic repair disabled (--no-repair)`; B2 — `… deterministic
  repair found no candidate (repair-mode=deterministic)` (its ladder clicks
  tab/strip candidates and re-polls the same five-row predicate after each;
  no click can ever satisfy it, because nothing is hidden). On
  `x-class-l3-page-size-2`, B fails earlier and as predicted — class drift
  L3 breaks its cached `login (#username)` selector — while B2 repairs login
  deterministically and then hits this same reveal-table wall. A passes all
  of these because its baseline pipeline never consults the five-row
  heuristic: it waits for any standings row, then walks the pager (JSON
  island as backstop).
- Everything else — F1's B2-recovers-drift story, decoy trigger-blindness for
  the whole B family at L1+, held-out vocabulary defeating the synonym
  dictionaries, card layouts defeating structural addressing — landed exactly
  as predicted.

The cluster is the grid's first genuine discovery, and the brittleness is
the **readiness heuristic itself**: a hard-coded five-visible-row threshold
that misclassifies valid small-page states as "content not ready". That
heuristic is shared by every readiness-gated policy — B, B2, C, and D all
use the same `waitForContent` — which sharpens the keyed-phase question to
**both C and D**: C's LLM repair will be asked to repair an *absent*
control, not rediscover a displaced one (and the reveal-table step re-polls
the same five-row predicate after any repair), while D may walk into the
same misclassification. Predictions remain frozen (sol predicted C all-pass
on F3); this is an interpretation correction only.

## Next steps (frozen sequence)

1. ~~Sol reviews this report~~ — **done 2026-07-21: keyless gate accepted**
   (sol independently re-verified the verifier result, both grids' 480
   trials, cell uniformity, stamps, spend, and the post-freeze commit).
2. Fresh temporary Anthropic key — operator supplies it **only via the
   gitignored repo-root `.env`** (`ANTHROPIC_API_KEY=…`; the driver loads
   `dotenv/config`) or the local environment; never pasted into chat, never
   committed.
3. Predeclared smoke (`runPurpose: smoke`, excluded from evidence).
4. Keyed C/D ABBA grid at commit `867723c` — machine-gated on this keyless
   ledger (§8 gate 3 / §5 item 9).
5. Final pooled verification `--expect-policies A,B,B2,C,D --expect-trials 5`.
6. §9 analysis; then evidence commits.
