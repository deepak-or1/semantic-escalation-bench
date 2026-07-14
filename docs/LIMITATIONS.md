# Limitations

An honest accounting of what this project does and does not establish. Kept specific on purpose — a benchmark you can't poke holes in isn't a benchmark, it's a brochure.

## Threats to validity

The short list of reasons to read the headline numbers with care; [docs/WRITEUP.md](WRITEUP.md) gives the full treatment.

1. **The baseline's author knew the scenario catalog.** Its brittleness is *representative*, not naive — positional and id-anchored selectors are exactly what production scrapers ship, and [docs/EVIDENCE.md](EVIDENCE.md) documents how common that is — but the 18/24 pass count is a property of *this scenario mix*, not of the world. The survival and compound groups exist to blunt that (they reprise the same breaks in harder, co-occurring, drifting forms rather than adding easy wins).
2. **Single trial per scenario.** The two deterministic engines have minimal variance by construction (the hybrid proves it: `llmCalls = 0`), so one trial characterises them; but LLM-path variance — Stagehand, and the hybrid's repair path — is entirely unmeasured until a key lands.
3. **The Stagehand column is an untested hypothesis on this machine.** It is `skipped`, never faked. What a keyed run would show is a prediction, not a result.
4. **The lab is synthetic.** Its chaos is modelled on documented real-world failure modes (each mapped to a live source in [docs/EVIDENCE.md](EVIDENCE.md)), but it is not a live site — no real auth, rate limits, or adversary.
5. **The hybrid's repair path is keyless-unverified.** Its deterministic tier *is* verified; the self-healing branch is implemented and unit-tested but has not run end-to-end here.

## Benchmark scope

- **The lab is synthetic, not adversarial.** The 14 chaos modes (`packages/shared/src/chaos.ts`) model *incidental* breakage — drift, layout changes, overlays, latency, corrupt cells. They do **not** model an adversary: no bot-detection, no CAPTCHAs, no fingerprinting, no rate-limiting, no obfuscated/rotating markup designed to defeat automation. "Survives the lab" means "survives ordinary page churn," not "beats anti-bot defences."
- **One site shape.** Every scenario is a variation of a single site's login → consent → standings → odds flow (`apps/lab`). The benchmark measures robustness to *changes in that shape*, not generalisation across genuinely different sites, sports, or data models.
- **One trial per scenario by default.** `pnpm bench` runs 1 trial/scenario. That's enough to characterise the two *deterministic* engines (baseline, and the hybrid's keyless tier — the hybrid recorded `llmCalls = 0` on every trial, so its variance is minimal by construction), but LLM extraction is non-deterministic — a single Stagehand trial, or a single hybrid *repair*, is a sample, not a rate. Use `--trials N` for anything you'd quote. The current `runs/latest` numbers are baseline + hybrid, keyless, 1 trial each; Stagehand and the hybrid repair path are unmeasured here.
- **Pass/fail is judged against a declared expectation, not raw success.** `schema-violation` "passing" means the pipeline *failed cleanly* with a `validation` category — correct behaviour, but worth understanding before reading the matrix (`packages/agent/src/reliability/runner.ts`).

## Stagehand side

- **No live keyed run in this build environment.** There is no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` here, so the Stagehand engine has not been exercised end-to-end against the lab; the benchmark reports it as `skipped` and the `stagehand-live` integration test auto-skips. The code is written and unit-tested (helpers, mapping, config), but the numbers in `runs/latest` are **keyless — baseline and hybrid only**. First real keyed run carries the usual first-run risks: the login `act` phrasing may need tuning for a given model, and extract fidelity under heavy drift (class + copy + layout at once) is unverified against real model output.
- **No live Browserbase run.** Same reason — no `BROWSERBASE_*` keys. The Browserbase path (including the persistent-context `persist: true` param) is written to the SDK's types but untested live.
- **Token cost is real and unbounded here.** Each Stagehand run makes several model calls (login acts, reveal observe/act, two extracts, plus pagination acts). Cost scales with pages, retries, and model choice; there is no budget cap or cost gate in the runner today (token usage is *recorded*, not *limited*).
- **Model non-determinism.** Two identical Stagehand runs can extract slightly differently or phrase an action differently. That's inherent to the approach; it's why trial counts matter and why the domain-validation layer exists as a deterministic backstop.

## Hybrid side

- **The repair path is implemented but keyless-unverified.** The hybrid's *deterministic* tier is fully exercised in `runs/latest` (`llmCalls = 0`, real numbers) — but the branch that makes it "self-healing", the `observe`/`extract` repair, only fires with a model key, and there is none here. So the claim "it clears shuffles deterministically and heals redesigns with a model" is only half-verified: the deterministic half is proven; the healing half is written and unit-tested but has never run end-to-end against the lab. Its keyless failures on `layout-variant` / `site-v3` / `compound-redesign-storm` are the honest boundary of what's been measured, not the ceiling of what's designed.
- **The synonym dictionary is scoped to general football vocabulary.** Header-name mapping (`packages/agent/src/hybrid/synonyms.ts`) covers standard terms — `P`/`Pld`/`Played`/`GP`, `W`/`Won`, `GF`/`Goals For`/`Scored`, `1`/`X`/`2`, and so on — chosen *before* looking at any lab copy variant and deliberately not tuned to make scenarios pass. That is a real, bounded surface: a header the dictionary doesn't cover (a genuinely novel rewording, or another sport's stat names) maps to nothing, which for the hybrid means falling through to the key-gated repair path — and keyless, that is a reported coverage gap, not a silent misread. The dictionary's coverage of the lab's `copyDrift` synonyms is a property of choosing common terms, not of peeking.

## Model side

- **Independence assumption.** Home and away goals are modelled as independent Poisson draws (`packages/model/src/forecast.ts`). There's no Dixon-Coles low-score correction, so 0-0 / 1-0 / 0-1 probabilities are mildly off.
- **Small-sample rates.** Scoring strengths come from a single simulated partial season (each team plays 22 matches). Those rates carry real sampling noise — a team's estimated attack strength is an estimate, not a truth.
- **Constant home advantage.** Home advantage is a single league-wide multiplier (1.14), not fit per team or venue (`packages/model/src/params.ts`).
- **Crude form.** "Recent form" is a 3/1/0-points heuristic over the last five results at a fixed low weight (0.25) — a nod to form, not a real time-series model.
- **The demo's edges are large by construction.** The generator draws model-facing season stats from a 22-game Poisson simulation while pricing odds off the *true* rates ±6% noise with a 5% / 4.5% overround (`packages/shared/src/seed/generate.ts`). So the model routinely "finds value" — that's the sampling-noise-vs-true-price story working as designed, not evidence the model would beat a real bookmaker. Every watchlist says so inline, and this is **not betting advice**.

## Engineering

- **Baseline brittleness is intentional, not a strawman weakness we forgot to fix.** The Playwright baseline is deliberately a competent-but-static selector scraper (it waits, paginates, re-logs-in, reuses sessions) whose *only* fragility is fixed ids and column indices (`packages/agent/src/baseline/mapping.ts`). That's the whole point — it isolates element-addressing as the single variable under test. Don't read its 6 failures (across 24 scenarios) as "Playwright is bad."
- **Some chaos modes don't differentiate the engines.** A consent wall and a newsletter modal are mechanical blockers all three engines clear the same way (submit the form / click dismiss). Those scenarios test that the *pipeline* handles them, not that semantic automation beats selectors — they're expected to be ties.
- **Recovery is only meaningful for transient failures.** The recovery metric measures how many first-attempt failures a second attempt fixed. But `runPipeline` only retries *operational* failures and never retries a validation failure (bad data is deterministic — a retry would reproduce it), so a low recovery rate against drift/not-found failures is expected, not alarming (`packages/agent/src/core/runPipeline.ts`).
- **Single-machine, filesystem storage.** Runs are JSON/JSONL under `runs/`, no database, no concurrency control. Fine for a demo; not a store you'd run a fleet against.

## What production would actually need

This is a portfolio demonstration of the *approach*. To run it for real you would add:

- **Context pools and Browserbase per-user contexts + stealth** — real auth persistence per account, warmed contexts, and the anti-detection posture the synthetic lab deliberately omits.
- **Live-site adapters** — a real site is a moving target with its own auth, pagination, and legal constraints; each source needs its own adapter and its own ToS/robots review. Nothing here should be pointed at a real book without that.
- **Cost tracking and budget gates** — per-run and per-day token/cost ceilings, model-tier routing, and alerting; today cost is recorded but never enforced.
- **CI benchmark gating** — run the benchmark on every change and fail the build on a reliability regression (a scenario that flips PASS→FAIL, or accuracy dropping below a floor), so robustness is defended automatically rather than checked by hand.
- **More trials and statistical treatment** — enough trials per scenario to report LLM success as a rate with a confidence interval, not a single sample.
