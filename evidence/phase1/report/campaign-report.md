# Campaign aggregation

Aggregated 16 run(s) · 96 scenario×configuration cell(s) · generated 2026-07-20T20:28:41.832Z

Sources: /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T19-08-46-611Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T19-19-24-734Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T19-29-56-809Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T19-40-24-220Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T19-50-54-133Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-01-04-151Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-03-41-665Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-06-18-943Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-08-52-496Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-11-29-594Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-14-09-239Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-16-34-681Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-19-01-358Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-21-30-286Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-23-55-579Z, /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent/runs/bench-2026-07-20T20-26-18-698Z

| Scenario | Config | Engine | Trials | Pass | Fail | Acc median | Acc range | Dur median (s) | Dur range (s) | llmCalls sum | llmCalls median | Det FB (trials) | Cost sum ($, priced) | Cost range ($) | Heal rate | Retry rec |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clean-extraction | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.38 | 22.02–23.36 | 25 | 5.0 | 0 (0) | 0.1435 (5/5) | 0.0284–0.0290 | 0% | 0 |
| clean-extraction | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.18 | 2.05–2.19 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| clean-extraction | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.24 | 2.09–2.30 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| clean-extraction | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.17 | 2.17 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| session-reuse | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 16.92 | 16.24–18.84 | 10 | 2.0 | 0 (0) | 0.1048 (5/5) | 0.0209–0.0211 | 0% | 0 |
| session-reuse | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 1.91 | 1.90–1.93 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| session-reuse | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 1.92 | 1.91–1.98 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| session-reuse | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 1.94 | 1.94 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| expired-session | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 21.37 | 20.65–23.24 | 25 | 5.0 | 0 (0) | 0.1427 (5/5) | 0.0284–0.0287 | 0% | 0 |
| expired-session | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.17 | 2.01–2.18 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| expired-session | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.19 | 2.02–2.24 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| expired-session | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.18 | 2.18 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| cookie-banner | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 26.83 | 22.96–33.91 | 30 | 6.0 | 0 (0) | 0.1555 (5/5) | 0.0309–0.0315 | 0% | 0 |
| cookie-banner | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.25 | 2.21–2.27 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| cookie-banner | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.23 | 2.16–2.32 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| cookie-banner | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.19 | 2.19 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| modal-overlay | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 25.66 | 23.99–29.57 | 30 | 6.0 | 0 (0) | 0.1692 (5/5) | 0.0338–0.0339 | 0% | 0 |
| modal-overlay | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.16 | 2.02–2.23 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| modal-overlay | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.22 | 2.21–2.26 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| modal-overlay | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.18 | 2.18 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| delayed-render | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 26.58 | 26.18–30.30 | 25 | 5.0 | 0 (0) | 0.1427 (5/5) | 0.0284–0.0289 | 0% | 0 |
| delayed-render | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 7.46 | 7.44–7.48 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| delayed-render | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 7.48 | 7.46–7.50 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| delayed-render | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 7.48 | 7.48 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| network-slowdown | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 29.69 | 28.99–30.67 | 25 | 5.0 | 0 (0) | 0.1433 (5/5) | 0.0285–0.0289 | 0% | 0 |
| network-slowdown | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 10.40 | 10.34–10.46 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| network-slowdown | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 10.43 | 10.34–10.47 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| network-slowdown | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 10.42 | 10.42 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| class-drift | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.55 | 22.37–25.64 | 25 | 5.0 | 0 (0) | 0.1429 (5/5) | 0.0284–0.0289 | 0% | 0 |
| class-drift | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 6.17 | 5.55–6.92 | 15 | 3.0 | 0 (0) | 0.0285 (5/5) | 0.0057–0.0058 | 100% | 0 |
| class-drift | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.18 | 2.04–2.21 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| class-drift | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.15 | 2.15 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| column-shuffle | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.72 | 21.18–30.00 | 25 | 5.0 | 0 (0) | 0.1431 (5/5) | 0.0285–0.0288 | 0% | 0 |
| column-shuffle | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.16 | 2.00–2.24 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| column-shuffle | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.16 | 2.03–2.25 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| column-shuffle | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.16 | 2.16 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| layout-variant | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 21.57 | 21.14–28.11 | 25 | 5.0 | 0 (0) | 0.1548 (5/5) | 0.0308–0.0314 | 0% | 0 |
| layout-variant | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 16.74 | 15.98–17.17 | 10 | 2.0 | 0 (0) | 0.1163 (5/5) | 0.0230–0.0235 | 100% | 0 |
| layout-variant | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 17.04 | 16.90–17.36 | 10 | 2.0 | 0 (0) | 0.1166 (5/5) | 0.0232–0.0236 | 100% | 0 |
| layout-variant | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 16.58 | 16.58 | 2 | 2.0 | 0 (0) | 0.0230 (1/1) | 0.0230 | 100% | 0 |
| hidden-tab | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 31.34 | 29.89–32.02 | 35 | 7.0 | 0 (0) | 0.1523 (5/5) | 0.0293–0.0309 | 0% | 0 |
| hidden-tab | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 10.61 | 10.47–10.74 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| hidden-tab | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 10.64 | 10.52–10.68 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| hidden-tab | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 10.59 | 10.59 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| pagination | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 31.93 | 30.75–36.58 | 45 | 9.0 | 0 (0) | 0.2137 (5/5) | 0.0426–0.0429 | 0% | 0 |
| pagination | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 3.40 | 3.25–3.50 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| pagination | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 3.40 | 3.29–3.48 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| pagination | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 3.37 | 3.37 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| partial-data | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 23.46 | 20.90–29.21 | 25 | 5.0 | 0 (0) | 0.1436 (5/5) | 0.0286–0.0288 | 0% | 0 |
| partial-data | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.17 | 2.14–2.18 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| partial-data | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.16 | 2.11–2.19 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| partial-data | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.01 | 2.01 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| copy-drift | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 21.84 | 20.16–22.44 | 25 | 5.0 | 0 (0) | 0.1429 (5/5) | 0.0270–0.0291 | 0% | 0 |
| copy-drift | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.15 | 2.00–2.21 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| copy-drift | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.18 | 2.01–2.22 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| copy-drift | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.05 | 2.05 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| odds-format-american | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.30 | 20.94–23.56 | 25 | 5.0 | 0 (0) | 0.1418 (5/5) | 0.0282–0.0286 | 0% | 0 |
| odds-format-american | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.04 | 1.98–2.24 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| odds-format-american | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.16 | 2.09–2.23 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| odds-format-american | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.15 | 2.15 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| stale-session | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 28.02 | 26.34–34.43 | 40 | 8.0 | 0 (0) | 0.1826 (5/5) | 0.0363–0.0367 | 0% | 0 |
| stale-session | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.43 | 2.28–2.55 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| stale-session | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.45 | 2.33–2.58 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| stale-session | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.25 | 2.25 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| schema-violation | D-full-semantic | stagehand | 5 | 5 | 0 | 0.958 | 0.958 | 22.49 | 20.64–23.78 | 25 | 5.0 | 0 (0) | 0.1437 (5/5) | 0.0286–0.0290 | 0% | 0 |
| schema-violation | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 0.958 | 0.958 | 2.15 | 2.15–2.23 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| schema-violation | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 0.958 | 0.958 | 2.16 | 2.01–2.26 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| schema-violation | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 0.958 | 0.958 | 2.14 | 2.14 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| site-v1 | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.46 | 21.82–25.45 | 25 | 5.0 | 0 (0) | 0.1430 (5/5) | 0.0285–0.0287 | 0% | 0 |
| site-v1 | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.21 | 2.15–2.30 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| site-v1 | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.15 | 2.13–2.23 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| site-v1 | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.13 | 2.13 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| site-v2 | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 23.75 | 19.22–24.16 | 25 | 5.0 | 0 (0) | 0.1413 (5/5) | 0.0272–0.0286 | 0% | 0 |
| site-v2 | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.15 | 2.14–2.25 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| site-v2 | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 2.03 | 1.98–2.23 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| site-v2 | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 2.20 | 2.20 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| site-v3 | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 22.53 | 21.80–26.52 | 25 | 5.0 | 0 (0) | 0.1553 (5/5) | 0.0308–0.0312 | 0% | 0 |
| site-v3 | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 21.75 | 20.29–22.49 | 25 | 5.0 | 0 (0) | 0.1453 (5/5) | 0.0288–0.0293 | 100% | 0 |
| site-v3 | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 16.52 | 15.58–18.91 | 10 | 2.0 | 0 (0) | 0.1162 (5/5) | 0.0230–0.0237 | 100% | 0 |
| site-v3 | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 16.63 | 16.63 | 2 | 2.0 | 0 (0) | 0.0232 (1/1) | 0.0232 | 100% | 0 |
| compound-blocked-and-slow | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 39.88 | 37.42–43.32 | 35 | 7.0 | 0 (0) | 0.1680 (5/5) | 0.0334–0.0338 | 0% | 0 |
| compound-blocked-and-slow | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 18.39 | 18.34–18.45 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-blocked-and-slow | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 18.43 | 18.35–18.45 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-blocked-and-slow | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 18.40 | 18.40 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| compound-session-churn | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 37.07 | 34.58–38.58 | 60 | 12.0 | 0 (0) | 0.2505 (5/5) | 0.0500–0.0502 | 0% | 0 |
| compound-session-churn | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 3.66 | 3.53–3.83 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-session-churn | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 3.57 | 3.51–3.84 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-session-churn | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 3.68 | 3.68 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| compound-messy-data-day | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 30.40 | 29.70–31.25 | 30 | 6.0 | 0 (0) | 0.1691 (5/5) | 0.0336–0.0340 | 0% | 0 |
| compound-messy-data-day | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 8.58 | 8.52–8.63 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-messy-data-day | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 8.57 | 8.52–8.64 | 0 | 0.0 | 0 (0) | 0.0000 (5/5) | 0.0000 | 0% | 0 |
| compound-messy-data-day | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 8.55 | 8.55 | 0 | 0.0 | 0 (0) | 0.0000 (1/1) | 0.0000 | 0% | 0 |
| compound-redesign-storm | D-full-semantic | stagehand | 5 | 5 | 0 | 1.000 | 1.000 | 23.33 | 21.05–24.54 | 25 | 5.0 | 0 (0) | 0.1552 (5/5) | 0.0309–0.0313 | 0% | 0 |
| compound-redesign-storm | C-hybrid-repair-cold | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 20.14 | 19.82–21.31 | 25 | 5.0 | 0 (0) | 0.1448 (5/5) | 0.0288–0.0291 | 100% | 0 |
| compound-redesign-storm | C-hybrid-repair-persistence | hybrid | 5 | 5 | 0 | 1.000 | 1.000 | 16.48 | 16.16–17.02 | 10 | 2.0 | 0 (0) | 0.1163 (5/5) | 0.0230–0.0236 | 100% | 0 |
| compound-redesign-storm | C-hybrid-repair-warm | hybrid | 1 | 1 | 0 | 1.000 | 1.000 | 16.19 | 16.19 | 2 | 2.0 | 0 (0) | 0.0232 (1/1) | 0.0232 | 100% | 0 |

## Warnings

- Runs span multiple seedCacheHash values: null, 5ca26c8470a8baf606eb13403929c1ebb4eb4d5b26c77316cecfe17305656558, 17637be0ff53c83e10f9e2e46436198fd5690fab36024914e7c9007e0233588c, 78043d650aa7cc05b122d7bff4a63abfe7625263e122a65f2468cda1a9125298, 01bd6eba35c4a061fd2488480d79888840d454c5e93596d97d31a42f725a5bcf, 35b5dea7531054acd13a3668e426ff145a3f3d3cd5ba9bbe16f87c36cfdfbe2e.

## Per-configuration totals

### D-full-semantic (stagehand)

- Trials: 120 · judged passes: 120 · judged failures: 0
- Silent corruption — D1 (of trials): 0/120 (0%) · D2 (of judged failures): — · D3 (of accepted outputs): 0/115 (0%)
- Deterministic fallbacks: 0 firing(s) across 0 trial(s)
- llmCalls: 690 · input tokens: 2248853 · output tokens: 299367
- Cost: $3.7457 (priced 120/120)
- Cost per successful workflow: $0.0312

### C-hybrid-repair-cold (hybrid)

- Trials: 120 · judged passes: 120 · judged failures: 0
- Silent corruption — D1 (of trials): 0/120 (0%) · D2 (of judged failures): — · D3 (of accepted outputs): 0/115 (0%)
- Deterministic fallbacks: 0 firing(s) across 0 trial(s)
- llmCalls: 75 · input tokens: 255614 · output tokens: 35854
- Cost: $0.4349 (priced 120/120)
- Cost per successful workflow: $0.0036

### C-hybrid-repair-persistence (hybrid)

- Trials: 120 · judged passes: 120 · judged failures: 0
- Silent corruption — D1 (of trials): 0/120 (0%) · D2 (of judged failures): — · D3 (of accepted outputs): 0/115 (0%)
- Deterministic fallbacks: 0 firing(s) across 0 trial(s)
- llmCalls: 30 · input tokens: 185535 · output tokens: 32709
- Cost: $0.3491 (priced 120/120)
- Cost per successful workflow: $0.0029

### C-hybrid-repair-warm (hybrid)

- Trials: 24 · judged passes: 24 · judged failures: 0
- Silent corruption — D1 (of trials): 0/24 (0%) · D2 (of judged failures): — · D3 (of accepted outputs): 0/23 (0%)
- Deterministic fallbacks: 0 firing(s) across 0 trial(s)
- llmCalls: 6 · input tokens: 37108 · output tokens: 6459
- Cost: $0.0694 (priced 24/24)
- Cost per successful workflow: $0.0029
