import { Stagehand, type Action, type V3Options } from "@browserbasehq/stagehand";
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
import { ODDS_INSTRUCTION, STATS_INSTRUCTION } from "../stagehand/engine";
import { mergeStatsRows, parsePageInfo } from "../stagehand/helpers";
import { bootstrapActions, type CacheKey } from "./bootstrap";
import { loadSeedCache, SelectorCache } from "./cache";
import {
  oddsRowsFrom,
  readVisibleTables,
  selectOddsTable,
  selectStatsTable,
  statsRowsFrom
} from "./extract";

/**
 * The hybrid engine: a production team's hand-written selectors, replayed as a
 * deterministic CACHE of Stagehand Action objects (zero LLM), plus a
 * structure-aware, header-name-mapped reader for extraction. When a cached
 * selector or the table shape it assumes stops matching, an EXPLICIT, key-gated
 * repair path (observe / extract) re-discovers it and heals the cache. Keyless,
 * the deterministic tier still runs and produces real numbers — repairs are
 * simply unavailable, and those failures are honest results, not crashes.
 *
 * ONE Stagehand v3.6 stack drives everything: env LOCAL, disableAPI, disablePino,
 * verbose 0, and selfHeal:false (mandatory — act(Action)'s built-in fallback
 * silently invokes the LLM on selector failure; the deterministic tier requires
 * that path closed). A `model` is set ONLY when a provider key is present.
 */

type StagehandPage = NonNullable<ReturnType<Stagehand["context"]["activePage"]>>;
type ActOptions = Parameters<Stagehand["act"]>[1];

const VIEWPORT = { width: 1280, height: 800 } as const;
const CONTENT_POLL_MS = 8_000;
const MODAL_SETTLE_MS = 1_200;
const CONSENT_SELECTOR = 'form[action="/consent"]';

// Repair-unavailable detail strings. Two distinguishable states: no model key
// at all vs. repair explicitly frozen (--no-repair). When --no-repair is set it
// is the operative reason and takes precedence in the message, even if keyless.
/** Keyless act-step failure detail. */
const ACT_REPAIR_NO_KEY = "cached selector failed; semantic repair unavailable (no model key)";
/** Explicitly frozen (--no-repair) act-step failure detail. */
const ACT_REPAIR_DISABLED = "cached selector failed; semantic repair disabled (--no-repair)";
/** Keyless extract failure detail. */
const EXTRACT_REPAIR_NO_KEY =
  "no header-mappable table found; semantic extraction unavailable (no model key)";
/** Explicitly frozen (--no-repair) extract failure detail. */
const EXTRACT_REPAIR_DISABLED =
  "no header-mappable table found; semantic extraction disabled (--no-repair)";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function failureCategoryFor(error: unknown, fallback: FailureCategory): FailureCategory {
  if (error instanceof PipelineStepError) return error.category;
  const message = errorMessage(error);
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/net::|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|socket hang up/i.test(message)) {
    return "navigation";
  }
  return fallback;
}

/** Construct the (attempt-invariant) Stagehand options: selfHeal OFF; model only when keyed. */
function buildHybridStagehandOptions(
  options: PipelineOptions,
  config: AgentEnvConfig
): V3Options {
  const model = config.stagehandModel ?? undefined;
  if (options.env === "browserbase") {
    return {
      env: "BROWSERBASE",
      ...(model ? { model } : {}),
      disableAPI: true,
      disablePino: true,
      verbose: 0,
      selfHeal: false,
      logger: () => {},
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
    ...(model ? { model } : {}),
    disableAPI: true,
    disablePino: true,
    verbose: 0,
    selfHeal: false,
    logger: () => {},
    localBrowserLaunchOptions: {
      headless: options.headless,
      viewport: VIEWPORT,
      // Trial-isolation hardening (2026-07-14): never serve a page from a
      // previous trial's HTTP cache — benchmark trials must always hit the lab.
      args: ["--disable-http-cache"]
    }
  };
}

// ── In-browser predicates (class/id-free, so they survive class drift) ───────

async function consentPresent(page: StagehandPage): Promise<boolean> {
  try {
    return (await page.evaluate(() => !!document.querySelector('form[action="/consent"]'))) === true;
  } catch {
    return false;
  }
}

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

// ── Engine ───────────────────────────────────────────────────────────────────

async function runHybridEngine(options: PipelineOptions): Promise<PipelineResult> {
  // Hybrid NEVER auto-skips: it is designed to run keyless. A model key only
  // unlocks the repair path; without one the deterministic tier still runs.
  const config = loadAgentEnvConfig();
  const hasKey = Boolean(config.stagehandModel);
  // --no-repair freezes the deterministic tier: repair is closed even with a
  // key. `canRepair` gates every observe/extract call; `repairDisabled` selects
  // the honest detail string (frozen vs. keyless), disabled taking precedence.
  const repairDisabled = options.disableRepair === true;
  const canRepair = hasKey && !repairDisabled;
  const stagehandOptions = buildHybridStagehandOptions(options, config);

  const wantStats = options.pages.includes("stats");
  const wantOdds = options.pages.includes("odds");

  // Per-trial cache + healed-step tracking, shared across the run's attempts so a
  // repair discovered on attempt 1 carries into a retry. Trials stay independent
  // because each run() builds its own cache from a fresh clone. Warm-cache runs
  // (--seed-cache) start from a persisted healed cache instead of the bootstrap,
  // replaying an earlier run's repairs deterministically; a missing/malformed
  // seed file raises a clear internal PipelineStepError naming the path.
  const bootstrap = options.seedCacheFile
    ? await loadSeedCache(options.seedCacheFile)
    : bootstrapActions();
  const cache = new SelectorCache(bootstrap);
  const healedSteps = new Set<string>();

  const attemptFn: AttemptFn = async (attempt): Promise<AttemptOutcome> => {
    const steps: StepResult[] = [];
    const screenshots: string[] = [];
    let llmCalls = 0;
    let stagehand: Stagehand | undefined;
    let page: StagehandPage | undefined;
    let statsRaw: { rows: ExtractedStatsRow[] } | undefined;
    let oddsRaw: { rows: ExtractedOddsRow[] } | undefined;
    let consentHandled = false;

    // observe() and extract() are the only model-driven calls; every act() here
    // replays a cached Action deterministically and never touches the LLM.
    const observe = (instruction: string): ReturnType<Stagehand["observe"]> => {
      llmCalls += 1;
      return stagehand!.observe(instruction);
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

    /** Replay a cached Action deterministically; a thrown/`success:false` is a failure. */
    const tryAct = async (action: Action, actOptions?: ActOptions): Promise<boolean> => {
      try {
        const result = await stagehand!.act(action, actOptions);
        return result.success === true;
      } catch {
        return false;
      }
    };

    /**
     * Deterministic act with an EXPLICIT, key-gated repair. On a cached-selector
     * failure: with a key, observe() re-discovers the element, we act it and heal
     * the cache; without a key, we throw a categorised "repair unavailable" error
     * (the honest keyless boundary). This is the ONLY place hybrid heals a step.
     */
    const cachedActOrRepair = async (params: {
      step: string;
      key: CacheKey;
      category: FailureCategory;
      repairInstruction: string;
      /** "fill" preserves the placeholder args + variables through the repair. */
      repairKind: "click" | "fill";
      actOptions?: ActOptions;
      placeholder?: string;
    }): Promise<void> => {
      const cached = cache.action(params.key);
      if (await tryAct(cached, params.actOptions)) return;

      if (!canRepair) {
        const detail = repairDisabled ? ACT_REPAIR_DISABLED : ACT_REPAIR_NO_KEY;
        throw new PipelineStepError(
          `${params.step} (${cached.selector}): ${detail}`,
          params.category,
          params.step
        );
      }

      const [candidate] = await observe(params.repairInstruction);
      if (!candidate) {
        throw new PipelineStepError(
          `${params.step}: cached selector failed and observe found no replacement element`,
          params.category,
          params.step
        );
      }
      const healed: Action =
        params.repairKind === "fill"
          ? {
              selector: candidate.selector,
              method: "fill",
              arguments: [params.placeholder ?? ""],
              description: cached.description
            }
          : {
              selector: candidate.selector,
              method: candidate.method ?? "click",
              arguments: candidate.arguments ?? [],
              description: cached.description
            };
      if (!(await tryAct(healed, params.actOptions))) {
        throw new PipelineStepError(
          `${params.step}: repaired selector still failed to act`,
          params.category,
          params.step
        );
      }
      cache.heal(params.step, params.key, healed);
      healedSteps.add(params.step);
    };

    /** Key-gated extraction repair: reuse the Stagehand engine's IDENTICAL instructions. */
    const extractRepair = async (
      step: "extract-stats" | "extract-odds"
    ): Promise<{ statsRows?: ExtractedStatsRow[]; oddsRows?: ExtractedOddsRow[] }> => {
      if (!canRepair) {
        const detail = repairDisabled ? EXTRACT_REPAIR_DISABLED : EXTRACT_REPAIR_NO_KEY;
        throw new PipelineStepError(detail, "extraction", step);
      }
      llmCalls += 1;
      if (step === "extract-stats") {
        const result = await stagehand!.extract(STATS_INSTRUCTION, ExtractedStatsPageSchema, {
          timeout: options.stepTimeoutMs
        });
        healedSteps.add(step);
        return { statsRows: result.rows };
      }
      const result = await stagehand!.extract(ODDS_INSTRUCTION, ExtractedOddsPageSchema, {
        timeout: options.stepTimeoutMs
      });
      healedSteps.add(step);
      return { oddsRows: result.rows };
    };

    const performLogin = async (stepName: "login" | "relogin"): Promise<void> => {
      await cachedActOrRepair({
        step: stepName,
        key: "username",
        category: "not_found",
        repairInstruction: "find the username text field of the login form",
        repairKind: "fill",
        placeholder: "%username%",
        actOptions: { variables: { username: options.credentials.username }, timeout: options.stepTimeoutMs }
      });
      await cachedActOrRepair({
        step: stepName,
        key: "password",
        category: "not_found",
        repairInstruction: "find the password field of the login form",
        repairKind: "fill",
        placeholder: "%password%",
        actOptions: { variables: { password: options.credentials.password }, timeout: options.stepTimeoutMs }
      });
      await cachedActOrRepair({
        step: stepName,
        key: "login-submit",
        category: "not_found",
        repairInstruction: "find the sign-in / submit button of the login form",
        repairKind: "click",
        actOptions: { timeout: options.stepTimeoutMs }
      });
    };

    // Consent walls only appear once authenticated, so this runs both before and
    // after login; whichever hits first emits the single "consent" step.
    const clearConsentIfPresent = async (): Promise<void> => {
      if (consentHandled || !page) return;
      if (!(await consentPresent(page))) return;
      const view = page;
      await runStep("consent", "not_found", async () => {
        await cachedActOrRepair({
          step: "consent",
          key: "consent",
          category: "not_found",
          repairInstruction: "accept the cookie consent so the page content is shown",
          repairKind: "click",
          actOptions: { timeout: options.stepTimeoutMs }
        });
        await pollUntil(async () => !(await consentPresent(view)), 5_000);
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
          await performLogin("login");
          const authed = await pollUntil(async () => !page!.url().includes("/login"), 8_000);
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
        await runStep("dismiss-modal", "not_found", async () => {
          await cachedActOrRepair({
            step: "dismiss-modal",
            key: "dismiss-modal",
            category: "not_found",
            repairInstruction: "close the popup dialog blocking the page",
            repairKind: "click",
            actOptions: { timeout: options.stepTimeoutMs }
          });
          await pollUntil(async () => !(await overlayPresent(page!)), 3_000);
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
            // Content is not yet readable and did not delay-render in: try the
            // cached tab that reveals the standings (repair-gated like any act).
            await cachedActOrRepair({
              step: "reveal-table",
              key: "reveal-table",
              category: "not_found",
              repairInstruction: "find the tab or control that reveals the full season standings table",
              repairKind: "click",
              actOptions: { timeout: options.stepTimeoutMs }
            });
            await page!.waitForTimeout(400);
            ready = await waitForContent(page!, CONTENT_POLL_MS, "stats");
          }
          if (!ready) {
            throw new PipelineStepError("stats content never appeared", "not_found", "reveal-table");
          }
        });

        await runStep("extract-stats", "extraction", async () => {
          await capture(`stats-a${attempt}`);
          const table = selectStatsTable(await readVisibleTables(page!));
          if (!table) {
            // Structure changed shape (e.g. a card grid): no header-mappable table.
            const { statsRows } = await extractRepair("extract-stats");
            statsRaw = { rows: statsRows ?? [] };
            return;
          }
          let rows = statsRowsFrom(table);
          let info = parsePageInfo(await page!.evaluate(() => document.body?.innerText ?? ""));
          if (info && info.total > 1) {
            let budget = info.total + 2;
            while (info && info.current < info.total && budget > 0) {
              budget -= 1;
              await cachedActOrRepair({
                step: "extract-stats",
                key: "next-page",
                category: "not_found",
                repairInstruction: "find the control that advances to the next page of the standings table",
                repairKind: "click",
                actOptions: { timeout: options.stepTimeoutMs }
              });
              await page!.waitForTimeout(600);
              const nextTable = selectStatsTable(await readVisibleTables(page!));
              if (nextTable) rows = mergeStatsRows(rows, statsRowsFrom(nextTable));
              const next = parsePageInfo(await page!.evaluate(() => document.body?.innerText ?? ""));
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
            await performLogin("relogin");
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
            throw new PipelineStepError("odds content never appeared", "not_found", "extract-odds");
          }
          await capture(`odds-a${attempt}`);
          const table = selectOddsTable(await readVisibleTables(page!));
          if (!table) {
            const { oddsRows } = await extractRepair("extract-odds");
            oddsRaw = { rows: oddsRows ?? [] };
            return;
          }
          oddsRaw = { rows: oddsRowsFrom(table) };
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
        ...(healedSteps.size > 0 ? { healedSteps: [...healedSteps] } : {})
      };
    } finally {
      try {
        await stagehand?.close();
      } catch {
        /* closing a crashed browser is best-effort */
      }
    }
  };

  const result = await runPipeline("hybrid", options, attemptFn);
  // Persist the healed selector cache (placeholders intact) when anything healed.
  await cache.persist(options.runDir);
  return result;
}

export const hybridEngine: Engine = {
  name: "hybrid",
  run: runHybridEngine
};
