#!/usr/bin/env python3
"""Render the README's Phase-2A charts from evidence/phase2a/ per-run records.

Every plotted number is recomputed from the bundled results.json files, then
checked against ``EXPECTED`` — a hard-coded snapshot of the published
figures, transcribed from docs/PHASE2A_RESULTS.md — before anything is
drawn; the script exits nonzero on any mismatch. It also independently
re-asserts the two structural claims the charts lean on: every cell is
deterministic (0/5 or 5/5 across sweeps), and every keyless trial recorded
zero LLM calls.

Usage:
    python3 -m venv .venv && .venv/bin/pip install matplotlib
    .venv/bin/python scripts/render-phase2a-charts.py

Writes docs/img/outcome_map.png, docs/img/pass_vs_cost.png,
docs/img/gate_effect.png.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

REPO = Path(__file__).resolve().parents[1]
EV = REPO / "evidence" / "phase2a"
OUT = REPO / "docs" / "img"

POLICIES = ["A", "B", "B2", "C", "D"]
KEYED = {"C", "D"}
SWEEPS = [1, 2, 3, 4, 5]

# Column order: the 32 held-out scenarios grouped by stratum.
GROUPS = [
    ("class drift (F1)", [f"f1-class-l{l}-{v}" for l in range(5) for v in "ab"]),
    ("silent decoys (F2)", [f"f2-decoy-l{l}-{v}" for l in range(4) for v in "ab"]),
    ("page size (F3)", [f"f3-page-size-{s}-{v}" for s in (5, 3, 2) for v in "ab"]),
    ("named (K)", ["k-header-vocabulary", "k-ui-copy", "k-column-order", "k-layout-cards"]),
    ("compound (X)", ["x-cards-header-vocabulary", "x-class-l2-decoy-l2",
                      "x-class-l3-page-size-2", "x-wrapped-column-copy"]),
]
SCENARIOS = [s for _, cols in GROUPS for s in cols]

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


# ── editorial style system (shared with mcp-router-stress-test) ──────────────
BG = "#F8F5EC"
INK = "#211E19"
SUB = "#55503F"
MUTED = "#8A8371"
GRID = "#E7E1CE"
AXISC = "#C6BFA9"
KICK = "#1E7A4C"
PASS_C = "#1E7A4C"
FAIL_C = "#A02B23"

SANS = ["Helvetica Neue", "Arial", "DejaVu Sans"]
MONO = ["Menlo", "Courier New", "DejaVu Sans Mono"]

POLICY_LABEL = {
    "A": "A  baseline selectors",
    "B": "B  structural (no repair)",
    "B2": "B2 deterministic repair",
    "C": "C  LLM repair on failure",
    "D": "D  full semantic (LLM drives)",
}
POLICY_COLOR = {
    "A": "#8C8678", "B": "#3E8CD1", "B2": "#C08019", "C": "#1E7A4C", "D": "#6B34C4",
}


def style(ax):
    ax.set_facecolor(BG)
    for spine in ax.spines.values():
        spine.set_color(AXISC)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors=MUTED, labelcolor=SUB)


def headline(fig, title, sub, y=0.955, sub_y=0.90, size=21):
    fig.text(0.045, y, title, fontsize=size, fontweight="bold", color=INK,
             family=SANS, ha="left", va="top")
    fig.add_artist(plt.Line2D([0.045, 0.085], [y - 0.062, y - 0.062],
                              transform=fig.transFigure, color=INK, lw=3))
    fig.text(0.045, sub_y - 0.02, sub, fontsize=10.5, color=SUB, family=SANS,
             ha="left", va="top", linespacing=1.55)


def footnote(fig, extra=""):
    fig.text(0.045, 0.012,
             "recomputed from evidence/phase2a per-run records; render refuses on any mismatch"
             + (f" · {extra}" if extra else "") + " · phase 2A",
             fontsize=8, color=MUTED, family=MONO, ha="left", va="bottom")


def chart_outcome_map(cells):
    fig, ax = plt.subplots(figsize=(13.4, 6.1), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.20, right=0.985, top=0.70, bottom=0.17)

    gap = 0.9
    xpos, group_bounds = {}, []
    x = 0.0
    for gname, cols in GROUPS:
        start = x
        for sid in cols:
            xpos[sid] = x
            x += 1.0
        group_bounds.append((gname, start, x - 1.0))
        x += gap

    for yi, pol in enumerate(POLICIES):
        y = len(POLICIES) - 1 - yi
        for sid in SCENARIOS:
            passed = all(p for _, p, _ in cells[pol][sid])
            color = PASS_C if passed else FAIL_C
            alpha = 0.92 if not passed else 0.55
            ax.add_patch(Rectangle((xpos[sid] - 0.44, y - 0.36), 0.88, 0.72,
                                   facecolor=color, alpha=alpha, edgecolor=BG, lw=1.2))
        npass = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS)
        ax.text(x - gap + 0.6, y, f"{npass}/32", fontsize=10, family=MONO,
                color=INK, va="center", ha="left")
        ax.text(-1.1, y, POLICY_LABEL[pol], fontsize=10, family=SANS,
                color=INK, va="center", ha="right", clip_on=False)

    level_labels = {
        "class drift (F1)": ["L0", "L1", "L2", "L3", "L4"],
        "silent decoys (F2)": ["L0", "L1", "L2", "L3"],
        "page size (F3)": ["5", "3", "2"],
        "named (K)": None,
        "compound (X)": None,
    }
    rotated_labels = {
        "named (K)": ["header-vocab", "ui-copy", "col-order", "layout-cards"],
        "compound (X)": ["cards+vocab", "class+decoy", "class+pagesize", "wrap+copy"],
    }
    for gname, start, end in group_bounds:
        mid = (start + end) / 2
        ax.text(mid, len(POLICIES) - 0.28, gname, fontsize=9.5, family=SANS,
                color=SUB, ha="center", fontweight="bold")
        labels = level_labels[gname]
        if labels is None:
            for i, lab in enumerate(rotated_labels[gname]):
                ax.text(start + i, -0.62, lab, fontsize=7.5, family=MONO,
                        color=MUTED, ha="right", va="top", rotation=40)
            continue
        ncols = end - start + 1
        per = ncols / len(labels)
        for i, lab in enumerate(labels):
            ax.text(start + per * i + (per - 1) / 2, -0.78, lab, fontsize=8,
                    family=MONO, color=MUTED, ha="center")

    # callouts
    f2 = group_bounds[1]
    ax.annotate("C fails every decoy cell with 0 repair calls —\nwrong data looks like success, the trigger never fires",
                xy=((f2[1] + f2[2]) / 2, -1.15), xytext=((f2[1] + f2[2]) / 2, -2.15),
                fontsize=8.8, family=SANS, color=FAIL_C, ha="center", va="top",
                arrowprops=dict(arrowstyle="-", color=FAIL_C, lw=0.8))
    f3 = group_bounds[2]
    gx = (xpos["f3-page-size-3-a"] + xpos["f3-page-size-2-b"]) / 2
    ax.annotate("pages 3 and 2: the shared ≥5-row readiness check\nfails every policy that consults it — only A passes",
                xy=(gx, -1.15), xytext=(gx + 4.5, -2.15),
                fontsize=8.8, family=SANS, color=INK, ha="center", va="top",
                arrowprops=dict(arrowstyle="-", color=INK, lw=0.8))

    ax.set_xlim(-0.7, x - gap + 2.3)
    ax.set_ylim(-2.6, len(POLICIES) + 0.4)
    ax.axis("off")

    headline(fig,
             "32 held-out scenarios × 5 policies: three failure regimes, zero variance",
             "Each cell pools five sweeps and every cell is 5/5 or 0/5 — the grid is perfectly repeatable, so "
             "the blocks are architecture, not noise.\n"
             "Class drift falls to deterministic repair. Silent decoys fall only to full semantics. "
             "The small-page cluster falls to nobody gated behind the readiness check.",
             y=0.965, sub_y=0.875)
    footnote(fig, "green = passed all 5 sweeps, red = failed all 5")
    fig.savefig(OUT / "outcome_map.png", facecolor=BG)
    plt.close(fig)


def chart_pass_vs_cost(cells, costs):
    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.09, right=0.96, top=0.72, bottom=0.12)
    style(ax)
    ax.grid(axis="y", color=GRID, lw=1)
    ax.set_axisbelow(True)

    pts = {}
    for pol in POLICIES:
        npass = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS)
        cost = sum(costs[pol]) / len(costs[pol]) if costs[pol] else 0.0
        pts[pol] = (cost, npass)
        ax.scatter([cost], [npass], s=130, color=POLICY_COLOR[pol], zorder=3)

    offsets = {"A": (0.028, 0.1), "B": (0.028, -0.25), "B2": (0.028, 0.1),
               "C": (0.028, 0.35), "D": (-0.03, 0.5)}
    align = {"D": "right"}
    for pol, (cost, npass) in pts.items():
        dx, dy = offsets[pol]
        cost_lab = "$0 (zero model-inference cost)" if cost == 0 else f"${cost:.3f}/sweep"
        ax.text(cost + dx, npass + dy, POLICY_LABEL[pol], fontsize=10.5,
                family=SANS, fontweight="bold", color=POLICY_COLOR[pol],
                ha=align.get(pol, "left"), va="bottom")
        ax.text(cost + dx, npass + dy - 0.08, f"{npass}/32 · {cost_lab}",
                fontsize=9.5, family=MONO, color=SUB,
                ha=align.get(pol, "left"), va="top")

    ax.set_xlim(-0.05, 1.16)
    ax.set_ylim(9.5, 30.5)
    ax.set_yticks([10, 15, 20, 25, 30])
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_xticklabels(["$0", "$0.25", "$0.50", "$0.75", "$1.00"],
                       fontsize=9.5, family=MONO)
    ax.set_xlabel("model-inference cost per 32-scenario sweep", fontsize=10,
                  family=MONO, color=MUTED)
    ax.set_ylabel("scenario cells passed (of 32, all 5 sweeps)", fontsize=10,
                  family=MONO, color=MUTED)

    ax.text(0.66, 16.5,
            "D's 7-cell edge over C is exactly the silent-decoy set,\n"
            "bought at 8.9× the spend — and the 5 cells D still fails\n"
            "are the shared readiness gate no spend can cross",
            fontsize=9.5, family=SANS, color=INK, ha="center",
            linespacing=1.5, fontweight="bold")

    headline(fig,
             "What paying for semantics buys, cell by cell",
             "Pass cells against per-sweep inference cost on the held-out grid. Up and left is better.\n"
             "Structural addressing (B) underperforms the hardcoded baseline under drift; deterministic "
             "repair (B2) is the best free policy;\nLLM repair (C) adds three cells for twelve cents; "
             "full semantics (D) adds seven more for a dollar.",
             y=0.955, sub_y=0.87)
    footnote(fig)
    fig.savefig(OUT / "pass_vs_cost.png", facecolor=BG)
    plt.close(fig)


def chart_gate_effect(cells):
    fig, ax = plt.subplots(figsize=(10.8, 5.6), dpi=150)
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(left=0.09, right=0.96, top=0.68, bottom=0.13)
    style(ax)
    ax.grid(axis="y", color=GRID, lw=1)
    ax.set_axisbelow(True)

    w = 0.36
    for i, pol in enumerate(POLICIES):
        full = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS) / 32
        ex = sum(all(p for _, p, _ in cells[pol][s]) for s in SCENARIOS if s not in GATE5) / 27
        ax.bar(i - w / 2, full * 100, w, color=POLICY_COLOR[pol], alpha=0.45)
        ax.bar(i + w / 2, ex * 100, w, color=POLICY_COLOR[pol])
        ax.text(i - w / 2, full * 100 + 1.2, f"{full * 100:.0f}", fontsize=9,
                family=MONO, color=MUTED, ha="center")
        ax.text(i + w / 2, ex * 100 + 1.2, f"{ex * 100:.0f}", fontsize=9.5,
                family=MONO, color=INK, ha="center", fontweight="bold")

    ax.annotate("100% — the model was never the ceiling;\nthe readiness gate was",
                xy=(4 + w / 2, 101), xytext=(2.55, 92), fontsize=9.5, family=SANS,
                color=INK, fontweight="bold", ha="center",
                arrowprops=dict(arrowstyle="-", color=INK, lw=0.8))

    ax.set_xticks(range(len(POLICIES)))
    ax.set_xticklabels([POLICY_LABEL[p] for p in POLICIES], fontsize=9.5,
                       family=SANS, color=INK)
    ax.set_ylim(0, 112)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.set_ylabel("cells passed", fontsize=10, family=MONO, color=MUTED)

    ax.text(0.02, 108, "faint: full 32-cell grid · solid: the 27 cells outside the readiness-gate cluster",
            fontsize=9, family=SANS, color=SUB, ha="left")

    headline(fig,
             "Remove the five gate cells and the ladder is a clean dose-response",
             "A descriptive cut, not a registered metric: the five columns where the shared ≥5-row readiness "
             "check blocks every gated policy are set aside.\nWhat remains orders exactly by how much semantics "
             "each policy buys — B2 < C < D, with D perfect.",
             y=0.95, sub_y=0.86, size=19)
    footnote(fig)
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
