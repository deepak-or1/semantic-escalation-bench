import { SESSION_COOKIE } from "@ssda/shared";
import { saveSessionState, type Credentials } from "../core";

/**
 * Log in over plain HTTP and persist the resulting session cookie to a state
 * file, so a benchmark trial can start the browser with an already-valid (or,
 * for the expired scenario, soon-to-be-invalidated) session.
 *
 * This is benchmark tooling talking to the lab directly — the measured engines
 * never do this; they always drive the login form through the browser.
 */
export async function prepSessionState(
  labUrl: string,
  credentials: Credentials,
  file: string
): Promise<void> {
  const body = new URLSearchParams({
    username: credentials.username,
    password: credentials.password
  });
  const res = await fetch(`${labUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual"
  });

  const value = extractSessionCookie(res);
  if (!value) {
    throw new Error(
      `prepSessionState: no ${SESSION_COOKIE} cookie returned from ${labUrl}/login ` +
        `(status ${res.status}) — check the lab credentials`
    );
  }
  await saveSessionState(file, labUrl, [{ name: SESSION_COOKIE, value }]);
}

/** Pull the ssda_session value out of the response's Set-Cookie header(s). */
function extractSessionCookie(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return pair.slice(eq + 1).trim();
  }
  return null;
}
