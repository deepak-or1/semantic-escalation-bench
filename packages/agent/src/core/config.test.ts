import { describe, expect, it } from "vitest";
import { loadAgentEnvConfig, requireStagehandReady } from "./config";
import { categorizeError, PipelineStepError } from "./errors";

describe("loadAgentEnvConfig", () => {
  it("returns nulls and browserbase not ready with no keys", () => {
    const config = loadAgentEnvConfig({});
    expect(config.modelProvider).toBeNull();
    expect(config.stagehandModel).toBeNull();
    expect(config.browserbase.ready).toBe(false);
  });

  it("selects anthropic with the haiku default model", () => {
    const config = loadAgentEnvConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(config.modelProvider).toBe("anthropic");
    expect(config.stagehandModel).toBe("anthropic/claude-haiku-4-5");
  });

  it("selects openai with its default model", () => {
    const config = loadAgentEnvConfig({ OPENAI_API_KEY: "sk-openai-test" });
    expect(config.modelProvider).toBe("openai");
    expect(config.stagehandModel).toBe("openai/gpt-4.1-mini");
  });

  it("lets STAGEHAND_MODEL override the provider default", () => {
    const config = loadAgentEnvConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      STAGEHAND_MODEL: "anthropic/claude-sonnet-4-5"
    });
    expect(config.modelProvider).toBe("anthropic");
    expect(config.stagehandModel).toBe("anthropic/claude-sonnet-4-5");
  });

  it("marks browserbase ready only when both key and project id are present", () => {
    expect(loadAgentEnvConfig({ BROWSERBASE_API_KEY: "k" }).browserbase.ready).toBe(false);
    expect(loadAgentEnvConfig({ BROWSERBASE_PROJECT_ID: "p" }).browserbase.ready).toBe(false);
    const both = loadAgentEnvConfig({ BROWSERBASE_API_KEY: "k", BROWSERBASE_PROJECT_ID: "p" });
    expect(both.browserbase.ready).toBe(true);
    expect(both.browserbase.apiKey).toBe("k");
    expect(both.browserbase.projectId).toBe("p");
  });
});

describe("requireStagehandReady", () => {
  it("throws mentioning ANTHROPIC_API_KEY when no model is configured", () => {
    const config = loadAgentEnvConfig({});
    expect(() => requireStagehandReady(config, "local")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws mentioning BROWSERBASE_API_KEY for browserbase without creds", () => {
    const config = loadAgentEnvConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(() => requireStagehandReady(config, "browserbase")).toThrow(/BROWSERBASE_API_KEY/);
  });

  it("returns the model when the environment is satisfied", () => {
    const local = loadAgentEnvConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(requireStagehandReady(local, "local")).toEqual({
      stagehandModel: "anthropic/claude-haiku-4-5"
    });

    const bb = loadAgentEnvConfig({
      OPENAI_API_KEY: "sk-openai-test",
      BROWSERBASE_API_KEY: "k",
      BROWSERBASE_PROJECT_ID: "p"
    });
    expect(requireStagehandReady(bb, "browserbase")).toEqual({
      stagehandModel: "openai/gpt-4.1-mini"
    });
  });
});

describe("categorizeError", () => {
  it("preserves the category and step of a PipelineStepError", () => {
    const err = new PipelineStepError("login did not stick", "auth", "login");
    expect(categorizeError(err, "fallback")).toEqual({
      category: "auth",
      step: "login",
      detail: "login did not stick"
    });
  });

  it("classifies a timeout message", () => {
    expect(categorizeError(new Error("Timed out after 5000ms"), "goto-stats").category).toBe(
      "timeout"
    );
  });

  it("classifies a connection-refused message as navigation", () => {
    expect(
      categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:4517"), "goto-stats").category
    ).toBe("navigation");
  });

  it("falls back to internal for an unrecognised message", () => {
    const result = categorizeError(new Error("weird"), "reveal-table");
    expect(result.category).toBe("internal");
    expect(result.step).toBe("reveal-table");
  });
});
