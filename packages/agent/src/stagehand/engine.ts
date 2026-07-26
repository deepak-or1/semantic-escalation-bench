import { Stagehand, type V3Options } from "@browserbasehq/stagehand";
import {
  ExtractedOddsPageSchema,
  ExtractedStatsPageSchema,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type FailureCategory,
  type PipelineResult,
  type StepResult,
  type StepTraceEntry,
  type TokensUsage
} from "@ssda/shared";
import {
  AttemptFailure,
  loadAgentEnvConfig,
  loadSessionState,
  PipelineStepError,
  acquireChromeVersionFromCdp,
  requireStagehandReady,
  runPipeline,
  saveScreenshot,
  saveSessionState,
  waitForContent,
  type AgentEnvConfig,
  type AttemptFn,
  type AttemptOutcome,
  type Engine,
  type PipelineOptions
} from "../core";
import { DISMISS_TEXT_PATTERN } from "../core/dismissPattern";
import {
  CONSENT_ACCEPT_INSTRUCTION,
  ODDS_INSTRUCTION,
  REVEAL_STANDINGS_INSTRUCTION,
  STAGEHAND_DISMISS_MODAL_INSTRUCTION,
  STAGEHAND_LOGIN_PASSWORD_INSTRUCTION,
  STAGEHAND_LOGIN_SUBMIT_INSTRUCTION,
  STAGEHAND_LOGIN_USERNAME_INSTRUCTION,
  STAGEHAND_NEXT_PAGE_INSTRUCTION,
  STAGEHAND_REVEAL_TABLE_CLICK_INSTRUCTION,
  STATS_INSTRUCTION
} from "../instructions";
import { mergeStatsRows, parsePageInfo } from "./helpers";

// The extraction prompts live in the single-source instruction registry
// (Wave F F1). Re-exported here so existing deep imports of
// "../stagehand/engine" (the hybrid engine, the runner) keep working unchanged.
export { STATS_INSTRUCTION, ODDS_INSTRUCTION };

/** The active page type Stagehand hands back, without importing internals. */
type StagehandPage = NonNullable<ReturnType<Stagehand["context"]["activePage"]>>;

const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * How long to wait for page content to materialise before treating it as
 * missing. Covers the lab's slowest delayed-render (seeded up to 4s) with
 * headroom, while staying short enough that a genuinely hidden table (behind a
 * tab) falls through to the reveal path quickly instead of blocking for the
 * full step timeout.
 */
const CONTENT_POLL_MS = 8_000;

/** Give a client-side modal (fires ~800ms after load) time to appear. */
const MODAL_SETTLE_MS = 1_200;

const CONSENT_SELECTOR = 'form[action="/consent"]';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition on the Node side until it holds or the deadline passes. */
async function pollUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Choose a failure bucket for a step error: an explicitly-categorised
 * PipelineStepError wins; otherwise a timeout/navigation signature in the
 * message is preferred over the step's default category.
 */
function failureCategoryFor(error: unknown, fallback: FailureCategory): FailureCategory {
  if (error instanceof PipelineStepError) return error.category;
  const message = errorMessage(error);
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/net::|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|socket hang up/i.test(message)) {
    return "navigation";
  }
  return fallback;
}

/** Construct the (attempt-invariant) Stagehand options for this run. */
function buildStagehandOptions(
  options: PipelineOptions,
  stagehandModel: string,
  config: AgentEnvConfig
): V3Options {
  if (options.env === "browserbase") {
    return {
      env: "BROWSERBASE",
      model: stagehandModel,
      disableAPI: true,
      disablePino: true,
      verbose: 0,
      apiKey: config.browserbase.apiKey,
      projectId: config.browserbase.projectId,
      ...(config.browserbase.contextId
        ? {
            browserbaseSessionCreateParams: {
              browserSettings: { context: { id: config.browserbase.contextId, persist: true } }
            }
          }
        : {})
    };
  }
  return {
    env: "LOCAL",
    model: stagehandModel,
    disableAPI: true,
    disablePino: true,
    verbose: 0,
    localBrowserLaunchOptions: {
      headless: options.headless,
      viewport: VIEWPORT,
      // Trial-isolation hardening (2026-07-14): never serve a page from a
      // previous trial's HTTP cache — benchmark trials must always hit the lab.
      args: ["--disable-http-cache"]
    }
  };
}

// ── In-browser predicates ──────────────────────────────────────────────────

/** True when a consent wall (POSTs to /consent) is on the page. */
async function consentPresent(page: StagehandPage): Promise<boolean> {
  try {
    return (await page.evaluate(() => !!document.querySelector('form[action="/consent"]'))) === true;
  } catch {
    return false;
  }
}

/**
 * True when a fixed-position element covers more than half the viewport and
 * contains a button — a generic "blocking modal" signature with no class
 * coupling.
 */
async function overlayPresent(page: StagehandPage): Promise<boolean> {
  try {
    return (
      (await page.evaluate(() => {
        const area = window.innerWidth * window.innerHeight;
        if (area <= 0) return false;
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if (getComputedStyle(el).position !== "fixed") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width * rect.height > area * 0.5 && el.querySelector("button")) return true;
        }
        return false;
      })) === true
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort: click a dismiss control inside the blocking overlay (PROTOCOL_2A
 * §2a). Candidates are visible enabled button/[role=button]/a inside the FIRST
 * >50%-viewport fixed overlay; a candidate matches when its TRIMMED WHOLE text
 * matches the anchored §2a pattern (shared source string, rebuilt in-page since a
 * closure cannot capture an outer const). Corrects the Phase-1 unanchored matcher
 * that fired on any text merely CONTAINING an x ("Ne**x**t").
 */
async function clickOverlayDismiss(page: StagehandPage): Promise<void> {
  try {
    await page.evaluate((pattern: string) => {
      const re = new RegExp(pattern, "i");
      const area = window.innerWidth * window.innerHeight;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (getComputedStyle(el).position !== "fixed") continue;
        const rect = el.getBoundingClientRect();
        if (!(area > 0 && rect.width * rect.height > area * 0.5)) continue;
        for (const c of Array.from(el.querySelectorAll("button, [role=button], a"))) {
          const r = c.getBoundingClientRect();
          const s = getComputedStyle(c);
          const vis = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          const en = !c.matches(":disabled") && s.pointerEvents !== "none";
          if (vis && en && re.test((c.textContent || "").trim()) && c instanceof HTMLElement) {
            c.click();
            return;
          }
        }
        return; // only the FIRST qualifying overlay is considered
      }
    }, DISMISS_TEXT_PATTERN);
  } catch {
    /* deterministic fallback is best-effort */
  }
}

/** Submit the consent form directly (deterministic fallback for the act). */
async function submitConsentForm(page: StagehandPage): Promise<void> {
  try {
    await page.evaluate(() => {
      const form = document.querySelector('form[action="/consent"]');
      const button = form?.querySelector("button");
      if (button instanceof HTMLElement) button.click();
    });
  } catch {
    /* best-effort */
  }
}

// ── Engine ──────────────────────────────────────────────────────────────────

async function runStagehandEngine(options: PipelineOptions): Promise<PipelineResult> {
  // Gate on configuration FIRST, before any attempt/browser starts. A missing
  // provider key is a setup problem, not a benchmark result, so we let the
  // friendly error propagate untouched (never wrapped as an AttemptFailure).
  const config = loadAgentEnvConfig();
  const { stagehandModel } = requireStagehandReady(config, options.env);
  const stagehandOptions = buildStagehandOptions(options, stagehandModel, config);

  const wantStats = options.pages.includes("stats");
  const wantOdds = options.pages.includes("odds");

  // Steps where a hand-written deterministic guard fired AFTER the semantic act
  // failed to clear a session blocker (Wave F F2). Disclosed on the trial so a
  // "full semantic" pass never silently leans on hand-written fallback code.
  // Trial-scoped across attempts (exactly how hybrid scopes its healedSteps Set):
  // a guard that fires on a losing attempt must still be recorded, so this array
  // outlives any single attempt. Entries stay one-per-firing — the same step name
  // may therefore appear once per attempt in which its guard fired.
  const deterministicFallbacks: string[] = [];
  // Record-version-2 escalation trace (docs/RECORD_FORMAT.md). Stagehand has no
  // cached-selector tier and therefore no escalation TRIGGER to evaluate: what it
  // can honestly report is WHERE it spent a model call and WHERE a hand-written
  // guard fired after a semantic act failed. Fields it cannot know
  // (cachedSelectorMatched) are omitted, never guessed. Trial-scoped across
  // attempts, exactly like deterministicFallbacks above.
  const stepTrace: StepTraceEntry[] = [];
  /**
   * Record an LLM call site. Pure bookkeeping — no wait, no page interaction.
   * Each entry is EXACTLY one model call, recorded at the same place the
   * llmCalls counter increments, so Σ modelCallsAtStep reconciles against
   * `tokens.llmCalls` even when the call itself then throws.
   */
  const traceLlmCall = (step: string, site: string): void => {
    stepTrace.push({ step, modelCallsAtStep: 1, note: `llm call site: ${site}` });
  };
  // The browser build this trial ran against, read ONCE from CDP after init.
  let chromeVersion: string | null = null;
  /**
   * Close out a step's trace entries once the step has finished:
   * `downstreamRecovered` answers "did the step complete after a repair
   * succeeded here?", knowable only at this point. Pure bookkeeping.
   */
  const settleStepTrace = (step: string, completed: boolean): void => {
    for (const entry of stepTrace) {
      if (entry.step !== step) continue;
      if (entry.repairSucceeded !== true) continue;
      if (entry.downstreamRecovered !== undefined) continue;
      entry.downstreamRecovered = completed;
    }
  };

  const attemptFn: AttemptFn = async (attempt): Promise<AttemptOutcome> => {
    const steps: StepResult[] = [];
    const screenshots: string[] = [];
    let llmCalls = 0;
    let stagehand: Stagehand | undefined;
    let page: StagehandPage | undefined;
    let statsRaw: { rows: ExtractedStatsRow[] } | undefined;
    let oddsRaw: { rows: ExtractedOddsRow[] } | undefined;
    let consentHandled = false;

    // The step currently executing, so an LLM call site can name where it fired.
    // Steps in this engine are strictly sequential and never nested, and every
    // model-driven call below runs inside one, so a plain assignment in runStep is
    // enough to attribute each call correctly.
    let currentStep = "(pre-step)";

    // ── LLM call wrappers (count every model-driven call) ──────────────────
    const act = (
      instruction: string,
      opts?: Parameters<Stagehand["act"]>[1]
    ): ReturnType<Stagehand["act"]> => {
      llmCalls += 1;
      traceLlmCall(currentStep, "act(instruction)");
      return stagehand!.act(instruction, opts);
    };
    const observe = (instruction: string): ReturnType<Stagehand["observe"]> => {
      llmCalls += 1;
      traceLlmCall(currentStep, "observe(instruction)");
      return stagehand!.observe(instruction);
    };
    const extractStats = () => {
      llmCalls += 1;
      traceLlmCall(currentStep, "extract(stats)");
      return stagehand!.extract(STATS_INSTRUCTION, ExtractedStatsPageSchema, {
        timeout: options.stepTimeoutMs
      });
    };
    const extractOdds = () => {
      llmCalls += 1;
      traceLlmCall(currentStep, "extract(odds)");
      return stagehand!.extract(ODDS_INSTRUCTION, ExtractedOddsPageSchema, {
        timeout: options.stepTimeoutMs
      });
    };

    const currentTokens = async (): Promise<TokensUsage | null> => {
      if (!stagehand) return null;
      try {
        const metrics = await stagehand.metrics;
        return {
          llmCalls,
          inputTokens: metrics.totalPromptTokens,
          outputTokens: metrics.totalCompletionTokens
        };
      } catch {
        return { llmCalls };
      }
    };

    const capture = async (name: string): Promise<void> => {
      if (!page) return;
      try {
        const buffer = await page.screenshot();
        screenshots.push(await saveScreenshot(options.runDir, name, buffer));
      } catch {
        /* screenshots are best-effort evidence, never fatal */
      }
    };

    const runStep = async <T>(
      name: string,
      fallback: FailureCategory,
      fn: () => Promise<T>
    ): Promise<T> => {
      const startedAt = Date.now();
      currentStep = name;
      try {
        const result = await fn();
        steps.push({ name, status: "passed", attempts: 1, durationMs: Date.now() - startedAt });
        settleStepTrace(name, true);
        return result;
      } catch (error) {
        const category = failureCategoryFor(error, fallback);
        steps.push({
          name,
          status: "failed",
          attempts: 1,
          durationMs: Date.now() - startedAt,
          category,
          error: errorMessage(error)
        });
        // Settled BEFORE the snapshot below, so the carried trace records that
        // the step did not complete.
        settleStepTrace(name, false);
        await capture(`failure-a${attempt}`);
        throw new AttemptFailure(
          errorMessage(error),
          category,
          name,
          steps,
          screenshots,
          await currentTokens(),
          // stagehand never heals; carry the trial-level deterministic-fallback
          // snapshot so a guard that fired on this (losing) attempt is not lost.
          // (stagehand never runs the B2 deterministic-repair ladder, so the
          // trailing deterministicRepairSteps param is left unset.)
          undefined,
          [...deterministicFallbacks],
          { cause: error },
          // stagehand never runs the B2 ladder, so deterministicRepairSteps stays
          // unset; the record-version-2 trace snapshot follows it.
          undefined,
          stepTrace.map((e) => ({ ...e })),
          // The build this trial ran against, so a trial that DIES still
          // records which browser executed it.
          ...(chromeVersion ? [chromeVersion] : [])
        );
      }
    };

    const performLogin = async (): Promise<void> => {
      await act(STAGEHAND_LOGIN_USERNAME_INSTRUCTION, {
        variables: { username: options.credentials.username },
        timeout: options.stepTimeoutMs
      });
      await act(STAGEHAND_LOGIN_PASSWORD_INSTRUCTION, {
        variables: { password: options.credentials.password },
        timeout: options.stepTimeoutMs
      });
      await act(STAGEHAND_LOGIN_SUBMIT_INSTRUCTION, {
        timeout: options.stepTimeoutMs
      });
    };

    // Clear a consent wall if one is showing. Consent walls only appear once
    // authenticated, so this is called both before and after login; whichever
    // hits first emits the single "consent" step.
    const clearConsentIfPresent = async (): Promise<void> => {
      if (consentHandled || !page) return;
      if (!(await consentPresent(page))) return;
      const view = page;
      await runStep("consent", "blocked_ui", async () => {
        await act(CONSENT_ACCEPT_INSTRUCTION, {
          timeout: options.stepTimeoutMs
        });
        await pollUntil(async () => !(await consentPresent(view)), 5_000);
        // The trace entry for the guard, when one fires. Pushed before the guard
        // runs and resolved from the SAME presence check the throw below already
        // performs — no extra page interaction is introduced.
        let guardTrace: StepTraceEntry | undefined;
        if (await consentPresent(view)) {
          deterministicFallbacks.push("consent");
          // A hand-written guard is about to run because the semantic act did not
          // clear the wall — recorded so a "full semantic" pass never silently
          // leans on deterministic code.
          guardTrace = {
            step: "consent",
            escalationTriggered: true,
            repairAttempted: true,
            repairSucceeded: false,
            repairKind: "deterministic",
            modelCallsAtStep: 0,
            note: "semantic act did not clear the consent wall; hand-written guard fired"
          };
          stepTrace.push(guardTrace);
          await submitConsentForm(view);
          await pollUntil(async () => !(await consentPresent(view)), 5_000);
        }
        const stillBlocked = await consentPresent(view);
        if (guardTrace) guardTrace.repairSucceeded = !stillBlocked;
        if (stillBlocked) {
          throw new PipelineStepError(
            `consent wall (${CONSENT_SELECTOR}) could not be cleared`,
            "blocked_ui",
            "consent"
          );
        }
      });
      consentHandled = true;
    };

    try {
      await runStep("init-browser", "internal", async () => {
        stagehand = new Stagehand(stagehandOptions);
        await stagehand.init();
      });

      // Browser-build provenance (record version 2). Read ONCE per trial, here —
      // OUTSIDE any runStep so no step duration absorbs it, off every page path,
      // never per step, and null-on-any-failure so it can never fail a trial.
      if (chromeVersion === null) {
        // `required` makes an unobtainable build an ABORT right here — after
        // init, before load-session/goto and before any semantic step — instead
        // of running a whole attempt whose record could never satisfy the
        // non-null requirement. Absent/false, this is byte-identical to before.
        chromeVersion = await acquireChromeVersionFromCdp(() => stagehand!.connectURL(), {
          ...(options.requireChromeVersion ? { required: true } : {})
        });
      }

      if (options.session.mode === "reuse" || options.session.mode === "expired") {
        await runStep("load-session", "internal", async () => {
          const stateFile = options.session.stateFile;
          if (!stateFile) return;
          const saved = await loadSessionState(stateFile);
          if (!saved || saved.cookies.length === 0) return;
          await stagehand!.context.addCookies(
            saved.cookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              url: options.labUrl
            }))
          );
        });
      }

      await runStep("goto-stats", "navigation", async () => {
        page = stagehand!.context.activePage() ?? (await stagehand!.context.newPage());
        await page.goto(`${options.labUrl}/stats`, {
          waitUntil: "load",
          timeoutMs: options.navTimeoutMs
        });
      });

      // A consent wall may already be up (a still-valid reused session).
      await clearConsentIfPresent();

      if (page!.url().includes("/login")) {
        await runStep("login", "auth", async () => {
          await performLogin();
          const authed = await pollUntil(
            async () => !page!.url().includes("/login"),
            8_000
          );
          if (!authed) {
            throw new PipelineStepError(
              "login did not stick — still on the login page",
              "auth",
              "login"
            );
          }
        });
      }

      // The consent wall usually appears only after we authenticate.
      await clearConsentIfPresent();

      // Give a delayed modal time to pop, then dismiss it if it blocks content.
      await page!.waitForTimeout(MODAL_SETTLE_MS);
      if (await overlayPresent(page!)) {
        await runStep("dismiss-modal", "blocked_ui", async () => {
          await act(STAGEHAND_DISMISS_MODAL_INSTRUCTION, { timeout: options.stepTimeoutMs });
          await pollUntil(async () => !(await overlayPresent(page!)), 3_000);
          let guardTrace: StepTraceEntry | undefined;
          if (await overlayPresent(page!)) {
            deterministicFallbacks.push("dismiss-modal");
            guardTrace = {
              step: "dismiss-modal",
              escalationTriggered: true,
              repairAttempted: true,
              repairSucceeded: false,
              repairKind: "deterministic",
              modelCallsAtStep: 0,
              note: "semantic act did not dismiss the overlay; hand-written guard fired"
            };
            stepTrace.push(guardTrace);
            await clickOverlayDismiss(page!);
            await pollUntil(async () => !(await overlayPresent(page!)), 3_000);
          }
          // Resolved from the SAME presence check the throw already performs.
          const stillBlocked = await overlayPresent(page!);
          if (guardTrace) guardTrace.repairSucceeded = !stillBlocked;
          if (stillBlocked) {
            throw new PipelineStepError(
              "blocking overlay could not be dismissed",
              "blocked_ui",
              "dismiss-modal"
            );
          }
        });
      }

      if (wantStats) {
        await runStep("reveal-table", "not_found", async () => {
          let ready = await waitForContent(page!, CONTENT_POLL_MS, "stats", options.readinessMode);
          if (!ready) {
            const [action] = await observe(REVEAL_STANDINGS_INSTRUCTION);
            if (action) {
              llmCalls += 1;
              traceLlmCall(currentStep, "act(observed action)");
              await stagehand!.act(action);
            } else {
              await act(STAGEHAND_REVEAL_TABLE_CLICK_INSTRUCTION, {
                timeout: options.stepTimeoutMs
              });
            }
            await page!.waitForTimeout(400);
            ready = await waitForContent(page!, CONTENT_POLL_MS, "stats", options.readinessMode);
          }
          if (!ready) {
            throw new PipelineStepError(
              "stats content never appeared",
              "not_found",
              "reveal-table"
            );
          }
        });

        await runStep("extract-stats", "extraction", async () => {
          await capture(`stats-a${attempt}`);
          let rows = (await extractStats()).rows;
          let info = parsePageInfo(await page!.evaluate(() => document.body?.innerText ?? ""));
          if (info && info.total > 1) {
            // Bound the loop defensively in case "next" stops advancing.
            let budget = info.total + 2;
            while (info && info.current < info.total && budget > 0) {
              budget -= 1;
              await act(STAGEHAND_NEXT_PAGE_INSTRUCTION, {
                timeout: options.stepTimeoutMs
              });
              await page!.waitForTimeout(600);
              rows = mergeStatsRows(rows, (await extractStats()).rows);
              const next = parsePageInfo(
                await page!.evaluate(() => document.body?.innerText ?? "")
              );
              if (!next || next.current <= info.current) break;
              info = next;
            }
          }
          statsRaw = { rows };
        });
      }

      if (wantOdds) {
        await runStep("goto-odds", "navigation", async () => {
          await page!.goto(`${options.labUrl}/odds`, {
            waitUntil: "load",
            timeoutMs: options.navTimeoutMs
          });
        });

        if (page!.url().includes("/login")) {
          await runStep("relogin", "auth", async () => {
            await performLogin();
            await pollUntil(async () => !page!.url().includes("/login"), 8_000);
            await page!.goto(`${options.labUrl}/odds`, {
              waitUntil: "load",
              timeoutMs: options.navTimeoutMs
            });
            if (page!.url().includes("/login")) {
              throw new PipelineStepError(
                "session did not recover after re-login",
                "auth",
                "relogin"
              );
            }
          });
        }

        await runStep("extract-odds", "extraction", async () => {
          if (!(await waitForContent(page!, CONTENT_POLL_MS, "odds", options.readinessMode))) {
            throw new PipelineStepError(
              "odds content never appeared",
              "not_found",
              "extract-odds"
            );
          }
          await capture(`odds-a${attempt}`);
          oddsRaw = { rows: (await extractOdds()).rows };
        });
      }

      if (options.saveSessionStateTo) {
        const target = options.saveSessionStateTo;
        await runStep("save-session", "internal", async () => {
          const cookies = await stagehand!.context.cookies(options.labUrl);
          await saveSessionState(
            target,
            options.labUrl,
            cookies.map((cookie) => ({ name: cookie.name, value: cookie.value }))
          );
        });
      }

      return {
        steps,
        ...(statsRaw ? { statsRaw } : {}),
        ...(oddsRaw ? { oddsRaw } : {}),
        screenshots,
        tokens: await currentTokens(),
        ...(deterministicFallbacks.length > 0
          ? { deterministicFallbacks: [...deterministicFallbacks] }
          : {}),
        ...(stepTrace.length > 0 ? { stepTrace: stepTrace.map((e) => ({ ...e })) } : {}),
        ...(chromeVersion ? { chromeVersion } : {})
      };
    } finally {
      try {
        await stagehand?.close();
      } catch {
        /* closing a crashed browser is best-effort */
      }
    }
  };

  return runPipeline("stagehand", options, attemptFn);
}

export const stagehandEngine: Engine = {
  name: "stagehand",
  run: runStagehandEngine
};
