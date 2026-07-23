# Writeup: building a semantic-escalation benchmark, and measuring where it breaks

*(The project began life as "stateful-sports-data-agent"; the sports lab survives as the test domain.)*

## The problem

Sports stats and odds pages are close to a worst case for browser automation.
They sit behind logins, so an agent has to manage session state, not just
navigate. They render tables client-side, late, and behind tabs. They ship
cookie walls and newsletter modals. Their markup churns constantly — class
names are build hashes, columns get reordered, layouts A/B between tables and
card grids, and the copy changes under your feet. A scraper that works on
Monday fails silently on Thursday, and "silently" is the operative word: the
worst outcome is not a crash, it's confidently extracting the wrong numbers.

I wanted to build a browser agent for this environment and — more importantly —
to *measure* where it breaks, instead of asserting that it works.

## The approach

Three engines that perform the identical task (log in, clear whatever blocks
the content, reveal the data, extract standings and odds), differing in
exactly one variable — *how the page is addressed*:

1. **A deliberately old-school Playwright baseline**: hardcoded ids and fixed
   column indices, but real competence everywhere else — explicit waits,
   pagination click-through, mid-flow re-login, session reuse. This is how a
   very large share of production scrapers are actually written
   (see [EVIDENCE.md](./EVIDENCE.md) on how common positional and
   id-anchored selectors are).
2. **A hybrid self-healing engine** (new): the same hand-written selectors,
   but stored as a *cache* of Stagehand `Action` objects and replayed
   deterministically with `selfHeal: false` — zero LLM calls. Extraction maps
   table columns by **header name** through a fixed synonym dictionary, never
   by position. When a cached selector dies, an *explicit*, key-gated repair
   path calls `observe()` to re-discover the element, heals the cache, and
   continues. No key → repairs unavailable, and those failures are recorded
   honestly. This is the middle rung: deterministic where determinism is
   cheap, semantic only at the exact moment determinism fails.
3. **A full Stagehand pipeline**: instruction-driven `act`/`extract`/`observe`
   ("map columns by their header names"), credentials through act variables so
   they never appear in logs, Browserbase contexts for session persistence.
   Requires a model key; without one it reports itself *skipped* — nowhere in
   this project is a benchmark number invented.

All three share every line of post-processing (normalization, two-layer
validation, accuracy scoring against seeded ground truth), so differences in
results attribute to addressing strategy alone. A **reliability benchmark**
runs them across 24 scenarios — 17 single-variable "core" scenarios, 4
compound scenarios where obstacles co-occur, and a 3-version **survival test**
— and grades every trial against ground truth.

## Why the flaky lab exists

Benchmarking against live bookmakers is a non-starter: it's unreproducible
(odds move between runs), unmeasurable (no ground truth to score accuracy
against), fragile as a demo, and hostile to sites' terms. So the lab is a
local Express app that seeds a fictional 12-team league from a PRNG
(`mulberry32`, no `Math.random` anywhere in the workspace), simulates a full
double round-robin season with Poisson draws, prices odds off the *true*
rates with noise and a 5% overround, and then serves it all through 14
composable "chaos" modes: consent walls, delayed renders, class drift, column
shuffles, layout swaps, hidden tabs, pagination, stale sessions, corrupt
cells, American odds, network latency, copy drift.

Two properties matter. Every chaos behaviour is **seeded** (same seed → same
delay, same shuffled column order, same corrupted cells), so benchmark results
are reproducible. And the lab exposes its **ground truth** on a control API the
engines are forbidden to touch — the harness configures chaos and scores
accuracy; the engines only ever see `/login`, `/stats`, `/odds`.

## Why these failure modes are real

Each chaos mode is modeled on a documented real-world failure, and
[EVIDENCE.md](./EVIDENCE.md) carries 28 citations whose quotes were re-fetched
from the live sources and machine-verified. Three anchors:

- **Class drift** is not an edge case; it is how modern frontends ship.
  styled-components' own FAQ says its dynamic class "will be different for
  every element … based on what the interpolations result in"; webpack's
  css-loader replaces authored class names with base64 hashes by default.
  Every deploy is a potential selector wipe.
- **Column drift caused a real silent-data bug in this exact domain**: Baseball
  Savant inserted a `miss_distance` column mid-table, and the widely-used
  `baseballr` package's fix PR describes stopping the "silently mislabeling
  the columns that follow it." That is the column-shuffle scenario, verbatim,
  in production sports analytics.
- **Positional addressing is warned against by the tooling itself**:
  Playwright's docs caution that `.nth()`-style locators break as pages
  change — yet fixed indices remain the default habit.

## What broke (all of these really happened)

- **Auth and session state.** The stale-session mode invalidates the session
  after the first authenticated page view, exactly once. Every engine had to
  learn the same lesson real sites teach: *any* navigation can land on the
  login page, so "am I logged in?" is a per-step question, not a one-time gate.
- **My own lab shipped a real bug.** The pagination page's inline script
  interpolated `class="cell"` into a double-quoted JS string — a SyntaxError
  that killed the Next button, so only 5 of 12 rows ever reached the DOM. The
  *baseline's* verification caught it, because it asserted 12 extracted teams
  against ground truth. An extractor cannot tell "the page broke" from "the
  page has less data today" without ground truth; that finding alone justifies
  the lab.
- **The bundler sabotaged in-browser code — but only on the keyless path.**
  tsx/esbuild's `keepNames` wraps named inner functions with a `__name(...)`
  helper that doesn't exist inside `page.evaluate`, throwing a
  `ReferenceError` in the browser. The fix is mundane (anonymous arrows in
  in-page code); the lesson is not: code that ships into another runtime can
  be broken by your *toolchain*, not your logic, and only executing it there
  tells you.
- **Column shuffle produced the most instructive failure.** With columns
  permuted, the baseline read the goal-difference column (which contains
  negative numbers) as goals-for. The extraction "succeeded"; the numbers were
  garbage. It was caught only by the domain-validation layer (goals must be
  non-negative, W+D+L must equal games played). The survival test's v2 then
  reproduced the same failure class independently (negative "losses") —
  silent misreads are a *category*, not an incident.
- **Consent walls appear after login, not before.** My canonical step order
  assumed consent → login; the lab (like real geo-gated sites) shows the wall
  only once you're authenticated. The engines now check both sides of login.
- **Composability had a trap.** Before adding compound and survival scenarios,
  an empirical probe of flag combinations found that the card-grid layout
  variant silently *suppresses* column shuffling and pagination (fixed field
  order, no pager). A survival scenario carrying that inert flag would have
  been unwinnable-by-that-signal and unfalsifiable. Site-v3 therefore drops
  `columnShuffle` deliberately — benchmark design needs ground-truthing too.
- **Stagehand's own self-heal had to be turned off.** `act(action)` on a
  cached selector has a built-in fallback that silently invokes the LLM when
  the selector fails. For a product that's a feature; for a benchmark tier
  whose claim is "deterministic," it's contamination. The hybrid sets
  `selfHeal: false` and proves the claim: `llmCalls: 0` recorded on every
  keyless trial.
- **The determinism gate caught real silent corruption — in our own
  infrastructure.** Freezing the keyed protocol required two consecutive
  keyless runs to produce identical outcome vectors. They didn't: three
  hybrid trials flipped, and the failing run contained the outcome
  taxonomy's first genuine silent-corruption flags — trials that extracted
  *structurally valid* league tables at 12–13% accuracy. Fingerprinting the
  raw extractions showed each corrupted trial had extracted the data of
  **exactly three scenarios earlier**. The lab was never wrong; the trials
  were reading stale pages. The enabling condition was environmental debris:
  a zombie Chrome process tree and nine orphaned lab servers left behind by
  interrupted runs earlier in development. With the debris cleared, an
  8-sweep stress run (128 trials) reproduced zero contamination. The
  permanent fixes attack the root: every benchmark run now owns a **private
  lab on its own ephemeral port** (runners never reuse an unowned lab — a
  flaw an external audit also demonstrated live by contaminating an
  in-flight run through the shared default port), every trial browser
  launches with `--disable-http-cache` so a page can never be served from a
  previous trial's cache, leftover browsers are logged as a warning-only
  forensic census in each bench log, and the determinism gate stays as a
  trigger for every future freeze. The meta-lesson is the best one in this
  project: the
  taxonomy's first real silent-corruption catch was a true positive, fired
  before a single LLM call had ever been made — the instrument works.

## The two-layer validation design

The single most useful architectural decision: extraction schemas are
**shape-lenient** (an honestly-displayed `-3` is extracted as `-3`; a dash
becomes `null`), and a separate **domain layer** owns semantics (plausibility
caps, W+D+L consistency, "≥30% of odds cells unusable = untrustworthy").
LLM extractors are eager to "fix" nonsense silently; pinning honesty at the
extraction layer and judgment at the domain layer means a corrupt page fails
*my* validation deterministically — which is itself a graded scenario: the
correct behaviour for `schema-violation` is a clean, categorised validation
failure, and silently-plausible garbage is scored as FAIL.

## Quantitative results

Committed keyless run (`runs/latest`, 24 scenarios × 1 trial, local headless
Chromium, no model-provider key — the Stagehand column reports itself as
*skipped* rather than inventing numbers; the keyed campaign that measured
Stagehand and the hybrid's repair path is reported separately in
[PHASE1_RESULTS.md](./PHASE1_RESULTS.md)):

| Engine | Judged pass | Task success | Extraction | Validation | Mean accuracy | Mean duration | Recovery | LLM calls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline (positional) | 18/24 | 75.0% | 83.3% | 70.8% | 95.42% | 4.51s | 0/4 | n/a |
| hybrid — **deterministic tier** (cache + header names) | 20/24 | **83.3%** | 83.3% | 79.2% | **99.79%** | 4.12s | 0/4 | **0** |
| stagehand (semantic) | — | *skipped: no model key* | | | | | | |

To say it precisely: **the hybrid's deterministic tier passed 20/24 without
ever invoking semantic repair** — `llmCalls: 0` on every trial. Whether LLM
repair recovers the remaining four drift failures, and at what cost, was
prospectively frozen as a question in [PROTOCOL.md](./PROTOCOL.md)
(methodology tagged before any keyed result existed) and then answered by
the 2026-07-20 campaign: the repair path recovered all four in every cold
sweep, and the full cost accounting — 8.6× cheaper than full semantics per
success, on this frozen suite — is in
[PHASE1_RESULTS.md](./PHASE1_RESULTS.md). A pass now requires *perfect* extraction (accuracy 1.0 with
full row coverage — the earlier 0.75 threshold was retired after checking
that every genuine pass already sat at exactly 1.0), and every trial carries
an outcome class; the safety headline is that **silent corruption is
currently 0 across every denominator** (0/48 trials, 0/10 judged failures,
0/36 accepted outputs — the frozen D1/D2/D3 of PROTOCOL §6) — every failure
in the committed run was self-reported by the pipeline before grading.

The failure sets are the story:

- **baseline** fails class-drift, column-shuffle, layout-variant, site-v2,
  site-v3, compound-redesign-storm — every scenario where the markup changed
  shape, and nothing else. Two of those failures (column-shuffle, site-v2)
  are *silent misreads* caught only by domain validation.
- **hybrid** fails class-drift, layout-variant, site-v3,
  compound-redesign-storm — and passes column-shuffle and site-v2 outright,
  because header-name mapping is order-invariant by construction. Its two
  keyless failure modes are even legibly different: cached-selector death at
  the login form (`not_found` — "semantic repair unavailable") versus a clean
  extraction refusal on the card grid (`extraction` — "no header-mappable
  table found"). Where it fails, it fails fast and says why.
- **Survival curve** (one site drifting v1 → v2 → v3, engines frozen as
  written): baseline survives through **v1**, hybrid through **v2**, and the
  semantic tier's ability to survive **v3** is exactly the hypothesis a model
  key would test. First the site quietly corrupts a positional scraper's data
  (v2), then it kills it (v3).
- **Retries never healed drift**: 0/4 recovery across both engines.
  Deterministic breakage does not fix itself on retry; it needs either a
  human or a repair layer.
- One incidental but honest observation: the baseline burned 42.5s of wait
  budget dying on the layout variant; the hybrid's structure-aware readiness
  poll failed the same scenario in 4.2s. Even *failing* is cheaper with
  structural awareness.

The hybrid's per-scenario outcomes matched the prediction table written in
the design contract *before implementation*, 24/24. The predictions weren't
luck; they fall out of the addressing strategy — which is the point: an
engine's failure boundary should be a design property, not a surprise.

## Threats to validity

Naming these beats having them named for me:

1. **The baseline's author knew the catalog.** Its brittleness is
   representative (positional and id-anchored selectors are the documented
   default habit, see EVIDENCE.md), but it was written with the scenarios in
   view. The survival and compound groups blunt this — drift there is a
   uniform preset, not a per-engine trap — but they do not eliminate it.
2. **Aggregate rates are properties of the scenario mix, not the world.**
   With 10 drift scenarios instead of 6, the baseline scores far worse. The
   durable claim is categorical — *mechanical obstacles are waitable;
   structural drift is deterministic, unrecoverable-by-retry, and sometimes
   silent* — not any particular percentage.
3. **One trial per scenario, keyless.** Both keyless engines are
   deterministic, so variance is minimal by construction; LLM-path variance
   was measured in the keyed campaign at five sweeps per cold configuration
   — judged outcomes and call counts did not vary across sweeps on this
   suite, token counts and latency did
   ([PHASE1_RESULTS.md](./PHASE1_RESULTS.md)). N=5 bounds what that
   repetition can detect.
4. **The Stagehand column here is the keyless report, not the measurement.**
   Its measurement is the keyed campaign: 120/120 judged-correct across five
   sweeps at $0.0312 of model inference per success, with token cost
   recorded per trial ([PHASE1_RESULTS.md](./PHASE1_RESULTS.md)). This
   document's keyless table proves where selectors fail; the campaign
   measured what semantics cost.
5. **The lab is synthetic.** Its chaos modes are modeled on cited real-world
   failure modes, and seeding buys reproducibility that live sites can't
   offer — but a live, ToS-respecting adapter behind the same Engine
   interface is the natural next validation step.
6. **The hybrid's repair path is verified end-to-end, with a measured
   boundary.** Its deterministic tier is fully verified keyless (including
   `llmCalls: 0`, and a `--no-repair` freeze that guarantees zero model
   calls even with a key present); the observe-heal-replay loop ran in the
   keyed campaign defined in [PROTOCOL.md](./PROTOCOL.md) — five cold
   sweeps per keyed configuration, persistence runs from saved repairs, and
   one warm-cache economics sweep, methodology tagged before the first
   keyed trial. What it showed: action repairs are cached and replay for
   free; extraction repairs are re-inferred every run, so a persisted cache
   cut model calls 60% but cost only 19.7%
   ([PHASE1_RESULTS.md](./PHASE1_RESULTS.md)).

## Where Stagehand helped, and where it wasn't enough

**Helped:** semantic extraction instructions ("map columns by header names")
are shuffle-proof and drift-proof by construction; `observe` finds "the tab
that reveals the full table" without knowing its id; credentials-as-variables
keep secrets out of logs; Browserbase contexts make session reuse a config
field instead of a cookie-jar dance. The hybrid tier is *also* Stagehand —
`Action` objects are plain serializable data, which is what makes
selectors-as-cache work at all, and Stagehand's own docs recommend exactly
this observe-cache-replay pattern and mixing deterministic code with AI
actions (citations in EVIDENCE.md). Notably, the whole deterministic tier
runs on a keyless Stagehand instance: model configuration is optional, and
`act(action)`/`evaluate` execute without any inference.

**Not enough on its own:** Stagehand doesn't know when the page is *ready* —
I still needed a structural, class-free "content is present" poll before
extracting, or delayed renders produce confident extractions of skeletons. It
doesn't know when data is *wrong* — the domain-validation layer does that
job, keyed or keyless. Its built-in self-heal is the right product default
and the wrong measurement default (silent LLM fallback), so the hybrid closes
it and makes every repair explicit and counted. And every LLM call is latency
plus spend, so the engines count calls and tokens per run: reliability per
dollar is the real production metric, and the hybrid's whole design is an
argument that most steps of a stable flow should cost zero.

## Lessons learned

1. **Ground truth or it didn't happen.** Every claim in this project that
   survived did so because something executed against seeded truth: the lab
   bug, the column-shuffle misread, the keepNames browser crash, the
   inert-flag trap in the survival design.
2. **Validation is a feature with its own scenario.** "Fails correctly on
   corrupt data" is a graded behaviour, equal in rank to "extracts correctly."
3. **Predict before you run.** Writing the hybrid's expected per-scenario
   outcomes into the design contract before implementation turned the
   benchmark into an acceptance test of the *design* — 24/24 — and would have
   flagged any accidental overfitting to the lab as a deviation.
4. **Delegate-and-verify beats trust.** Parts of this codebase were built by
   sub-agents; acceptance by execution (run the tests, curl the endpoints,
   diff the scope against a checksum snapshot) was the only reliable signal —
   including for the benchmark's own evidence file, whose citations were
   machine re-verified against the live sources.
5. **Read the installed types, not your memory.** The v2→v3 Stagehand rewrite
   would have burned the whole engine budget; the same habit later surfaced
   `selfHeal`'s silent LLM fallback before it could contaminate the numbers.
6. **Honest benchmarks are more persuasive than good ones.** A baseline that
   passes 18/24, a hybrid that fails 4 scenarios *and says exactly why*, and
   an empty column labeled "skipped" make a stronger case than any strawman
   sweep.

## What I'd build next

Two items from the original version of this list have since been built and
run — the keyed campaign (Stagehand and the hybrid's repair path measured on
this exact catalog, five sweeps per cold configuration, cost per successful
workflow as a first-class metric) and the heal-once/replay measurement
(persistence runs from saved repairs, where the amortization argument met a
real boundary: cached action repairs replay free, extraction repairs are
re-inferred every run, so calls fell 60% but cost only 19.7%). Both are
reported with their evidence in [PHASE1_RESULTS.md](./PHASE1_RESULTS.md).
Still ahead:

- **A suite that can say no.** Every keyed policy passed every scenario, so
  this suite bounds nothing above the hybrid — a predeclared
  perturbation-intensity grid on held-out scenarios (Phase 2A) is the
  experiment that could locate where cache-plus-repair actually stops
  matching full semantics.
- **Live-site adapters** behind the same `Engine` contract (one real stats
  source, read-only, ToS-respecting), with the lab remaining the CI target.
- **CI regression gating**: fail a PR when task success, accuracy, or the
  survival curve regresses against the committed baseline results.
- **Dixon-Coles correction + calibration plots** for the model, so the
  quantitative layer earns the same rigor as the automation layer.
