import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApp } from "./app";

/**
 * POST /__lab/config perturbation-param contract (PROTOCOL_2A §3, deliverable 1).
 * A schema error OR any §3 contradiction/lab-side violation returns HTTP 400 with
 * the error list — never a silent resolve. GET /__lab/ground-truth is unaffected by
 * params (presentation only). Boots the real express app on an ephemeral port.
 */

let server: Server;
let url: string;

beforeAll(async () => {
  const app = createLabApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

type Json = Record<string, unknown>;

async function postConfig(body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${url}/__lab/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function getJson(route: string): Promise<Json> {
  const res = await fetch(`${url}${route}`);
  return (await res.json()) as Json;
}

const issuesOf = (json: Json): string[] => (json.issues as string[] | undefined) ?? [];

const FULL_ORDER = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"];

describe("POST /__lab/config — §3 flag-XOR-param contradictions → 400", () => {
  const pairs: Array<[string, unknown, Record<string, unknown>]> = [
    ["columnShuffle + columnOrder", ["columnShuffle"], { columnOrder: FULL_ORDER }],
    ["copyDrift + uiCopy", ["copyDrift"], { uiCopy: { nextButton: "Onward" } }],
    ["classDrift + classDriftLevel", ["classDrift"], { classDriftLevel: 2 }],
    ["layoutVariant + layoutCondition", ["layoutVariant"], { layoutCondition: "cards" }],
    ["pagination + pageSize", ["pagination"], { pageSize: 3 }]
  ];
  for (const [label, chaos, params] of pairs) {
    it(`rejects ${label}`, async () => {
      const { status, json } = await postConfig({ seed: 2201, chaos, params });
      expect(status).toBe(400);
      expect(issuesOf(json).length).toBeGreaterThan(0);
    });
  }
});

describe("POST /__lab/config — lab-side validation → 400", () => {
  it("rejects a non-permutation columnOrder (duplicate + missing key)", async () => {
    const bad = ["P", "P", "W", "D", "L", "GF", "GA", "GD", "Form"]; // dup P, no Pts
    const { status, json } = await postConfig({ seed: 2201, params: { columnOrder: bad } });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("columnOrder"))).toBe(true);
  });

  it("rejects a too-short columnOrder", async () => {
    const { status } = await postConfig({ seed: 2201, params: { columnOrder: ["P", "W"] } });
    expect(status).toBe(400);
  });

  it("rejects decoyLevel 1 with no pagination scaffold", async () => {
    const { status, json } = await postConfig({ seed: 2201, chaos: [], params: { decoyLevel: 1 } });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("next-page"))).toBe(true);
  });

  it("rejects decoyLevel 2 when the hiddenTab scaffold is missing", async () => {
    const { status, json } = await postConfig({
      seed: 2201,
      chaos: ["pagination"],
      params: { decoyLevel: 2 }
    });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("hiddenTab"))).toBe(true);
  });

  it("rejects decoyLevel >= 1 with the layoutVariant flag (layout suppresses next-page)", async () => {
    // pagination scaffold present, so ONLY the layout-suppression conflict fires.
    const { status, json } = await postConfig({
      seed: 2201,
      chaos: ["layoutVariant", "pagination"],
      params: { decoyLevel: 1 }
    });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("layoutVariant") && s.includes("next-page"))).toBe(true);
  });

  it("rejects decoyLevel >= 1 with the layoutCondition param (layout suppresses next-page)", async () => {
    const { status, json } = await postConfig({
      seed: 2201,
      chaos: ["pagination"],
      params: { decoyLevel: 1, layoutCondition: "wrapped" }
    });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("layoutCondition") && s.includes("next-page"))).toBe(true);
  });

  it("rejects delayRangeMs without the delayedRender flag", async () => {
    const { status, json } = await postConfig({ seed: 2201, chaos: [], params: { delayRangeMs: [100, 200] } });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("delayedRender"))).toBe(true);
  });

  it("rejects networkDelayRangeMs without the networkDelay flag", async () => {
    const { status, json } = await postConfig({ seed: 2201, chaos: [], params: { networkDelayRangeMs: [10, 20] } });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("networkDelay"))).toBe(true);
  });

  it("rejects an inverted delayRangeMs [min>max] with its flag present, naming the inversion", async () => {
    const { status, json } = await postConfig({
      seed: 2201,
      chaos: ["delayedRender"],
      params: { delayRangeMs: [500, 100] }
    });
    expect(status).toBe(400);
    expect(issuesOf(json).some((s) => s.includes("inverted"))).toBe(true);
  });
});

describe("POST /__lab/config — schema errors → 400", () => {
  it("rejects an out-of-range classDriftLevel", async () => {
    const { status } = await postConfig({ seed: 2201, params: { classDriftLevel: 9 } });
    expect(status).toBe(400);
  });
  it("rejects an out-of-range pageSize", async () => {
    const { status } = await postConfig({ seed: 2201, params: { pageSize: 1 } });
    expect(status).toBe(400);
  });
});

describe("POST /__lab/config — valid params → 200", () => {
  it("accepts a param used without its conflicting flag", async () => {
    const { status } = await postConfig({ seed: 2201, chaos: [], params: { classDriftLevel: 2 } });
    expect(status).toBe(200);
  });

  it("accepts decoyLevel 3 with the full scaffold and held-out copy/placement", async () => {
    const { status } = await postConfig({
      seed: 2201,
      chaos: ["pagination", "hiddenTab"],
      params: {
        decoyLevel: 3,
        decoyCopy: { "next-page": "Older", "login-submit": "Enter" },
        decoyPlacement: "before"
      }
    });
    expect(status).toBe(200);
  });
});

describe("GET /__lab/ground-truth — params never affect truth", () => {
  it("returns identical truth with and without presentation params", async () => {
    await postConfig({ seed: 2201, chaos: [] });
    const baseline = await getJson("/__lab/ground-truth");
    await postConfig({ seed: 2201, chaos: [], params: { headerVocab: { team: "Club" }, columnOrder: FULL_ORDER } });
    const perturbed = await getJson("/__lab/ground-truth");
    expect(perturbed.truth).toEqual(baseline.truth);
    // The endpoint never serialises params — the grader reads truth here, not headers.
    expect(perturbed).not.toHaveProperty("params");
  });
});
