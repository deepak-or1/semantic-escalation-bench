import { describe, expect, it } from "vitest";
import { DISMISS_TEXT_PATTERN } from "./dismissPattern";

describe("DISMISS_TEXT_PATTERN (§2a anchored whole-text matcher)", () => {
  const re = new RegExp(DISMISS_TEXT_PATTERN, "i");
  const matches = (text: string): boolean => re.test(text.trim());

  it("matches the exact dismiss words, case-insensitive and trimmed", () => {
    for (const t of ["No thanks", "close", "Dismiss", "x", "X", "×", "  Close  "]) {
      expect(matches(t)).toBe(true);
    }
  });

  it("does NOT match text that merely CONTAINS an x (the Phase-1 unanchored bug)", () => {
    // The §2a correction anchors to the whole text, so "Next" (with an x) no
    // longer matches — the exact defect §2a fixes.
    for (const t of ["Next", "Fixtures", "Explore", "Full table", "Max"]) {
      expect(matches(t)).toBe(false);
    }
  });

  it("does not match unrelated control text", () => {
    for (const t of ["Accept all", "Sign in", "Continue", "Agree & continue"]) {
      expect(matches(t)).toBe(false);
    }
  });

  it("is the frozen source string equivalent to /^\\s*(no thanks|close|dismiss|×|x)\\s*$/i", () => {
    expect(DISMISS_TEXT_PATTERN).toBe("^\\s*(no thanks|close|dismiss|×|x)\\s*$");
  });
});
