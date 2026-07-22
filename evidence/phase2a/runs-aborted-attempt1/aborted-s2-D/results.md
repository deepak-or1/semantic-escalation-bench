# Reliability Benchmark

Created 2026-07-21T21:54:10.679Z · node v20.14.0 · stagehand 3.6.0 · model anthropic/claude-haiku-4-5 · provider anthropic · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 32 | 62.5% | 62.5% | 62.5% | 100.0% | 30.3s | 12 | 0.0% (0/12) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stagehand | 20 | 0 | 0 | 0 | 12 | 0.0% |

- **stagehand** silent corruption: 0 (0/32 trials, 0/12 failures, 0/20 accepted outputs)

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
| f3-page-size-2-b | FAIL | stagehand: expected success but pipeline failed [timeout] Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error (attempted addresses: 2607:6bc0::10:443, 160.79.104.10:443) |
| k-header-vocabulary | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| k-ui-copy | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| k-column-order | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| k-layout-cards | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| x-cards-header-vocabulary | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| x-class-l2-decoy-l2 | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| x-class-l3-page-size-2 | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |
| x-wrapped-column-copy | FAIL | stagehand: expected success but pipeline failed [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com |

## Failures

- **f3-page-size-3-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-3-b** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-a** (stagehand) [hard-failure] — [not_found] stats content never appeared
- **f3-page-size-2-b** (stagehand) [hard-failure] — [timeout] Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error (attempted addresses: 2607:6bc0::10:443, 160.79.104.10:443)
- **k-header-vocabulary** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **k-ui-copy** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **k-column-order** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **k-layout-cards** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **x-cards-header-vocabulary** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **x-class-l2-decoy-l2** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **x-class-l3-page-size-2** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
- **x-wrapped-column-copy** (stagehand) [hard-failure] — [navigation] Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND api.anthropic.com
