# Prospectively frozen keyed-experiment protocol

**Status: FROZEN at annotated tag `protocol-freeze-v1`.** The keyless
benchmark results committed alongside this file carry provenance
(`gitCommit`, `gitDirty: false`, prompt and lockfile hashes) proving they
were generated at the freeze commit. The keyless benchmark results
in `runs/latest` already exist and predate this document; nothing here is
pre-registration for them. What this document freezes — *before any keyed
result has been observed* — is the methodology for the keyed experiment: the
engine policies, model, prompts, retry and cache rules, repetition counts,
metrics, and analysis plan. Any deviation after the freeze requires a new tag
and a documented amendment at the bottom of this file. The git tag's
timestamp is the proof that the method predates the results.

The claim under test: **does semantic execution, or selective semantic
repair, recover structural drift reliably enough to justify its cost?**
The keyless benchmark already established the free tiers' boundaries
(positional dies on any markup change, sometimes silently; structural
survives reorder/reword but not redesigns). The keyed experiment measures
whether paying a model closes the remaining gap — and what it costs.

---

## 1. Frozen engine configurations

Four configurations, one variable (how the page is addressed). All four share
the identical downstream pipeline — see §2.

| # | Configuration | Command | Policy |
|---|---|---|---|
| A | Positional baseline | `--engines baseline` | Hardcoded ids + fixed column indices; competent waits/retries/re-login; no header mapping; no LLM. |
| B | Structural deterministic | `--engines hybrid --no-repair` | Cached selector replay (`act(action)`, `selfHeal: false`) + header-name column mapping via the fixed synonym dictionary; repair paths hard-disabled; **guaranteed zero model calls** (asserted by test even with a key present). |
| C | Hybrid repair | `--engines hybrid` (key present) | B, plus: on cached-selector failure or no header-mappable table, ONE explicit repair per step — `observe()` → best Action → replay → heal cache; `extract()` as extraction repair using the identical instructions as D. Every repair is recorded in `healedSteps` and token accounting. |
| D | Full semantic | `--engines stagehand` (key present) | Instruction-driven `act`/`extract`/`observe` throughout; no hand-written fallback selectors; credentials via act variables. |

**Frozen parameters** (values live in code at the tagged commit; listed here
for the record):

- **Model:** `anthropic/claude-haiku-4-5` (the repo default; `STAGEHAND_MODEL`
  must NOT be overridden during the campaign).
- **Prompts:** the fixed instruction strings exported from
  `packages/agent/src/stagehand/engine.ts` (`STATS_INSTRUCTION`,
  `ODDS_INSTRUCTION`) and the per-step repair instructions in
  `packages/agent/src/hybrid/engine.ts`. No prompt edits mid-campaign.
- **Retries:** `maxAttempts: 2` per trial (one retry); validation failures
  never retry (deterministic data property). Unchanged from the keyless runs.
- **Scenario seeds:** frozen in `packages/shared/src/scenarios.ts`
  (seeds 1101–1124); the catalog of 24 scenarios is closed for the campaign.
- **Judge:** perfect extraction — accuracy 1.0 with full row coverage on both
  pages (override-aware scoring; 0.02 decimal tolerance for American-odds
  round-trips); a successful pipeline with no accuracy sample fails.
- **Outcome taxonomy:** pass / recovered / safe-failure / silent-corruption /
  hard-failure, computed from behavior, orthogonal to the judged outcome.
- **Repetitions:** N = 5 per scenario for every keyed configuration.

## 2. Shared-pipeline invariant

Every configuration feeds the **identical** post-extraction path:

```
engine-specific extraction
        ↓
shared normalization      (packages/agent/src/core/normalize.ts)
        ↓
shared domain validation  (packages/shared/src/quality.ts)
        ↓
shared ground-truth grader (packages/agent/src/core/score.ts)
```

No engine gets a different validator, schema, or grader. The comparison
isolates addressing strategy, not pipeline quality.

## 3. Cache policy (cold by construction)

| Configuration | Stagehand server cache | `cacheDir` action cache | `selfHeal` | Selector cache |
|---|---|---|---|---|
| A baseline | n/a (no Stagehand) | n/a | n/a | none |
| B structural | not reachable (`env: LOCAL`, `disableAPI: true`) | unset | `false` | bootstrap, fresh per trial |
| C hybrid repair | not reachable (same) | unset | `false` | bootstrap fresh per trial (cold); `--seed-cache <healed-cache.json>` (persistence/warm) |
| D full semantic | not reachable (same) | unset | `false` for act-replay paths; engine uses live inference per step | none |

"Cold" therefore means: local Chrome, no Browserbase server cache possible,
no on-disk action cache, no reused selector repairs. **Warm** applies only to
configuration C and means exactly one thing: the trial's initial cache is a
`healed-cache.json` produced by a prior repair run, supplied via
`--seed-cache`.

## 4. Key-in triggers

All six must hold before `ANTHROPIC_API_KEY` enters `.env`:

1. Perfect-extraction judge merged. ✅ (Wave C)
2. Outcome taxonomy + all three silent-corruption denominators visible in
   results.md and the dashboard. ✅ (Wave C)
3. `--no-repair` tested to guarantee zero model calls. ✅ (Wave C)
4. Shared normalize → validate → grade path confirmed for every engine. ✅
   (architectural invariant, §2)
5. This document committed and tagged `protocol-freeze-v1`.
6. Repo clean; the pre-key benchmark reruns deterministically (two
   consecutive keyless runs produce identical outcome / outcomeClass /
   accuracy vectors; durations may differ).

## 5. Smoke test (first keyed action — NOT benchmark evidence)

Four scenarios only, one trial each, before any campaign sweep:

| Scenario | Configuration | Verifies |
|---|---|---|
| clean-extraction | D full semantic | model genuinely called; token accounting populates; output flows through the shared validator |
| class-drift | D full semantic | semantic addressing on drifted markup |
| schema-violation | D full semantic | whether an LLM extractor also refuses corrupt data (class safe-failure) or "fixes" it silently (class silent-corruption) — calibrates the grader under LLM conditions |
| class-drift | C hybrid repair | repair activates, heals the cache, `healedSteps` + tokens recorded |

Acceptance: costs roughly within expectations (order: cents). Smoke
artifacts are labeled smoke and **excluded from published results**; smoke
outcomes are never cited as evidence regardless of what they show.

## 6. Campaign (in order, all local Chrome)

**Trial isolation (enforced by construction):** every benchmark run owns a
**private lab on its own ephemeral port** — runners never reuse an unowned
lab, so concurrent or interrupted runs cannot touch this run's scenario
state (`--lab-url` transfers ownership to the caller, with a warning). Every
trial browser launches with `--disable-http-cache`, so a page can never be
served from a previous trial's cache. Leftover Stagehand browsers from
other runs are logged as a warning-only forensic census at bench start.
(Both protections were added after the determinism gate caught real
cross-trial contamination — see WRITEUP.md, "What broke".)

**Metric definitions:** silent corruption is reported over three
denominators — D1 total trials; D2 judged failures (`outcome === "fail"`;
silent corruption is always a subset of D2); D3 accepted outputs (classes
pass + recovered + silent-corruption). For the committed keyless run these
are 48 / 10 / 36. `llmCalls` counts Stagehand inference operations; token
counts are provider-reported via Stagehand metrics, accumulated across ALL
attempts of a trial (a failed attempt's spend is never discarded). Dollar
costs are computed at analysis time from recorded tokens and a pinned price
table — never estimated fields in raw results. Class `recovered` requires a
recorded semantic repair (`healedSteps` nonempty); retry-only successes are
reported separately as `retryRecoveries`. Persistence runs use per-scenario
seed caches via `--seed-cache-manifest` (with provenance: source benchId,
healed steps, creation time), harvested from repair sweeps by
`pnpm heals:collect`; cross-run campaign reporting comes from
`pnpm campaign:aggregate` (raw counts, median, min–max — never reduced to
majority pass/fail). The keyless seed-cache test proves replay mechanics
only; that semantic repair produces *valid* caches is a keyed question
answered by campaign step 3.

1. **Five cold full-semantic sweeps** (D × 24 scenarios × 5).
2. **Five cold hybrid-repair sweeps** (C × 24 × 5, bootstrap cache each trial).
3. **Persistence runs:** for every scenario healed in step 2, re-run C in a
   fresh browser seeded from the saved `healed-cache.json` (`--seed-cache`).
   "Persistently repaired" = judged pass with `llmCalls === 0`.
4. **One warm-cache economics sweep** (C × 24, seeded from step 2's caches):
   steady-state cost and latency.
5. **Analysis and publication** (§7). Browserbase is added **afterward, as a
   hosted demonstration only** — never a requirement for the core benchmark,
   so model behavior stays the only new paid variable in steps 1–4.

## 7. Metrics and statistics discipline

Reported per configuration, and per scenario where meaningful:

- Judged pass rate; outcome-class counts.
- **Silent corruption with three denominators**: /total trials, /failed
  trials, /accepted outputs (the headline: "of the data the pipeline vouched
  for, how much was wrong").
- Accuracy: mean and median (diagnostic; the judge itself is binary at 1.0).
- Latency: median and min–max range per scenario; percentiles only pooled
  across all trials of a configuration. **No per-scenario P95 at N=5.**
- Tokens (input/output) and dollars per trial and per sweep, from recorded
  usage — never from estimates.
- Recovery, split: `recovered` (within-run) vs **persistently repaired**
  (later-run pass at zero additional LLM calls, from §6.3).
- Variance: raw counts and ranges. No standard-deviation theater at N=5.
- The decision metric: **probability of undetected incorrect data per
  dollar** — silent-corruption rate over accepted outputs, against cost per
  successful workflow.

## 8. Amendments

None. (Any post-freeze change: add a dated entry here, bump the tag —
`protocol-freeze-v2` — and disclose it in the writeup.)
