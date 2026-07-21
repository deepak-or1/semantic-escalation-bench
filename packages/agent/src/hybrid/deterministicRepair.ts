import { parseOddsValue, type ExtractedOddsRow, type ExtractedStatsRow } from "@ssda/shared";
import { waitForContent, type DomReadyPage } from "../core";
import {
  oddsRowsFrom,
  parseIntCell,
  selectOddsTable,
  selectStatsTable,
  statsRowsFrom,
  type RawTable
} from "./extract";
import type { CacheKey } from "./bootstrap";

/**
 * Policy B2 — the deterministic repair ladder (PROTOCOL_2A §2, revision 5). The
 * hybrid engine with repair enabled but NO model call in the code path: where
 * policy C calls observe()/extract(), B2 runs these class-free, id-free heuristics.
 * Every DOM predicate here uses the §2 operational definitions:
 *
 *  - visible: getBoundingClientRect() has positive area AND computed
 *    visibility !== "hidden" AND display !== "none".
 *  - enabled: not :disabled AND computed pointer-events !== "none".
 *  - candidate order: document order (querySelectorAll order).
 *  - label–value pair: a dt/dd pair inside a dl, or (fallback) an element pair
 *    whose first child's text is non-numeric and whose second parses under the
 *    SAME cell parsers B's table path uses — parseIntCell (stats integers) or
 *    parseOddsValue (odds decimal/american). Both sides are required; a pair whose
 *    value does not parse is not a label–value pair (see pairValueParses).
 *  - a block's IDENTITY field (team/match name) is structural, not vocabulary: it
 *    comes from the block's heading element (h1–h6) or, absent one, its first text
 *    outside any label–value pair. All other fields map through the dictionary.
 *
 * The re-location rungs mark the located element with a temporary data attribute
 * and return its selector, so the engine can heal the in-memory cache and replay
 * the action through the SAME credential-safe Stagehand path a cached/LLM heal uses
 * (placeholders + variables never enter the page). B2 heals the in-memory cache
 * for within-trial replay but the engine NEVER persists a healed cache in
 * deterministic mode (Phase-2A is cold-only). No new vocabulary: the card reader
 * maps labels through B's own STAT_SYNONYMS/ODDS_SYNONYMS via the existing table
 * functions — that shared dictionary boundary IS the measurement.
 *
 * The in-browser closures follow core/domReady.ts's rule: ONLY anonymous inline
 * arrows and value consts — never a named function expression (`const f = () => …`),
 * which bundlers wrap with a `__name(...)` helper that is undefined once the
 * function is serialised into the page. DOM traversal a rung's SELECTION rule
 * depends on returns serialisable descriptors, and the rule itself is a pure,
 * unit-testable Node function (pickRevealCandidates / selectLoginSubmit).
 */

/** Temporary marker attribute the rungs stamp on a located element. */
const MARKER = "data-ssda-b2";

/** Cap on the per-candidate content-ready poll in the reveal-table ladder (§2). */
const REVEAL_CANDIDATE_POLL_MS = 3_000;

/** next-page control text (§2), equivalent to /^\s*(next|more|»|→|older)\s*$/i. */
const NEXT_TEXT_PATTERN = "^\\s*(next|more|»|→|older)\\s*$";

/** One label–value pair read from a card block. */
export interface LabelValuePair {
  label: string;
  value: string;
}
/** A card block reduced to its structural identity plus its label–value pairs. */
export interface RawCard {
  /** Team/match name from the block's heading or first non-pair text (§2). */
  identity: string;
  pairs: LabelValuePair[];
}

/**
 * The login-submit fallback rule (§2, revision 5): the form's first visible enabled
 * [type=submit], else its ONLY visible enabled button — exactly-one semantics, so a
 * form with no submit and more than one visible enabled button yields NO candidate.
 * Pure and unit-tested; the relocateControl closure inlines the same expression.
 */
export function selectLoginSubmit<T>(visibleEnabledSubmits: T[], visibleEnabledButtons: T[]): T | null {
  if (visibleEnabledSubmits.length > 0) return visibleEnabledSubmits[0]!;
  return visibleEnabledButtons.length === 1 ? visibleEnabledButtons[0]! : null;
}

/**
 * Re-locate a single control (§2 "Action re-location, per step") and mark it, so the
 * engine can heal the cache and replay through Stagehand. Returns the marker CSS
 * selector, or null when no candidate is found (the caller raises the §2 failure).
 * `reveal-table` is handled by its own ladder (revealTableDeterministic) and is a
 * no-op here (returns null).
 */
export function relocateControl(
  page: DomReadyPage,
  key: CacheKey,
  dismissPattern: string
): Promise<string | null> {
  return page.evaluate<string | null, { key: string; marker: string; dismissPattern: string; nextPattern: string }>(
    (arg) => {
      const key = arg.key;
      const marker = arg.marker;
      // Clear any stale marker for this key before re-locating.
      for (const prev of Array.from(document.querySelectorAll(`[${marker}="${key}"]`))) {
        prev.removeAttribute(marker);
      }

      let target: Element | null = null;

      if (key === "username" || key === "password" || key === "login-submit") {
        // First VISIBLE form containing an input[type=password].
        let form: Element | null = null;
        for (const f of Array.from(document.querySelectorAll("form"))) {
          const r = f.getBoundingClientRect();
          const s = getComputedStyle(f);
          if (!(r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none")) continue;
          if (f.querySelector("input[type=password]")) {
            form = f;
            break;
          }
        }
        if (form) {
          const pw = form.querySelector("input[type=password]") as HTMLInputElement | null;
          if (key === "password") {
            target = pw;
          } else if (key === "username") {
            // Last VISIBLE text/email/typeless input preceding the password input.
            const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
            const pwIndex = pw ? inputs.indexOf(pw) : inputs.length;
            for (let i = pwIndex - 1; i >= 0; i--) {
              const inp = inputs[i]!;
              const t = (inp.getAttribute("type") || "").toLowerCase();
              if (t === "text" || t === "email" || t === "") {
                const r = inp.getBoundingClientRect();
                const s = getComputedStyle(inp);
                if (r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none") {
                  target = inp;
                  break;
                }
              }
            }
          } else {
            // login-submit: first visible enabled [type=submit], else the form's
            // ONLY visible enabled button (exactly-one; else no candidate).
            const submits: Element[] = [];
            for (const sub of Array.from(form.querySelectorAll("[type=submit]"))) {
              const r = sub.getBoundingClientRect();
              const s = getComputedStyle(sub);
              const vis = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
              const en = !sub.matches(":disabled") && s.pointerEvents !== "none";
              if (vis && en) submits.push(sub);
            }
            const buttons: Element[] = [];
            for (const b of Array.from(form.querySelectorAll("button"))) {
              const r = b.getBoundingClientRect();
              const s = getComputedStyle(b);
              const vis = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
              const en = !b.matches(":disabled") && s.pointerEvents !== "none";
              if (vis && en) buttons.push(b);
            }
            // Mirror of selectLoginSubmit (kept in sync; that pure fn is the spec).
            target = submits.length > 0 ? submits[0]! : buttons.length === 1 ? buttons[0]! : null;
          }
        }
      } else if (key === "consent") {
        // First visible form whose submit target is the consent endpoint, OR the
        // first visible form inside a >50%-viewport fixed element; its first
        // visible enabled button.
        const area = window.innerWidth * window.innerHeight;
        for (const f of Array.from(document.querySelectorAll("form"))) {
          const r = f.getBoundingClientRect();
          const s = getComputedStyle(f);
          if (!(r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none")) continue;
          const action = (f.getAttribute("action") || "").replace(/\?.*$/, "");
          let match = action.endsWith("/consent");
          if (!match && area > 0) {
            let anc: Element | null = f;
            while (anc && anc !== document.body) {
              const as = getComputedStyle(anc);
              if (as.position === "fixed") {
                const ar = anc.getBoundingClientRect();
                if (ar.width * ar.height > area * 0.5) {
                  match = true;
                  break;
                }
              }
              anc = anc.parentElement;
            }
          }
          if (!match) continue;
          for (const b of Array.from(f.querySelectorAll("button"))) {
            const r2 = b.getBoundingClientRect();
            const s2 = getComputedStyle(b);
            const vis = r2.width * r2.height > 0 && s2.visibility !== "hidden" && s2.display !== "none";
            const en = !b.matches(":disabled") && s2.pointerEvents !== "none";
            if (vis && en) {
              target = b;
              break;
            }
          }
          if (target) break;
        }
      } else if (key === "dismiss-modal") {
        // Inside the FIRST >50%-viewport fixed element, the first visible enabled
        // button/[role=button]/a whose trimmed whole text matches the §2a pattern.
        const re = new RegExp(arg.dismissPattern, "i");
        const area = window.innerWidth * window.innerHeight;
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if (getComputedStyle(el).position !== "fixed") continue;
          const rect = el.getBoundingClientRect();
          if (!(area > 0 && rect.width * rect.height > area * 0.5)) continue;
          for (const c of Array.from(el.querySelectorAll("button, [role=button], a"))) {
            const r = c.getBoundingClientRect();
            const s = getComputedStyle(c);
            const vis = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
            const en = !c.matches(":disabled") && s.pointerEvents !== "none";
            if (vis && en && re.test((c.textContent || "").trim())) {
              target = c;
              break;
            }
          }
          break; // only the FIRST qualifying overlay is considered
        }
      } else if (key === "next-page") {
        // Pager signature: smallest ancestor of the current-page indicator with
        // >=2 button/a controls; first visible enabled control with rel=next or
        // matching text, else the last visible enabled control.
        const nre = new RegExp(arg.nextPattern, "i");
        const pageInfoRe = /(\d+)\s*(?:of|\/)\s*(\d+)/i;
        let indicator: Element | null = null;
        let indicatorSize = Infinity;
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const txt = (el.textContent || "").trim();
          if (!pageInfoRe.test(txt)) continue;
          const size = el.querySelectorAll("*").length;
          if (size < indicatorSize) {
            indicator = el;
            indicatorSize = size;
          }
        }
        if (indicator) {
          let container: Element | null = indicator;
          while (container && container !== document.body) {
            if (container.querySelectorAll("button, a").length >= 2) break;
            container = container.parentElement;
          }
          if (container && container !== document.body && container.querySelectorAll("button, a").length >= 2) {
            const controls = Array.from(container.querySelectorAll("button, a")).filter((c) => {
              const r = c.getBoundingClientRect();
              const s = getComputedStyle(c);
              const vis = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
              const en = !c.matches(":disabled") && s.pointerEvents !== "none";
              return vis && en;
            });
            for (const c of controls) {
              const rel = (c.getAttribute("rel") || "").toLowerCase();
              if (rel === "next" || nre.test((c.textContent || "").trim())) {
                target = c;
                break;
              }
            }
            if (!target && controls.length > 0) target = controls[controls.length - 1]!;
          }
        }
      }

      if (!target) return null;
      target.setAttribute(marker, key);
      return `[${marker}="${key}"]`;
    },
    { key, marker: MARKER, dismissPattern, nextPattern: NEXT_TEXT_PATTERN }
  );
}

/** A reveal-table candidate element reduced to its selection-relevant properties. */
export interface RevealDescriptor {
  /** Element has role="tab" (group 1). */
  roleTab: boolean;
  tag: "button" | "a" | "other";
  /** An <a> whose href is a full (non-fragment) URL — site navigation, not a tab (§2). */
  anchorNavigational: boolean;
  /** Inside a nav, [role=tablist], or a tab-strip ancestor (>=2 sibling button/a). */
  inStrip: boolean;
  visible: boolean;
  enabled: boolean;
}

/**
 * The reveal-table candidate rule (§2, revision 5), pure and unit-tested. Document
 * order: visible enabled [role=tab] first; then, inside a strip, visible enabled
 * button elements and a elements whose href is absent/fragment-only (a full-href
 * anchor is site navigation, excluded). Returns the descriptor indices to click,
 * capped at 5.
 */
export function pickRevealCandidates(descriptors: RevealDescriptor[]): number[] {
  const roleTabs: number[] = [];
  const stripControls: number[] = [];
  descriptors.forEach((d, i) => {
    if (!d.visible || !d.enabled) return;
    if (d.roleTab) {
      roleTabs.push(i);
      return;
    }
    if (!d.inStrip) return;
    if (d.tag === "button" || (d.tag === "a" && !d.anchorNavigational)) stripControls.push(i);
  });
  return [...roleTabs, ...stripControls].slice(0, 5);
}

/**
 * reveal-table rung (§2): collect candidate descriptors from the DOM (marking each),
 * pick the eligible ones with pickRevealCandidates, then click them in order (<=5),
 * running the content-ready poll (capped at 3000 ms) after each; stop at first
 * success. Returns the successful candidate's marker selector (for the cache heal),
 * else null.
 */
export async function revealTableDeterministic(
  page: DomReadyPage,
  contentPollMs: number
): Promise<string | null> {
  const descriptors = await page.evaluate<RevealDescriptor[], { marker: string }>((arg) => {
    const marker = arg.marker;
    for (const prev of Array.from(document.querySelectorAll(`[${marker}^="revealcand:"]`))) {
      prev.removeAttribute(marker);
    }
    const out: RevealDescriptor[] = [];
    const els = Array.from(document.querySelectorAll("button, a, [role=tab]"));
    els.forEach((el, i) => {
      el.setAttribute(marker, `revealcand:${i}`);
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const visible = r.width * r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      const enabled = !el.matches(":disabled") && s.pointerEvents !== "none";
      const tagName = el.tagName.toLowerCase();
      const tag: "button" | "a" | "other" =
        tagName === "button" ? "button" : tagName === "a" ? "a" : "other";
      const href = el.getAttribute("href");
      const anchorNavigational = tag === "a" && href !== null && !href.startsWith("#");
      let inStrip = false;
      let anc: Element | null = el.parentElement;
      while (anc && anc !== document.body) {
        const at = anc.tagName.toLowerCase();
        if (at === "nav" || anc.getAttribute("role") === "tablist") {
          inStrip = true;
          break;
        }
        let siblingControls = 0;
        for (const ch of Array.from(anc.children)) {
          const ct = ch.tagName.toLowerCase();
          if (ct === "button" || ct === "a") siblingControls += 1;
        }
        if (siblingControls >= 2) {
          inStrip = true;
          break;
        }
        anc = anc.parentElement;
      }
      out.push({ roleTab: el.getAttribute("role") === "tab", tag, anchorNavigational, inStrip, visible, enabled });
    });
    return out;
  }, { marker: MARKER });

  const budget = Math.min(contentPollMs, REVEAL_CANDIDATE_POLL_MS);
  for (const idx of pickRevealCandidates(descriptors)) {
    const selector = `[${MARKER}="revealcand:${idx}"]`;
    const existed = await page.evaluate<boolean, { selector: string }>((arg) => {
      const el = document.querySelector(arg.selector);
      if (el instanceof HTMLElement) el.click();
      return el !== null;
    }, { selector });
    if (!existed) continue;
    if (await waitForContent(page, budget, "stats")) return selector;
  }
  return null;
}

/**
 * Fold a set of card blocks into a synthetic RawTable so the SAME header-name
 * mapping and cell parsers B's table path uses apply unchanged. The block identity
 * is injected as the frozen dictionary term (`team`/`match`) so statsRowsFrom/
 * oddsRowsFrom read it structurally; the remaining pair labels map by dictionary.
 * Headers come from the first block's labels; every block aligns to them by label.
 */
export function cardsToTable(cards: RawCard[], identityHeader: string): RawTable {
  if (cards.length === 0) return { headers: [], rows: [] };
  const pairHeaders = cards[0]!.pairs.map((p) => p.label);
  const headers = [identityHeader, ...pairHeaders];
  const rows = cards.map((card) => {
    const lookup = new Map<string, string>();
    for (const pair of card.pairs) if (!lookup.has(pair.label)) lookup.set(pair.label, pair.value);
    return [card.identity, ...pairHeaders.map((h) => lookup.get(h) ?? "")];
  });
  return { headers, rows };
}

/** Map card blocks to stats rows via the frozen table path, or null when unmappable. */
export function readStatsCards(cards: RawCard[]): ExtractedStatsRow[] | null {
  const table = selectStatsTable([cardsToTable(cards, "team")]);
  return table ? statsRowsFrom(table) : null;
}

/** Map card blocks to odds rows via the frozen table path, or null when unmappable. */
export function readOddsCards(cards: RawCard[]): ExtractedOddsRow[] | null {
  const table = selectOddsTable([cardsToTable(cards, "match")]);
  return table ? oddsRowsFrom(table) : null;
}

/** A candidate pair from the DOM collector; `fromDl` pairs skip the value check. */
interface CandidatePair {
  label: string;
  value: string;
  /** dt/dd pairs are pairs unconditionally (the primary §2 definition). */
  fromDl: boolean;
}
/** One candidate card block, keyed by its parent so siblings can be grouped. */
export interface BlockCandidate {
  parentKey: number;
  identity: string;
  pairs: CandidatePair[];
}

/**
 * Does a fallback pair's VALUE parse under the same cell parsers B's table path
 * uses (§2)? parseIntCell covers stats integers; parseOddsValue covers odds
 * decimal/american values. dt/dd pairs never reach this — they are pairs by the
 * primary §2 definition.
 */
export function pairValueParses(value: string): boolean {
  return parseIntCell(value) !== null || parseOddsValue(value) != null;
}

/**
 * Reduce the DOM collector's candidate blocks to the §2 card set: drop fallback
 * pairs whose value does not parse (pairValueParses), keep blocks with >=3
 * surviving label–value pairs, group by parent, and return the largest sibling
 * group of >=4 blocks (first on a tie). Pure and unit-tested; readCardBlocks feeds
 * it the browser-collected candidates.
 */
export function selectCardBlocks(candidates: BlockCandidate[]): RawCard[] {
  const byParent = new Map<number, RawCard[]>();
  for (const candidate of candidates) {
    const pairs = candidate.pairs
      .filter((p) => p.fromDl || pairValueParses(p.value))
      .map((p) => ({ label: p.label, value: p.value }));
    if (pairs.length < 3) continue;
    const list = byParent.get(candidate.parentKey) ?? [];
    list.push({ identity: candidate.identity, pairs });
    byParent.set(candidate.parentKey, list);
  }
  let best: RawCard[] = [];
  for (const list of byParent.values()) {
    if (list.length >= 4 && list.length > best.length) best = list;
  }
  return best;
}

/** Collect candidate card blocks from the DOM (identity + candidate pairs, per parent). */
function collectBlockCandidates(page: DomReadyPage): Promise<BlockCandidate[]> {
  return page.evaluate<BlockCandidate[], undefined>(() => {
    const intCell = /^-?\d+$/;
    const parentKeys = new Map<Element, number>();
    const out: BlockCandidate[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const pairs: { label: string; value: string; fromDl: boolean }[] = [];
      const dls = el.querySelectorAll("dl");
      if (dls.length > 0) {
        for (const dl of Array.from(dls)) {
          const dts = Array.from(dl.querySelectorAll("dt"));
          const dds = Array.from(dl.querySelectorAll("dd"));
          const n = Math.min(dts.length, dds.length);
          for (let i = 0; i < n; i++) {
            pairs.push({
              label: (dts[i]!.textContent || "").replace(/\s+/g, " ").trim(),
              value: (dds[i]!.textContent || "").replace(/\s+/g, " ").trim(),
              fromDl: true
            });
          }
        }
      } else {
        // Fallback: consecutive element children whose LABEL is non-numeric. The
        // VALUE-side parse check (§2) is applied on the Node side (selectCardBlocks)
        // with B's real cell parsers, which cannot run inside page.evaluate.
        const kids = Array.from(el.children);
        for (let i = 0; i + 1 < kids.length; i += 2) {
          const label = (kids[i]!.textContent || "").replace(/\s+/g, " ").trim();
          const value = (kids[i + 1]!.textContent || "").replace(/\s+/g, " ").trim();
          if (label.length > 0 && !intCell.test(label)) pairs.push({ label, value, fromDl: false });
        }
      }
      // >=3 CANDIDATE pairs: value validation only REMOVES pairs, so this cannot
      // drop a block that would still have >=3 valid pairs after the Node-side check.
      if (pairs.length < 3) continue;
      const parent = el.parentElement;
      if (!parent) continue;

      // Identity (§2): the block's heading's own text (excluding nested elements
      // such as a rank badge), else the first text outside any label–value pair.
      const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
      let identity = "";
      if (heading) {
        const parts: string[] = [];
        for (const child of Array.from(heading.childNodes)) {
          if (child.nodeType === 3) parts.push(child.textContent || "");
        }
        identity = parts.join("").replace(/\s+/g, " ").trim();
        if (!identity) identity = (heading.textContent || "").replace(/\s+/g, " ").trim();
      } else {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const t = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (t) {
            let p = node.parentElement;
            let insidePair = false;
            while (p && p !== el) {
              const tag = p.tagName.toLowerCase();
              if (tag === "dt" || tag === "dd") {
                insidePair = true;
                break;
              }
              p = p.parentElement;
            }
            if (!insidePair) {
              identity = t;
              break;
            }
          }
          node = walker.nextNode();
        }
      }

      let parentKey = parentKeys.get(parent);
      if (parentKey === undefined) {
        parentKey = parentKeys.size;
        parentKeys.set(parent, parentKey);
      }
      out.push({ parentKey, identity, pairs });
    }
    return out;
  });
}

/**
 * Read the largest set of >=4 sibling blocks each containing >=3 label–value pairs
 * (§2): collect candidate blocks from the DOM, then apply the value-side parse
 * check + thresholds + sibling grouping on the Node side with B's real cell parsers.
 */
export async function readCardBlocks(page: DomReadyPage): Promise<RawCard[]> {
  return selectCardBlocks(await collectBlockCandidates(page));
}

/**
 * Deterministic extraction repair (§2): the same trigger as C's extract repair
 * (no header-mappable table found). Reads the card grid and maps it through the
 * frozen table path. Returns the rows, or null when no mappable structure exists.
 */
export async function deterministicExtract(
  page: DomReadyPage,
  step: "extract-stats" | "extract-odds"
): Promise<{ statsRows?: ExtractedStatsRow[]; oddsRows?: ExtractedOddsRow[] } | null> {
  const cards = await readCardBlocks(page);
  if (step === "extract-stats") {
    const rows = readStatsCards(cards);
    return rows ? { statsRows: rows } : null;
  }
  const rows = readOddsCards(cards);
  return rows ? { oddsRows: rows } : null;
}
