# Reliability Benchmark

Created 2026-07-14T11:54:59.566Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 0 | — | — | — | — | — | 0 | — |
| baseline | 24 | 75.0% | 83.3% | 70.8% | 95.4% | 4.5s | 4 | 0.0% (0/4) |
| hybrid | 24 | 83.3% | 83.3% | 79.2% | 99.8% | 4.1s | 4 | 0.0% (0/4) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 0 | 0 | 0 | 0 | 0 | — |
| baseline | 17 | 0 | 3 | 0 | 4 | 0.0% |
| hybrid | 19 | 0 | 2 | 0 | 3 | 0.0% |

- **baseline** silent corruption: 0 (0/24 trials, 0/6 failures, 0/17 accepted outputs)
- **hybrid** silent corruption: 0 (0/24 trials, 0/4 failures, 0/19 accepted outputs)

## Scenario comparison

| Scenario | Stagehand | Baseline | Hybrid | Note |
| --- | :---: | :---: | :---: | --- |
| clean-extraction | SKIPPED | PASS | PASS |  |
| session-reuse | SKIPPED | PASS | PASS |  |
| expired-session | SKIPPED | PASS | PASS |  |
| cookie-banner | SKIPPED | PASS | PASS |  |
| modal-overlay | SKIPPED | PASS | PASS |  |
| delayed-render | SKIPPED | PASS | PASS |  |
| network-slowdown | SKIPPED | PASS | PASS |  |
| class-drift | SKIPPED | FAIL | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing \| hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key) |
| column-shuffle | SKIPPED | FAIL | PASS | baseline: expected success but pipeline failed [validation] Farrow Wanderers: goalsFor Number must be greater than or equal to 0 \| Eastvale Athletic: goalsFor Number must be greater than or equal to 0 \| Bexley Town: goalsFor Number must be greater than or equal to 0 \| Harwick Albion: goalsFor Number must be greater than or equal to 0 \| Ironbridge FC: goalsFor Number must be greater than or equal to 0 |
| layout-variant | SKIPPED | FAIL | FAIL | baseline: expected success but pipeline failed [not_found] standings table not found — selector #standings matched nothing or stayed empty \| hybrid: expected success but pipeline failed [extraction] no header-mappable table found; semantic extraction unavailable (no model key) |
| hidden-tab | SKIPPED | PASS | PASS |  |
| pagination | SKIPPED | PASS | PASS |  |
| partial-data | SKIPPED | PASS | PASS |  |
| copy-drift | SKIPPED | PASS | PASS |  |
| odds-format-american | SKIPPED | PASS | PASS |  |
| stale-session | SKIPPED | PASS | PASS |  |
| schema-violation | SKIPPED | PASS | PASS |  |

### Compound scenarios — obstacles co-occur

| Scenario | Stagehand | Baseline | Hybrid | Note |
| --- | :---: | :---: | :---: | --- |
| compound-blocked-and-slow | SKIPPED | PASS | PASS |  |
| compound-session-churn | SKIPPED | PASS | PASS |  |
| compound-messy-data-day | SKIPPED | PASS | PASS |  |
| compound-redesign-storm | SKIPPED | FAIL | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing \| hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key) |

## Survival — frozen engines vs accumulating site drift

| Scenario | Stagehand | Baseline | Hybrid | Note |
| --- | :---: | :---: | :---: | --- |
| site-v1 | SKIPPED | PASS | PASS |  |
| site-v2 | SKIPPED | FAIL | PASS | baseline: expected success but pipeline failed [validation] Harwick Albion: losses Number must be greater than or equal to 0 \| Lowton Harriers: losses Number must be greater than or equal to 0 \| Dunmore City: losses Number must be greater than or equal to 0 \| Eastvale Athletic: losses Number must be greater than or equal to 0 \| Ironbridge FC: losses Number must be greater than or equal to 0 |
| site-v3 | SKIPPED | FAIL | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing \| hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key) |

| Engine | v1 | v2 | v3 | Survived through |
| --- | :---: | :---: | :---: | :---: |
| stagehand | SKIPPED | SKIPPED | SKIPPED | not run |
| baseline | PASS | FAIL | FAIL | v1 |
| hybrid | PASS | PASS | FAIL | v2 |

## Failures

- **class-drift** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **class-drift** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key)
- **column-shuffle** (baseline) [safe-failure] — [validation] Farrow Wanderers: goalsFor Number must be greater than or equal to 0 | Eastvale Athletic: goalsFor Number must be greater than or equal to 0 | Bexley Town: goalsFor Number must be greater than or equal to 0 | Harwick Albion: goalsFor Number must be greater than or equal to 0 | Ironbridge FC: goalsFor Number must be greater than or equal to 0
- **layout-variant** (baseline) [hard-failure] — [not_found] standings table not found — selector #standings matched nothing or stayed empty
- **layout-variant** (hybrid) [safe-failure] — [extraction] no header-mappable table found; semantic extraction unavailable (no model key)
- **site-v2** (baseline) [safe-failure] — [validation] Harwick Albion: losses Number must be greater than or equal to 0 | Lowton Harriers: losses Number must be greater than or equal to 0 | Dunmore City: losses Number must be greater than or equal to 0 | Eastvale Athletic: losses Number must be greater than or equal to 0 | Ironbridge FC: losses Number must be greater than or equal to 0
- **site-v3** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **site-v3** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key)
- **compound-redesign-storm** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **compound-redesign-storm** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair unavailable (no model key)

> stagehand skipped: no model provider key — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env
