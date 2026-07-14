import {
  computeDisplayOverrides,
  generateGroundTruth,
  type ChaosFlag,
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
  truth: GroundTruth;
  overrides: DisplayOverride[];
  readonly sessions = new Map<string, Session>();
  staleAlreadyFired = false;
  readonly startedAt = new Date().toISOString();
  requestCount = 0;

  constructor(seed: number, chaos: readonly ChaosFlag[] = []) {
    this.seed = seed;
    this.chaos = new Set(chaos);
    this.truth = generateGroundTruth(seed);
    this.overrides = computeDisplayOverrides(this.truth, chaos, seed);
  }

  /** Apply a new seed/chaos config: regenerate data and wipe session state. */
  reconfigure(seed: number, chaos: readonly ChaosFlag[]): void {
    this.seed = seed;
    this.chaos = new Set(chaos);
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
