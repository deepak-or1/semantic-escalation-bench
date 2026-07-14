import { hashSeed } from "@ssda/shared";

/**
 * A "skin" bundles the class-drift decision so page rendering, CSS and inline
 * JS all agree on the exact class names / ids to emit. classDrift chaos flips
 * driftOn: class tokens gain a seed-derived suffix and every id/data-testid
 * attribute is dropped, so agents that keyed off ids or stable classes break.
 */
export interface Skin {
  readonly seed: number;
  readonly driftOn: boolean;
  /** Drifted (or plain) single class token. */
  cls(base: string): string;
  /** ` class="a b"` with each base drifted when active. */
  classAttr(...bases: string[]): string;
  /** ` id="base"` when drift is off, otherwise "" (ids vanish under drift). */
  idAttr(base: string): string;
  /** CSS selector inline JS should use to find an element — always class-based
   *  so it works whether or not ids are present. */
  jsSel(base: string): string;
}

export function createSkin(seed: number, driftOn: boolean): Skin {
  const cls = (base: string): string =>
    driftOn
      ? `${base}-x${hashSeed(`cls:${seed}:${base}`).toString(36).slice(0, 6)}`
      : base;
  return {
    seed,
    driftOn,
    cls,
    classAttr: (...bases) => ` class="${bases.map(cls).join(" ")}"`,
    idAttr: (base) => (driftOn ? "" : ` id="${base}"`),
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
