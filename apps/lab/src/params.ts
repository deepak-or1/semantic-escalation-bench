import {
  DECOY_CONTROLS,
  hashSeed,
  validateChaosConfig,
  type ChaosParams,
  type DecoyControl,
  type DecoyPlacement,
  type LayoutCondition
} from "@ssda/shared";
import { esc, type Skin } from "./markup";

/**
 * Phase-2A perturbation-parameter plumbing for the lab renderer (PROTOCOL_2A §3).
 * The schema (packages/shared/src/chaosParams) fixes the shapes and ranges; this
 * module holds the lab-side resolution of params into concrete render decisions,
 * plus the config validation the schema cannot express (permutation exactness,
 * decoy-scaffold presence, timing-param-needs-its-flag). Ground truth is never
 * touched — every knob here is presentation.
 */

// ── Config validation ─────────────────────────────────────────
// Returned as human-readable strings so POST /__lab/config can 400 with the list.

/**
 * Every §3 config error for a (chaos, params) pair. The full validator is
 * single-sourced in @ssda/shared (validateChaosConfig) so the lab config API and
 * the suite loader reject the IDENTICAL set of violations — a §3-violating scenario
 * fails loudly at load time, never mid-run. No lab-only config checks remain; if
 * any arise (a knob only the renderer knows about), append them to `errors` here.
 */
export function validateLabConfig(chaos: string[], params: ChaosParams): string[] {
  const errors = validateChaosConfig(chaos, params);
  return errors;
}

// ── Effective-value resolvers ─────────────────────────────────

/** classDrift flag ≡ level 4; a param level supersedes it (XOR-guarded). */
export function resolveClassDriftLevel(hasClassDrift: boolean, params: ChaosParams): number {
  return params.classDriftLevel ?? (hasClassDrift ? 4 : 0);
}

/**
 * Pagination is active under the `pagination` flag OR any `pageSize` (the flag ≡
 * pageSize 5). XOR-guarded, so at most one is set; either yields the paginated view.
 */
export function resolvePagination(
  hasPagination: boolean,
  params: ChaosParams
): { active: boolean; size: number } {
  return {
    active: hasPagination || params.pageSize !== undefined,
    size: params.pageSize ?? 5
  };
}

/** `cards` (≡ layoutVariant) or `wrapped`, else the ordinary table view. */
export function resolveLayout(
  hasLayoutVariant: boolean,
  params: ChaosParams
): LayoutCondition | undefined {
  if (params.layoutCondition !== undefined) return params.layoutCondition;
  return hasLayoutVariant ? "cards" : undefined;
}

/** delayed-render bounds — same seeded draw, param only re-bounds it. */
export function resolveDelayRange(params: ChaosParams): [number, number] {
  return params.delayRangeMs ?? [1500, 4000];
}

/** network-latency bounds — same seeded draw, param only re-bounds it. */
export function resolveNetworkDelayRange(params: ChaosParams): [number, number] {
  return params.networkDelayRangeMs ?? [500, 2500];
}

/** headerVocab lookup: rendered string for a key, or the canonical fallback. */
export type HeaderVocab = (key: string, fallback: string) => string;
export function headerVocab(params: ChaosParams): HeaderVocab {
  const map = params.headerVocab;
  return (key, fallback) => map?.[key] ?? fallback;
}

/**
 * layoutCondition `wrapped`: nest an element inside 2–3 non-semantic wrapper divs
 * with seed-drifted (meaningless) class names. The inner element — the real
 * `<table>` — is unchanged, so structure-faithful readers still see a table.
 */
export function wrapInDivs(seed: number, inner: string): string {
  const count = 2 + (hashSeed(`wrapcount:${seed}`) % 2); // 2 or 3
  let html = inner;
  for (let i = count - 1; i >= 0; i--) {
    const cls = `wrap-${hashSeed(`wrap:${seed}:${i}`).toString(36).slice(0, 6)}`;
    html = `<div class="${cls}">${html}</div>`;
  }
  return html;
}

// ── Decoy rebinding (§3 F2) ───────────────────────────────────

export interface DecoyState {
  level: number;
  copy: Partial<Record<DecoyControl, string>>;
  placement: DecoyPlacement;
}

export function decoyStateFrom(params: ChaosParams): DecoyState {
  return {
    level: params.decoyLevel ?? 0,
    copy: params.decoyCopy ?? {},
    placement: params.decoyPlacement ?? "after"
  };
}

/** True when decoyLevel rebinds this control (fixed order = DECOY_CONTROLS). */
export function isRebound(control: DecoyControl, decoy: DecoyState): boolean {
  const idx = DECOY_CONTROLS.indexOf(control);
  return idx >= 0 && idx < decoy.level;
}

/** Seed-drifted class suffix for functional controls — independent of classDrift. */
function decoySuffix(seed: number): string {
  return hashSeed(`decoy:${seed}`).toString(36).slice(0, 6);
}

export interface ControlSpec {
  control: DecoyControl;
  seed: number;
  skin: Skin;
  decoy: DecoyState;
  type: "button" | "submit";
  /** [identifying base, ...styling bases] — e.g. ["next-page", "btn"]. */
  bases: string[];
  /** Functional control's visible text (canonical copy). */
  text: string;
}

/**
 * Render a rebindable control. When not rebound this is byte-identical to the
 * Phase-1 single-button markup. When rebound: the FUNCTIONAL control keeps its
 * text/behaviour but loses its canonical id and takes a seed-drifted id class; an
 * INERT decoy (same tag, canonical id, no handler, `type=button` so it can never
 * submit) renders before/after it per `decoyPlacement`. `sel` is the selector the
 * lab's inline script must bind to reach the functional control.
 */
export function renderControl(spec: ControlSpec): { html: string; sel: string } {
  const { control, seed, skin, decoy, type, bases, text } = spec;
  const idBase = bases[0] as string;

  if (!isRebound(control, decoy)) {
    const html = `<button type="${type}"${skin.idAttr(idBase)}${skin.classAttr(...bases)}>${esc(text)}</button>`;
    return { html, sel: skin.jsSel(idBase) };
  }

  const funcClass = `${idBase}-d${decoySuffix(seed)}`;
  const styling = bases.slice(1).map((b) => skin.cls(b));
  const funcClassAttr = ` class="${[funcClass, ...styling].join(" ")}"`;
  const functional = `<button type="${type}"${funcClassAttr}>${esc(text)}</button>`;

  const decoyText = decoy.copy[control] ?? text;
  // Canonical id LITERAL so it survives classDrift (level 4 strips real ids); the
  // decoy is the plausible-looking target that carries the id the policy caches.
  const decoyEl = `<button type="button" id="${idBase}"${skin.classAttr(...bases)}>${esc(decoyText)}</button>`;

  const html = decoy.placement === "before" ? decoyEl + functional : functional + decoyEl;
  return { html, sel: `.${funcClass}` };
}
