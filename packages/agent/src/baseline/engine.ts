import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  SESSION_COOKIE,
  type ExtractedOddsRow,
  type ExtractedStatsRow,
  type FailureCategory,
  type StepResult
} from "@ssda/shared";
import {
  AttemptFailure,
  loadSessionState,
  runPipeline,
  saveScreenshot,
  saveSessionState,
  type AttemptOutcome,
  type Engine,
  type PipelineOptions
} from "../core";
import {
  dedupeByTeam,
  SELECTORS,
  toOddsRow,
  toStatsRow,
  totalPagesFrom
} from "./mapping";

const CONSENT_COOKIE = "lab_consent";
const VIEWPORT = { width: 1280, height: 800 } as const;
const TABLE_TIMEOUT_MS = 20_000;
const MODAL_SETTLE_MS = 1_000;
const PAGE_STEP_MS = 250;

/**
 * One whole browser attempt. Builds a FRESH browser, walks the canonical
 * pipeline against the default DOM, and returns an AttemptOutcome on success.
 * Any operational failure throws AttemptFailure (categorised, with the steps
 * and screenshots gathered so far); the browser is always closed in `finally`.
 */
async function runAttempt(options: PipelineOptions, attempt: number): Promise<AttemptOutcome> {
  const { labUrl } = options;
  const steps: StepResult[] = [];
  const screenshots: string[] = [];
  let browser: Browser | undefined;
  let context!: BrowserContext;
  let page!: Page;

  const msSince = (start: number): number => Math.max(0, Date.now() - start);
  const pass = (name: string, start: number): void => {
    steps.push({ name, status: "passed", attempts: 1, durationMs: msSince(start) });
  };
  const snap = async (name: string): Promise<void> => {
    if (!page) return;
    try {
      screenshots.push(await saveScreenshot(options.runDir, name, await page.screenshot()));
    } catch {
      /* screenshots are best-effort and never fail the run */
    }
  };
  const fail = async (
    name: string,
    category: FailureCategory,
    message: string,
    start: number,
    cause?: unknown
  ): Promise<never> => {
    await snap(`failure-a${attempt}`);
    steps.push({ name, status: "failed", attempts: 1, durationMs: msSince(start), category, error: message });
    throw new AttemptFailure(
      message,
      category,
      name,
      steps,
      screenshots,
      null,
      // baseline neither heals nor uses deterministic fallbacks.
      undefined,
      undefined,
      cause !== undefined ? { cause } : undefined,
      // …nor runs the B2 ladder or records a step trace.
      undefined,
      undefined,
      // The build this trial ran against. Attaching it HERE is the fix for the
      // gate-1 nulls: the success return below records it, but a trial that
      // fails mid-attempt never reaches that return, so the version — already
      // in hand since launch — was being discarded. `browser.version()` is the
      // same synchronous accessor used there; undefined only when the launch
      // itself never produced a browser.
      browser ? browser.version() : undefined
    );
  };
  const firstLine = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split("\n")[0]?.slice(0, 300) ?? "error";
  };

  const exists = async (selector: string): Promise<boolean> =>
    (await page.locator(selector).count()) > 0;
  const isVisible = async (selector: string): Promise<boolean> => {
    const loc = page.locator(selector);
    if ((await loc.count()) === 0) return false;
    return loc.first().isVisible();
  };
  const readLoginError = async (): Promise<string | null> => {
    try {
      const loc = page.locator(".error");
      if ((await loc.count()) === 0) return null;
      const text = (await loc.first().textContent())?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  };

  // Clear the consent interstitial wherever it appears (a reused session hits it
  // before login; a fresh session only reaches it after logging in). Emits a
  // "consent" step only when the banner is actually present and clicked.
  const handleConsent = async (): Promise<void> => {
    if (!(await exists(SELECTORS.acceptCookies))) return;
    const start = Date.now();
    try {
      await page.click(SELECTORS.acceptCookies);
      await page.waitForLoadState("load");
    } catch (err) {
      await fail("consent", "blocked_ui", firstLine(err), start, err);
    }
    if (await exists(SELECTORS.acceptCookies)) {
      await fail("consent", "blocked_ui", "consent banner still present after accepting", start);
    }
    pass("consent", start);
  };

  // Fill the hardcoded login form. Shared by the initial login and the mid-flow
  // relogin; emits its step only when we are actually sitting on /login.
  const handleLogin = async (name: "login" | "relogin"): Promise<void> => {
    if (!page.url().includes("/login")) return;
    const start = Date.now();
    if (!(await exists(SELECTORS.loginForm))) {
      await fail(name, "not_found", "login form not found — selector #login-form matched nothing", start);
    }
    try {
      await page.fill(SELECTORS.username, options.credentials.username);
      await page.fill(SELECTORS.password, options.credentials.password);
      await page.click(SELECTORS.loginSubmit);
      await page.waitForLoadState("load");
    } catch (err) {
      await fail(name, "auth", firstLine(err), start, err);
    }
    if (page.url().includes("/login")) {
      const message = (await readLoginError()) ?? "login did not stick — still on /login after submit";
      await fail(name, "auth", message, start);
    }
    pass(name, start);
  };

  const readStatsRows = async (): Promise<ExtractedStatsRow[]> => {
    const raw = await page.$$eval(SELECTORS.statsRows, (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""))
    );
    return raw.map(toStatsRow);
  };
  const readOddsRows = async (): Promise<ExtractedOddsRow[]> => {
    const raw = await page.$$eval(SELECTORS.oddsRows, (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""))
    );
    return raw.map(toOddsRow);
  };
  const pageIndicatorText = async (): Promise<string | null> => {
    if (!(await exists(SELECTORS.pageIndicator))) return null;
    return page.locator(SELECTORS.pageIndicator).first().textContent();
  };
  // Every paginated row is embedded in the #table-data JSON island (a sanctioned
  // hook). We read the DISPLAYED text of each cell — resolving the form cell's
  // chip markup to plain letters — and map by the SAME fixed indices, so the
  // island is just a second source of the exact rows the table renders.
  const readTableDataRows = async (): Promise<ExtractedStatsRow[]> => {
    const raw = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      let data: string[][];
      try {
        data = JSON.parse(el.textContent ?? "[]") as string[][];
      } catch {
        return null;
      }
      const holder = document.createElement("template");
      return data.map((row) =>
        row.map((cellHtml) => {
          holder.innerHTML = cellHtml;
          return holder.content.textContent ?? "";
        })
      );
    }, SELECTORS.tableData);
    return raw ? raw.map(toStatsRow) : [];
  };

  try {
    // 1. init-browser
    {
      const start = Date.now();
      try {
        browser = await chromium.launch({ headless: options.headless });
        context = await browser.newContext({ viewport: VIEWPORT });
        context.setDefaultNavigationTimeout(options.navTimeoutMs);
        context.setDefaultTimeout(options.navTimeoutMs);
        page = await context.newPage();
      } catch (err) {
        await fail("init-browser", "internal", firstLine(err), start, err);
      }
      pass("init-browser", start);
    }

    // 2. load-session (reuse / expired)
    if (options.session.mode === "reuse" || options.session.mode === "expired") {
      const start = Date.now();
      const stateFile = options.session.stateFile;
      if (stateFile) {
        const saved = await loadSessionState(stateFile);
        if (saved && saved.cookies.length > 0) {
          await context.addCookies(
            saved.cookies.map((c) => ({ name: c.name, value: c.value, url: labUrl }))
          );
        }
      }
      pass("load-session", start);
    }

    // 3. goto-stats
    {
      const start = Date.now();
      try {
        await page.goto(`${labUrl}/stats`, { waitUntil: "load" });
      } catch (err) {
        await fail("goto-stats", "navigation", firstLine(err), start, err);
      }
      pass("goto-stats", start);
    }

    // 4-6. gates: consent (pre-login for reused sessions), login, consent again
    // (post-login for fresh sessions — the wall only appears once authenticated).
    await handleConsent();
    await handleLogin("login");
    await handleConsent();

    // 7. dismiss-modal (the newsletter modal surfaces ~800ms after load)
    {
      const start = Date.now();
      await page.waitForTimeout(MODAL_SETTLE_MS);
      if (await isVisible(SELECTORS.modal)) {
        try {
          await page.click(SELECTORS.modalClose);
        } catch (err) {
          await fail("dismiss-modal", "blocked_ui", firstLine(err), start, err);
        }
        if (await isVisible(SELECTORS.modal)) {
          await fail("dismiss-modal", "blocked_ui", "newsletter modal still visible after close", start);
        }
        pass("dismiss-modal", start);
      }
    }

    // 8. reveal-table (open the non-default tab if present, then wait for rows)
    {
      const start = Date.now();
      if (await exists(SELECTORS.tabTable)) {
        try {
          await page.click(SELECTORS.tabTable);
        } catch (err) {
          await fail("reveal-table", "blocked_ui", firstLine(err), start, err);
        }
      }
      try {
        await page.waitForSelector(SELECTORS.statsRows, { timeout: TABLE_TIMEOUT_MS });
      } catch (err) {
        await fail(
          "reveal-table",
          "not_found",
          "standings table not found — selector #standings matched nothing or stayed empty",
          start,
          err
        );
      }
      await snap(`stats-a${attempt}`);
      pass("reveal-table", start);
    }

    // 9. extract-stats. When a "Page X of N" pager reports N > 1, walk the
    // pages by clicking #next-page; if the click loop yields fewer rows than
    // the #table-data island holds (e.g. a broken pager script), fall back to
    // the island. Rows are deduped by team.
    let statsRaw: { rows: ExtractedStatsRow[] } = { rows: [] };
    {
      const start = Date.now();
      const batches: ExtractedStatsRow[][] = [await readStatsRows()];
      const totalPages = totalPagesFrom(await pageIndicatorText());
      if (totalPages > 1) {
        for (let p = 2; p <= totalPages; p++) {
          try {
            await page.click(SELECTORS.nextPage);
          } catch (err) {
            await fail("extract-stats", "blocked_ui", firstLine(err), start, err);
          }
          await page.waitForTimeout(PAGE_STEP_MS);
          batches.push(await readStatsRows());
        }
        const clicked = dedupeByTeam(batches.flat());
        const island = await readTableDataRows();
        if (island.length > clicked.length) {
          batches.push(island);
        }
      }
      statsRaw = { rows: dedupeByTeam(batches.flat()) };
      pass("extract-stats", start);
    }

    // 10. goto-odds (+ relogin if a stale session bounced us back to /login)
    {
      const start = Date.now();
      try {
        await page.goto(`${labUrl}/odds`, { waitUntil: "load" });
      } catch (err) {
        await fail("goto-odds", "navigation", firstLine(err), start, err);
      }
      pass("goto-odds", start);
    }
    if (page.url().includes("/login")) {
      await handleLogin("relogin");
      try {
        await page.goto(`${labUrl}/odds`, { waitUntil: "load" });
      } catch (err) {
        await fail("relogin", "navigation", firstLine(err), Date.now(), err);
      }
    }

    // 11. extract-odds
    let oddsRaw: { rows: ExtractedOddsRow[] } = { rows: [] };
    {
      const start = Date.now();
      try {
        await page.waitForSelector(SELECTORS.oddsRows, { timeout: TABLE_TIMEOUT_MS });
      } catch (err) {
        await fail(
          "extract-odds",
          "not_found",
          "odds table not found — selector #odds-table matched nothing or stayed empty",
          start,
          err
        );
      }
      await snap(`odds-a${attempt}`);
      oddsRaw = { rows: await readOddsRows() };
      pass("extract-odds", start);
    }

    // 12. save-session
    if (options.saveSessionStateTo) {
      const start = Date.now();
      const cookies = await context.cookies(labUrl);
      const filtered = cookies
        .filter((c) => c.name === SESSION_COOKIE || c.name === CONSENT_COOKIE)
        .map((c) => ({ name: c.name, value: c.value }));
      await saveSessionState(options.saveSessionStateTo, labUrl, filtered);
      pass("save-session", start);
    }

    // `browser.version()` is a synchronous accessor over the value Playwright
    // already received on the connect handshake: reading it costs nothing, adds
    // no wait, and never touches the page. The baseline records NO stepTrace —
    // it has no escalation machinery to trace (docs/RECORD_FORMAT.md).
    return {
      steps,
      statsRaw,
      oddsRaw,
      screenshots,
      tokens: null,
      ...(browser ? { chromeVersion: browser.version() } : {})
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export const baselineEngine: Engine = {
  name: "baseline",
  run(options) {
    return runPipeline("baseline", options, (attempt) => runAttempt(options, attempt));
  }
};
