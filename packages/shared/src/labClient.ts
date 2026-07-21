import type { ChaosFlag } from "./chaos";
import type { ChaosParams } from "./chaosParams";
import type { DisplayOverride, GroundTruth } from "./schemas/domain";

/**
 * Bridge the Phase-2A perturbation-param machinery (packages/shared/src/chaosParams)
 * out through the `@ssda/shared` package barrel. The lab (apps/lab) reaches these
 * only via the package entry, so surfacing the schema, the flag-XOR-param validator,
 * and the small key/control constants here makes them importable lab-side without
 * touching the package index. Types re-exported separately for isolatedModules.
 */
export {
  ChaosParamsSchema,
  validateChaosParamsCompat,
  validateChaosConfig,
  DECOY_CONTROLS,
  STAT_COLUMN_KEYS
} from "./chaosParams";
export type {
  ChaosParams,
  DecoyControl,
  DecoyPlacement,
  LayoutCondition
} from "./chaosParams";

/**
 * Typed client for the lab's control API. Used by the benchmark runner and
 * tests only — the extraction engines themselves never touch /__lab routes
 * (that would be cheating).
 *
 * Lab control contract:
 *   GET  /__lab/health              → { ok: true }
 *   GET  /__lab/state               → LabState
 *   POST /__lab/config              → body { seed?, chaos?, params? }; resets data AND sessions; returns LabState
 *                                     (params validated by ChaosParamsSchema + the §3 flag-XOR-param rule; 400 on any error)
 *   GET  /__lab/ground-truth        → LabTruth
 *   POST /__lab/sessions/expire-all → { ok: true }
 */

export interface LabState {
  seed: number;
  chaos: ChaosFlag[];
  startedAt: string;
  requestCount: number;
}

export interface LabTruth {
  seed: number;
  chaos: ChaosFlag[];
  truth: GroundTruth;
  overrides: DisplayOverride[];
}

export class LabClient {
  constructor(readonly baseUrl: string) {}

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`Lab ${method} ${route} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  configure(options: {
    seed?: number;
    chaos?: ChaosFlag[];
    params?: ChaosParams;
  }): Promise<LabState> {
    return this.request<LabState>("POST", "/__lab/config", options);
  }

  state(): Promise<LabState> {
    return this.request<LabState>("GET", "/__lab/state");
  }

  groundTruth(): Promise<LabTruth> {
    return this.request<LabTruth>("GET", "/__lab/ground-truth");
  }

  async expireAllSessions(): Promise<void> {
    await this.request<{ ok: boolean }>("POST", "/__lab/sessions/expire-all");
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request<{ ok: boolean }>("GET", "/__lab/health");
      return res.ok === true;
    } catch {
      return false;
    }
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.health()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Lab at ${this.baseUrl} not ready after ${timeoutMs}ms — is it running? (pnpm dev:lab)`
    );
  }
}
