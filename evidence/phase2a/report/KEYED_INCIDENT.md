# Phase 2A keyed-campaign incident report (for sol's ruling before any rerun)

Date: 2026-07-21. Status: **keyed campaign STOPPED by operator at 5/10
entries** (6th mid-flight, unrecorded) after detecting transport-failure
contamination of judged outcomes. No frozen code touched. Commit freeze
intact; tree clean at `867723c`. Recorded spend $2.2746209999999993 of the
$39.90 pre-trial stop threshold.

**SOL'S RULING (2026-07-21): option (b) — full keyed-grid restart.** The
aborted attempt is labeled **"aborted — transport contamination"**; none of
its runs enter final verification, including technically-clean sweep 1
(full invalidation avoids any appearance of post-hoc selection after
outcomes were seen). The clean sweep-1 readiness finding remains a
preliminary observation; it becomes reportable only if the replacement
grid independently reproduces it. Execution details in "Restart plan"
below.

## What happened

The predeclared smoke was green on every §8.5 criterion (4/4 pass, C healed
`class-drift` with `healedSteps: ['login']` / 3 calls, D 5 calls with both
token sides, stamps correct, `runPurpose: smoke`). The keyed grid launched
through the §8 gate-3 machine check and ran normally through sweep 1.

Mid-campaign status review caught an anomaly in the ledger: **sweep-2 C
recorded $0.0000 with 30 llmCalls.** Investigation: all 15 repair-bearing
trials in that entry recorded `llmCalls > 0` with **zero tokens on both
sides** — every model call errored. The recorded failure detail is
identical across poisoned trials:

```
Failed after 3 attempts. Last error: Cannot connect to API:
getaddrinfo ENOTFOUND api.anthropic.com
```

Root cause: **intermittent local provider-transport/connectivity
interruption** on the operator machine, spanning sweep-2 D through
sweep-3 C. Most poisoned trials show `ENOTFOUND` (DNS), but one sweep-2 D
trial (`f3-page-size-2-b`) resolved Anthropic's IPv4/IPv6 addresses and
then timed out —
`Connect Timeout Error (attempted addresses: 2607:6bc0::10:443,
160.79.104.10:443)` — so this was broader connectivity loss (network
move, Wi-Fi roaming, or brief sleep), not purely DNS. Not rate limiting,
not the key, not frozen code. Transport re-verified healthy after the
stop (3 consecutive HTTPS probes to api.anthropic.com succeed).

## Contamination criterion (outcome-blind, mechanical)

A trial is transport-poisoned iff:

1. `llmCalls > 0` AND `inputTokens == 0` AND `outputTokens == 0`; OR
2. `failureDetail`/`outcomeReason` matches
   `/ENOTFOUND|Cannot connect to API|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/`.

Criterion 2 catches partial-trial poisoning (early calls landed, a later
call died — one sweep-2 D trial). Poisoned-but-passed is not a realistic
class: each SDK call already spans 3 transport attempts, so a blip either
is absorbed inside a successful call (tokens recorded, harmless) or
exhausts retries and fails the step visibly.

## Contamination map (union of both criteria)

| Entry | Poisoned trials | Status |
| --- | ---: | --- |
| sweep 1 C | 0 | **CLEAN** (fails 12/32, cost $0.1187) |
| sweep 1 D | 0 | **CLEAN** (fails 5/32, cost $1.0595) |
| sweep 2 D | 9 | contaminated (fails 12/32, cost $0.8054) |
| sweep 2 C | 15 | contaminated (fails 21/32, cost $0.0000) |
| sweep 3 C | 6 | contaminated (fails 18/32, cost $0.0908) |
| sweep 3 D | — | killed mid-run, **unrecorded** (reruns natively) |

Coherence check: sweep-3 C's 18 fails = clean sweep-1 C's exact 12-cell
legitimate failure set + the 6 poisoned F1-drift cells. The legitimate C
failure set is stable across sweeps; poison only ever adds cells.

## Why the frozen machinery did not catch this

- The frozen verifier has **no token-side or transport checks**; judged
  failures are admissible by design ("failure is admissible evidence and
  never fails the verifier").
- §7 crash-rerun-once covers process crashes, not entries that completed
  with poisoned outcomes.
- This is a protocol gap: no pre-specified rule for provider-transport
  failure. Disclosed as such.

## The validity question for sol

A trial whose repair/act call never reached the provider does not
instantiate policy C or D as defined in §4 — C's "one key-gated LLM repair
per broken step" was never executed; the trial degenerates to a different
policy. On that argument the poisoned entries are void ab initio. However:
the operator has now SEEN sweep 1–3 outcomes, so any void-and-rerun is
post-hoc. We take no action without sol's ruling. Options:

- **(a) Recommended:** void the three contaminated entries (C2, C3, D2)
  whole — entry is the campaign unit — rerun each once, select by the
  mechanical criterion above (never by outcome), disclose fully in §9.
  State-file surgery on `campaign-state.keyed.json` (a runtime artifact,
  not frozen) with the exact procedure blessed by sol.
- **(b)** Restart the entire keyed grid (cleanest optics, ~$2.3 sunk).
- **(c)** Sol's alternative.

## Preliminary observations from CLEAN data only (sweep 1; never gating)

- **C 20/32:** 6 decoy fails at `llmCalls 0` (trigger-blind, exactly as
  predicted); 4 F3 fails with repair attempted-and-failed (1 call each) —
  **C could not repair the absent reveal control**, as the corrected
  keyless report anticipated; plus `x-class-l2-decoy-l2`,
  `x-class-l3-page-size-2`.
- **D 27/32:** fails exactly 4 F3 + `x-class-l3-page-size-2`, burning 10
  calls per failing trial — **D walks into the same five-row readiness
  misclassification** (sol predicted D 32/0).
- The readiness-heuristic discovery therefore spans every readiness-gated
  policy (B, B2, C, D). Final prediction scoring only after a valid grid.

## Restart plan (sol's ruling, executed)

1. **Preservation.** The aborted ledger is byte-preserved at
   `runs/phase2a/campaign-state.keyed.attempt1-aborted-transport-contamination.json`
   (renamed from `campaign-state.keyed.json`, content unchanged). All five
   completed run directories and the unledgered partial D3 directory
   (`runs/bench-2026-07-21T22-11-02-244Z`, 8 trial dirs, no results.json)
   are untouched on disk. None of these runs enter final verification.
2. **Partial D3 spend disclosure.** The aborted ledger's entry costs sum
   to $2.074342; `spendUsd` is $2.2746209999999993. The $0.200279
   difference is partial D3's per-trial spend, banked by the driver's
   afterTrial hook before the kill. Further unaccounted provider spend is
   possible (calls in flight at the kill; the $39.90 figure remains a
   pre-trial recorded-spend threshold, never a total-cost bound).
3. **Replacement state.** `runs/phase2a/campaign-state.keyed.restart1.json`,
   running the complete ten-entry ABBA schedule via `--state`. Its initial
   `spendUsd` is seeded with the aborted attempt's exact recorded figure,
   `2.2746209999999993` — an **explicitly approved incident exception** to
   the `sum(entries.costUsd) === spendUsd` reconciliation invariant
   (schema-checked: `spendUsd` is load-validated only as nonnegative;
   the invariant is maintained by the accumulate path, so the seed loads
   cleanly and the frozen `shouldStop` enforces $39.90 against the carried
   total, preserving the phase-wide pre-trial protection). At campaign
   end, `state.spendUsd − sum(replacement entries' costUsd)` must equal
   exactly this carry-forward.
4. **Environment.** Stationary on stable network, plugged in, lid open,
   driver wrapped in `caffeinate -i`; no VPN toggles or network changes
   mid-run. Same fresh key (gitignored `.env` only), same commit
   `867723c`, same suite hash. Key revoked after the campaign per §8.4.
5. **Stability gate + smoke.** After a monitored stability period
   (continuous DNS/HTTPS probes), the exact predeclared §8.5 smoke is
   rerun (still never evidence) before the grid starts.
6. **Live transport watchdog.** An external monitor probes
   api.anthropic.com continuously and scans each completed replacement
   entry against the predeclared transport criterion (above); any match
   stops the campaign immediately and preserves everything.
7. **Final verification** uses the keyless directories plus ONLY the ten
   replacement keyed directories.
