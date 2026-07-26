import { describe, expect, it } from "vitest";
import { readinessThresholds, waitForContent, type DomReadyPage } from "./domReady";

/**
 * The readiness predicate's ARM switch (docs/PROTOCOL_2B.md §Design). The arms
 * differ in EXACTLY one thing — the row/card counts that mean "ready" — so that
 * is what these tests pin, from both directions:
 *
 *  · `frozen` must remain the Phase-2A predicate bit-for-bit. If these numbers
 *    move, Arm F stops being a replication control and the whole ablation loses
 *    its baseline.
 *  · `any-row` must be ready at ONE row or card, with every other property of
 *    the poll — structure-awareness (requireHeading), the caller's timeout —
 *    untouched, so the ablation isolates a single variable.
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
