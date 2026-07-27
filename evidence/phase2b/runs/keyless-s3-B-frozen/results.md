# Reliability Benchmark

Created 2026-07-26T22:36:39.342Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 5 | 0.0% | 0.0% | 0.0% | — | 16.4s | 5 | 0.0% (0/5) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 0 | 0 | 0 | 0 | 5 | 0.0% |

- **hybrid** silent corruption: 0 (0/5 trials, 0/5 failures, 0/0 accepted outputs)

## Scenario comparison

| Scenario | Hybrid | Note |
| --- | :---: | --- |
| f3-page-size-3-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-3-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-2-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| f3-page-size-2-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair) |
| x-class-l3-page-size-2 | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |

## Failures

- **f3-page-size-3-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-3-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-2-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **f3-page-size-2-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; semantic repair disabled (--no-repair)
- **x-class-l3-page-size-2** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
