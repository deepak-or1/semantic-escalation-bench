import { readJsonOr, writeJson } from "@ssda/shared";

export interface SavedSessionState {
  labUrl: string;
  cookies: Array<{ name: string; value: string }>;
  savedAt: string;
}

export async function saveSessionState(
  file: string,
  labUrl: string,
  cookies: Array<{ name: string; value: string }>
): Promise<void> {
  const state: SavedSessionState = {
    labUrl,
    cookies: cookies.map(({ name, value }) => ({ name, value })),
    savedAt: new Date().toISOString()
  };
  await writeJson(file, state);
}

export async function loadSessionState(file: string): Promise<SavedSessionState | null> {
  const state = await readJsonOr<SavedSessionState | null>(file, null);
  if (!state || !Array.isArray(state.cookies)) return null;
  return state;
}
