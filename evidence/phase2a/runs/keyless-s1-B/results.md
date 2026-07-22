# Reliability Benchmark

Created 2026-07-21T19:23:37.770Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 32 | 34.4% | 40.6% | 40.6% | 95.5% | 8.8s | 19 | 0.0% (0/19) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 11 | 0 | 3 | 2 | 16 | 6.3% |

- **hybrid** silent corruption: 2 (2/32 trials, 2/21 failures, 2/13 accepted outputs)

## Scenario comparison

| Scenario | Hybrid | Note |
| --- | :---: | --- |
| f1-class-l0-a | PASS |  |
| f1-class-l0-b | PASS |  |
| f1-class-l1-a | PASS |  |
| f1-class-l1-b | PASS |  |
| f1-class-l2-a | FAIL | hybrid: expected success but pipeline failed [not_found] login (#password): cached selector failed; semantic repair disabled (--no-repair) |
| f1-class-l2-b | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| f1-class-l3-a | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| f1-class-l3-b | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| f1-class-l4-a | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| f1-class-l4-b | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| f2-decoy-l0-a | PASS |  |
| f2-decoy-l0-b | PASS |  |
| f2-decoy-l1-a | FAIL | hybrid: expected success but accuracy 1.00 required, got 0.71 |
| f2-decoy-l1-b | FAIL | hybrid: expected success but accuracy 1.00 required, got 0.71 |
| f2-decoy-l2-a | FAIL | hybrid: expected success but pipeline failed [not_found] stats content never appeared |
| f2-decoy-l2-b | FAIL | hybrid: expected success but pipeline failed [not_found] stats content never appeared |
| f2-decoy-l3-a | FAIL | hybrid: expected success but pipeline failed [auth] login did not stick — still on the login page |
| f2-decoy-l3-b | FAIL | hybrid: expected success but pipeline failed [auth] login did not stick — still on the login page |
| f3-page-size-5-a | PASS |  |
| f3-page-size-5-b | PASS |  |
| f3-page-size-3-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-3-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-2-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-2-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| k-header-vocabulary | FAIL | hybrid: expected success but pipeline failed [extraction] no header-mappable table found; semantic extraction disabled (--no-repair) |
| k-ui-copy | PASS |  |
| k-column-order | PASS |  |
| k-layout-cards | FAIL | hybrid: expected success but pipeline failed [extraction] no header-mappable table found; semantic extraction disabled (--no-repair) |
| x-cards-header-vocabulary | FAIL | hybrid: expected success but pipeline failed [extraction] no header-mappable table found; semantic extraction disabled (--no-repair) |
| x-class-l2-decoy-l2 | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| x-class-l3-page-size-2 | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |
| x-wrapped-column-copy | PASS |  |

## Failures

- **f1-class-l2-a** (hybrid) [hard-failure] — [not_found] login (#password): cached selector failed; semantic repair disabled (--no-repair)
- **f1-class-l2-b** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **f1-class-l3-a** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **f1-class-l3-b** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **f1-class-l4-a** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **f1-class-l4-b** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **f2-decoy-l1-a** (hybrid) [silent-corruption] — [—] expected success but accuracy 1.00 required, got 0.71
- **f2-decoy-l1-b** (hybrid) [silent-corruption] — [—] expected success but accuracy 1.00 required, got 0.71
- **f2-decoy-l2-a** (hybrid) [hard-failure] — [not_found] stats content never appeared
- **f2-decoy-l2-b** (hybrid) [hard-failure] — [not_found] stats content never appeared
- **f2-decoy-l3-a** (hybrid) [hard-failure] — [auth] login did not stick — still on the login page
- **f2-decoy-l3-b** (hybrid) [hard-failure] — [auth] login did not stick — still on the login page
- **f3-page-size-3-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-3-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-2-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-2-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **k-header-vocabulary** (hybrid) [safe-failure] — [extraction] no header-mappable table found; semantic extraction disabled (--no-repair)
- **k-layout-cards** (hybrid) [safe-failure] — [extraction] no header-mappable table found; semantic extraction disabled (--no-repair)
- **x-cards-header-vocabulary** (hybrid) [safe-failure] — [extraction] no header-mappable table found; semantic extraction disabled (--no-repair)
- **x-class-l2-decoy-l2** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
- **x-class-l3-page-size-2** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
