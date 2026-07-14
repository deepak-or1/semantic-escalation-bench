import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionState, saveSessionState } from "./session";

const LAB_URL = "http://localhost:4517";

describe("session state", () => {
  it("round-trips a saved session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ssda-session-"));
    const file = path.join(dir, "session.json");
    const cookies = [
      { name: "ssda_session", value: "abc123" },
      { name: "consent", value: "yes" }
    ];
    await saveSessionState(file, LAB_URL, cookies);

    const loaded = await loadSessionState(file);
    expect(loaded).not.toBeNull();
    expect(loaded!.labUrl).toBe(LAB_URL);
    expect(loaded!.cookies).toEqual(cookies);
    expect(typeof loaded!.savedAt).toBe("string");
  });

  it("returns null for a missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ssda-session-"));
    expect(await loadSessionState(path.join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("strips extra cookie fields down to name and value", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ssda-session-"));
    const file = path.join(dir, "session.json");
    // A Playwright-style cookie carries many fields; only name/value persist.
    const richCookies = [
      {
        name: "ssda_session",
        value: "abc123",
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: false,
        expires: 1893456000
      }
    ];
    await saveSessionState(file, LAB_URL, richCookies);

    const loaded = await loadSessionState(file);
    expect(loaded!.cookies).toEqual([{ name: "ssda_session", value: "abc123" }]);
    expect(Object.keys(loaded!.cookies[0]!).sort()).toEqual(["name", "value"]);
  });
});
