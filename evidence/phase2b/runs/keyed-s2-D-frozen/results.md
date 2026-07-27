# Reliability Benchmark

Created 2026-07-26T23:26:34.328Z · node v20.14.0 · stagehand 3.6.0 · model anthropic/claude-haiku-4-5 · provider anthropic · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 5 | 0.0% | 0.0% | 0.0% | — | 51.7s | 5 | 0.0% (0/5) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 0 | 0 | 0 | 0 | 5 | 0.0% |

- **stagehand** silent corruption: 0 (0/5 trials, 0/5 failures, 0/0 accepted outputs)

## Scenario comparison

| Scenario | Stagehand | Note |
| --- | :---: | --- |
| f3-page-size-3-a | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-3-b | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-2-a | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| f3-page-size-2-b | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |
| x-class-l3-page-size-2 | FAIL | stagehand: expected success but pipeline failed [not_found] stats content never appeared |

## Failures

- **f3-page-size-3-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-3-b** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-b** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **x-class-l3-page-size-2** (stagehand) [hard-failure] — [not_found] stats content never appeared
