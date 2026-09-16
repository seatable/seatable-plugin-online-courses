/**
 * EXPERIMENT (Course 3) — write a row AS THE COLLEAGUE, through the dtable-STORE.
 *
 * What this is testing
 * --------------------
 * Course 3 stages a colleague ("Malika") who edits a row, and Step 4 then has the
 * learner read the logs and Restore that one change. Measured against a real base
 * on 2026-09-16, the REST route cannot serve that step:
 *
 *   · named API token  → base log author "API", row log "anonymous"
 *   · account token    → attribution correct, BUT
 *   · either way, every REST write is a BULK op: the base log renders
 *     "Malika modified table Customers / The number of modified rows is: 1"
 *     instead of "Row James Bennett modified" — the row's NAME is lost, which is
 *     exactly the anchor Step 1 teaches and Step 4 uses to find the entry. And on
 *     6.2.12 `old_rows` comes back empty, so there is nothing to Restore from.
 *     There is no way around it: /rows/{row_id}/ is GET-only, the gateway's row
 *     PUT is the batch endpoint, and the old singular /dtable-server/api/v1/ path
 *     was removed in 5.3.
 *
 * The store is the other route. `learnerWrite.ts` already drives
 * `dtableStore.modifyRow` with a populated `old_row` and produces an operation
 * byte-for-byte identical to a hand edit — singular, row named, restorable. Its
 * one limitation is that it rides the HOST's connection, so it signs as the
 * learner.
 *
 * Nothing says it has to be the host's connection. The SDK builds its store from
 * `{ server, accessToken, dtableUuid, workspaceID }` (see dtable-sdk's init), and
 * a base token minted from the COLLEAGUE'S ACCOUNT TOKEN carries her `username`.
 * So we open a SECOND store with her token and drive the same op through it.
 *
 * If the hypothesis holds, the base log shows "Row James Bennett modified" signed
 * by Malika, with Restore available — i.e. exactly what she would have produced
 * sitting in front of the UI, with no second browser window anywhere.
 *
 * Credential handling (spike only)
 * --------------------------------
 * The account token is read from `localStorage` (or the dev config), NEVER from
 * the plugin data store: that store lives inside the base, so a token put there
 * would be readable by anyone the base is shared with. Where a real feature would
 * keep it is a separate decision — this experiment only needs to answer whether
 * the write works at all.
 */

import { DTableStore } from 'dtable-store';
import { RowUtils } from 'dtable-store';

/** Where the learner pastes Malika's account token for this experiment. */
export const COLLEAGUE_TOKEN_KEY = 'online-courses:colleague-account-token';

export interface ColleagueWriteSpec {
  /** Table holding the row, e.g. 'Customers'. */
  table: string;
  /** How to find the row: first-column (or any column) value, e.g. Full Name = James Bennett. */
  match: { column: string; equals: string };
  /** Column NAME → display value, e.g. { Status: 'Client' }. */
  cells: Record<string, any>;
}

export interface ColleagueWriteResult {
  rowId: string;
  before: Record<string, any>;
  after: Record<string, any>;
  colleague: string;
}

type Status = (msg: string) => void;

/**
 * The store stays referenced for the life of the page. It owns a socket, and a
 * collected store is a closed socket — which would cut the operation off before
 * the server ever saw it.
 */
let liveStore: any = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the store's socket is up, or give up and let the caller try anyway. */
async function waitForSocket(store: any, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store?.socketClient?.socket?.connected) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Wait for the operation to actually leave. `pendingOperations` is the store's own
 * outbox, so an empty one is the honest signal that the write went out — far
 * better than sleeping for a guessed number of milliseconds.
 */
async function waitForFlush(store: any, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!store?.pendingOperations?.length) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Base identity, host first. `window.dtable` is what a real base injects;
 * `dtableSDK.config` only exists on the dev server. Reading the dev source first
 * is the trap that made every op-log grade fail INSIDE a base (2026-09-01).
 */
function hostConfig(): {
  server: string;
  workspaceID: string;
  baseName: string;
  dtableUuid: string;
} {
  const host: any = (window as any).dtable || {};
  const cfg: any = (window as any).dtableSDK?.config || {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = host[key] ?? cfg[key];
      if (value) return String(value);
    }
    return '';
  };
  return {
    server: pick('server').replace(/\/+$/, ''),
    workspaceID: pick('workspaceID', 'workspace_id'),
    baseName: pick('fileName', 'dtableName'),
    dtableUuid: pick('dtableUuid', 'dtable_uuid'),
  };
}

export function getColleagueToken(): string {
  const fromConfig = (window as any).dtablePluginConfig?.colleagueAccountToken;
  if (fromConfig) return String(fromConfig).trim();
  try {
    return (localStorage.getItem(COLLEAGUE_TOKEN_KEY) || '').trim();
  } catch {
    // Private windows and blocked site data both throw here; no token is a
    // perfectly ordinary answer, so it must never take the step down with it.
    return '';
  }
}

/**
 * Mint a base token that carries the colleague's `username`.
 *
 * This is the whole difference with a named API token, whose JWT has
 * `username: ""` — nobody to sign with, which is why comments came back "Unknown"
 * and log entries "anonymous".
 */
async function colleagueBaseToken(
  accountToken: string,
  server: string,
  workspaceID: string,
  baseName: string
): Promise<{ accessToken: string; dtableUuid: string }> {
  const url =
    `${server}/api/v2.1/workspace/${workspaceID}/dtable/` +
    `${encodeURIComponent(baseName)}/access-token/`;
  const resp = await fetch(url, {
    headers: { Authorization: `Token ${accountToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(
      resp.status === 403 || resp.status === 404
        ? 'That account cannot open this base — check the token, and that the colleague has access.'
        : `Could not get a base token for the colleague (${resp.status}).`
    );
  }
  const data = await resp.json();
  return { accessToken: data.access_token, dtableUuid: data.dtable_uuid };
}

/**
 * Open a second store on the same base, authenticated as the colleague, and make
 * one edit through it.
 *
 * The store is loaded and then discarded: this is a one-shot write, and leaving a
 * second live connection open would keep receiving the base's updates for nothing.
 */
export async function colleagueStoreWrite(
  spec: ColleagueWriteSpec,
  onStatus: Status = () => undefined
): Promise<ColleagueWriteResult> {
  const accountToken = getColleagueToken();
  if (!accountToken) {
    throw new Error(
      'No colleague token. Paste her account token (Personal settings) into ' +
        `localStorage under "${COLLEAGUE_TOKEN_KEY}", then run this again.`
    );
  }

  const { server, workspaceID, baseName } = hostConfig();
  if (!server || !workspaceID || !baseName) {
    const missing = [
      !server && 'server',
      !workspaceID && 'workspaceID',
      !baseName && 'base name',
    ].filter(Boolean);
    throw new Error(`Base identity incomplete: ${missing.join(', ')} not on window.dtable.`);
  }

  onStatus('Signing in as your colleague…');
  const { accessToken, dtableUuid } = await colleagueBaseToken(
    accountToken,
    server,
    workspaceID,
    baseName
  );

  onStatus('Opening the base as her…');
  const store = new DTableStore({
    server,
    accessToken,
    dtableUuid,
    workspaceID,
    appName: 'online-courses',
  });
  liveStore = store; // keep it reachable: a collected store takes its socket with it

  // ⚠️ THE TRAP (measured 2026-09-16): `loadDTable()` only fetches the snapshot.
  // It is `syncWithServer()` that builds the socketClient — the thing that SENDS
  // operations. Without it `modifyRow` mutates local state, the plugin happily
  // reports success, and NOTHING reaches the base: no row change, no log entry.
  // dtable-sdk's own `syncWithServer` does five things and this is the fourth.
  await store.loadDTable();
  store.syncWithServer();
  await waitForSocket(store);

  const tables: any[] = store.value?.tables || [];
  const tableIndex = tables.findIndex((t) => t.name === spec.table);
  if (tableIndex < 0) {
    throw new Error(`Table "${spec.table}" not found in the base she sees.`);
  }
  const table = tables[tableIndex];

  const column = (table.columns || []).find((c: any) => c.name === spec.match.column);
  if (!column) throw new Error(`Column "${spec.match.column}" not found in "${spec.table}".`);
  const row = (table.rows || []).find(
    (r: any) => String(r[column.key] ?? '').trim() === spec.match.equals
  );
  if (!row) {
    throw new Error(`No row where ${spec.match.column} is "${spec.match.equals}".`);
  }

  // Same conversion the SDK and the manual UI use: column NAME → key, display
  // label → stored value (a single-select label becomes its option id).
  const updated = RowUtils.convertRowBack(spec.cells, table);
  const oldData: Record<string, any> = {};
  Object.keys(updated).forEach((key) => {
    oldData[key] = row[key];
  });

  // The 4th argument is what makes the difference. dtable-sdk's own modifyRow
  // computes the before-values and then throws them away (`modifyRow(idx, id,
  // updated, null)`), which both breaks the native history renderer and leaves
  // nothing to Restore from. We pass the real old_row, exactly as learnerWrite
  // does for the learner's own edits.
  // Same guard as learnerWrite: a write that changes nothing still produces a log
  // entry, and a second identical entry is noise in the one surface this whole
  // experiment exists to read. Restore the value (or edit it back) to run again.
  if (JSON.stringify(oldData) === JSON.stringify(updated)) {
    throw new Error(
      `${spec.match.equals} is already ${Object.values(spec.cells).join(', ')} — ` +
        'nothing to change. Put the value back first, then run this again.'
    );
  }

  onStatus('Making her change…');
  store.modifyRow(tableIndex, row._id, updated, oldData);

  // Don't claim success until the outbox is empty. Reporting "done" on a write
  // that never left is the exact failure this function was first shipped with.
  const flushed = await waitForFlush(store);
  if (!flushed) {
    throw new Error(
      'The change was made locally but never reached the server — the store never ' +
        'flushed it. Check that her token is valid and that the socket connected.'
    );
  }

  return {
    rowId: row._id,
    before: oldData,
    after: updated,
    colleague: baseName,
  };
}
