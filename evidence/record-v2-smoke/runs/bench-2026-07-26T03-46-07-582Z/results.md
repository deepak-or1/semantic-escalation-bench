# Reliability Benchmark

Created 2026-07-26T03:52:18.317Z · node v20.14.0 · stagehand 3.6.0 · model n/a · provider none · browserbase not configured · 1 trial(s)/scenario

## Engine summary

| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 32 | 53.1% | 62.5% | 59.4% | 94.6% | 11.6s | 12 | 0.0% (0/12) |

## Outcome classes

_Behaviour classification, orthogonal to pass/fail. A schema-violation refusal is judged PASS yet classed safe-failure. Silent-corruption (success claimed on wrong/unverifiable data) is the headline safety metric._

| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid | 17 | 0 | 3 | 2 | 10 | 6.3% |

- **hybrid** silent corruption: 2 (2/32 trials, 2/15 failures, 2/19 accepted outputs)

## Scenario comparison

| Scenario | Hybrid | Note |
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
| f2-decoy-l1-a | FAIL | hybrid: expected success but accuracy 1.00 required, got 0.71 |
| f2-decoy-l1-b | FAIL | hybrid: expected success but accuracy 1.00 required, got 0.71 |
| f2-decoy-l2-a | FAIL | hybrid: expected success but pipeline failed [not_found] stats content never appeared |
| f2-decoy-l2-b | FAIL | hybrid: expected success but pipeline failed [not_found] stats content never appeared |
| f2-decoy-l3-a | FAIL | hybrid: expected success but pipeline failed [auth] login did not stick — still on the login page |
| f2-decoy-l3-b | FAIL | hybrid: expected success but pipeline failed [auth] login did not stick — still on the login page |
| f3-page-size-5-a | PASS |  |
| f3-page-size-5-b | PASS |  |
| f3-page-size-3-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic) |
| f3-page-size-3-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic) |
| f3-page-size-2-a | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic) |
| f3-page-size-2-b | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic) |
| k-header-vocabulary | FAIL | hybrid: expected success but pipeline failed [extraction] no header-mappable table found; deterministic card reader found no mappable structure (repair-mode=deterministic) |
| k-ui-copy | PASS |  |
| k-column-order | PASS |  |
| k-layout-cards | FAIL | hybrid: expected success but pipeline failed [validation] odds row 1: missing team name(s) \| odds row 2: missing team name(s) \| odds row 3: missing team name(s) \| odds row 4: missing team name(s) \| odds row 5: missing team name(s) |
| x-cards-header-vocabulary | FAIL | hybrid: expected success but pipeline failed [extraction] no header-mappable table found; deterministic card reader found no mappable structure (repair-mode=deterministic) |
| x-class-l2-decoy-l2 | FAIL | hybrid: expected success but pipeline failed [not_found] stats content never appeared |
| x-class-l3-page-size-2 | FAIL | hybrid: expected success but pipeline failed [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic) |
| x-wrapped-column-copy | PASS |  |

## Failures

- **f2-decoy-l1-a** (hybrid) [silent-corruption] — [—] expected success but accuracy 1.00 required, got 0.71
- **f2-decoy-l1-b** (hybrid) [silent-corruption] — [—] expected success but accuracy 1.00 required, got 0.71
- **f2-decoy-l2-a** (hybrid) [hard-failure] — [not_found] stats content never appeared
- **f2-decoy-l2-b** (hybrid) [hard-failure] — [not_found] stats content never appeared
- **f2-decoy-l3-a** (hybrid) [hard-failure] — [auth] login did not stick — still on the login page
- **f2-decoy-l3-b** (hybrid) [hard-failure] — [auth] login did not stick — still on the login page
- **f3-page-size-3-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic)
- **f3-page-size-3-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic)
- **f3-page-size-2-a** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic)
- **f3-page-size-2-b** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic)
- **k-header-vocabulary** (hybrid) [safe-failure] — [extraction] no header-mappable table found; deterministic card reader found no mappable structure (repair-mode=deterministic)
- **k-layout-cards** (hybrid) [safe-failure] — [validation] odds row 1: missing team name(s) | odds row 2: missing team name(s) | odds row 3: missing team name(s) | odds row 4: missing team name(s) | odds row 5: missing team name(s)
- **x-cards-header-vocabulary** (hybrid) [safe-failure] — [extraction] no header-mappable table found; deterministic card reader found no mappable structure (repair-mode=deterministic)
- **x-class-l2-decoy-l2** (hybrid) [hard-failure] — [not_found] stats content never appeared
- **x-class-l3-page-size-2** (hybrid) [hard-failure] — [not_found] reveal-table (#tab-table): cached selector failed; deterministic repair found no candidate (repair-mode=deterministic)
