/**
 * The single source string for the dismiss-modal text matcher (PROTOCOL_2A §2a).
 *
 * The Phase-1 matcher `/no thanks|close|dismiss|x/i` was tested UNANCHORED against
 * raw textContent, so its `x` alternative matched any control merely CONTAINING an
 * x ("Ne**x**t"). The §2a correction anchors the pattern to the trimmed WHOLE text.
 *
 * This is exported as a plain SOURCE STRING (not a RegExp) because it is passed
 * as an argument into `page.evaluate` closures — both the stagehand engine's
 * `clickOverlayDismiss` guard and the hybrid B2 `dismiss-modal` rung rebuild it
 * with `new RegExp(DISMISS_TEXT_PATTERN, "i")` inside the page, where an outer
 * const cannot be captured. Equivalent to `/^\s*(no thanks|close|dismiss|×|x)\s*$/i`
 * (the `×` alternative is U+00D7, the multiplication sign).
 */
export const DISMISS_TEXT_PATTERN: string = "^\\s*(no thanks|close|dismiss|×|x)\\s*$";
