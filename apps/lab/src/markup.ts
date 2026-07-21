import { hashSeed } from "@ssda/shared";

/**
 * A "skin" bundles the class- AND id-drift decisions so page rendering, CSS and
 * inline JS all agree on the exact class names / ids to emit. The class-drift axis
 * is a level 0–4 (PROTOCOL_2A §3 F1): each level renames a nested, seed-chosen
 * fraction of BOTH class and id tokens, with independent per-token decisions:
 *   L0 — nothing renamed, ids intact (byte-identical to an unperturbed page);
 *   L1 — 25% of classes AND a separate seeded 25% of ids renamed;
 *   L2 — 50% of classes AND a separate seeded 50% of ids renamed;
 *   L3 — 100% of classes AND 100% of ids renamed (every id present but drifted);
 *   L4 — 100% of classes renamed AND ALL ids removed (≡ the Phase-1 `classDrift`
 *        flag, byte-for-byte).
 * Levels 1–3 make an id-keyed selector (`#standings`, `#username`, …) miss on the
 * drifted fraction; level 4 strips ids entirely. The renamed id set nests exactly
 * like the class set (level k ⊆ level k+1 for k in 1..3); level 4's removal of all
 * ids is the deliberate superset break. Agents that keyed off ids or stable classes
 * break progressively as the level rises.
 */
export interface Skin {
  readonly seed: number;
  /** The active class- and id-drift level (0 = off, 4 = full drift + ids removed). */
  readonly driftLevel: number;
  /** True when any class or id token drifts (level ≥ 1). */
  readonly driftOn: boolean;
  /** Drifted (or plain) single class token. */
  cls(base: string): string;
  /** ` class="a b"` with each base drifted when active. */
  classAttr(...bases: string[]): string;
  /** The (possibly renamed) id token for levels 0–3 — base at L0, a seeded
   *  fraction drifted at L1/L2, all drifted at L3. (L4 removes ids; see idAttr.) */
  idName(base: string): string;
  /** ` id="…"` with the id token drifted per idName while ids survive (levels
   *  0–3), otherwise "" (level 4 strips every id). */
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
 * Fraction of id tokens renamed at each drift level — same monotone thresholds as
 * `driftFraction`, applied independently to ids so a page drifts a nested 25%/50%/
 * 100% of its id hooks across levels 1–3. Level ≥ 4 is handled separately in
 * `idAttr` (ids are removed, not renamed), so this returns 1 there for consistency.
 */
function idFraction(level: number): number {
  if (level <= 0) return 0;
  if (level === 1) return 0.25;
  if (level === 2) return 0.5;
  return 1; // levels 3 and 4 rename every id token (level 4 then removes them)
}

/**
 * `createSkin(seed, level)` — level 0 leaves markup untouched (classes AND ids);
 * levels 1–2 rename a seeded 25%/50% of classes and a *separately* seeded 25%/50%
 * of ids (ids kept, just drifted); level 3 renames all classes and all ids (ids
 * kept); level 4 renames all classes AND removes every id, reproducing the Phase-1
 * `classDrift` path byte-for-byte. Renamed classes use the Phase-1 `-x…` suffix
 * formula; renamed ids use the same formula under a distinct `id:` salt.
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
  // Id-drift decision — fully independent of the class decision (own `iddriftpick:`
  // salt for the pick, own `id:` salt for the rename), so which ids drift is
  // uncorrelated with which classes drift, and the drifted-id set is nested across
  // levels 1–3 by the same monotone-threshold argument.
  const idFrac = idFraction(level);
  const idDrifts = (base: string): boolean =>
    hashSeed(`iddriftpick:${seed}:${base}`) / 4294967296 < idFrac;
  const idName = (base: string): string =>
    idDrifts(base)
      ? `${base}-x${hashSeed(`id:${seed}:${base}`).toString(36).slice(0, 6)}`
      : base;
  return {
    seed,
    driftLevel: level,
    driftOn: level >= 1,
    cls,
    classAttr: (...bases) => ` class="${bases.map(cls).join(" ")}"`,
    idName,
    idAttr: (base) => (level >= 4 ? "" : ` id="${idName(base)}"`),
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
