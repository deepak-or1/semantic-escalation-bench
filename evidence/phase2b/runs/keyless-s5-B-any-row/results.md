# Reliability Benchmark

Created 2026-07-26T22:44:36.469Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 5 | 80.0% | 80.0% | 80.0% | 100.0% | 3.9s | 1 | 0.0% (0/1) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 4 | 0 | 0 | 0 | 1 | 0.0% |

- **hybrid** silent corruption: 0 (0/5 trials, 0/1 failures, 0/4 accepted outputs)

## Scenario comparison

| Scenario | Hybrid | Note |
| --- | :---: | --- |
| f3-page-size-3-a | PASS |  |
| f3-page-size-3-b | PASS |  |
| f3-page-size-2-a | PASS |  |
| f3-page-size-2-b | PASS |  |
| x-class-l3-page-size-2 | FAIL | hybrid: expected success but pipeline failed [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair) |

## Failures

- **x-class-l3-page-size-2** (hybrid) [hard-failure] — [not_found] login (#username): cached selector failed; semantic repair disabled (--no-repair)
