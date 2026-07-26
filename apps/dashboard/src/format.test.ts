import { describe, expect, it } from "vitest";
import { esc, jsonForScript, niceTicks } from "./format";

describe("esc", () => {
  it("escapes every HTML-significant character, including attribute quotes", () => {
    expect(esc(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
    );
  });

  it("replaces ampersands first, so already-escaped text is escaped again not decoded", () => {
    expect(esc("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
  });

  it("stringifies non-string values rather than throwing on them", () => {
    expect(esc(null)).toBe("null");
    expect(esc(undefined)).toBe("undefined");
    expect(esc(0)).toBe("0");
    expect(esc(false)).toBe("false");
  });
});

describe("jsonForScript", () => {
  it("escapes `<` so an embedded payload cannot close the script tag", () => {
    const out = jsonForScript({ s: "</script><img onerror=alert(1)>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script>");
    // The escape is JSON-level, so the island still parses back to the original.
    expect(JSON.parse(out)).toEqual({ s: "</script><img onerror=alert(1)>" });
  });

  it("escapes U+2028/U+2029, which are illegal raw inside a JS string literal", () => {
    const value = { s: "a\u2028b\u2029c" };
    const out = jsonForScript(value);
    expect(out).toBe('{"s":"a\\u2028b\\u2029c"}');
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe("niceTicks", () => {
  it("rounds to clean steps from 0, and falls back to 0–1 for a non-positive or non-finite max", () => {
    expect(niceTicks(1)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceTicks(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceTicks(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceTicks(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
  });
});
