/**
 * Structural, class-free "is the content ready?" poll shared by the Stagehand
 * and hybrid engines. Runs entirely inside the browser: it treats content as
 * ready when a visible table has enough body rows, or when enough card-like
 * blocks are present. This handles delayed render (content swaps in later) and
 * distinguishes genuinely-hidden content (behind a tab) by timing out.
 *
 * Extracted verbatim from the Stagehand engine so both engines gate extraction
 * on the exact same readiness definition (no behaviour change).
 */

export type ContentMode = "stats" | "odds";

/**
 * Minimal structural view of a page: just the `evaluate` used here. Matches the
 * Stagehand understudy `Page` (and Playwright's `Page`) without pulling either
 * type into core.
 */
export interface DomReadyPage {
  evaluate<R = unknown, Arg = unknown>(
    pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg
  ): Promise<R>;
}

/**
 * Poll (inside the browser) until the expected content is present and visible.
 * Structural, class-free predicates: a table with enough rows, or enough
 * card-like blocks. Handles delayed render (content swaps in later) and
 * distinguishes genuinely-hidden content (behind a tab) by timing out.
 */
export async function waitForContent(
  page: DomReadyPage,
  timeoutMs: number,
  mode: ContentMode
): Promise<boolean> {
  try {
    // NOTE: the in-browser function below uses ONLY anonymous inline arrows and
    // no named function expressions. Bundlers (esbuild via tsx/vitest) wrap named
    // functions with a `__name(...)` keepNames helper that is undefined once the
    // function is serialised into the page — so `const visible = () => …` here
    // would throw a ReferenceError. Keep the body helper-free.
    return await page.evaluate(
      async (arg: { minRows: number; requireHeading: boolean; minCards: number; timeoutMs: number }) => {
        const deadline = Date.now() + arg.timeoutMs;
        for (;;) {
          let ok = false;
          for (const table of Array.from(document.querySelectorAll("table"))) {
            if (table.getClientRects().length === 0) continue;
            const body = table.querySelector("tbody") ?? table;
            if (body.querySelectorAll("tr").length >= arg.minRows) {
              ok = true;
              break;
            }
          }
          if (!ok) {
            let count = 0;
            for (const el of Array.from(document.querySelectorAll("article, div"))) {
              if (el.getClientRects().length === 0) continue;
              if (!el.querySelector("dl")) continue;
              if (arg.requireHeading && !el.querySelector("h3")) continue;
              count += 1;
            }
            if (count >= arg.minCards) ok = true;
          }
          if (ok) return true;
          if (Date.now() >= deadline) return ok;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      },
      mode === "stats"
        ? { minRows: 5, requireHeading: true, minCards: 8, timeoutMs }
        : { minRows: 4, requireHeading: false, minCards: 4, timeoutMs }
    );
  } catch {
    return false;
  }
}
