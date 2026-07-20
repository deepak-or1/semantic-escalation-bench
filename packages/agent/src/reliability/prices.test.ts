import { describe, expect, it } from "vitest";
import { trialCostUsd } from "./prices";

/**
 * The pinned price table strict-costing rules (Wave G G3.1; ordering fixed at
 * v4). llmCalls is a required field of the tokens shape: llmCalls===0 is a
 * real, priced $0 before any model lookup (deterministic trials, keyless
 * included), llmCalls>0 requires BOTH token sides (never a half-cost), and an
 * unknown/absent model with calls — or null tokens — is null (unknown usage).
 */
describe("trialCostUsd", () => {
  const haiku = "anthropic/claude-haiku-4-5";

  it("both sides present with llmCalls>0 → exact hand-computed cost (200k in + 40k out = $0.40)", () => {
    // (200000·1 + 40000·5) / 1e6 = (200000 + 200000)/1e6 = 0.40.
    expect(
      trialCostUsd({ llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 }, haiku)
    ).toBeCloseTo(0.4, 10);
  });

  it("llmCalls>0 with a missing outputTokens → null (never a half-cost)", () => {
    expect(trialCostUsd({ llmCalls: 3, inputTokens: 1_000_000 }, haiku)).toBeNull();
  });

  it("llmCalls>0 with a missing inputTokens → null (never a half-cost)", () => {
    expect(trialCostUsd({ llmCalls: 3, outputTokens: 1_000_000 }, haiku)).toBeNull();
  });

  it("llmCalls===0 → 0 (zero inference is a real, priced $0)", () => {
    expect(trialCostUsd({ llmCalls: 0 }, haiku)).toBe(0);
    // Even with token sides absent, zero inference stays a priced $0.
    expect(trialCostUsd({ llmCalls: 0, inputTokens: 5, outputTokens: 7 }, haiku)).toBe(0);
  });

  it("llmCalls===0 → 0 even with an absent or unknown model (keyless runs record none)", () => {
    expect(trialCostUsd({ llmCalls: 0 }, undefined)).toBe(0);
    expect(trialCostUsd({ llmCalls: 0 }, null)).toBe(0);
    expect(trialCostUsd({ llmCalls: 0, inputTokens: 0, outputTokens: 0 }, "openai/gpt-unknown")).toBe(0);
  });

  it("returns null for an unknown or absent model", () => {
    expect(
      trialCostUsd({ llmCalls: 5, inputTokens: 100, outputTokens: 100 }, "openai/gpt-unknown")
    ).toBeNull();
    expect(
      trialCostUsd({ llmCalls: 5, inputTokens: 100, outputTokens: 100 }, undefined)
    ).toBeNull();
    expect(
      trialCostUsd({ llmCalls: 5, inputTokens: 100, outputTokens: 100 }, null)
    ).toBeNull();
  });

  it("returns null for null/undefined tokens (unknown usage), regardless of model", () => {
    expect(trialCostUsd(null, haiku)).toBeNull();
    expect(trialCostUsd(undefined, haiku)).toBeNull();
  });
});
