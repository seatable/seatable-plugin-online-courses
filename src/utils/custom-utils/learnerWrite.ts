/**
 * Learner row edits — write to the learner's own base AS the learner, driving
 * dtable-store directly so the logged operation is byte-for-byte what a manual UI
 * edit produces: a singular `modify_row` op carrying a populated `old_row` (so the
 * change is restorable from the native history, exactly like a hand edit).
 *
 * This replicates dtableSDK.modifyRow (dtable.js) but fixes its one bug — the SDK
 * computes the before-values then discards them, calling
 * `dtableStore.modifyRow(idx, id, updated, null)`. That hardcoded `null` both
 * crashes the native history view and leaves nothing to restore from. We pass the
 * real old_row instead.
 *
 * We deliberately do NOT use the REST gateway: it emits a PLURAL `modify_rows` op
 * with an empty `old_rows:{}` — non-crashing, but still non-restorable and
 * structurally unlike a manual edit. The store path is the only one that matches
 * the UI. It also works on the localhost dev server (a pure in-memory SDK op synced
 * over the base websocket, no session base token needed).
 *
 * (The former "authored write as a named colleague" mechanism — session-created API
 * tokens, base-token minting, gateway PUTs — was removed 2026-07-02: the boss asked
 * to keep the plugin simple, and that device was far from it.)
 */

import { RowUtils } from 'dtable-store';

function sdk(): any {
  return (window as any).dtableSDK;
}

/**
 * Update one row authored as the learner. `cellsByName` is keyed by column NAME
 * with display values (e.g. { Status: 'Client' }).
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
