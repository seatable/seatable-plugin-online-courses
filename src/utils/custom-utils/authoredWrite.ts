/**
 * Authored row edits — write to the learner's own base AS a named "colleague",
 * so the row's "Last modifier" column / row history shows that name instead of
 * the learner. This is the collaboration-course device for "who did what".
 *
 * Confirmed chain (June 2026), 100% client-side, no account token / no password:
 *  1. ensureApiToken  — create a named rw API token via the session-cookie route
 *                       (POST .../api-tokens/ with the csrftoken cookie). The
 *                       token's `app_name` IS the author string.
 *  2. getBaseToken    — mint a base/access token from that API token
 *                       (GET .../app-access-token/), cached until it expires.
 *  3. authoredUpdateRow — PUT the row via the API Gateway with that base token.
 *
 * Caveat (accepted): the Last-modifier COLUMN shows the app_name, but the
 * row-history detail log shows generic "API". Good enough for the course.
 *
 * Tokens are cached in the plugin datastore (IPluginDataStore.colleagueTokens),
 * keyed by app_name, reused across the course, and removed by deleteColleagueToken
 * (call at course end).
 *
 * For the LEARNER's own plugin-driven edits, use learnerUpdateRow — it drives
 * dtable-store directly so the logged op is IDENTICAL to a manual UI edit (a
 * singular `modify_row` with a populated `old_row`). It deliberately does NOT use
 * dtableSDK.modifyRow, which hardcodes `old_row: null` (crashes native history and
 * leaves nothing to restore from), nor the REST gateway, which emits a plural
 * `modify_rows` with an empty `old_rows` (non-crashing but still non-restorable).
 */

import { RowUtils } from 'dtable-store';
import { PLUGIN_NAME } from '../template-constants';
import { IColleagueToken, IPluginDataStore } from '../template-interfaces/App.interface';

function sdk(): any {
  return (window as any).dtableSDK;
}

// Runtime base identity. dtableSDK.config is populated on init (server,
// workspaceID, dtableName, dtableUuid); window.dtable is the fallback.
function getConfig(): {
  server: string;
  workspaceID: string;
  dtableName: string;
  dtableUuid: string;
} {
  const cfg = sdk()?.config || {};
  const win = (window as any).dtable || {};
  return {
    server: String(cfg.server || win.server || '').replace(/\/+$/, ''),
    workspaceID: String(cfg.workspaceID || win.workspaceID || ''),
    // Base name: dev exposes it as `dtableName` on the SDK config; production
    // exposes it as `fileName` on `window.dtable`. Fall back across both so the
    // api-tokens URL never ends up with an empty `/dtable//api-tokens/` segment.
    dtableName: String(cfg.dtableName || cfg.fileName || win.dtableName || win.fileName || ''),
    dtableUuid: String(cfg.dtableUuid || win.dtableUuid || ''),
  };
}

function getCsrfToken(): string {
  return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
}

function apiTokensUrl(): string {
  const { server, workspaceID, dtableName } = getConfig();
  return `${server}/api/v2.1/workspace/${workspaceID}/dtable/${encodeURIComponent(
    dtableName
  )}/api-tokens/`;
}

// --- plugin-datastore token cache -------------------------------------------

function readStore(): IPluginDataStore {
  return (sdk()?.getPluginSettings?.(PLUGIN_NAME) as IPluginDataStore) || ({} as IPluginDataStore);
}

function getStoredToken(appName: string): IColleagueToken | undefined {
  return readStore().colleagueTokens?.[appName];
}

function persistToken(appName: string, token: IColleagueToken): void {
  const store = readStore();
  sdk()?.updatePluginSettings?.(PLUGIN_NAME, {
    ...store,
    colleagueTokens: { ...(store.colleagueTokens || {}), [appName]: token },
  });
}

function removeStoredToken(appName: string): void {
  const store = readStore();
  const map = { ...(store.colleagueTokens || {}) };
  delete map[appName];
  sdk()?.updatePluginSettings?.(PLUGIN_NAME, { ...store, colleagueTokens: map });
}

// Decode a base-token JWT's `exp` claim (seconds → ms). Used so we re-mint only
// when the cached base token is actually about to expire.
function jwtExpiryMs(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return payload?.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// --- step 1: ensure a named API token exists --------------------------------

async function findExistingApiToken(appName: string): Promise<string | null> {
  // Recovery path for the "token already exists" case (names are unique per base):
  // list the base's tokens and pull the one whose app_name matches.
  const resp = await fetch(apiTokensUrl(), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  const list: any[] = data.api_tokens || data.tokens || [];
  const match = list.find((t) => t.app_name === appName);
  return match?.api_token || match?.token || null;
}

async function ensureApiToken(appName: string, permission = 'rw'): Promise<string> {
  const existing = getStoredToken(appName);
  if (existing?.apiToken) return existing.apiToken;

  const body = new URLSearchParams({ app_name: appName, permission });
  const resp = await fetch(apiTokensUrl(), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-CSRFToken': getCsrfToken(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    // 400 most likely = a token with this app_name already exists → recover it.
    const recovered = await findExistingApiToken(appName);
    if (recovered) {
      persistToken(appName, { apiToken: recovered });
      return recovered;
    }
    throw new Error(`create api-token failed (${resp.status}): ${JSON.stringify(data)}`);
  }

  const apiToken: string = data.api_token || data.token || '';
  if (!apiToken) throw new Error(`create api-token: no token in response: ${JSON.stringify(data)}`);
  persistToken(appName, { apiToken });
  return apiToken;
}

// --- step 2: mint / reuse a base token --------------------------------------

async function getBaseToken(appName: string): Promise<{ baseToken: string; dtableUuid: string }> {
  const stored = getStoredToken(appName);
  const now = Date.now();
  if (
    stored?.baseToken &&
    stored.dtableUuid &&
    stored.baseTokenExpiresAt &&
    stored.baseTokenExpiresAt - 60_000 > now
  ) {
    return { baseToken: stored.baseToken, dtableUuid: stored.dtableUuid };
  }

  const apiToken = await ensureApiToken(appName);
  const { server } = getConfig();
  const resp = await fetch(`${server}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Token ${apiToken}`, Accept: 'application/json' },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`app-access-token failed (${resp.status}): ${JSON.stringify(data)}`);
  }
  const baseToken: string = data.access_token;
  const dtableUuid: string = data.dtable_uuid;
  const expiresAt = jwtExpiryMs(baseToken) ?? now + 2 * 24 * 60 * 60 * 1000;
  persistToken(appName, { apiToken, baseToken, baseTokenExpiresAt: expiresAt, dtableUuid });
  return { baseToken, dtableUuid };
}

// --- step 3: gateway row update ---------------------------------------------

// One row update via the API-Gateway Update-Row endpoint, with whatever base
// token / identity the caller supplies. This is the path for AUTHORED writes
// (authoredUpdateRow), where the author identity comes from a named API token, so
// it must go over REST rather than the SDK store. Note the resulting op is a
// plural `modify_rows` with an empty `old_rows:{}` — fine for the colleague-
// attribution device, but NOT restorable; learner edits use the store path instead.
async function gatewayUpdateRow(
  server: string,
  dtableUuid: string,
  baseToken: string,
  tableName: string,
  rowId: string,
  cellsByName: Record<string, any>
): Promise<void> {
  const resp = await fetch(`${server}/api-gateway/api/v2/dtables/${dtableUuid}/rows/`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${baseToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      table_name: tableName,
      updates: [{ row_id: rowId, row: cellsByName }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`update row failed (${resp.status}): ${text}`);
  }
}

/**
 * Update one row, authored as `appName` (a named colleague). `cellsByName` is
 * keyed by column NAME with display values (e.g. { Status: 'Client' }).
 */
export async function authoredUpdateRow(
  appName: string,
  tableName: string,
  rowId: string,
  cellsByName: Record<string, any>
): Promise<void> {
  const { baseToken, dtableUuid } = await getBaseToken(appName);
  const { server } = getConfig();
  await gatewayUpdateRow(server, dtableUuid, baseToken, tableName, rowId, cellsByName);
}

/**
 * Update one row authored as the LEARNER, driving dtable-store directly so the
 * logged operation is byte-for-byte what a manual UI edit produces: a singular
 * `modify_row` op carrying a populated `old_row` (so the change is restorable from
 * the native history, exactly like a hand edit).
 *
 * This replicates dtableSDK.modifyRow (dtable.js) but fixes its one bug — the SDK
 * computes the before-values then discards them, calling
 * `dtableStore.modifyRow(idx, id, updated, null)`. That hardcoded `null` both
 * crashes the native history view and leaves nothing to restore from. We pass the
 * real old_row instead.
 *
 * We also do NOT use the REST gateway here: it emits a PLURAL `modify_rows` op with
 * an empty `old_rows:{}` — non-crashing, but still non-restorable and structurally
 * unlike a manual edit. The store path is the only one that matches the UI.
 *
 * Unlike the REST path, this works on the localhost dev server too (it's a pure
 * in-memory SDK op synced over the base websocket, no session base token needed).
 *
 * `cellsByName` is keyed by column NAME with display values (e.g. { Status: 'Client' }).
 */
export async function learnerUpdateRow(
  tableName: string,
  rowId: string,
  cellsByName: Record<string, any>
): Promise<void> {
  const s = sdk();
  const tables: any[] = s?.getTables?.() || [];
  const table = tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`learnerUpdateRow: table "${tableName}" not found`);
  const tableIndex = tables.findIndex((t) => t._id === table._id);
  const row = (table.rows || []).find((r: any) => r._id === rowId);
  if (!row) throw new Error(`learnerUpdateRow: row "${rowId}" not found`);

  // convertRowBack maps column NAME→key and display label→stored value (e.g. a
  // single-select label → its option id), the same conversion the SDK and the
  // manual UI use. oldData mirrors those same keys from the current row.
  const newUpdated = RowUtils.convertRowBack(cellsByName, table);
  const oldData: Record<string, any> = {};
  Object.keys(newUpdated).forEach((key) => {
    oldData[key] = row[key];
  });
  if (JSON.stringify(oldData) === JSON.stringify(newUpdated)) return;
  s.dtableStore.modifyRow(tableIndex, rowId, newUpdated, oldData);
}

// --- course-end cleanup -----------------------------------------------------

export async function deleteColleagueToken(appName: string): Promise<void> {
  const stored = getStoredToken(appName);
  removeStoredToken(appName); // drop from cache regardless of API outcome
  if (!stored?.apiToken) return;
  const { server, workspaceID, dtableName } = getConfig();
  const url = `${server}/api/v2.1/workspace/${workspaceID}/dtable/${encodeURIComponent(
    dtableName
  )}/api-tokens/${encodeURIComponent(appName)}/`;
  await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'X-CSRFToken': getCsrfToken(), Accept: 'application/json' },
  }).catch(() => {
    /* best-effort cleanup */
  });
}

// --- helper: resolve a row id by a match column/value -----------------------

/** Find a row's _id by matching a column's display value (single-select aware). */
export function findRowId(
  tableName: string,
  matchColumnName: string,
  matchValue: string
): string | null {
  const tables: any[] = sdk()?.getTables?.() || [];
  const table = tables.find((t) => t.name === tableName);
  if (!table) return null;
  const columns: any[] = table.columns || [];
  const matchCol = matchColumnName ? columns.find((c) => c.name === matchColumnName) : columns[0];
  if (!matchCol) return null;
  const row = (table.rows || []).find((r: any) => {
    const raw = r[matchCol.key];
    const opts = matchCol?.data?.options;
    let label = raw;
    if (Array.isArray(opts)) {
      const o = opts.find((x: any) => x.id === raw || x.name === raw);
      if (o) label = o.name;
    }
    return label === matchValue;
  });
  return row?._id || null;
}
