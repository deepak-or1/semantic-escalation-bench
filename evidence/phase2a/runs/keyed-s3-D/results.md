# Reliability Benchmark

Created 2026-07-22T00:01:01.279Z · node v20.14.0 · stagehand 3.6.0 · model anthropic/claude-haiku-4-5 · provider anthropic · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 32 | 84.4% | 84.4% | 84.4% | 100.0% | 32.3s | 5 | 0.0% (0/5) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 27 | 0 | 0 | 0 | 5 | 0.0% |

- **stagehand** silent corruption: 0 (0/32 trials, 0/5 failures, 0/27 accepted outputs)

## Scenario comparison

| Scenario | Stagehand | Note |
| --- | :---: | --- |
| f1-class-l0-a | PASS |  |
| f1-class-l0-b | PASS |  |
| f1-class-l1-a | PASS |  |
| f1-class-l1-b | PASS |  |
| f1-class-l2-a | PASS |  |
| f1-class-l2-b | PASS |  |
| f1-class-l3-a | PASS |  |
| f1-class-l3-b | PASS |  |
| f1-class-l4-a | PASS |  |
| f1-class-l4-b | PASS |  |
| f2-decoy-l0-a | PASS |  |
| f2-decoy-l0-b | PASS |  |
| f2-decoy-l1-a | PASS |  |
| f2-decoy-l1-b | PASS |  |
| f2-decoy-l2-a | PASS |  |
| f2-decoy-l2-b | PASS |  |
| f2-decoy-l3-a | PASS |  |
| f2-decoy-l3-b | PASS |  |
| f3-page-size-5-a | PASS |  |
| f3-page-size-5-b | PASS |  |
| f3-page-size-3-a | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-3-b | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-2-a | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-2-b | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| k-header-vocabulary | PASS |  |
| k-ui-copy | PASS |  |
| k-column-order | PASS |  |
| k-layout-cards | PASS |  |
| x-cards-header-vocabulary | PASS |  |
| x-class-l2-decoy-l2 | PASS |  |
| x-class-l3-page-size-2 | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| x-wrapped-column-copy | PASS |  |

## Failures

- **f3-page-size-3-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-3-b** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-b** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **x-class-l3-page-size-2** (stagehand) [hard-failure] — [not_found] stats content never appeared
