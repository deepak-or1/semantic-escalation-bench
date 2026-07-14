export const DEFAULT_LAB_PORT = 4517;
export const DEFAULT_DASHBOARD_PORT = 4618;
export const DEFAULT_SEED = 42;

export const SESSION_COOKIE = "ssda_session";
export const SESSION_TTL_MS = 15 * 60 * 1000;

// Demo credentials for the local lab only. They gate seeded fake data and are
// overridable via LAB_USERNAME / LAB_PASSWORD. Real credentials never belong here.
export const DEFAULT_LAB_USERNAME = "analyst";
export const DEFAULT_LAB_PASSWORD = "scout-the-lab";

export const SENSITIVE_ENV_KEYS = [
  "BROWSERBASE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LAB_PASSWORD"
] as const;

export function labPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.LAB_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LAB_PORT;
}

export function labBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAB_URL ?? `http://localhost:${labPortFromEnv(env)}`;
}

export function labCredentials(env: NodeJS.ProcessEnv = process.env): {
  username: string;
  password: string;
} {
  return {
    username: env.LAB_USERNAME ?? DEFAULT_LAB_USERNAME,
    password: env.LAB_PASSWORD ?? DEFAULT_LAB_PASSWORD
  };
}

export function dashboardPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.DASHBOARD_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DASHBOARD_PORT;
}
