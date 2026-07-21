import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type Express, type Request, type Response } from "express";
import {
  ChaosFlagSchema,
  ChaosParamsSchema,
  createRng,
  DEFAULT_SEED,
  hashSeed,
  labCredentials,
  rngFloat,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type ChaosFlag,
  type ChaosParams
} from "@ssda/shared";
import { getCopy } from "./copy";
import { createSkin } from "./markup";
import {
  decoyStateFrom,
  resolveClassDriftLevel,
  resolveNetworkDelayRange,
  validateLabConfig
} from "./params";
import { renderConsentPage, renderLoginPage, renderOddsPage, renderStatsPage } from "./render";
import { LabState, type Session } from "./state";

const CONTROL_PREFIX = "/__lab";
const CONSENT_COOKIE = "lab_consent";

function seedFromEnv(): number {
  const parsed = Number.parseInt(process.env.LAB_SEED ?? "", 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEED;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only same-origin relative paths are allowed as redirect targets. */
function safeNext(value: unknown, fallback: string): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : fallback;
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Build one lab instance. All mutable state lives on `state` (per instance),
 * so tests can boot several apps in the same process without cross-talk.
 */
export function createLabApp(): Express {
  const state = new LabState(seedFromEnv());
  const app = express();

  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // requestCount increments on EVERY request (control routes included).
  app.use((_req, _res, next) => {
    state.requestCount += 1;
    next();
  });

  // networkDelay: seeded latency, page routes only — the control API is never delayed.
  // networkDelayRangeMs (§3 Timing) only re-bounds the same seeded draw when active.
  app.use(async (req, _res, next) => {
    if (!req.path.startsWith(CONTROL_PREFIX) && state.hasChaos("networkDelay")) {
      const rng = createRng(hashSeed(`net:${state.seed}:${req.path}:${state.requestCount}`));
      const [nmin, nmax] = resolveNetworkDelayRange(state.params);
      await sleep(rngFloat(rng, nmin, nmax));
    }
    next();
  });

  const skin = () =>
    createSkin(state.seed, resolveClassDriftLevel(state.hasChaos("classDrift"), state.params));
  const copy = () => getCopy(state.seed, state.hasChaos("copyDrift"), state.params.uiCopy);
  const decoy = () => decoyStateFrom(state.params);

  // ── Control API ──────────────────────────────────────────────
  app.get(`${CONTROL_PREFIX}/health`, (_req, res) => {
    res.json({ ok: true });
  });

  app.get(`${CONTROL_PREFIX}/state`, (_req, res) => {
    res.json(state.toJson());
  });

  app.get(`${CONTROL_PREFIX}/ground-truth`, (_req, res) => {
    res.json({
      seed: state.seed,
      chaos: state.chaosList(),
      truth: state.truth,
      overrides: state.overrides
    });
  });

  app.post(`${CONTROL_PREFIX}/config`, (req, res) => {
    const body = (req.body ?? {}) as { seed?: unknown; chaos?: unknown; params?: unknown };

    let chaos: ChaosFlag[] = state.chaosList();
    if (body.chaos !== undefined) {
      if (!Array.isArray(body.chaos)) {
        res.status(400).json({ error: "chaos must be an array of chaos flags" });
        return;
      }
      const parsed: ChaosFlag[] = [];
      for (const value of body.chaos) {
        const result = ChaosFlagSchema.safeParse(value);
        if (!result.success) {
          res.status(400).json({ error: `invalid chaos flag: ${JSON.stringify(value)}` });
          return;
        }
        parsed.push(result.data);
      }
      chaos = parsed;
    }

    let seed = state.seed;
    if (body.seed !== undefined) {
      if (typeof body.seed !== "number" || !Number.isFinite(body.seed)) {
        res.status(400).json({ error: "seed must be a finite number" });
        return;
      }
      seed = body.seed;
    }

    // Phase-2A perturbation params (§3): schema-validate, then the flag-XOR-param
    // contradictions and the lab-side checks. Any error ⇒ 400 with the full list;
    // never resolved silently. Params are presentation-only and never affect truth.
    let params: ChaosParams = state.params;
    if (body.params !== undefined) {
      const parsed = ChaosParamsSchema.safeParse(body.params);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid params",
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        });
        return;
      }
      params = parsed.data;
    }

    const configErrors = validateLabConfig(chaos, params);
    if (configErrors.length > 0) {
      res.status(400).json({ error: "invalid config", issues: configErrors });
      return;
    }

    state.reconfigure(seed, chaos, params);
    res.json(state.toJson());
  });

  app.post(`${CONTROL_PREFIX}/sessions/expire-all`, (_req, res) => {
    for (const session of state.sessions.values()) session.expiresAt = 0;
    res.json({ ok: true });
  });

  // ── Auth helpers ─────────────────────────────────────────────
  function currentSession(req: Request): { token: string; session: Session } | null {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const session = state.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      state.sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  // ── Auth routes ──────────────────────────────────────────────
  app.get("/login", (req, res) => {
    const next = safeNext(req.query.next, "/stats");
    res.status(200).send(renderLoginPage({ skin: skin(), copy: copy(), next, decoy: decoy() }));
  });

  app.post("/login", (req, res) => {
    const body = req.body as { username?: string; password?: string; next?: string };
    const next = safeNext(body.next ?? req.query.next, "/stats");
    const creds = labCredentials();
    if (body.username !== creds.username || body.password !== creds.password) {
      res
        .status(401)
        .send(
          renderLoginPage({
            skin: skin(),
            copy: copy(),
            next,
            error: "Incorrect username or password.",
            decoy: decoy()
          })
        );
      return;
    }
    const token = crypto.randomBytes(16).toString("hex");
    state.sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, authedViews: 0 });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, path: "/" });
    res.redirect(302, next);
  });

  app.post("/logout", (req, res) => {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) state.sessions.delete(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect(302, "/");
  });

  app.post("/consent", (req, res) => {
    const body = req.body as { next?: string };
    const next = safeNext(body.next, "/stats");
    res.cookie(CONSENT_COOKIE, "1", { path: "/" });
    res.redirect(302, next);
  });

  // ── Authenticated data pages ─────────────────────────────────
  function servePage(req: Request, res: Response, path: string, render: () => string): void {
    const found = currentSession(req);
    if (!found) {
      // `path` is always a fixed internal literal ("/stats" | "/odds").
      res.redirect(302, `/login?next=${path}`);
      return;
    }

    // staleSession: invalidate the session exactly once, on the 2nd authed view.
    if (state.hasChaos("staleSession")) {
      found.session.authedViews += 1;
      if (!state.staleAlreadyFired && found.session.authedViews >= 2) {
        state.sessions.delete(found.token);
        state.staleAlreadyFired = true;
        res.redirect(302, `/login?next=${path}`);
        return;
      }
    }

    // cookieBanner: block content behind a consent interstitial until accepted.
    if (state.hasChaos("cookieBanner") && cookieValue(req, CONSENT_COOKIE) !== "1") {
      res.status(200).send(renderConsentPage({ skin: skin(), copy: copy(), next: path }));
      return;
    }

    res.status(200).send(render());
  }

  app.get("/stats", (req, res) => {
    servePage(req, res, "/stats", () => renderStatsPage({ state, skin: skin(), copy: copy() }));
  });

  app.get("/odds", (req, res) => {
    servePage(req, res, "/odds", () => renderOddsPage({ state, skin: skin(), copy: copy() }));
  });

  app.get("/", (req, res) => {
    res.redirect(302, currentSession(req) ? "/stats" : "/login?next=/stats");
  });

  return app;
}
