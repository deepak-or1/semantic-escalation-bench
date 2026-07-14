# stateful-sports-data-agent

A browser-native sports-analytics agent, and a reliability harness that measures whether you can trust it.

The agent logs into a stateful, deliberately flaky local sports-stats site, extracts league standings and betting odds into zod-validated schemas, feeds them through a Poisson / expected-value model to produce a ranked "value" watchlist, and then **benchmarks three element-addressing strategies against each other across 24 failure scenarios** — a semantic Stagehand agent, a brittle Playwright selector baseline, and a new self-healing hybrid. It is built on [Stagehand](https://github.com/browserbase/stagehand) + [Browserbase](https://browserbase.com), runs read-only, and never places bets, automates wagering, bypasses paywalls, or defeats anti-bot protections. The flaky site it works against is local and synthetic — precisely so the demo is reproducible and doesn't depend on hammering a real site.

---

## Three engines, one pipeline

The primitive on display is **instruction-level browser automation**: Stagehand's `act` / `observe` / `extract` address a page *semantically* ("extract every team row, mapping columns by their header names") instead of by CSS selector. When a site drifts — renamed classes, reordered columns, reworded buttons, a different DOM shape — a selector script breaks, but a semantic instruction usually still holds. Browserbase adds the second half: **session and context persistence**, so authenticated state survives across runs instead of forcing a fresh login every time.

Those are claims, so the project makes them measurable. The benchmark runs the **exact same pipeline** three ways; the only thing that changes between engines is *how an element on the page is addressed*:

- **baseline** — a period-accurate Playwright selector scraper. Competent 2019-era craftsmanship: it waits, retries, paginates, opens tabs, clears overlays, re-logs-in, reuses sessions. But it addresses the page *only* through hardcoded ids (`#login-form`, `#standings`) and fixed `<td>` column indices; it never reads a header to find a column. That single assumption is its one intentional weakness — exactly the variable under test.
- **hybrid** *(new)* — **your existing selectors become a cache; the LLM is the repair crew.** The same hand-written selectors, stored as a cache of Stagehand `Action` objects and replayed with `selfHeal: false` (zero LLM), plus a reader that maps table columns by their **header name** through a fixed synonym dictionary — never by position, id, or class. When a cached selector or the table shape it assumes stops matching, an explicit, key-gated repair path (`observe` to re-find the element and heal the cache; `extract` when a page abandons the table shape) steps in. Keyless, the deterministic tier still runs and produces real numbers — the repair path is simply unavailable, and those failures are reported honestly rather than crashing.
- **stagehand** — full semantic automation: `act` / `extract` / `observe` driven by natural-language instructions, columns mapped by header name with no DOM coupling. Requires a model key; on a keyless machine it reports itself `skipped` and no numbers are fabricated for it.

Because everything downstream of addressing — the validation, the scoring, the judge — is shared, the comparison isolates that one variable and shows precisely where each strategy pays off (class drift, layout change, copy drift, column shuffle) and where nothing differentiates them (a cookie wall or a modal is a mechanical blocker every engine clears the same way).

## The flaky lab

`apps/lab` is a small Express site (`apps/lab/src/app.ts`) that serves a login, a consent wall, a standings page, and an odds board — all rendered from a **seeded, internally-consistent fake league** (`packages/shared/src/seed/generate.ts`). A private control API (`/__lab/*`, never touched by the agent) lets the benchmark reconfigure it per trial and read exact ground truth, which is what makes **extraction accuracy** measurable rather than guessed.

It ships 14 chaos flags (`packages/shared/src/chaos.ts`), each simulating one real way stat/odds pages break automation:

| Chaos flag | What it simulates |
| --- | --- |
| `cookieBanner` | A consent banner overlays the page and intercepts clicks until accepted. |
| `modal` | A newsletter modal appears ~800 ms after load and blocks the content until dismissed. |
| `delayedRender` | Tables render client-side behind a skeleton after a seeded 1.5–4 s delay. |
| `networkDelay` | Every HTTP response is delayed by a seeded 0.5–2.5 s latency. |
| `classDrift` | All CSS class names carry a seed-derived suffix; ids and `data-testid`s are removed. |
| `columnShuffle` | Stats-table columns are deterministically permuted. |
| `layoutVariant` | Stats render as a card grid instead of a table; odds switch to a stacked list. |
| `hiddenTab` | Season stats live behind a non-default tab that must be clicked first. |
| `pagination` | The stats table shows 5 rows per page; the rest require clicking Next. |
| `partialData` | A few cells render as em-dashes (missing values). |
| `copyDrift` | Headings, labels and button text are swapped for synonyms between runs. |
| `oddsFormatAmerican` | Odds display as American moneyline (`+120` / `-145`) instead of decimal. |
| `staleSession` | The session is invalidated server-side after the first authenticated page view, once. |
| `corruptData` | The page serves malformed values (negative played, inconsistent W/D/L, unparseable odds). |

Why a local lab instead of a real site? Three reasons: **stable demos** (the same seed produces the same page every time), **reproducible benchmarks** (chaos is toggled deterministically, not hoped for), and **no terms-of-service issues** (nothing real is scraped, logged into, or paywalled). Everything in this repo runs against `localhost`.

## Quickstart

**Prerequisites**

- **Node 20+**
- **pnpm 9** — via corepack (`corepack enable`) or a standalone install. This repo invokes it from the workspace root.
- **Google Chrome installed** — Stagehand's local mode launches your installed Chrome. The Playwright baseline and everything else use a bundled Chromium.

```bash
git clone <this-repo>
cd stateful-sports-data-agent
pnpm install
cp .env.example .env          # optional; sensible defaults, no keys required
```

**Run the lab** (seeded flaky site on `http://localhost:4517`):

```bash
pnpm dev:lab
```

**Run the agent — keyless engines (baseline or hybrid, ZERO keys):**

```bash
pnpm agent:local -- --engine baseline   # Playwright selector scraper
pnpm agent:local -- --engine hybrid     # cached selectors + deterministic header-mapped reader
```

Either logs in, extracts standings + odds, scores them against ground truth, and prints a ranked value watchlist. No API key, no cloud, no cost.

**Run the agent — Stagehand engine (needs a model key):**

```bash
# set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env first
pnpm agent:local                                  # Stagehand (the default engine), local Chrome
pnpm agent:local -- --scenario class-drift        # apply a benchmark scenario's lab setup
pnpm agent:local -- --seed 7 --chaos modal,copyDrift --headed
```

**Run on Browserbase** (needs `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`; set `BROWSERBASE_CONTEXT_ID` to persist auth across runs):

```bash
pnpm agent:browserbase
```

**Run the reliability benchmark** (all 24 scenarios across all three engines; Stagehand is auto-skipped when no key is present):

```bash
pnpm bench                                        # 24 scenarios × 3 engines × 1 trial
pnpm bench -- --engines baseline,hybrid           # explicit engine subset (both keyless)
pnpm bench -- --scenarios clean-extraction,class-drift --headed
```

**Generate the report and open the dashboard:**

```bash
pnpm report          # writes runs/latest/report.html (self-contained)
pnpm dev:dashboard   # live dashboard on http://localhost:4618
pnpm dev             # lab + dashboard together
```

**Inspect the generated data without a browser at all:**

```bash
pnpm seed -- --preview                 # print the seeded league + odds to stdout
pnpm seed -- --seed 1108 --chaos classDrift   # push a config to a running lab
```

**Tests and checks:**

```bash
pnpm test              # all tests
pnpm test:unit         # unit tests only (no browser)
pnpm test:integration  # integration (boots the lab; Stagehand-live test auto-skips without a key)
pnpm typecheck
pnpm lint
```

## Reliability benchmark

The scenario catalog lives in `packages/shared/src/scenarios.ts` — **24 scenarios in three groups: 17 core + 4 compound + 3 survival.** Each fixes a seed and a set of chaos flags and declares what *correct* behaviour is.

**Core (17)** — one isolated failure mode each:

| Scenario | Simulates | Expected |
| --- | --- | --- |
| `clean-extraction` | No chaos — fresh login and extract | success |
| `session-reuse` | Valid saved session; reach data without logging in | success |
| `expired-session` | Server force-expires the session; must re-login | success |
| `cookie-banner` | Consent overlay intercepts clicks | success |
| `modal-overlay` | Newsletter modal blocks content | success |
| `delayed-render` | Tables appear behind a skeleton after 1.5–4 s | success |
| `network-slowdown` | 0.5–2.5 s latency on every response | success |
| `class-drift` | Class names suffixed; ids/testids removed | success |
| `column-shuffle` | Stats columns permuted | success |
| `layout-variant` | Card grid / stacked list instead of tables | success |
| `hidden-tab` | Stats behind a non-default tab | success |
| `pagination` | 5 rows per page, click Next for the rest | success |
| `partial-data` | Some cells are em-dashes | success-with-warnings |
| `copy-drift` | Headings/labels/buttons reworded | success |
| `odds-format-american` | Moneyline odds must be normalised to decimal | success |
| `stale-session` | Session dies mid-flow; must recover | success |
| `schema-violation` | Corrupt values served | validation-failure |

**Compound (4)** — several obstacles co-occur in one run (the realistic Tuesday, where a redesign, a dead session, and slow responses all land together), checking the pipeline holds when failure modes stack rather than arrive one at a time:

| Scenario | Simulates | Expected |
| --- | --- | --- |
| `compound-blocked-and-slow` | cookieBanner + modal + delayedRender + networkDelay | success |
| `compound-session-churn` | staleSession + pagination + oddsFormatAmerican | success |
| `compound-messy-data-day` | partialData + networkDelay + modal | success-with-warnings |
| `compound-redesign-storm` | classDrift + copyDrift + layoutVariant | success |

**Survival (3)** — the *same site* drifting across versions while every engine stays frozen as first written, so where an engine stops is a survival curve, not a judging special case. Every version still *expects* success; an engine that fails v2 or v3 is the finding:

| Scenario | Simulates | Expected |
| --- | --- | --- |
| `site-v1` | Launch: stable ids, one standings table, decimal odds | success |
| `site-v2` | Content refresh: copy reworded, columns reordered (copyDrift + columnShuffle) | success |
| `site-v3` | Redesign: hashed classes, ids gone, table → card grid (copyDrift + classDrift + layoutVariant) | success |

`site-v3` deliberately omits `columnShuffle`: probing showed `layoutVariant`'s card grid has a fixed field order that suppresses column shuffling and pagination, so the flag would be inert.

**Judge rules** (`packages/agent/src/reliability/runner.ts`), shared by all three engines. A `success` scenario passes only if the pipeline succeeds *and* extraction is **perfect** — overall accuracy against ground truth is **1.0 with full row coverage** on both pages (every graded cell correct within the 0.02 odds tolerance). A successful pipeline that scores below 1.0, *or that produced no accuracy sample at all*, is a FAIL: its extraction can't be shown to be right (and, for `session-reuse`, no login step may have run). `success-with-warnings` additionally requires at least one domain warning; `validation-failure` passes only when the pipeline fails with failure category exactly `validation`. Silent garbage extraction is a FAIL even when the pipeline "succeeds".

**Metrics collected** per engine (`packages/agent/src/reliability/metrics.ts`): task-success rate, extraction / validation success rates, mean accuracy, mean duration, retries, recovery rate (of first-attempt failures, how many recovered), failures by category, token usage, and — for the hybrid — `healedTrials`, the count of trials in which the LLM repair path fired at least once.

**Where results land:** each run writes to `runs/<benchId>/` and is mirrored to `runs/latest/` — `results.json`, `results.md`, `failures.jsonl`, and (after `pnpm report`) `report.html`. Per-trial artifacts (events log, raw extraction, normalized dataset, screenshots) live under `runs/<benchId>/trials/<scenario>-<engine>-t<n>/`.

**Current keyless numbers** (from `runs/latest/results.md`, 1 trial/scenario, local headless Chromium, no model key, Node 20, Stagehand 3.6.0):

| Engine | Judged pass | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery | LLM calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | skipped | — | — | — | — | — | — | — | — |
| baseline | 18/24 | 75.0% | 83.3% | 70.8% | 95.42% | 4.51s | 4 | 0/4 | n/a |
| hybrid (deterministic tier) | 20/24 | 83.3% | 83.3% | 79.2% | 99.79% | 4.12s | 4 | 0/4 | 0 |

The **baseline** passes 18/24 and fails exactly where a static scraper is expected to: `class-drift` (its `#login-form` hook matches nothing, so it dies at login → `not_found`), `layout-variant` (no `<table>` for `#standings` → `not_found`), `column-shuffle` (fixed column indices silently read the wrong fields, caught by domain validation → `validation`), plus the survival/compound scenarios that reprise those breaks (`site-v2`, `site-v3`, `compound-redesign-storm`). `schema-violation` counts as a **pass** because failing cleanly on corrupt data is the correct behaviour there.

The **hybrid's deterministic tier passed 20/24 without invoking semantic repair** — clearing the two cases the baseline can't: **`column-shuffle` and `site-v2`**, where header-name mapping reads the right columns at 99.79% accuracy while the baseline silently misreads shuffled columns. Where the DOM itself changes shape — `class-drift` strips the login ids, `layout-variant` / `site-v3` / `compound-redesign-storm` replace the table with a card grid — the hybrid's cached selectors and header-mapped reader also stop, and keyless its repair path can't intervene: those are honest `not_found` / `extraction` failures, labelled *"cached selector failed; semantic repair unavailable (no model key)"*. Keyed experiments will measure whether LLM repair recovers those remaining drift failures, and at what token and dollar cost — the methodology is frozen in advance (see [Keyed experiment protocol](#keyed-experiment-protocol) below). The hybrid recorded **`llmCalls = 0` on every trial** — `selfHeal: false` closes Stagehand's built-in silent LLM fallback, so the deterministic tier is provably deterministic. Retry never healed a drift failure (0/4 recovery on both engines: deterministic breakage reproduces on the next attempt). The baseline burned 42.5s on `layout-variant` exhausting wait budgets before dying; the hybrid failed fast (4.2s) because its readiness poll is structure-aware.

**Survival curve:** the baseline survives through **v1**; the hybrid's deterministic tier through **v2**; Stagehand was not run.

The Stagehand row is `skipped` because this build environment has no model provider key. The harness reports it skipped and **never fabricates trial data** (`packages/agent/src/reliability/runner.ts`); those columns populate the moment `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set — and with a key the hybrid also gains its repair path (expect `llmCalls > 0` only on the trials that actually repair). Numbers in this README are copied from `runs/latest`, never invented.

**Outcome taxonomy** — behaviour classification, orthogonal to pass/fail. A `schema-violation` refusal is judged PASS yet classed a *safe-failure*; **silent-corruption** (success claimed on wrong or unverifiable data) is the headline safety metric:

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 0 | 0 | 0 | 0 | 0 | — |
| baseline | 17 | 0 | 3 | 0 | 4 | 0.0% |
| hybrid (deterministic tier) | 19 | 0 | 2 | 0 | 3 | 0.0% |

Both keyless engines produced **zero silent corruption** on every denominator — **baseline** 0 (0/24 trials, 0/6 judged failures, 0/17 accepted outputs); **hybrid** 0 (0/24 trials, 0/4 judged failures, 0/19 accepted outputs). Nothing was ever accepted as valid that wasn't correct: every break is either a clean refusal (*safe-failure*) or visible breakage (*hard-failure*), never quietly-wrong data.

**Frozen configurations.** Two flags pin reproducible engine policies:

- `--no-repair` freezes the hybrid's **structural-deterministic** tier — it never invokes `observe` / `extract` even when a model key is present, so it is guaranteed to make **zero model calls** (tested: a key-present drift trial still records `llmCalls = 0` and fails with a distinct *"repair disabled (--no-repair)"* detail).
- `--seed-cache <path>` warm-starts the hybrid from a persisted `healed-cache.json`, so a repair discovered in an earlier keyed run replays deterministically in a later one — the basis of the **persistence runs** (tested: a `class-drift` trial passes keyless from a seeded healed cache with `llmCalls = 0`, proving replay-of-repair needs no model).

### Keyed experiment protocol

The keyless results above are committed; the methodology for the *keyed* runs — exact model, prompts, retry and cache policy, scenario seeds, repetitions, and the reliability / silent-corruption / latency / cost comparison — is **prospectively frozen** (decided before any keyed result is observed) in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## The model

`packages/model` turns a validated dataset into a value watchlist (`buildWatchlist`, `packages/model/src/watchlist.ts`). It estimates each team's attack/defence strength against the observed league average, forecasts every upcoming fixture as an **independent-Poisson score matrix** (home/away goals as independent Poisson draws, home-advantage and away multipliers, a light recent-form adjustment), de-vigs the bookmaker's implied probabilities per market group, and surfaces selections where the model's probability beats the no-vig line by more than a 2% edge, ranked by expected value per unit.

Every watchlist carries its own limitations inline: goals are modelled as independent Poisson draws (no Dixon-Coles low-score correction), scoring rates come from a single partial season and carry sampling noise, home advantage is a constant multiplier, form is a crude 3/1/0-points heuristic, and bookmaker margin means small modelled edges are usually noise. **This is a read-only analytics demo — not betting advice.** See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full accounting.

## Screenshots

> The images below are not committed. Produce them once locally and drop them in `docs/img/`.

```bash
pnpm bench                    # populate runs/latest with a fresh benchmark
pnpm agent:local -- --engine baseline   # produce an agent run + watchlist
pnpm report                   # writes runs/latest/report.html
pnpm dev:dashboard            # or serve the live dashboard on :4618
```

Then capture:

- The dashboard scenario matrix (Stagehand vs baseline vs hybrid) and the Survival curve panel at `http://localhost:4618`, or open `runs/latest/report.html`.

  ![Reliability benchmark: scenario matrix](docs/img/dashboard-matrix.png)

- A single failure's detail view (its screenshot + `events.jsonl` timeline).

  ![Failure detail with screenshot and event log](docs/img/failure-detail.png)

- The agent run's value watchlist.

  ![Ranked value watchlist](docs/img/watchlist.png)

## Safety & compliance

This is **read-only sports analytics and reliability evaluation**. It never places bets, automates wagering, bypasses paywalls, or attempts to defeat anti-bot protections. All data is synthetic and generated locally; the value model is a modelling demo and explicitly **not betting advice**. The shipped configuration points only at the local lab. If you ever repoint an adapter at a real source, that is on you to do lawfully — respect the site's terms of service, robots policy, and rate limits.

## Repo structure

```
stateful-sports-data-agent/
├── apps/
│   ├── lab/            Express flaky-site: seeded league, chaos flags, /__lab control API
│   └── dashboard/      Reliability dashboard (server on :4618) + report.html generator
├── packages/
│   ├── shared/         Schemas (extraction / domain), scenarios, chaos, seeded RNG,
│   │   └── src/          the fake-league generator, lab client, storage, logging
│   ├── agent/          Engines + pipeline
│   │   └── src/
│   │       ├── core/        engine-agnostic pipeline shell, normalize, scoring, session, domReady
│   │       ├── stagehand/   Stagehand engine (semantic act/observe/extract)
│   │       ├── baseline/    Playwright selector baseline (deliberately brittle)
│   │       ├── hybrid/      cached-selector engine: Action cache + header-mapped reader + key-gated repair
│   │       └── reliability/ benchmark runner, metrics, results markdown
│   └── model/          Poisson / EV model → value watchlist
├── scripts/            run-agent, run-benchmark, seed-lab (CLIs behind the pnpm scripts)
├── tests/integration/  lab+baseline and benchmark integration tests
├── runs/               per-run artifacts; runs/latest mirrors the newest benchmark
└── docs/               ARCHITECTURE, WRITEUP, DEMO_SCRIPT, LIMITATIONS
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system fits together and why.
- [docs/WRITEUP.md](docs/WRITEUP.md) — the build story: what broke and what it taught.
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — a 2–3 minute recorded-demo script.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — honest scope, caveats, and what production would need.
- [docs/EVIDENCE.md](docs/EVIDENCE.md) — the citation appendix: each lab chaos mode mapped to a documented real-world failure mode.
