import { Stagehand, type V3Options } from "@browserbasehq/stagehand";
import {
  ExtractedOddsPageSchema,
  ExtractedStatsPageSchema,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type FailureCategory,
  type PipelineResult,
  type StepResult,
  type TokensUsage
} from "@ssda/shared";
import {
  AttemptFailure,
  loadAgentEnvConfig,
  loadSessionState,
  PipelineStepError,
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
import { mergeStatsRows, parsePageInfo } from "./helpers";

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

// Extraction instructions are column/label driven so they survive class drift,
// column shuffles, copy drift and layout changes without any DOM coupling.
// Exported so the hybrid engine's key-gated extraction repair reuses the
// IDENTICAL instructions (its LLM fallback must match this engine's semantics).
export const STATS_INSTRUCTION =
  "Extract every team row from the league standings shown on this page. " +
  "Map columns BY THEIR HEADER NAMES (the column order varies): P/Played -> played, " +
  "W -> wins, D -> draws, L -> losses, GF -> goalsFor, GA -> goalsAgainst, Pts -> points, " +
  "Form -> form (a string like WWDLW). Numbers must be integers exactly as displayed, " +
  "including negative numbers. If a cell shows a dash, N/A, or anything unreadable as a " +
  "number, use null. Include every visible team.";

export const ODDS_INSTRUCTION =
  "Extract every fixture row from the odds board. Each row has a match like " +
  "'Home Team vs Away Team' -> homeTeam/awayTeam, a kickoff time -> kickoff, and odds cells. " +
  "Copy each odds value VERBATIM as the page displays it, as a string: decimal like '2.20' or " +
  "American like '+154' or '-120'. The three main odds are homeOdds (1), drawOdds (X), " +
  "awayOdds (2); the totals columns are overOdds and underOdds with totalsLine '2.5'. " +
  "Use null for any cell showing a dash or no value.";

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

/** Best-effort: click a dismiss-looking button inside the blocking overlay. */
async function clickOverlayDismiss(page: StagehandPage): Promise<void> {
  try {
    await page.evaluate(() => {
      const area = window.innerWidth * window.innerHeight;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (getComputedStyle(el).position !== "fixed") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width * rect.height <= area * 0.5) continue;
        for (const btn of Array.from(el.querySelectorAll("button"))) {
          if (/no thanks|close|dismiss|x/i.test(btn.textContent || "")) {
            btn.click();
            return;
          }
        }
      }
    });
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

  const attemptFn: AttemptFn = async (attempt): Promise<AttemptOutcome> => {
    const steps: StepResult[] = [];
    const screenshots: string[] = [];
    let llmCalls = 0;
    let stagehand: Stagehand | undefined;
    let page: StagehandPage | undefined;
    let statsRaw: { rows: ExtractedStatsRow[] } | undefined;
    let oddsRaw: { rows: ExtractedOddsRow[] } | undefined;
    let consentHandled = false;

    // ── LLM call wrappers (count every model-driven call) ──────────────────
    const act = (
      instruction: string,
      opts?: Parameters<Stagehand["act"]>[1]
    ): ReturnType<Stagehand["act"]> => {
      llmCalls += 1;
      return stagehand!.act(instruction, opts);
    };
    const observe = (instruction: string): ReturnType<Stagehand["observe"]> => {
      llmCalls += 1;
      return stagehand!.observe(instruction);
    };
    const extractStats = () => {
      llmCalls += 1;
      return stagehand!.extract(STATS_INSTRUCTION, ExtractedStatsPageSchema, {
        timeout: options.stepTimeoutMs
      });
    };
    const extractOdds = () => {
      llmCalls += 1;
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
      try {
        const result = await fn();
        steps.push({ name, status: "passed", attempts: 1, durationMs: Date.now() - startedAt });
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
        await capture(`failure-a${attempt}`);
        throw new AttemptFailure(
          errorMessage(error),
          category,
          name,
          steps,
          screenshots,
          await currentTokens(),
          { cause: error }
        );
      }
    };

    const performLogin = async (): Promise<void> => {
      await act("type %username% into the username field", {
        variables: { username: options.credentials.username },
        timeout: options.stepTimeoutMs
      });
      await act("type %password% into the password field", {
        variables: { password: options.credentials.password },
        timeout: options.stepTimeoutMs
      });
      await act("click the sign-in/submit button of the login form", {
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
        await act("accept the cookie consent so the page content is shown", {
          timeout: options.stepTimeoutMs
        });
        await pollUntil(async () => !(await consentPresent(view)), 5_000);
        if (await consentPresent(view)) {
          await submitConsentForm(view);
          await pollUntil(async () => !(await consentPresent(view)), 5_000);
        }
        if (await consentPresent(view)) {
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
          await act("close the popup dialog", { timeout: options.stepTimeoutMs });
          await pollUntil(async () => !(await overlayPresent(page!)), 3_000);
          if (await overlayPresent(page!)) {
            await clickOverlayDismiss(page!);
            await pollUntil(async () => !(await overlayPresent(page!)), 3_000);
          }
          if (await overlayPresent(page!)) {
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
          let ready = await waitForContent(page!, CONTENT_POLL_MS, "stats");
          if (!ready) {
            const [action] = await observe(
              "find the tab or control that reveals the full season standings table"
            );
            if (action) {
              llmCalls += 1;
              await stagehand!.act(action);
            } else {
              await act("click the tab that reveals the full season standings table", {
                timeout: options.stepTimeoutMs
              });
            }
            await page!.waitForTimeout(400);
            ready = await waitForContent(page!, CONTENT_POLL_MS, "stats");
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
              await act("go to the next page of the standings table", {
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
          if (!(await waitForContent(page!, CONTENT_POLL_MS, "odds"))) {
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
        tokens: await currentTokens()
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
