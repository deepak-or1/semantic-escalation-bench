import { afterEach, describe, expect, it, vi } from "vitest";
import { readinessThresholds, waitForContent, type DomReadyPage } from "./domReady";

/**
 * Two suites over the shared readiness poll.
 *
 * The first pins the ARM switch (docs/PROTOCOL_2B.md §Design). The arms differ
 * in EXACTLY one thing — the row/card counts that mean "ready" — so that is
 * what these tests pin, from both directions:
 *
 *  · `frozen` must remain the Phase-2A predicate bit-for-bit. If these numbers
 *    move, Arm F stops being a replication control and the whole ablation loses
 *    its baseline.
 *  · `any-row` must be ready at ONE row or card, with every other property of
 *    the poll — structure-awareness (requireHeading), the caller's timeout —
 *    untouched, so the ablation isolates a single variable.
 *
 * The second exercises the in-browser poll function itself: the page's
 * `evaluate` runs the serialised function locally against a `document` stub
 * covering only the DOM calls that function makes, so the real predicates and
 * the real poll loop run without a browser.
 */

/** A page that records the argument `waitForContent` serialises into the browser. */
function capturingPage(): { page: DomReadyPage; args: Record<string, unknown>[] } {
  const args: Record<string, unknown>[] = [];
  const page: DomReadyPage = {
    evaluate: async <R, Arg>(_fn: string | ((arg: Arg) => R | Promise<R>), arg?: Arg) => {
      args.push(arg as Record<string, unknown>);
      return true as R;
    }
  };
  return { page, args };
}

describe("readinessThresholds — frozen is Phase 2A, bit-for-bit", () => {
  it("stats: >= 5 rows or >= 8 cards, heading required", () => {
    expect(readinessThresholds("stats", "frozen")).toEqual({
      minRows: 5,
      requireHeading: true,
      minCards: 8
    });
  });

  it("odds: >= 4 rows or >= 4 cards, no heading required", () => {
    expect(readinessThresholds("odds", "frozen")).toEqual({
      minRows: 4,
      requireHeading: false,
      minCards: 4
    });
  });

  it("frozen is the DEFAULT — an omitted arm is the Phase-2A predicate", () => {
    expect(readinessThresholds("stats")).toEqual(readinessThresholds("stats", "frozen"));
    expect(readinessThresholds("odds")).toEqual(readinessThresholds("odds", "frozen"));
  });
});

describe("readinessThresholds — any-row is ready at one row or card", () => {
  it("stats: >= 1 row or >= 1 card", () => {
    expect(readinessThresholds("stats", "any-row")).toEqual({
      minRows: 1,
      requireHeading: true,
      minCards: 1
    });
  });

  it("odds: >= 1 row or >= 1 card", () => {
    expect(readinessThresholds("odds", "any-row")).toEqual({
      minRows: 1,
      requireHeading: false,
      minCards: 1
    });
  });

  it("changes ONLY the counts: structure-awareness is a property of the content mode, not the arm", () => {
    for (const mode of ["stats", "odds"] as const) {
      expect(readinessThresholds(mode, "any-row").requireHeading).toBe(
        readinessThresholds(mode, "frozen").requireHeading
      );
    }
  });
});

describe("waitForContent passes the arm's thresholds into the page", () => {
  it("omitting the arm sends the frozen thresholds — every existing call site is unchanged", async () => {
    const { page, args } = capturingPage();
    await waitForContent(page, 8_000, "stats");
    expect(args[0]).toEqual({ minRows: 5, requireHeading: true, minCards: 8, timeoutMs: 8_000 });
  });

  it("any-row sends the relaxed thresholds and the caller's timeout untouched", async () => {
    const { page, args } = capturingPage();
    await waitForContent(page, 8_000, "stats", "any-row");
    expect(args[0]).toEqual({ minRows: 1, requireHeading: true, minCards: 1, timeoutMs: 8_000 });
    await waitForContent(page, 3_000, "odds", "any-row");
    expect(args[1]).toEqual({ minRows: 1, requireHeading: false, minCards: 1, timeoutMs: 3_000 });
  });

  it("still never throws — a page whose evaluate rejects reads as not-ready", async () => {
    const page: DomReadyPage = {
      evaluate: async () => {
        throw new Error("execution context destroyed");
      }
    };
    await expect(waitForContent(page, 100, "stats", "any-row")).resolves.toBe(false);
  });
});

// ── In-browser poll behaviour (frozen arm) ──────────────────────────────────

interface FakeElement {
  getClientRects(): unknown[];
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function element(children: Record<string, FakeElement[]> = {}, visible = true): FakeElement {
  return {
    getClientRects: () => (visible ? [{}] : []),
    querySelector: (selector) => children[selector]?.[0] ?? null,
    querySelectorAll: (selector) => children[selector] ?? []
  };
}

/** A table with no <tbody>, so the poll counts <tr> on the table itself. */
function table(rowCount: number, visible = true): FakeElement {
  return element({ tr: Array.from({ length: rowCount }, () => element()) }, visible);
}

/** A card-like block: always has a <dl>, optionally the <h3> stats mode requires. */
function card(heading: boolean): FakeElement {
  return element(heading ? { dl: [element()], h3: [element()] } : { dl: [element()] });
}

function stubDocument(nodes: { tables?: () => FakeElement[]; cards?: () => FakeElement[] }): void {
  // Selector-exact so a future query in the poll falls through to [] instead
  // of silently reusing the card list.
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (selector === "table") return nodes.tables?.() ?? [];
      if (selector === "article, div") return nodes.cards?.() ?? [];
      return [];
    }
  });
}

/** Page that runs the in-browser function in this process against the stub DOM. */
const domPage: DomReadyPage = {
  evaluate: async <R, Arg>(
    pageFunction: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg
  ): Promise<R> => {
    if (typeof pageFunction === "string") throw new Error("expected a function, not an expression");
    return await pageFunction(arg as Arg);
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waitForContent — poll behaviour under the frozen predicate", () => {
  it("is ready as soon as a visible table has enough body rows", async () => {
    stubDocument({ tables: () => [table(5)] });
    expect(await waitForContent(domPage, 1000, "stats")).toBe(true);
  });

  // Pins the frozen readiness floor: a genuinely loaded three-row table never
  // counts as ready in stats mode. This is the behaviour behind the
  // readiness-gate finding in docs/PHASE2A_RESULTS.md — the pin documents it,
  // it doesn't endorse it (the any-row arm above is Phase 2B's ablation of it).
  it("stats mode never reports ready for a valid table below five rows", async () => {
    vi.useFakeTimers();
    stubDocument({ tables: () => [table(3)] });

    const pending = waitForContent(domPage, 500, "stats");
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toBe(false);
  });

  it("counts heading-less card blocks in odds mode but not in stats mode", async () => {
    vi.useFakeTimers();
    stubDocument({ cards: () => Array.from({ length: 8 }, () => card(false)) });

    expect(await waitForContent(domPage, 300, "odds")).toBe(true);

    const stats = waitForContent(domPage, 300, "stats");
    await vi.advanceTimersByTimeAsync(600);
    expect(await stats).toBe(false);
  });

  it("times out to false when the only matching table is hidden (content behind a tab)", async () => {
    vi.useFakeTimers();
    stubDocument({ tables: () => [table(9, false)] });

    const pending = waitForContent(domPage, 500, "stats");
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toBe(false);
  });

  it("keeps polling so content that swaps in late still counts as ready", async () => {
    vi.useFakeTimers();
    let tables: FakeElement[] = [];
    stubDocument({ tables: () => tables });

    const pending = waitForContent(domPage, 5000, "odds");
    await vi.advanceTimersByTimeAsync(300);
    tables = [table(4)];
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe(true);
  });
});
