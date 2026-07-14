import type { Action } from "@browserbasehq/stagehand";

/**
 * The "existing selectors" a production team would already have hand-written for
 * this site — expressed as Stagehand `Action` objects the hybrid engine replays
 * deterministically (zero LLM). Same id inventory as the Playwright baseline
 * (#accept-cookies, #username/#password, #login-submit, #modal-close, #tab-table,
 * #next-page), so the two engines start from the identical selector assumptions;
 * only the failure-recovery strategy differs.
 *
 * Methods are Playwright locator verbs the act handler supports ("click",
 * "fill"). Credentials are NEVER written here: the username/password fills carry
 * the `%username%` / `%password%` placeholders and are substituted at act() time
 * via Stagehand variables, so no secret ever reaches a cache file, log or
 * artifact.
 */

export type CacheKey =
  | "consent"
  | "username"
  | "password"
  | "login-submit"
  | "dismiss-modal"
  | "reveal-table"
  | "next-page";

export function bootstrapActions(): Record<CacheKey, Action> {
  return {
    consent: {
      selector: "#accept-cookies",
      method: "click",
      arguments: [],
      description: "accept the cookie consent"
    },
    username: {
      selector: "#username",
      method: "fill",
      arguments: ["%username%"],
      description: "type the username into the login form"
    },
    password: {
      selector: "#password",
      method: "fill",
      arguments: ["%password%"],
      description: "type the password into the login form"
    },
    "login-submit": {
      selector: "#login-submit",
      method: "click",
      arguments: [],
      description: "submit the login form"
    },
    "dismiss-modal": {
      selector: "#modal-close",
      method: "click",
      arguments: [],
      description: "close the popup dialog"
    },
    "reveal-table": {
      selector: "#tab-table",
      method: "click",
      arguments: [],
      description: "reveal the full season standings table"
    },
    "next-page": {
      selector: "#next-page",
      method: "click",
      arguments: [],
      description: "go to the next page of the standings table"
    }
  };
}
