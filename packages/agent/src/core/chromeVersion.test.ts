import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireChromeVersionFromCdp,
  cdpHttpOrigin,
  readChromeVersionFromCdp
} from "./chromeVersion";

/**
 * Browser-build acquisition (gate-3 task 1). The bounded retry exists so a
 * transient CDP hiccup cannot abort a whole `--require-chrome-version` campaign
 * run; the never-throws guarantee exists so recording provenance can never turn
 * a passing trial into an engine error. Both are pinned here with a mocked read,
 * so no browser and no network are involved.
 */

const okResponse = (browser: unknown): Response =>
  ({ ok: true, json: async () => ({ Browser: browser }) }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe("cdpHttpOrigin", () => {
  it("maps a ws:// browser endpoint to its http origin", () => {
    expect(cdpHttpOrigin("ws://127.0.0.1:53219/devtools/browser/abc-123")).toBe(
      "http://127.0.0.1:53219"
    );
  });

  it("maps wss:// to https://, and refuses anything it cannot honestly map", () => {
    expect(cdpHttpOrigin("wss://remote.example:9222/devtools/browser/x")).toBe(
      "https://remote.example:9222"
    );
    expect(cdpHttpOrigin("http://127.0.0.1:9222")).toBeNull();
    expect(cdpHttpOrigin("not a url")).toBeNull();
  });
});

describe("readChromeVersionFromCdp", () => {
  it("returns the Browser string verbatim — never normalized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("HeadlessChrome/140.0.7339.16"))
    );
    await expect(
      readChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x")
    ).resolves.toBe("HeadlessChrome/140.0.7339.16");
  });

  it("never throws: a connectURL() that throws, a rejected fetch, a bad body all yield null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("Chrome/1.2.3")));
    await expect(
      readChromeVersionFromCdp(() => {
        throw new Error("StagehandNotInitializedError: connectURL()");
      })
    ).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(
      readChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x")
    ).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as unknown as Response));
    await expect(
      readChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x")
    ).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => okResponse(undefined)));
    await expect(
      readChromeVersionFromCdp(() => "ws://127.0.0.1:9222/devtools/browser/x")
    ).resolves.toBeNull();
  });
});

describe("acquireChromeVersionFromCdp — bounded retry", () => {
  const url = () => "ws://127.0.0.1:9222/devtools/browser/x";

  it("returns on the FIRST success without retrying", async () => {
    const fetchMock = vi.fn(async () => okResponse("Chrome/150.0.7871.184"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(acquireChromeVersionFromCdp(url, { budgetMs: 1_000, retryMs: 5 })).resolves.toBe(
      "Chrome/150.0.7871.184"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a failing read and succeeds once the endpoint answers", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error("ECONNREFUSED — Chrome still starting");
        return okResponse("Chrome/150.0.7871.184");
      })
    );
    await expect(acquireChromeVersionFromCdp(url, { budgetMs: 2_000, retryMs: 5 })).resolves.toBe(
      "Chrome/150.0.7871.184"
    );
    expect(calls).toBe(3);
  });

  it("gives up at the budget and returns null — never throws, never spins forever", async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new Error("ECONNREFUSED")));
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();
    await expect(
      acquireChromeVersionFromCdp(url, { budgetMs: 120, retryMs: 20 })
    ).resolves.toBeNull();
    // Bounded: it stopped near the budget rather than retrying indefinitely.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
