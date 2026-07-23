# Demo script (2–3 minutes)

A recorded walkthrough. The goal is to land one idea: **browser agents are easy to build and hard to trust, and this project measures the trust.** Timings are targets, not gospel.

**Before you hit record**

```bash
pnpm install
cp .env.example .env         # keep it keyless for the guaranteed-repeatable path
pnpm dev                     # lab on :4517, dashboard on :4618 (leave running)
```

Have three terminal tabs ready and a browser open to `http://localhost:4618`. If you have a model key, export it now (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) — see the "with a key" notes at each beat.

---

### 0:00–0:20 — The dashboard, cold

**Do:** Open `http://localhost:4618`. If you've run a benchmark before, the scenario matrix is already there; if not, it's the empty state.

**Say:** "This is a benchmark of when web automation should pay for a model call. The agent logs into a synthetic stats site, pulls standings and odds, and the easy part is done. The hard part — and what this dashboard is about — is knowing when to trust what it scraped. So the harness benchmarks three ways of addressing a page against 24 ways a page can break."

**Notice:** the three-engine framing — a Stagehand agent, a plain selector scraper, and a self-healing hybrid — that runs through the whole demo.

### 0:20–0:50 — The flaky lab, live

**Do:** Switch to the lab at `http://localhost:4517`, log in with `analyst` / `scout-the-lab`, show the standings and odds pages. Then, in a terminal:

```bash
pnpm seed -- --seed 1108 --chaos classDrift
```

Refresh the lab page.

**Say:** "The site is local and synthetic on purpose — a seeded fake league, so every run is reproducible and nothing real gets scraped. But it fights back. I just flipped on `classDrift` — every CSS class just got a random suffix and the ids are gone." (Open dev tools briefly to show the mangled class names.) "There are 14 of these chaos modes: consent walls, modals, delayed rendering, column shuffles, American odds, sessions that die mid-flow, corrupt data."

**Notice:** the page looks the same to a human but is now unrecognisable to a selector.

### 0:50–1:30 — The agent runs and produces a watchlist

**Do:** In a fresh terminal:

```bash
pnpm agent:local -- --engine baseline
```

**Say (while it runs):** "Here's the agent doing the real task on a clean page: log in, clear the consent wall, extract standings and odds into validated schemas, and score what it got against the ground truth the lab knows." When the watchlist prints: "Then a Poisson model turns that into a ranked value watchlist — model probability versus the de-vigged line, edge, expected value — and it labels its own confidence and its own limitations. It closes with 'Research demo — not betting advice,' because that's what it is."

**Notice:** the `accuracy vs ground truth` line and the ranked selections with `edge` / `EV` columns.

> **Also keyless:** run `pnpm agent:local -- --engine hybrid` to drive the *hybrid* engine — same clean-page output, but extraction maps columns by header name instead of by fixed index. On a clean page the watchlist is identical; the difference only shows under drift.
>
> **With a model key:** run `pnpm agent:local` (no `--engine`) instead to drive the *Stagehand* engine — same output, but the extraction is done by semantic instructions, and the run reports LLM calls and token usage.

### 1:30–2:00 — The benchmark

**Do:**

```bash
pnpm bench -- --trials 1
```

Let the progress lines stream (`[k/24] scenario engine -> PASS/FAIL`).

**Say:** "Now the same pipeline runs against all 24 scenarios — 17 isolated failure modes, 4 compound ones where obstacles stack in a single run, and 3 survival ones where the same site drifts version to version while the engines stay frozen. The only thing that changes between engines is *how they find elements on the page* — CSS selectors, semantic instructions, or the hybrid's cached selectors with header-name reading. Everything else — the validation, the scoring, the judge — is shared, so the comparison is honest."

**Notice:** most scenarios pass; a few baseline ones fail — and they fail *loudly*, as results, not crashes.

> **No key (default):** Stagehand is reported as `SKIPPED — no model provider key`; the harness never fabricates numbers for it. The two keyless engines run fully — the baseline passes 18 of 24, the hybrid 20 of 24.
>
> **With a key:** all three engines run. The interesting cells are the drift scenarios — `class-drift`, `layout-variant`, `column-shuffle` — where you'd expect the selector baseline to break, the hybrid to hold on shuffles and heal on redesigns, and the semantic agent to hold throughout.

### 2:00–2:40 — Read the results

**Do:**

```bash
pnpm report            # writes runs/latest/report.html
```

Refresh the dashboard at `:4618` (or open `runs/latest/report.html`). Walk it in three passes:

1. **The engine scorecard.** Three tiles — baseline, hybrid, stagehand. Point at the **hybrid tile**: it carries an extra `llm repairs` metric reading **0**, and a small note, *"repairs unavailable (no model key)."* "The hybrid made zero model calls this whole run — that's the point. Keyless, it's a purely deterministic engine; the LLM only wakes up to repair a broken selector, and there's no key here to wake it."

2. **The differentiator, `column-shuffle` (and its survival twin `site-v2`).** Open the baseline and hybrid cells side by side. "This is the one scenario where the two keyless engines split. The baseline reads columns by fixed position, so when the site reorders them it silently pulls the wrong numbers — and our domain validation catches it: *'goalsFor must be ≥ 0.'* A failure, but a *loud* one. The hybrid reads the same table by **header name**, maps the columns correctly, and passes at 99.8% accuracy. Same break, opposite outcome — and that's the entire case for reading structure instead of position."

3. **The Survival curve panel.** "Same site, drifting across three versions, engines frozen as first written. Read the 'survived through' column: the baseline dies at v2 the moment columns move; the hybrid rides through the content refresh and only stops at v3, the full redesign that turns the table into a card grid. **Where an engine stops is where its selectors met the change.**"

Then click into one failing scenario — `class-drift` or `layout-variant` — and open its failure detail: the screenshot and the `events.jsonl` step timeline.

**Say:** "Here's the payoff. The baseline fails `class-drift` because its `#login-form` selector matches nothing; the hybrid fails the same one — but its message is honest about *why*: *'cached selector failed; semantic repair unavailable (no model key).'* Keyless, its repair crew is off. Each failure has a screenshot and a full event log, so you can see exactly where and why it broke. That's the difference between 'the agent said it worked' and 'the agent proved it worked.'"

**Notice:** the failure category (`not_found`, `validation`, `extraction`) and that `schema-violation` is a **pass** — failing cleanly on corrupt data is the correct outcome.

### 2:40–3:00 — Close

**Say:** "Anyone can wire up a browser agent that works on a good day. The missing piece for real deployments is knowing, per failure mode, whether it works on a bad day — and being able to prove it with reproducible numbers. That's what this is: the agent, and the harness that keeps it honest."

---

## What changes with a model key

Everything above runs keyless via the baseline and hybrid engines. Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env` and two things change:

- `pnpm agent:local` (no `--engine`) drives the Stagehand engine and reports token usage.
- `pnpm bench` runs all three engines: the Stagehand column in the matrix populates instead of `SKIPPED`, **and the hybrid's repair path switches on** — on the redesign scenarios where it failed keyless (`layout-variant`, `site-v3`, `compound-redesign-storm`) it can now `observe`/`extract` to heal, so watch the hybrid tile's `llm repairs` count climb above 0 on exactly those trials and nowhere else.
- The drift scenarios become the story — swap the beat at 1:30–2:40 to contrast all three engines on `class-drift` / `layout-variant`, and note that the hybrid spends model budget *only* when a cached selector actually breaks.

Nothing in the demo requires a Browserbase account; add `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` only if you want to show `pnpm agent:browserbase` running the session in the cloud.
