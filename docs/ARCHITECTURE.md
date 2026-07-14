# Architecture

The system has four moving parts and one invariant that ties them together: **the three extraction engines are graded by identical, shared rules, and differ only in how they address elements on the page.** Everything below serves that comparison.

## Monorepo map

| Package | Responsibility | Key files |
| --- | --- | --- |
| `apps/lab` | The stateful flaky site + `/__lab` control API | `apps/lab/src/app.ts`, `apps/lab/src/state.ts`, `apps/lab/src/render.ts` |
| `apps/dashboard` | Renders `runs/latest` + agent runs; `pnpm report` emits a self-contained `report.html` | `apps/dashboard/src/` |
| `packages/shared` | Schemas, scenarios, chaos flags, seeded RNG, the fake-league generator, lab client, storage, logging | `packages/shared/src/` |
| `packages/agent` | The pipeline shell, the three engines, and the benchmark runner | `packages/agent/src/{core,stagehand,baseline,hybrid,reliability}` |
| `packages/model` | Poisson / EV model → value watchlist | `packages/model/src/watchlist.ts` |
| `scripts` | Thin CLIs behind the `pnpm` scripts | `scripts/{run-agent,run-benchmark,seed-lab}.ts` |

## Data flow

```
                          ┌─────────────────────────────────────────────┐
                          │  apps/lab  (seeded fake league + chaos)       │
                          │  /login  /consent  /stats  /odds              │
                          │  /__lab/*  (control API — agent never sees it)│
                          └───────────────┬───────────────┬──────────────┘
                                          │ pages          │ ground truth + chaos
                                          │ (HTML)         │ (HTTP, benchmark only)
                     ┌────────────────────▼─────────┐      │
   ENGINE (stagehand │  attempt: login → consent →   │      │
   | baseline        │  modal → reveal → extract     │      │
   | hybrid)         └────────────────────┬──────────┘      │
                                          │ statsRaw / oddsRaw (pre-validation)
        ┌─────────────────────────────────▼───────────────────────────────┐
        │  runPipeline shared post-processing (packages/agent/src/core)     │
        │  1. checkStatsSchema / checkOddsSchema  (extraction layer, zod)   │
        │  2. normalizeStats / normalizeOdds → buildDataset                 │
        │  3. assessDataset  (domain layer: semantic rules)                 │
        │  → PipelineResult { success, failureCategory, normalized, … }     │
        └───────────────┬──────────────────────────────┬───────────────────┘
                        │ normalized dataset            │ PipelineResult
        ┌───────────────▼───────────────┐   ┌───────────▼─────────────────────────┐
        │  packages/model                │   │  BENCHMARK (reliability/runner.ts)    │
        │  strengths → forecastMatch     │   │  per trial: configure lab, read       │
        │  → devig → EV → buildWatchlist │   │  ground truth, run engine, score      │
        │  → ranked value selections     │   │  accuracy, judge vs expected outcome  │
        └────────────────────────────────┘   │  → results.json / .md / failures.jsonl│
                                              └───────────────────────────────────────┘
```

An **agent run** (`scripts/run-agent.ts`) takes the left path: one engine, one config, produce a watchlist. A **benchmark run** (`scripts/run-benchmark.ts` → `runBenchmark`) takes the right path: sweep every scenario × engine × trial and score each against ground truth.

## Two-layer validation, and why

Extraction and semantics are split into two layers on purpose.

**Layer 1 — extraction schemas** (`packages/shared/src/schemas/extraction.ts`) are intentionally *shape-lenient*. A stats cell is `z.number().int().nullable()`; odds cells stay **raw strings** (`"1.85"`, `"+120"`, `"—"`). The schema validates only that the extractor *faithfully read what the page displayed*, including nonsense the page really shows — a negative "played", an unparseable odds cell. Extractors record; they do not judge.

**Layer 2 — domain assessment** (`assessDataset`, `packages/shared/src/quality.ts`) owns every semantic rule: `wins + draws + losses == played`, plausibility caps (played ≤ 60, goals ≤ 250), and a "more than 30% of odds cells unusable ⇒ odds untrustworthy" rule. Its output separates hard **failures** from soft **warnings**.

Why the split? Because if you let an LLM "clean up" data mid-extraction, a corrupt page gets silently repaired and you never know your source was broken. Here a corrupt page produces a **deterministic validation failure that our own code raises** — which is exactly what the `schema-violation` scenario asserts. The extractor stays honest; the domain layer stays in charge of trust.

The canonical shapes both layers converge on are in `packages/shared/src/schemas/domain.ts` (`GroundTruth`, `NormalizedDataset`), and the lenient→canonical adapters live in `packages/agent/src/core/normalize.ts`.

## Engine contract

All three engines implement one interface (`packages/agent/src/core/types.ts`):

```ts
interface Engine { readonly name: EngineName; run(options: PipelineOptions): Promise<PipelineResult>; }
```

- **`PipelineOptions`** carries the lab URL, which pages to visit, credentials, session setup (`fresh` | `reuse` | `expired`), the run directory, a logger, `maxAttempts`, timeouts, and `env` (`local` | `browserbase`). Notably it does **not** carry any chaos flags — see scenario-blindness below.
- **`AttemptOutcome`** is what one attempt returns: the `StepResult[]`, `statsRaw` / `oddsRaw` (**before** schema validation), screenshots, and token usage.
- **`AttemptFailure`** is what an attempt throws when it dies mid-flight; it carries a `FailureCategory`, the failing step name, and the steps/screenshots gathered so far.

**Canonical steps** (each engine walks the same order, data-driven): `init-browser → load-session (reuse/expired) → goto-stats → consent → login → consent → dismiss-modal → reveal-table → extract-stats → goto-odds → (relogin) → extract-odds → save-session`. Consent is checked on *both* sides of login because the lab (like real sites) only raises its consent wall *after* authentication — but a reused session can hit it before. Step order is driven by what the page actually shows, not by a fixed assumption.

**Shared readiness gate.** Both browser-driven engines (Stagehand and hybrid) gate extraction on the *same* structural, class-free poll, `waitForContent` in `packages/agent/src/core/domReady.ts`: content is "ready" when a visible table has enough body rows, or when enough card-like blocks are present. It was extracted verbatim from the Stagehand engine so the two share one readiness definition, and it is what lets the hybrid fail *fast* (it distinguishes genuinely-hidden content, behind a tab, from slow content by timing out) rather than burning wait budgets.

**Retry semantics** live entirely in the shared shell `runPipeline` (`packages/agent/src/core/runPipeline.ts`). It loops up to `maxAttempts` (default 2 = one recovery retry). A retry happens **only** for operational failures — an attempt that *threw* an `AttemptFailure` (navigation, timeout, blocked UI, auth, not-found). It runs the attempt, and only then, once, runs the shared post-processing (schema → normalize → domain). **Validation failures never retry**: bad data is a deterministic property of the page, so re-running the same attempt would produce the same bad data. `recoveredAfterFailure` is set when a run succeeds on attempt > 1, which feeds the recovery metric.

An attempt may also return **`healedSteps`** — the names of steps the hybrid repaired via an LLM `observe`/`extract` this attempt (empty for the deterministic engines). `runPipeline` threads the successful attempt's `healedSteps` onto the `PipelineResult`, the trial records it, and `metrics.ts` rolls it up into a per-engine **`healedTrials`** count (trials in which at least one step healed). Keyless, that count stays 0 — the honest signature of a run that never called a model.

Because post-processing is shared, a `success` requires `extractOk && domainOk`; a failed run is categorised `extraction` when the schema check failed and `validation` when the schema passed but `assessDataset` raised failures. All three engines are graded by *this* code, not their own.

## Scenario-blindness

Engines never see the chaos configuration and never touch the control API. Only the benchmark harness (`packages/agent/src/reliability/runner.ts`) calls `/__lab/config` to set chaos and `/__lab/ground-truth` to read the truth, and it does so over plain HTTP — cheap, out-of-band, invisible to the engine under test. An engine gets the same `PipelineOptions` whether or not chaos is active; it has to *discover* the page state the way a real agent would. This is what makes the comparison fair: neither engine can special-case a scenario.

## Accuracy scoring (override-aware)

`packages/agent/src/core/score.ts` grades a normalized dataset against ground truth. Each report is `score = rowCoverage × fieldAccuracy`, and `overall` is the mean of the stats and odds scores. Two subtleties make it fair under chaos:

- **`partial` cells** (a `partialData` em-dash) are scored *correct when the extractor reports them as `null`* — degrading gracefully is the right answer, not a miss.
- **`corrupt` cells** (a `corruptData` bad value) are **excluded from accuracy entirely**; for odds, the whole 1X2 trio or totals pair containing a corrupt cell is skipped, because normalization drops incomplete groups by design and grading the survivors would punish correct behaviour. The `schema-violation` scenario is judged on *validation behaviour*, not accuracy.

The lab's per-seed `DisplayOverride[]` (`packages/shared/src/seed/generate.ts`, `computeDisplayOverrides`) is what tells the scorer which cells are `partial` vs `corrupt`.

## Seeded determinism

Everything reproducible flows from one seed. `packages/shared/src/rng.ts` provides an **xmur3** string hash and a **mulberry32** PRNG, plus seeded `rngInt` / `rngFloat` / `rngShuffle` / `poissonSample` helpers. There is **no `Math.random` anywhere in the workspace** — the lab's latency jitter, its class-name suffixes, its column permutation, the fake season, and every chaos decision all derive from `createRng(hashSeed(...))`. The same seed produces byte-identical pages and byte-identical benchmark inputs, which is what makes both the demo and the numbers reproducible.

The fake league (`generateGroundTruth`) is a genuine simulation, not hand-tuned data: 12 fictional teams in the "Northern Premier Division", a full double round-robin (each team plays 22 matches) simulated by Poisson score draws from each team's true attack/defence rates, then upcoming-fixture odds derived from those *true* rates with ±6% seeded noise and a 5% / 4.5% overround. That construction is what lets the model find real "value" (the noise makes some lines generous) *and* lets the scorer check extraction against exact truth.

## Storage layout

No database — everything is JSON/JSONL on disk under `runs/`, with secrets redacted from every log line (`SENSITIVE_ENV_KEYS`, `packages/shared/src/constants.ts`).

```
runs/
├── agent-<timestamp>/              one manual agent run
│   ├── manifest.json  result.json  normalized.json  watchlist.json  events.jsonl
│   ├── raw/           stats-attempt-N.json  odds-attempt-N.json  (pre-validation)
│   └── artifacts/     stats-aN.png  odds-aN.png  failure-aN.png
├── bench-<timestamp>/              one benchmark run
│   ├── manifest.json  results.json  results.md  failures.jsonl
│   └── trials/<scenario>-<engine>-t<n>/   events.jsonl  normalized.json  raw/  artifacts/
└── latest/                         mirror of the newest benchmark (what the dashboard reads)
```

## How the three engines differ (the isolated variable)

All three engines share `runPipeline`, the canonical step order, retry semantics, and scoring. The *only* difference is element addressing.

**Baseline** (`packages/agent/src/baseline/engine.ts`, hooks in `packages/agent/src/baseline/mapping.ts`) is a period-accurate, pre-LLM selector scraper. It is genuinely competent — it waits, retries, reuses sessions, paginates (with a JSON-island fallback), opens tabs, clears consent/modal overlays, and recovers from a mid-flow re-login. But it addresses the page **only** through hardcoded ids (`#login-form`, `#standings`, `#odds-table`, `#next-page`, …) and **fixed `<td>` column indices** read from the default column order — it never reads a header to map a column and never falls back to a structural heuristic. `mapping.ts` documents this as an explicit "brittleness contract". That single assumption is its one intentional weakness, so the comparison measures exactly it: `classDrift` kills the ids, `columnShuffle` makes the fixed indices read the wrong fields (caught downstream by domain validation), `layoutVariant` removes the `<table>` entirely.

**Stagehand** (`packages/agent/src/stagehand/engine.ts`) addresses the same pages semantically. Its extraction instructions are **header-name / label driven** ("map columns BY THEIR HEADER NAMES: P/Played → played, W → wins…"), so they survive class drift, column shuffle, copy drift, and layout changes with no DOM coupling. Structural helpers (the shared class-free `waitForContent`) handle delayed render and layout variants; deterministic fallbacks exist *only* for mechanical blockers (submit the consent form, click a dismiss button in a fixed overlay) where semantics add nothing.

**Hybrid** (`packages/agent/src/hybrid/engine.ts`) is the middle path: **the baseline's hand-written selectors become a cache, and the LLM is the repair crew.** It starts from the *same* id inventory as the baseline (`#username`/`#password`, `#login-submit`, `#accept-cookies`, `#modal-close`, `#tab-table`, `#next-page`), so the two begin from identical selector assumptions and only the failure-recovery strategy differs. What changes is (a) actions are *replayed*, not re-derived — a cache of Stagehand `Action` objects run through `act(action)` with `selfHeal: false`, zero LLM; (b) extraction is **structure-aware**, mapping table columns by their *header name* through a fixed synonym dictionary rather than by fixed `<td>` index — which is exactly why the hybrid clears `column-shuffle` and `site-v2` where the baseline silently misreads; and (c) when a cached selector or the table shape it assumes stops matching, an explicit key-gated repair path can re-discover it. Where the page abandons the `<table>` shape entirely (a card grid), the header-mapped reader finds no mappable table — an honest boundary it reports, healed only when a key is present. See the next section for the full anatomy.

## The hybrid engine, in detail

The hybrid runs on **one** Stagehand v3.6 stack (`env: LOCAL`, `disableAPI`, `disablePino`, `verbose: 0`, `selfHeal: false`), and a `model` is set on the Stagehand options *only* when a provider key is present. It never auto-skips — it is designed to run keyless. Its anatomy is four tiers:

- **The bootstrap cache** (`hybrid/bootstrap.ts`). `bootstrapActions()` returns the "existing selectors a production team would already have," expressed as Stagehand `Action` objects keyed by step: `consent`, `username`, `password`, `login-submit`, `dismiss-modal`, `reveal-table`, `next-page`. Same id inventory as the baseline. Credentials are **never** written here — the username/password fills carry `%username%` / `%password%` placeholders substituted at `act()` time via Stagehand `variables`, so no secret ever reaches a cache file, log, or artifact. A per-trial `SelectorCache` (`hybrid/cache.ts`) wraps a fresh clone of this bootstrap so trials stay independent.
- **Deterministic replay.** Every `act()` in the engine replays a cached `Action` through `stagehand.act(action)`; `observe`/`extract` are the only model-driven calls. `selfHeal: false` is **mandatory** — `act(Action)`'s built-in fallback would otherwise silently invoke the LLM on a selector miss, which is exactly the hidden inference the deterministic tier must forbid. Keyless, `llmCalls` is therefore provably 0.
- **The key-gated repair path.** `cachedActOrRepair` is the *only* place a step heals. It replays the cached action; on failure, **with a key** it runs `observe(<natural-language instruction>)` to re-discover the element, acts on the candidate, and calls `cache.heal(...)` (recording the step in `healedSteps`); **without a key** it throws a categorised `PipelineStepError` carrying the fixed substring `cached selector failed; semantic repair unavailable (no model key)`. Extraction has its own repair, `extractRepair`, which — when the header-mapped reader finds no table — reuses the Stagehand engine's **identical** `STATS_INSTRUCTION` / `ODDS_INSTRUCTION`, or (keyless) throws `no header-mappable table found; semantic extraction unavailable (no model key)`. These fixed substrings are the honest keyless boundary the benchmark surfaces verbatim.
- **Header-name extraction** (`hybrid/synonyms.ts`, `hybrid/extract.ts`). `readVisibleTables` reduces every visible `<table>` to `{ headers, rows }` of displayed text; `mapStatsHeaders` / `mapOddsHeaders` map each header to a field through `STAT_SYNONYMS` / `ODDS_SYNONYMS` — a **fixed general football vocabulary chosen before looking at any lab copy variant**, matched case-insensitively and exact-token (a single-letter synonym matches only a single-letter header, so `P` maps `played` but `Pts` never does). Unrecognised headers (`#`, `GD`) are simply omitted, so extra columns never corrupt a row, and the first column to claim a field wins. `selectStatsTable` accepts the first table whose headers name ≥ 4 stats fields; `selectOddsTable` wants a match column plus ≥ 3 odds-value columns. A header the dictionary doesn't cover is an honest coverage gap to report, never a reason to widen the dictionary.

At the end of a run the healed cache is persisted to the run dir (`cache.persist`, placeholders intact). Everything after `statsRaw` / `oddsRaw` — `runPipeline`, `normalize`, the two validation layers, the scorer — is the **shared** code, so the hybrid is graded by the same judge as the other two. The comparison isolates addressing strategy and nothing else.

## Scenario groups and the survival preset

Every scenario now carries a **`group`** field (`packages/shared/src/schemas/benchmark.ts`, `ScenarioGroupSchema`, defaulting to `"core"` so the original 17 specs need no edit): `core` = one isolated failure mode; `compound` = several obstacles co-occurring in one run; `survival` = one site frozen at accumulating versions of drift. The runner and the report/markdown section the matrix by group.

The **survival preset** is the sharpest test: `site-v1` (launch, no chaos), `site-v2` (content refresh: `copyDrift + columnShuffle`), `site-v3` (redesign: `copyDrift + classDrift + layoutVariant`). Engines are graded exactly as written for v1 — no engine ever sees which version it is running — so an engine that fails v2 or v3 marks the point where its addressing strategy met a change it couldn't absorb. **`site-v3` deliberately omits `columnShuffle`**: probing proved `layoutVariant`'s card grid renders with a fixed field order that suppresses both `columnShuffle` and `pagination`, so adding the flag would leave an inert marker rather than an active obstacle — an honest scenario states only the chaos that actually bites.

Results are recorded in **record-form**: `ScenarioComparisonSchema` holds `results: z.record(EngineName, "pass" | "fail" | "skipped")` — one verdict per *requested* engine, not a hardcoded pair — which is what lets the matrix grow from a two-engine comparison to a three-engine one without a schema change, and lets an engine that never ran (Stagehand, keyless) appear as `skipped` rather than a fabricated fail. `metrics.ts` rolls the per-trial `healedSteps` up into each engine summary's `healedTrials`, and `markdown.ts` derives the survival matrix (each engine × version, plus the last version it cleared) straight from these records.

## Stagehand v3 specifics actually used

This engine targets Stagehand v3 (installed 3.6.0), which moved the primitives onto the instance and dropped Playwright for its own CDP core. Concretely, in `packages/agent/src/stagehand/engine.ts`:

- **Top-level `act` / `extract` / `observe`** on the `Stagehand` instance — `stagehand.act("...")`, `stagehand.extract(instruction, ZodSchema, { timeout })`, `stagehand.observe("...")` — each wrapped so every model-driven call increments an LLM-call counter.
- **`variables` for credentials**: login is `act("type %username% into the username field", { variables: { username } })`, so the secret is never baked into the instruction string.
- **`observe` → `act` reveal**: when the stats table isn't visible, the engine `observe`s "the tab or control that reveals the full standings" and acts on the returned candidate, falling back to a direct `act` — this is the `reveal-table` step.
- **Context cookies for session state**: `stagehand.context.addCookies(...)` to restore a saved session (reuse/expired) and `stagehand.context.cookies(labUrl)` to persist one — the Browserbase equivalent of a persisted context.
- **Metrics for tokens**: `await stagehand.metrics` yields `totalPromptTokens` / `totalCompletionTokens`, surfaced as `TokensUsage`.
- **Options**: `disableAPI: true`, `disablePino: true`, `verbose: 0`; `env: "LOCAL"` with `localBrowserLaunchOptions` (installed Chrome) or `env: "BROWSERBASE"` with `apiKey` / `projectId` and, when `BROWSERBASE_CONTEXT_ID` is set, `browserbaseSessionCreateParams.browserSettings.context = { id, persist: true }` for cross-run auth reuse.

A missing model key is treated as a *setup* problem, not a benchmark result: `runStagehandEngine` gates on configuration before any browser starts and lets the friendly error propagate, which is why the benchmark reports Stagehand as `skipped` rather than failed.
