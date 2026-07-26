import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForContent, type DomReadyPage } from "./domReady";

/**
 * The readiness poll runs inside the browser, so these tests supply (a) a page
 * whose `evaluate` runs the serialised function locally and (b) a `document`
 * stub covering only the four DOM calls that function makes. That exercises the
 * real predicates and the real poll loop without a browser.
 */

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
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) =>
      selector === "table" ? (nodes.tables?.() ?? []) : (nodes.cards?.() ?? [])
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

describe("waitForContent", () => {
  it("passes mode-specific thresholds and the timeout into the page", async () => {
    const args: unknown[] = [];
    const page: DomReadyPage = {
      evaluate: async <R, Arg>(
        _pageFunction: string | ((arg: Arg) => R | Promise<R>),
        arg?: Arg
      ): Promise<R> => {
        args.push(arg);
        return true as unknown as R;
      }
    };

    expect(await waitForContent(page, 1234, "stats")).toBe(true);
    expect(await waitForContent(page, 1234, "odds")).toBe(true);
    expect(args).toEqual([
      { minRows: 5, requireHeading: true, minCards: 8, timeoutMs: 1234 },
      { minRows: 4, requireHeading: false, minCards: 4, timeoutMs: 1234 }
    ]);
  });

  it("is ready as soon as a visible table has enough body rows", async () => {
    stubDocument({ tables: () => [table(5)] });
    expect(await waitForContent(domPage, 1000, "stats")).toBe(true);
  });

  // Pins the frozen readiness floor: a genuinely loaded three-row table never
  // counts as ready in stats mode. This is the behaviour behind the
  // readiness-gate finding in docs/PHASE2A_RESULTS.md — the pin documents it,
  // it doesn't endorse it.
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

  it("returns false instead of throwing when the page evaluation fails", async () => {
    const page: DomReadyPage = {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      }
    };
    expect(await waitForContent(page, 100, "stats")).toBe(false);
  });
});
