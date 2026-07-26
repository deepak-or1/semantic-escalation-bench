/**
 * Browser-build provenance for the Stagehand-backed engines (record version 2,
 * docs/RECORD_FORMAT.md).
 *
 * The Playwright baseline gets its build for free from `browser.version()`. The
 * Stagehand-backed engines drive Chrome over CDP and expose no version accessor,
 * so the build is read ONCE per engine init from the CDP `/json/version`
 * endpoint — metadata only. Hard rules this module exists to enforce:
 *
 *  - It is NEVER called on a page path and never per step: one read, at init.
 *  - It is timeout-guarded (CHROME_VERSION_TIMEOUT_MS) so a wedged endpoint can
 *    never stall a trial.
 *  - ANY failure — unreachable, non-200, malformed body, timeout, a connect URL
 *    that will not parse — yields `null`. It never throws, so recording the
 *    build can never turn a passing trial into an engine error.
 */

/**
 * Thrown when a run demands browser provenance (`requireChromeVersion`) and the
 * build could not be acquired. Distinguished from every other failure on
 * purpose: it is a PROVENANCE abort, not an engine failure, so the runner must
 * rethrow it rather than record it as a crashed trial — a run that cannot meet
 * Phase 2B's non-null requirement must stop, not produce a trial record saying
 * the engine broke.
 *
 * Raised at ACQUISITION time, i.e. immediately after browser init and before any
 * navigation or semantic step, so a strict run spends nothing on a trial whose
 * provenance can never satisfy the protocol.
 */
export class ChromeVersionUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(
      `requireChromeVersion: the browser build could not be acquired (${detail}). ` +
        "Aborting before any navigation or semantic step — this run cannot produce " +
        "evidence that satisfies the non-null browser-provenance requirement."
    );
    this.name = "ChromeVersionUnavailableError";
  }
}

/** Upper bound on a SINGLE metadata read. */
export const CHROME_VERSION_TIMEOUT_MS = 1_500;

/**
 * Total budget for acquiring the build at engine init, across retries, and the
 * spacing between attempts. Bounded on purpose: this runs once per trial, off
 * every page path, and a browser that cannot answer within ten seconds of
 * finishing its own init is not going to.
 */
export const CHROME_VERSION_BUDGET_MS = 10_000;
export const CHROME_VERSION_RETRY_MS = 300;

/**
 * Derive the CDP HTTP origin from Stagehand's browser-level WebSocket endpoint
 * (`ws://127.0.0.1:PORT/devtools/browser/<id>`). Returns null when the input is
 * not a URL this can honestly map.
 */
export function cdpHttpOrigin(connectUrl: string): string | null {
  try {
    const url = new URL(connectUrl);
    const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : null;
    if (!protocol || !url.host) return null;
    return `${protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Read the browser build from a CDP endpoint's `/json/version`. The endpoint
 * reports e.g. `{ "Browser": "HeadlessChrome/140.0.7339.16" }`; that string is
 * recorded VERBATIM — it is not rewritten to match Playwright's bare build
 * number, because inventing a common format would assert an equivalence this
 * code has not checked.
 */
export async function readChromeVersionFromCdp(
  /**
   * A THUNK, not a string: Stagehand's `connectURL()` throws when the instance
   * is not initialized, so evaluating it at the call site would put that throw
   * OUTSIDE this function's guarantee. Taking the thunk pulls the argument
   * expression inside the guard, making "never throws" cover it too.
   */
  connectUrl: () => string,
  timeoutMs: number = CHROME_VERSION_TIMEOUT_MS
): Promise<string | null> {
  let origin: string | null;
  try {
    origin = cdpHttpOrigin(connectUrl());
  } catch {
    return null;
  }
  if (!origin) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/json/version`, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const browser =
      body !== null && typeof body === "object"
        ? (body as { Browser?: unknown }).Browser
        : undefined;
    return typeof browser === "string" && browser.length > 0 ? browser : null;
  } catch {
    // Unreachable endpoint, abort, non-JSON body — all mean "unknown build".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Acquire the build at engine init, retrying within a bounded budget and
 * stopping at the FIRST success.
 *
 * A single read is enough in every case observed so far — the diagnosed cause of
 * null versions was a discarded value, not a failed read (see runPipeline's
 * no-outcome path) — so this exists for the other half of the guarantee: with
 * `--require-chrome-version` a transient CDP hiccup would abort an entire
 * campaign run, and a bounded poll is far cheaper than that. Still init-only,
 * still never on a page path, still never throws: an exhausted budget yields
 * null exactly as a single failed read did.
 */
export async function acquireChromeVersionFromCdp(
  connectUrl: () => string,
  options: {
    budgetMs?: number;
    retryMs?: number;
    timeoutMs?: number;
    /**
     * When true, an exhausted budget THROWS ChromeVersionUnavailableError instead
     * of returning null. Callers pass the run's `requireChromeVersion`, so the
     * abort happens here — at init, before any page work — rather than after a
     * whole attempt has already run.
     */
    required?: boolean;
  } = {}
): Promise<string | null> {
  const budgetMs = options.budgetMs ?? CHROME_VERSION_BUDGET_MS;
  const retryMs = options.retryMs ?? CHROME_VERSION_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? CHROME_VERSION_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const version = await readChromeVersionFromCdp(connectUrl, timeoutMs);
    if (version !== null) return version;
    if (Date.now() + retryMs >= deadline) {
      if (options.required === true) {
        throw new ChromeVersionUnavailableError(
          `CDP /json/version did not answer within the ${budgetMs}ms init budget`
        );
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
