/**
 * The colleague's identity — where her credential is kept, and how it becomes a
 * base token that carries HER name.
 *
 * Course 3 stages a colleague (Malika) who shares, comments and edits. The plugin
 * plays her part, and everything it can do for her hangs off one credential: her
 * ACCOUNT token, which she copies from her own Personal settings page (no
 * password, no API call). Measured 2026-09-16:
 *
 *   · a base token minted from it carries her `username`, so a row edit or a
 *     comment made with it is authored by the real person — the base log and the
 *     row log show her name, and the entry can be Restored;
 *   · a NAMED API token, the only other lever available, has an empty `username`:
 *     writes land as "API" / "anonymous", comments as "Unknown", and an @mention
 *     posted with it leaves the recipient's notification centre showing a badge
 *     over an empty list. That route is a dead end and is not offered here.
 *
 * STORAGE: the plugin datastore, which is saved inside the base (decided
 * 2026-09-22, reversing an earlier localStorage spike). The base is shared with
 * the colleague in Step 2, so she — and anyone else the learner shares it with —
 * can read her own token there. That is the honest cost, and the course states it
 * once where the token is pasted, together with what makes it acceptable: the
 * second account is created for this course and reaches nothing but the exercise
 * bases. What localStorage cost instead was worse for a course that runs over
 * several sittings: a cleared cache, another browser or another machine and the
 * learner is stuck mid-course with no clue why the colleague stopped acting.
 */

import { getStoredColleagueToken, setStoredColleagueToken } from './courseStore';

export interface HostConfig {
  server: string;
  workspaceID: string;
  baseName: string;
  dtableUuid: string;
  /** The base's own colour, the one tinting its header. Always a usable hex. */
  color: string;
}

/**
 * The base's default colour. The host reports it as the literal string "None"
 * rather than an empty value (measured 2026-09-22), so `||` and `??` both let it
 * through and CSS then silently ignores it. Normalised here, once.
 */
export const BASE_DEFAULT_COLOR = '#ff8000';

/**
 * Base identity, host first. `window.dtable` is what a real base injects;
 * `dtableSDK.config` only exists on the dev server. Reading the dev source first
 * is the trap that made every op-log grade fail INSIDE a base (2026-09-01).
 */
export function hostConfig(): HostConfig {
  const host: any = (window as any).dtable || {};
  const cfg: any = (window as any).dtableSDK?.config || {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = host[key] ?? cfg[key];
      if (value) return String(value);
    }
    return '';
  };
  const colour = pick('dtableColor', 'dtable_color');
  return {
    server: pick('server').replace(/\/+$/, ''),
    workspaceID: pick('workspaceID', 'workspace_id'),
    baseName: pick('fileName', 'dtableName'),
    dtableUuid: pick('dtableUuid', 'dtable_uuid'),
    color: colour && colour !== 'None' ? colour : BASE_DEFAULT_COLOR,
  };
}

/**
 * Read the stored credential. A missing one is an ordinary answer, never a throw.
 * The dev config wins when it is set: the dev server has no base to store it in.
 */
export function getColleagueToken(): string {
  const fromConfig = (window as any).dtablePluginConfig?.colleagueAccountToken;
  if (fromConfig) return String(fromConfig).trim();
  return getStoredColleagueToken();
}

export function setColleagueToken(token: string): void {
  setStoredColleagueToken(token);
}

export function clearColleagueToken(): void {
  setStoredColleagueToken('');
}

export function hasColleagueToken(): boolean {
  return getColleagueToken().length > 0;
}

/** A GET against the account API, authenticated as the colleague. */
export async function colleagueAccountGet(path: string): Promise<any> {
  const token = getColleagueToken();
  if (!token) throw new Error('No colleague token yet.');
  const { server } = hostConfig();
  const resp = await fetch(`${server}${path}`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`${path} answered ${resp.status}`);
  return resp.json();
}

/**
 * Mint a base token for the colleague on THIS base.
 *
 * Also the honest test of whether she still has access: once the learner revokes
 * the share, this call fails — which is exactly what Step 2 wants to show.
 */
export async function colleagueBaseToken(): Promise<{
  accessToken: string;
  dtableUuid: string;
}> {
  const token = getColleagueToken();
  if (!token) throw new Error('No colleague token yet.');
  const { server, workspaceID, baseName } = hostConfig();
  if (!server || !workspaceID || !baseName) {
    const missing = [
      !server && 'server',
      !workspaceID && 'workspaceID',
      !baseName && 'base name',
    ].filter(Boolean);
    throw new Error(`Base identity incomplete: ${missing.join(', ')} not on window.dtable.`);
  }
  const url =
    `${server}/api/v2.1/workspace/${workspaceID}/dtable/` +
    `${encodeURIComponent(baseName)}/access-token/`;
  const resp = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(
      resp.status === 403 || resp.status === 404
        ? 'She cannot open this base — check the token, and that the base is still shared with her.'
        : `Could not get a base token for her (${resp.status}).`
    );
  }
  const data = await resp.json();
  return { accessToken: data.access_token, dtableUuid: data.dtable_uuid };
}
