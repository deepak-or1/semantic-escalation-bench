import { hashSeed } from "@ssda/shared";

/**
 * A "skin" bundles the class-drift decision so page rendering, CSS and inline
 * JS all agree on the exact class names / ids to emit. Class drift is a level
 * 0–4 (PROTOCOL_2A §3 F1): each level renames a nested, seed-chosen fraction of
 * class tokens; level 4 additionally strips every id (≡ the Phase-1 `classDrift`
 * flag). Agents that keyed off ids or stable classes break as the level rises.
 */
export interface Skin {
  readonly seed: number;
  /** The active class-drift level (0 = off, 4 = full drift + ids removed). */
  readonly driftLevel: number;
  /** True when any class token drifts (level ≥ 1). */
  readonly driftOn: boolean;
  /** Drifted (or plain) single class token. */
  cls(base: string): string;
  /** ` class="a b"` with each base drifted when active. */
  classAttr(...bases: string[]): string;
  /** ` id="base"` while ids survive (levels 0–3), otherwise "" (level 4). */
  idAttr(base: string): string;
  /** CSS selector inline JS should use to find an element — always class-based
   *  so it works whether or not ids are present. */
  jsSel(base: string): string;
}

/**
 * Fraction of class tokens renamed at each drift level. The nesting property
 * (level k's renamed set ⊆ level k+1's) falls out of comparing a single stable
 * per-token hash against these monotonically increasing thresholds.
 */
function driftFraction(level: number): number {
  if (level <= 0) return 0;
  if (level === 1) return 0.25;
  if (level === 2) return 0.5;
  return 1; // levels 3 and 4 rename every token
}

/**
 * `createSkin(seed, level)` — level 0 leaves markup untouched; levels 1–2 rename
 * a seeded 25%/50% of tokens (ids kept); level 3 renames all tokens (ids kept);
 * level 4 renames all tokens AND removes ids, reproducing the Phase-1 `classDrift`
 * path byte-for-byte. The renamed token uses the exact Phase-1 suffix formula.
 */
export function createSkin(seed: number, level: number): Skin {
  const fraction = driftFraction(level);
  // Per-token drift decision: a stable hash in [0,1) compared against the level
  // fraction. Distinct salt from the rename hash so the choice and the new name
  // are independent; monotone thresholds make the drifted set nested across levels.
  const drifts = (base: string): boolean =>
    hashSeed(`driftpick:${seed}:${base}`) / 4294967296 < fraction;
  const cls = (base: string): string =>
    drifts(base)
      ? `${base}-x${hashSeed(`cls:${seed}:${base}`).toString(36).slice(0, 6)}`
      : base;
  return {
    seed,
    driftLevel: level,
    driftOn: level >= 1,
    cls,
    classAttr: (...bases) => ` class="${bases.map(cls).join(" ")}"`,
    idAttr: (base) => (level >= 4 ? "" : ` id="${base}"`),
    jsSel: (base) => `.${cls(base)}`
  };
}

/** HTML-escape text and attribute values. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safe indexed access for the small fixed lookup tables in this app. */
export function at<T>(items: readonly T[], index: number): T {
  return (items[index] ?? items[0]) as T;
}
