import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Action } from "@browserbasehq/stagehand";
import { bootstrapActions } from "./bootstrap";
import { SelectorCache } from "./cache";

const HEALED_FILE = ["artifacts", "healed-cache.json"];

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("bootstrap cache", () => {
  it("starts from the bootstrap actions with credential PLACEHOLDERS, never secrets", () => {
    const cache = new SelectorCache();
    expect(cache.action("username")).toMatchObject({
      selector: "#username",
      method: "fill",
      arguments: ["%username%"]
    });
    expect(cache.action("password").arguments).toEqual(["%password%"]);
    // No cached action or description leaks a real credential value.
    const dump = JSON.stringify(cache.snapshot());
    expect(dump).not.toMatch(/analyst|password123|secret/i);
    expect(dump).toContain("%username%");
    expect(dump).toContain("%password%");
  });

  it("clones per instance so trials stay independent", () => {
    const a = new SelectorCache();
    const healed: Action = { selector: ".u-x9", method: "fill", arguments: ["%username%"], description: "u" };
    a.heal("login", "username", healed);
    const b = new SelectorCache();
    expect(b.action("username").selector).toBe("#username"); // b untouched
  });
});

describe("heal + persistence gating", () => {
  it("records the healed step name and swaps the cached selector", () => {
    const cache = new SelectorCache();
    expect(cache.didHeal).toBe(false);
    expect(cache.healedSteps).toEqual([]);

    const healed: Action = {
      selector: ".username-x1a2b3",
      method: "fill",
      arguments: ["%username%"],
      description: "type the username into the login form"
    };
    cache.heal("login", "username", healed);

    expect(cache.didHeal).toBe(true);
    expect(cache.healedSteps).toEqual(["login"]);
    expect(cache.action("username").selector).toBe(".username-x1a2b3");
  });

  it("dedupes step names across multiple entry heals within one step", () => {
    const cache = new SelectorCache();
    cache.heal("login", "username", { ...bootstrapActions().username, selector: ".u" });
    cache.heal("login", "password", { ...bootstrapActions().password, selector: ".p" });
    expect(cache.healedSteps).toEqual(["login"]);
  });

  it("does NOT persist a cache that never healed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ssda-cache-clean-"));
    const cache = new SelectorCache();
    await cache.persist(dir);
    expect(await fileExists(path.join(dir, ...HEALED_FILE))).toBe(false);
  });

  it("persists a healed cache (placeholders intact) when at least one heal ran", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ssda-cache-healed-"));
    const cache = new SelectorCache();
    cache.heal("login", "username", {
      selector: ".username-drifted",
      method: "fill",
      arguments: ["%username%"],
      description: "type the username into the login form"
    });
    await cache.persist(dir);

    const file = path.join(dir, ...HEALED_FILE);
    expect(await fileExists(file)).toBe(true);
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, Action>;
    expect(written.username?.selector).toBe(".username-drifted");
    expect(written.username?.arguments).toEqual(["%username%"]); // placeholder, not a secret
    expect(JSON.stringify(written)).not.toMatch(/analyst|password123/i);
  });
});
