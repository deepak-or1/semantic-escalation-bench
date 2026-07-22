#!/usr/bin/env python3
"""Render the README's Phase-2A charts from evidence/phase2a/ per-run records.

Every plotted number is recomputed from the bundled results.json files, then
checked against ``EXPECTED`` — a hard-coded snapshot of the published
figures, transcribed from docs/PHASE2A_RESULTS.md — before anything is
drawn; the script exits nonzero on any mismatch. It also independently
re-asserts the two structural claims the charts lean on: every cell is
deterministic (0/5 or 5/5 across sweeps), and every keyless trial recorded
zero LLM calls.

Style variant: "newsroom graphics desk" (Economist/FT lineage, modernized).
Presentation layer only — the data-integrity gate below is unchanged.

Usage:
    python3 -m venv .venv && .venv/bin/pip install matplotlib
    .venv/bin/python render.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle
from matplotlib.lines import Line2D

REPO = Path(__file__).resolve().parents[1]
EV = REPO / "evidence" / "phase2a"
OUT = REPO / "docs" / "img"

POLICIES = ["A", "B", "B2", "C", "D"]
KEYED = {"C", "D"}
SWEEPS = [1, 2, 3, 4, 5]

# Column order: the 32 held-out scenarios grouped by stratum.
GROUPS = [
    ("class drift", "F1 · levels 0–4", [f"f1-class-l{l}-{v}" for l in range(5) for v in "ab"]),
    ("silent decoys", "F2 · levels 0–3", [f"f2-decoy-l{l}-{v}" for l in range(4) for v in "ab"]),
    ("page size", "F3 · rows per page", [f"f3-page-size-{s}-{v}" for s in (5, 3, 2) for v in "ab"]),
    ("named", "K · one condition", ["k-header-vocabulary", "k-ui-copy", "k-column-order", "k-layout-cards"]),
    ("compound", "X · two at once", ["x-cards-header-vocabulary", "x-class-l2-decoy-l2",
                                     "x-class-l3-page-size-2", "x-wrapped-column-copy"]),
]
SCENARIOS = [s for _, _, cols in GROUPS for s in cols]

GATE5 = {"f3-page-size-3-a", "f3-page-size-3-b", "f3-page-size-2-a",
         "f3-page-size-2-b", "x-class-l3-page-size-2"}

# Hard-coded snapshot of the published numbers (docs/PHASE2A_RESULTS.md).
# The script recomputes each from the bundled records and refuses to render
# on mismatch.
EXPECTED_PASS = {"A": 15, "B": 11, "B2": 17, "C": 20, "D": 27}          # of 32
EXPECTED_PASS_EXGATE = {"A": 11, "B": 11, "B2": 17, "C": 20, "D": 27}   # of 27
EXPECTED_SWEEP_COST = {"A": 0.0, "B": 0.0, "B2": 0.0, "C": 0.1192, "D": 1.0565}
EXPECTED_C_ZEROCALL_FAILCELLS = 6   # trigger-blind decoy cells: 0 LLM calls in all 5 sweeps


def load():
    """-> cells[policy][scenario] = list of (sweep, passed, llmCalls); costs[policy] = [per-sweep $]."""
    cells = defaultdict(dict)
    costs = defaultdict(list)
    for prefix, ledger in (("keyless", "campaign-state.keyless.json"),
                           ("keyed", "campaign-state.keyed.restart1.json")):
        state = json.loads((EV / "states" / ledger).read_text())
        for e in state["entries"]:
            run = EV / "runs" / f"{prefix}-s{e['sweep']}-{e['policy']}"
            data = json.loads((run / "results.json").read_text())
            costs[e["policy"]].append(e["costUsd"])
            for t in data["trials"]:
                calls = (t.get("tokens") or {}).get("llmCalls", 0)
                cells[e["policy"]].setdefault(t["scenarioId"], []).append(
                    (e["sweep"], t["outcome"] == "pass", calls))
    return cells, costs


def verify(cells, costs):
    bad = []
    for pol in POLICIES:
        got = cells[pol]
        if sorted(got) != sorted(SCENARIOS):
            bad.append(f"{pol}: scenario set mismatch")
            continue
        for sid, obs in got.items():
            if len(obs) != 5:
                bad.append(f"{pol}/{sid}: {len(obs)} trials, expected 5")
            outcomes = {p for _, p, _ in obs}
            if len(outcomes) != 1:
                bad.append(f"{pol}/{sid}: nondeterministic across sweeps")
            if pol not in KEYED and any(c != 0 for _, _, c in obs):
                bad.append(f"{pol}/{sid}: keyless trial recorded llmCalls > 0")
        npass = sum(all(p for _, p, _ in obs) for obs in got.values())
        if npass != EXPECTED_PASS[pol]:
            bad.append(f"{pol}: {npass}/32 != published {EXPECTED_PASS[pol]}/32")
        nex = sum(all(p for _, p, _ in obs) for sid, obs in got.items() if sid not in GATE5)
        if nex != EXPECTED_PASS_EXGATE[pol]:
            bad.append(f"{pol}: {nex}/27 ex-gate != published {EXPECTED_PASS_EXGATE[pol]}/27")
        mean_cost = sum(costs[pol]) / len(costs[pol]) if costs[pol] else 0.0
        if abs(mean_cost - EXPECTED_SWEEP_COST[pol]) > 0.001:
            bad.append(f"{pol}: ${mean_cost:.4f}/sweep != published ${EXPECTED_SWEEP_COST[pol]:.4f}")
    zerocall = sum(
        1 for sid, obs in cells["C"].items()
        if sid not in GATE5 and not any(p for _, p, _ in obs)
        and all(c == 0 for _, _, c in obs))
    if zerocall != EXPECTED_C_ZEROCALL_FAILCELLS:
        bad.append(f"C zero-call fail cells: {zerocall} != published {EXPECTED_C_ZEROCALL_FAILCELLS}")
    for line in bad:
        print(f"[FAIL] {line}")
    return not bad


# ── newsroom graphics-desk style system ──────────────────────────────────────
# Warm broadsheet paper, near-black ink, one signature vermilion. The five
# policies carry no categorical colour: an ordered ink→silver gray ramp encodes
# ladder position (darkest = D, lightest = A). Vermilion is reserved, strictly,
# for the kicker tab, failure tiles, and story-critical marks.
BG    = "#FDFCF9"   # warm near-white paper
INK   = "#14171C"   # near-black ink
SUB   = "#3C3F46"   # subtitle / reading note
MUTED = "#6E7178"   # secondary labels, ticks
FAINT = "#A7AAAE"   # footnote, ghost figures
GRID  = "#E8E4DB"   # hairline grid on paper
RULE  = "#1F232A"   # header hairline rule
VERM  = "#E03131"   # signature crimson-coral — tab · failures · highlight

# Per-policy palette — "Stripe-warm vibrant": chroma-equalized mid-lightness
# hues, warm-shifted toward the paper. Each hue ships with a designed lighter
# partner for within-mark duotone gradients (the Tableau-20 mechanism).
POLICY_COLOR = {
    "A":  "#6B6259",   # warm slate
    "B":  "#4C6EF5",   # cobalt
    "B2": "#F59F00",   # marigold
    "C":  "#099268",   # emerald
    "D":  "#9C36B5",   # grape
}
POLICY_LIGHT = {
    "A":  "#CFC7BC",   # bone
    "B":  "#91A7FF",   # periwinkle
    "B2": "#FFCE85",   # light gold
    "C":  "#63E6BE",   # mint
    "D":  "#E599F7",   # orchid
}
PASS_TINT = "#E6F6EC"  # quiet mint-sage pass tile — passes stay silent


def blend(hex1, hex2, t):
    """t=0 -> hex1, t=1 -> hex2."""
    a = [int(hex1[i:i+2], 16) for i in (1, 3, 5)]
    b = [int(hex2[i:i+2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(a, b))

SERIF = ["Georgia", "Charter", "Palatino", "DejaVu Serif"]              # display headline
SANS  = ["Seravek", "Avenir Next", "Helvetica Neue", "DejaVu Sans"]     # humanist body
MONO  = ["Menlo", "Courier New", "DejaVu Sans Mono"]                    # every numeral

POLICY_LABEL = {
    "A": "A · baseline selectors",
    "B": "B · structural, no repair",
    "B2": "B2 · deterministic repair",
    "C": "C · LLM repair on failure",
    "D": "D · full semantic",
}


def bloom(ax, x, y, color, rx, ry, peak=0.30, n=240):
    """A smooth Gaussian radial bloom in data coordinates — the mark reads
    as a light source bleeding softly onto the paper."""
    import numpy as np
    from matplotlib import colors as mcolors
    yy, xx = np.mgrid[-1:1:complex(n), -1:1:complex(n)]
    falloff = np.exp(-(xx ** 2 + yy ** 2) * 4.5)
    img = np.empty((n, n, 4))
    img[..., :3] = mcolors.to_rgb(color)
    img[..., 3] = peak * falloff
    ax.imshow(img, extent=(x - rx, x + rx, y - ry, y + ry),
              origin="lower", aspect="auto", zorder=1.8,
              interpolation="bilinear")


def grad_bar(ax, x, h, w, color, light, n=180):
    """Solid bar with a within-mark duotone gradient: full hue at the cap
    fading toward its designed lighter partner at the base."""
    import numpy as np
    from matplotlib import colors as mcolors
    top = np.array(mcolors.to_rgb(color))
    bot = np.array(mcolors.to_rgb(blend(color, light, 0.68)))
    t = np.linspace(0, 1, n).reshape(-1, 1, 1)
    img = bot + (top - bot) * t
    ax.imshow(img, extent=(x - w / 2, x + w / 2, 0, h), origin="lower",
              aspect="auto", zorder=3, interpolation="bilinear")


def dot(ax, x, y, color, light, s=66, filled=True):
    """Open ring = the policy spends nothing on inference; filled = it pays.
    Every mark sits in a soft Gaussian bloom of its own hue (paid marks burn
    brighter); filled dots are lit from within: saturated rim, light-partner
    body, near-white hot center."""
    if filled:
        bloom(ax, x, y, color, rx=0.042, ry=2.6, peak=0.10)
        ax.scatter([x], [y], s=s, color=color, lw=0.7, edgecolors=BG, zorder=3)
        ax.scatter([x], [y], s=s * 0.52, color=light, alpha=1.0, lw=0, zorder=4)
    else:
        ax.scatter([x], [y], s=s, facecolors=BG, edgecolors=color, lw=1.6, zorder=3)


def kicker_tab(fig, x0=0.048, y_top=0.966):
    """The classic broadsheet red kicker tab — a ~48×8px vermilion rectangle
    pinned to the very top-left of the figure."""
    w_in, h_in = fig.get_size_inches()
    tw = 48.0 / (w_in * fig.dpi)
    th = 8.0 / (h_in * fig.dpi)
    fig.add_artist(Rectangle((x0, y_top - th), tw, th, transform=fig.transFigure,
                             facecolor=VERM, edgecolor="none", zorder=6, clip_on=False))


def hairline(fig, y, x0=0.048, x1=0.985):
    """0.75pt full-width rule under the header block."""
    fig.add_artist(Line2D([x0, x1], [y, y], transform=fig.transFigure,
                          color=RULE, lw=0.75, solid_capstyle="butt", zorder=4))


def header(fig, kicker, title, sub, legend=None, title_y=0.905, rule_y=0.715):
    """Broadsheet masthead: vermilion tab, mono eyebrow, serif display
    headline, humanist-sans standfirst, then a hairline rule."""
    x0 = 0.048
    kicker_tab(fig)
    fig.text(x0, 0.945, kicker, fontsize=7.1, family=MONO, color=MUTED,
             ha="left", va="top", fontweight="bold")
    fig.text(x0, title_y, title, fontsize=18, family=SERIF, fontweight="bold",
             color=INK, ha="left", va="top", linespacing=1.06)
    fig.text(x0, title_y - 0.066, sub, fontsize=9.4, family=SANS, color=SUB,
             ha="left", va="top", linespacing=1.6)
    hairline(fig, rule_y)
    if legend:
        x = 0.985
        for label, color in reversed(legend):
            t = fig.text(x, 0.951, label, fontsize=8.4, family=SANS,
                         color=SUB, ha="right", va="top")
            fig.canvas.draw()
            bb = t.get_window_extent().transformed(fig.transFigure.inverted())
            fig.text(bb.x0 - 0.009, 0.9475, "■", fontsize=6.6, color=color,
                     ha="right", va="top")
            x = bb.x0 - 0.03


def verdict(ax, x, y, line1, line2, color, ha="left"):
    ax.text(x, y, line1, fontsize=8.2, family=SANS, color=color,
            fontweight="bold", ha=ha, va="top", linespacing=1.5)
    ax.text(x, y, "\n" + line2, fontsize=8.2, family=SANS, color=MUTED,
            ha=ha, va="top", linespacing=1.5)


def footnote(fig, extra="", num=None):
    lead = f"fig. {num}/3 · " if num else ""
    fig.text(0.048, 0.018,
             lead + "recomputed from evidence/phase2a per-run records · render refuses on any mismatch"
             + (f" · {extra}" if extra else "") + " · phase 2A",
             fontsize=7.2, color=FAINT, family=MONO, ha="left", va="bottom")


def bare(ax):
    ax.set_facecolor(BG)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(colors=FAINT, labelcolor=MUTED, length=0)


def chart_outcome_map(cells):
    fig, ax = plt.subplots(figsize=(12.9, 6.1), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.185, right=0.985, top=0.66, bottom=0.15)

    gap = 1.1
    xpos, bounds = {}, []
    x = 0.0
    for gname, qual, cols in GROUPS:
        start = x
        for sid in cols:
            xpos[sid] = x
            x += 1.0
        bounds.append((gname, qual, start, x - 1.0))
        x += gap

    for yi, pol in enumerate(POLICIES):
        y = len(POLICIES) - 1 - yi
        for sid in SCENARIOS:
            passed = all(p for _, p, _ in cells[pol][sid])
            ax.add_patch(FancyBboxPatch(
                (xpos[sid] - 0.36, y - 0.28), 0.72, 0.56,
                boxstyle="round,pad=0,rounding_size=0.06", mutation_aspect=0.62,
                facecolor=PASS_TINT if passed else VERM, edgecolor="none"))
        npass = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS)
        ax.text(x - gap + 0.7, y, f"{npass}/32", fontsize=8.8, family=MONO,
                color=SUB, va="center", ha="left")
        ax.text(-1.1, y, POLICY_LABEL[pol], fontsize=9.2, family=SANS,
                color=INK, va="center", ha="right", clip_on=False)

    level_labels = {
        "class drift": ["L0", "L1", "L2", "L3", "L4"],
        "silent decoys": ["L0", "L1", "L2", "L3"],
        "page size": ["5", "3", "2"],
    }
    rotated_labels = {
        "named": ["header-vocab", "ui-copy", "col-order", "layout-cards"],
        "compound": ["cards+vocab", "class+decoy", "class+pagesize", "wrap+copy"],
    }
    for gname, qual, start, end in bounds:
        ax.text(start - 0.38, len(POLICIES) + 0.28, gname, fontsize=9.2,
                family=SANS, color=INK, ha="left", fontweight="bold")
        ax.text(start - 0.38, len(POLICIES) - 0.22, qual, fontsize=7.3,
                family=MONO, color=MUTED, ha="left")
        if gname in level_labels:
            labels = level_labels[gname]
            per = (end - start + 1) / len(labels)
            for i, lab in enumerate(labels):
                ax.text(start + per * i + (per - 1) / 2, -0.72, lab, fontsize=7.3,
                        family=MONO, color=MUTED, ha="center")
        else:
            for i, lab in enumerate(rotated_labels[gname]):
                ax.text(start + i, -0.58, lab, fontsize=6.8, family=MONO,
                        color=MUTED, ha="right", va="top", rotation=38)

    f2 = bounds[1]
    verdict(ax, (f2[2] + f2[3]) / 2, -1.92,
            "C fails all six pure F2 decoy cells with 0 repair calls —",
            "wrong data looks like success, so the trigger never fires",
            VERM, ha="center")
    gx = (xpos["f3-page-size-3-a"] + xpos["f3-page-size-2-b"]) / 2
    verdict(ax, gx + 5.5, -1.92,
            "pages 3 and 2: the shared ≥5-row readiness check fails",
            "every policy that consults it — only A passes these four cells",
            INK, ha="center")

    ax.set_xlim(-0.7, x - gap + 2.6)
    ax.set_ylim(-2.75, len(POLICIES) + 0.75)
    ax.axis("off")

    header(fig,
           "EVERY CELL IDENTICAL ACROSS ALL FIVE SWEEPS · 5/5 OR 0/5 · NOTHING BETWEEN",
           "32 held-out scenarios × 5 policies: three failure regimes",
           "Each tile pools five sweeps; the grid repeats exactly, so the blocks are architecture, not noise. Class drift falls to\n"
           "deterministic repair. Silent decoys fall only to full semantics. The small-page cluster falls to nobody behind the readiness check.",
           legend=[("passed all 5 sweeps", "#C9E9D6"), ("failed all 5", VERM)])
    footnote(fig, num=1)
    fig.savefig(OUT / "outcome_map.png", facecolor=BG)
    plt.close(fig)


def chart_pass_vs_cost(cells, costs):
    fig, ax = plt.subplots(figsize=(12.9, 6.1), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.075, right=0.96, top=0.66, bottom=0.13)
    bare(ax)
    ax.grid(axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)

    pts = {}
    for pol in POLICIES:
        npass = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS)
        cost = sum(costs[pol]) / len(costs[pol]) if costs[pol] else 0.0
        pts[pol] = (cost, npass)
        dot(ax, cost, npass, POLICY_COLOR[pol], POLICY_LIGHT[pol], filled=pol in KEYED)

    offsets = {"A": (0.022, -1.62), "B": (0.022, 0.0), "B2": (0.022, 0.30),
               "C": (0.022, 0.25), "D": (-0.026, 0.25)}
    align = {"D": "right"}
    for pol, (cost, npass) in pts.items():
        dx, dy = offsets[pol]
        cost_lab = "$0 · zero model inference" if cost == 0 else f"${cost:.3f}/sweep"
        ax.text(cost + dx, npass + dy + 0.18, POLICY_LABEL[pol], fontsize=9,
                family=SANS, fontweight="bold", color=POLICY_COLOR[pol],
                ha=align.get(pol, "left"), va="bottom")
        ax.text(cost + dx, npass + dy + 0.05, f"{npass}/32 · {cost_lab}",
                fontsize=8, family=MONO, color=MUTED,
                ha=align.get(pol, "left"), va="top")

    ax.set_xlim(-0.05, 1.15)
    ax.set_ylim(9.2, 30.2)
    ax.set_yticks([10, 15, 20, 25, 30])
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_xticklabels(["$0", "$0.25", "$0.50", "$0.75", "$1.00"],
                       fontsize=8, family=MONO)
    ax.tick_params(axis="y", labelsize=8)
    for tick in ax.get_yticklabels():
        tick.set_fontfamily(MONO)
    ax.set_xlabel("model-inference cost per 32-scenario sweep", fontsize=8,
                  family=MONO, color=MUTED, labelpad=8)
    ax.set_ylabel("cells passed · of 32", fontsize=8,
                  family=MONO, color=MUTED, labelpad=8)

    verdict(ax, 0.63, 17.6,
            "D's 7-cell edge over C is exactly the silent-decoy set, at 8.9× the spend —",
            "and the 5 cells D still fails are the shared readiness gate no spend can cross",
            POLICY_COLOR["D"], ha="center")

    header(fig,
           "FIVE POLICIES · ONE PIPELINE · 32 HELD-OUT SCENARIOS · EXACT-OUTPUT GRADED",
           "What paying for semantics buys, cell by cell",
           "Cells passed against per-sweep inference cost. Up and left is better. Structural addressing without repair (B)\n"
           "lands under the hardcoded baseline; deterministic repair (B2) is the best free policy; LLM repair (C) adds three\n"
           "cells for twelve cents; full semantics (D) adds the seven decoy cells for a dollar.",
           legend=None, rule_y=0.70)
    footnote(fig, num=2)
    fig.savefig(OUT / "pass_vs_cost.png", facecolor=BG)
    plt.close(fig)


def chart_gate_effect(cells):
    fig, ax = plt.subplots(figsize=(12.9, 6.1), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.075, right=0.96, top=0.66, bottom=0.13)
    bare(ax)
    ax.grid(axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)

    w = 0.30
    for i, pol in enumerate(POLICIES):
        col = POLICY_COLOR[pol]
        full = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS) / 32
        ex = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS if s not in GATE5) / 27
        ax.bar(i - w / 2 - 0.02, full * 100, w,
               color=blend(POLICY_LIGHT[pol], BG, 0.45), zorder=2)
        grad_bar(ax, i + w / 2 + 0.02, ex * 100, w, col, POLICY_LIGHT[pol])
        ax.text(i - w / 2 - 0.02, full * 100 + 1.6, f"{full * 100:.0f}", fontsize=8,
                family=MONO, color=MUTED, ha="center")
        ax.text(i + w / 2 + 0.02, ex * 100 + 1.6, f"{ex * 100:.0f}", fontsize=8.6,
                family=MONO, color=INK, ha="center", fontweight="bold")

    verdict(ax, 2.62, 97,
            "D reads 100% with the gate cells set aside —",
            "the model was never the ceiling; the readiness gate was",
            POLICY_COLOR["D"], ha="center")

    ax.set_xlim(-0.55, len(POLICIES) - 0.45)
    ax.set_xticks(range(len(POLICIES)))
    ax.set_xticklabels([POLICY_LABEL[p] for p in POLICIES], fontsize=8.6,
                       family=SANS, color=INK)
    ax.set_ylim(0, 110)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"], fontsize=8)
    for tick in ax.get_yticklabels():
        tick.set_fontfamily(MONO)
    ax.set_ylabel("cells passed · %", fontsize=8, family=MONO, color=MUTED,
                  labelpad=8)

    header(fig,
           "A DESCRIPTIVE CUT, NOT A REGISTERED METRIC",
           "Remove the five gate cells and the ladder is a clean dose-response",
           "The five columns where the shared ≥5-row readiness check blocks every gated policy are set aside.\n"
           "What remains orders exactly by how much semantics each policy buys — B2 < C < D, with D perfect.",
           legend=[("full 32-cell grid", "#DCD6CB"), ("the 27 cells outside the gate cluster", "#57504A")])
    footnote(fig, num=3)
    fig.savefig(OUT / "gate_effect.png", facecolor=BG)
    plt.close(fig)


def main():
    cells, costs = load()
    if not verify(cells, costs):
        print("refusing to render: recomputed numbers disagree with the published snapshot")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    plt.rcParams["font.family"] = SANS
    chart_outcome_map(cells)
    chart_pass_vs_cost(cells, costs)
    chart_gate_effect(cells)
    print("wrote outcome_map.png, pass_vs_cost.png, gate_effect.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
