export interface AgentEnvConfig {
  browserbase: {
    apiKey?: string;
    projectId?: string;
    contextId?: string;
    /** True when both API key and project id are present. */
    ready: boolean;
  };
  /** First available model provider for Stagehand, or null. */
  modelProvider: "anthropic" | "openai" | null;
  /** Stagehand model string, e.g. "anthropic/claude-haiku-4-5". */
  stagehandModel: string | null;
}

const DEFAULT_MODELS = {
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-4.1-mini"
} as const;

export function loadAgentEnvConfig(env: NodeJS.ProcessEnv = process.env): AgentEnvConfig {
  const apiKey = env.BROWSERBASE_API_KEY || undefined;
  const projectId = env.BROWSERBASE_PROJECT_ID || undefined;
  const contextId = env.BROWSERBASE_CONTEXT_ID || undefined;
  const modelProvider = env.ANTHROPIC_API_KEY
    ? ("anthropic" as const)
    : env.OPENAI_API_KEY
      ? ("openai" as const)
      : null;
  const stagehandModel =
    env.STAGEHAND_MODEL || (modelProvider ? DEFAULT_MODELS[modelProvider] : null);
  return {
    browserbase: { apiKey, projectId, contextId, ready: Boolean(apiKey && projectId) },
    modelProvider,
    stagehandModel
  };
}

/** Clear setup error for Stagehand paths only — the baseline and lab never need keys. */
export function requireStagehandReady(
  config: AgentEnvConfig,
  env: "local" | "browserbase"
): { stagehandModel: string } {
  if (!config.stagehandModel) {
    throw new Error(
      [
        "Stagehand needs an LLM provider key (its observe/act/extract calls are model-driven).",
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (see .env.example), or set STAGEHAND_MODEL plus the matching provider key.",
        "The local lab, the Playwright baseline and the dashboard all run without any key."
      ].join("\n")
    );
  }
  if (env === "browserbase" && !config.browserbase.ready) {
    throw new Error(
      [
        "Browserbase mode needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (see .env.example).",
        "BROWSERBASE_CONTEXT_ID is optional and enables persistent session/auth state across runs.",
        "Tip: pnpm agent:local runs the same pipeline against a local browser without Browserbase."
      ].join("\n")
    );
  }
  return { stagehandModel: config.stagehandModel };
}
