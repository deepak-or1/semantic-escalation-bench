import {
  computeDisplayOverrides,
  generateGroundTruth,
  type ChaosFlag,
  type ChaosParams,
  type DisplayOverride,
  type GroundTruth,
  type LabState as LabStateJson
} from "@ssda/shared";

export interface Session {
  expiresAt: number;
  /** Authenticated page views this session has served (drives staleSession). */
  authedViews: number;
}

/**
 * All mutable lab state for one app instance. Kept in a class (not module
 * globals) so tests can boot several independent labs in the same process.
 */
export class LabState {
  seed: number;
  chaos: Set<ChaosFlag>;
  /**
   * Phase-2A perturbation parameters (PROTOCOL_2A §3). Presentation-only, parsed
   * and §3-validated at POST /__lab/config; never affects truth/overrides.
   */
  params: ChaosParams;
  truth: GroundTruth;
  overrides: DisplayOverride[];
  readonly sessions = new Map<string, Session>();
  staleAlreadyFired = false;
  readonly startedAt = new Date().toISOString();
  requestCount = 0;

  constructor(seed: number, chaos: readonly ChaosFlag[] = [], params: ChaosParams = {}) {
    this.seed = seed;
    this.chaos = new Set(chaos);
    this.params = params;
    this.truth = generateGroundTruth(seed);
    this.overrides = computeDisplayOverrides(this.truth, chaos, seed);
  }

  /** Apply a new seed/chaos/params config: regenerate data and wipe session state. */
  reconfigure(seed: number, chaos: readonly ChaosFlag[], params: ChaosParams = {}): void {
    this.seed = seed;
    this.chaos = new Set(chaos);
    this.params = params;
    this.truth = generateGroundTruth(seed);
    this.overrides = computeDisplayOverrides(this.truth, chaos, seed);
    this.sessions.clear();
    this.staleAlreadyFired = false;
    this.requestCount = 0;
  }

  hasChaos(flag: ChaosFlag): boolean {
    return this.chaos.has(flag);
  }

  chaosList(): ChaosFlag[] {
    return [...this.chaos];
  }

  toJson(): LabStateJson {
    return {
      seed: this.seed,
      chaos: this.chaosList(),
      startedAt: this.startedAt,
      requestCount: this.requestCount
    };
  }
}
