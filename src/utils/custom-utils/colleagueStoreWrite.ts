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
 * Credential handling
 * -------------------
 * The account token comes from the setup step, stored in the plugin datastore
 * (or the dev config). See colleagueIdentity.ts for where that puts it and why.
 */

import { DTableStore } from 'dtable-store';
import { RowUtils } from 'dtable-store';
import { colleagueBaseToken, getColleagueToken, hostConfig } from './colleagueIdentity';
import { cellLabel, findRowByMatch, getColumn, getTableByName } from './sdkRead';

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
  /** False when the row already held the values and nothing was sent (skipIfUnchanged). */
  changed: boolean;
}

type Status = (msg: string) => void;

/**
 * The store stays referenced for the life of the page. It owns a socket, and a
 * collected store is a closed socket — which would cut the operation off before
 * the server ever saw it.
 */
let liveStore: any = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the store may SEND. A connected socket is not enough: dtable-store
 * only sends once its socket has JOINED THE BASE'S ROOM, which is when it sets
 * `socketConnected` (read in its bundle, 2026-09-29). Before that an operation
 * just waits in the outbox.
 */
async function waitForRoom(store: any, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store?.socketConnected) return true;
    await sleep(100);
  }
  return false;
}

/** Close a store's connection — the previous run's, before opening a new one. */
function closeStore(store: any): void {
  try {
    store?.socketClient?.socket?.disconnect();
  } catch {
    /* already gone */
  }
}

/**
 * Has the change reached the base? Read in the LEARNER's own session, which
 * receives the base's updates like any open window: if her edit really landed, it
 * shows up there. The only check that does not trust the sending side.
 */
async function landedInHost(spec: ColleagueWriteSpec, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const table = getTableByName(spec.table);
    const row = table && findRowByMatch(table, spec.match.column, spec.match.equals);
    if (
      row &&
      Object.entries(spec.cells).every(([name, want]) => {
        const column = getColumn(table, name);
        return column && cellLabel(column, row[column.key]) === String(want);
      })
    ) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/**
 * Wait for the operation to leave. `pendingOperations` is the store's own outbox.
 * ⚠️ An empty outbox means LEFT, not ACCEPTED: when the server refuses an
 * operation, dtable-store drops it, dispatches `operation-execute-error` on its
 * event bus, and moves on — so the outbox empties exactly as on a success.
 * Measured 2026-09-29: a refused edit was reported as done and the reply went out.
 * The caller listens for that error and checks the result in the base.
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
 * Open a second store on the same base, authenticated as the colleague, and make
 * one edit through it.
 *
 * The store is loaded and then discarded: this is a one-shot write, and leaving a
 * second live connection open would keep receiving the base's updates for nothing.
 */
export async function colleagueStoreWrite(
  spec: ColleagueWriteSpec,
  onStatus: Status = () => undefined,
  opts: { skipIfUnchanged?: boolean } = {}
): Promise<ColleagueWriteResult> {
  const accountToken = getColleagueToken();
  if (!accountToken) {
    throw new Error('No colleague token yet — the course asks for it in Step 2.');
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
  const { accessToken, dtableUuid } = await colleagueBaseToken();

  onStatus('Opening the base as her…');
  // A second run on the same page would otherwise leave the first run's
  // connection open alongside the new one.
  closeStore(liveStore);
  liveStore = null;
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
  if (!(await waitForRoom(store))) {
    throw new Error(
      'Could not connect to the base as her — her change was not made. Try again in a moment.'
    );
  }

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
    // A background edit replayed by "Start over" is already in place: nothing to
    // add, and no reason to stop the step over it.
    if (opts.skipIfUnchanged) {
      return {
        rowId: row._id,
        before: oldData,
        after: updated,
        colleague: baseName,
        changed: false,
      };
    }
    throw new Error(
      `${spec.match.equals} is already ${Object.values(spec.cells).join(', ')} — ` +
        'nothing to change. Put the value back first, then run this again.'
    );
  }

  onStatus('Making her change…');
  let refused = '';
  const stopListening = store.eventBus.subscribe('operation-execute-error', (e: any) => {
    refused = String(e?.message || e?.error_msg || 'no reason given');
  });
  store.modifyRow(tableIndex, row._id, updated, oldData);

  // Don't claim success until the outbox is empty. Reporting "done" on a write
  // that never left is the exact failure this function was first shipped with.
  const flushed = await waitForFlush(store);
  stopListening();
  if (refused) throw new Error(`SeaTable refused her change: ${refused}.`);
  if (!flushed) {
    throw new Error(
      'The change was made locally but never reached the server — the store never ' +
        'flushed it. Check that her token is valid and that the socket connected.'
    );
  }
  onStatus('Checking that her change reached the base…');
  if (!(await landedInHost(spec))) {
    throw new Error(
      'Her change was sent but does not show in the base. Nothing else was done — try again.'
    );
  }

  return {
    rowId: row._id,
    before: oldData,
    after: updated,
    colleague: baseName,
    changed: true,
  };
}
