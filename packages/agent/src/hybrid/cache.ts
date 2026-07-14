import path from "node:path";
import { readJson, writeJson } from "@ssda/shared";
import type { Action } from "@browserbasehq/stagehand";
import { PipelineStepError } from "../core";
import { bootstrapActions, type CacheKey } from "./bootstrap";

/**
 * A per-trial, in-memory copy of the bootstrap selector cache. Each trial gets a
 * fresh clone so trials stay independent and reproducible. When a cached
 * selector fails and the key-gated repair path re-discovers the element via
 * observe(), `heal()` swaps the entry and records the pipeline step that healed.
 * If anything healed, the (still credential-free) cache is persisted for the run.
 */

function cloneAction(action: Action): Action {
  return {
    selector: action.selector,
    description: action.description,
    ...(action.method !== undefined ? { method: action.method } : {}),
    ...(action.arguments !== undefined ? { arguments: [...action.arguments] } : {})
  };
}

function cloneAll(src: Record<CacheKey, Action>): Record<CacheKey, Action> {
  const out = {} as Record<CacheKey, Action>;
  for (const key of Object.keys(src) as CacheKey[]) out[key] = cloneAction(src[key]);
  return out;
}

export class SelectorCache {
  private readonly actions: Record<CacheKey, Action>;
  /** Pipeline step names whose cached selector was LLM-repaired this trial. */
  private readonly healedStepNames = new Set<string>();
  private healCount = 0;

  constructor(bootstrap: Record<CacheKey, Action> = bootstrapActions()) {
    this.actions = cloneAll(bootstrap);
  }

  /** Current cached Action for a key (a fresh copy — callers never mutate the cache). */
  action(key: CacheKey): Action {
    return cloneAction(this.actions[key]);
  }

  /**
   * Replace a cached entry with a repaired Action and record the pipeline step
   * that healed. `action` keeps variable placeholders (never resolved secrets).
   */
  heal(step: string, key: CacheKey, action: Action): void {
    this.actions[key] = cloneAction(action);
    this.healedStepNames.add(step);
    this.healCount += 1;
  }

  /** Step names that healed at least once (deduped, insertion order). */
  get healedSteps(): string[] {
    return [...this.healedStepNames];
  }

  get didHeal(): boolean {
    return this.healCount > 0;
  }

  /** Plain-JSON snapshot of the current cache (placeholders intact). */
  snapshot(): Record<CacheKey, Action> {
    return cloneAll(this.actions);
  }

  /**
   * Persist the healed cache to `<runDir>/artifacts/healed-cache.json` — only
   * when at least one entry healed (a clean, un-repaired run writes nothing).
   */
  async persist(runDir: string): Promise<void> {
    if (this.healCount === 0) return;
    await writeJson(path.join(runDir, "artifacts", "healed-cache.json"), this.snapshot());
  }
}

/** Is `value` a structurally valid cached `Action` (selector + description, optional method/arguments)? */
function isCachedAction(value: unknown): value is Action {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.selector !== "string" || a.selector.length === 0) return false;
  if (typeof a.description !== "string") return false;
  if (a.method !== undefined && typeof a.method !== "string") return false;
  if (a.arguments !== undefined && !Array.isArray(a.arguments)) return false;
  return true;
}

/**
 * Load a warm-start selector cache from a healed-cache.json artifact (the shape
 * `SelectorCache.persist` writes): every `CacheKey` must be present and hold a
 * valid `Action`. Returned as an independent clone, ready to seed a fresh
 * `SelectorCache`. A missing file, non-object JSON, or a missing/malformed entry
 * raises a clear internal `PipelineStepError` that names the offending path — so
 * warm-cache runs fail loudly instead of silently falling back to the bootstrap.
 */
export async function loadSeedCache(file: string): Promise<Record<CacheKey, Action>> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PipelineStepError(
      `seed cache could not be read at ${file}: ${reason}`,
      "internal",
      "seed-cache"
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PipelineStepError(
      `seed cache at ${file} is not a JSON object of cached actions`,
      "internal",
      "seed-cache"
    );
  }
  const src = raw as Record<string, unknown>;
  const out = {} as Record<CacheKey, Action>;
  for (const key of Object.keys(bootstrapActions()) as CacheKey[]) {
    const entry = src[key];
    if (!isCachedAction(entry)) {
      throw new PipelineStepError(
        `seed cache at ${file} is missing or malformed entry "${key}"`,
        "internal",
        "seed-cache"
      );
    }
    out[key] = cloneAction(entry);
  }
  return out;
}
