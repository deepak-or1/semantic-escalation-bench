# Reliability Benchmark

Created 2026-07-26T03:46:06.209Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 32 | 46.9% | 53.1% | 46.9% | 94.1% | 6.4s | 15 | 0.0% (0/15) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 15 | 0 | 2 | 0 | 15 | 0.0% |

- **baseline** silent corruption: 0 (0/32 trials, 0/17 failures, 0/15 accepted outputs)

## Scenario comparison

| Scenario | Baseline | Note |
| --- | :---: | --- |
| f1-class-l0-a | PASS |  |
| f1-class-l0-b | PASS |  |
| f1-class-l1-a | PASS |  |
| f1-class-l1-b | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l2-a | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l2-b | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l3-a | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l3-b | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l4-a | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f1-class-l4-b | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| f2-decoy-l0-a | PASS |  |
| f2-decoy-l0-b | PASS |  |
| f2-decoy-l1-a | PASS |  |
| f2-decoy-l1-b | PASS |  |
| f2-decoy-l2-a | FAIL | baseline: expected success but pipeline failed [not_found] standings table not found — selector #standings matched nothing or stayed empty |
| f2-decoy-l2-b | FAIL | baseline: expected success but pipeline failed [not_found] standings table not found — selector #standings matched nothing or stayed empty |
| f2-decoy-l3-a | FAIL | baseline: expected success but pipeline failed [auth] login did not stick — still on /login after submit |
| f2-decoy-l3-b | FAIL | baseline: expected success but pipeline failed [auth] login did not stick — still on /login after submit |
| f3-page-size-5-a | PASS |  |
| f3-page-size-5-b | PASS |  |
| f3-page-size-3-a | PASS |  |
| f3-page-size-3-b | PASS |  |
| f3-page-size-2-a | PASS |  |
| f3-page-size-2-b | PASS |  |
| k-header-vocabulary | PASS |  |
| k-ui-copy | PASS |  |
| k-column-order | FAIL | baseline: expected success but pipeline failed [validation] Lowton Harriers: played is missing/unreadable \| Ashford Rovers: played is missing/unreadable \| Dunmore City: played is missing/unreadable \| Bexley Town: played is missing/unreadable \| Harwick Albion: played is missing/unreadable |
| k-layout-cards | FAIL | baseline: expected success but pipeline failed [not_found] standings table not found — selector #standings matched nothing or stayed empty |
| x-cards-header-vocabulary | FAIL | baseline: expected success but pipeline failed [not_found] standings table not found — selector #standings matched nothing or stayed empty |
| x-class-l2-decoy-l2 | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| x-class-l3-page-size-2 | FAIL | baseline: expected success but pipeline failed [not_found] login form not found — selector #login-form matched nothing |
| x-wrapped-column-copy | FAIL | baseline: expected success but pipeline failed [validation] Ashford Rovers: played is missing/unreadable \| Dunmore City: played is missing/unreadable \| Bexley Town: played is missing/unreadable \| Farrow Wanderers: played is missing/unreadable \| Gillside FC: played is missing/unreadable |

## Failures

- **f1-class-l1-b** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l2-a** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l2-b** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l3-a** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l3-b** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l4-a** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f1-class-l4-b** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **f2-decoy-l2-a** (baseline) [hard-failure] — [not_found] standings table not found — selector #standings matched nothing or stayed empty
- **f2-decoy-l2-b** (baseline) [hard-failure] — [not_found] standings table not found — selector #standings matched nothing or stayed empty
- **f2-decoy-l3-a** (baseline) [hard-failure] — [auth] login did not stick — still on /login after submit
- **f2-decoy-l3-b** (baseline) [hard-failure] — [auth] login did not stick — still on /login after submit
- **k-column-order** (baseline) [safe-failure] — [validation] Lowton Harriers: played is missing/unreadable | Ashford Rovers: played is missing/unreadable | Dunmore City: played is missing/unreadable | Bexley Town: played is missing/unreadable | Harwick Albion: played is missing/unreadable
- **k-layout-cards** (baseline) [hard-failure] — [not_found] standings table not found — selector #standings matched nothing or stayed empty
- **x-cards-header-vocabulary** (baseline) [hard-failure] — [not_found] standings table not found — selector #standings matched nothing or stayed empty
- **x-class-l2-decoy-l2** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **x-class-l3-page-size-2** (baseline) [hard-failure] — [not_found] login form not found — selector #login-form matched nothing
- **x-wrapped-column-copy** (baseline) [safe-failure] — [validation] Ashford Rovers: played is missing/unreadable | Dunmore City: played is missing/unreadable | Bexley Town: played is missing/unreadable | Farrow Wanderers: played is missing/unreadable | Gillside FC: played is missing/unreadable
