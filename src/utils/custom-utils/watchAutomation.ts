/**
 * "Watch it work" — the post-build demo of the Step-2 linking automation.
 *
 * Once the learner's automation passes its config check, nothing has actually run
 * through it yet. The plugin closes that gap: it writes a few delivery lines into
 * Line items in front of the learner, then confirms — on the very rows it created —
 * that THEIR automation filled the link columns the plugin never wrote.
 *
 * Two things this module has to get right:
 *
 * 1. **Which rows we created.** `appendRow` doesn't hand back the new row's _id, so
 *    we snapshot the table's ids, append, then diff. That's exact, and it survives a
 *    base that already contains lines with the same references (a learner re-running
 *    the demo, say) — matching on Product reference would pick up the older ones and
 *    happily "confirm" links the learner's rule never made.
 *
 * 2. **Waiting for a server-side rule.** The automation runs on the server; the
 *    filled links come back to us as remote ops on the shared store. So we poll the
 *    store rather than read once — a link cell that's empty the instant after the
 *    insert means nothing.
 *
 * Displaying the right table is deliberately NOT done here. There is no supported
 * way to change the host's current table (the SDK only READS the selection via
 * getActiveTable/getActiveView; dtableStore.selectView would move the shared store
 * out from under the host grid, which owns its own React state and the tid/vid URL).
 * So we only READ the selection, and the runner uses it to ask the learner to open
 * the right table (and view) first.
 *
 * That ask used to be a nudge and never a hard block — rightly, while the read came
 * from `getActiveTable()`, which is not a live read at all (see below) and would have
 * trapped every learner on a constant. Read from the host's own `tid`/`vid` URL and
 * checked against a real base, it is trustworthy enough to BLOCK on: an action nobody
 * watched is a step silently lost, and these demos clean up after themselves. The
 * safety property is kept where it belongs — an unreadable selection resolves to
 * null, so an uncertain read blocks nothing.
 */

import { getTableByName } from './sdkRead';

function sdk(): any {
  return (window as any).dtableSDK;
}

/**
 * Name of the table the base is currently showing, or null if it can't be read.
 *
 * ⛔ Do NOT use `dtableSDK.getActiveTable()` for this. Read its source and it is
 *   `return this.dtableStore.currentTable || tables[0];`
 * — `currentTable` belongs to the PLUGIN's own store, which nothing here ever sets,
 * so it always falls through to **the first table in the base**. It is a constant
 * wearing the name of a live read: the nudge it fed never fired on a step watching
 * table[0], and fired permanently on a step watching any other. (Found 2026-09-01,
 * from step 5a never warning anyone.)
 *
 * The base editor puts the displayed table and view in its own URL (`tid`, `vid`),
 * and an overlay plugin shares that document — so the query string is the honest
 * source. `vid` is there too if a step ever needs to check the view.
 *
 * Returns null whenever we cannot tell, and callers must treat null as "no opinion"
 * rather than "wrong table": never trap a learner on a read we are unsure of.
 */
export function getActiveTableName(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('tid');
    if (!raw) return null;
    // `tid` is the table's `_id` (measured in a real base 2026-09-01:
    // `?tid=g17O&vid=0000` on a base whose Products table is `g17O`). Matched on
    // name too, defensively — it costs nothing and a name can never collide with an
    // id here. An unmatched value falls through to null and simply blocks nothing.
    // `URLSearchParams.get` has already percent-decoded; decoding again would be
    // wrong (it throws on a literal '%').
    const tables: any[] = sdk()?.getTables?.() || [];
    return tables.find((t: any) => t?.name === raw || t?._id === raw)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Name of the VIEW the base is currently showing, or null if it can't be read.
 * `vid` sits beside `tid` and is likewise the view's `_id` — it tracks the displayed
 * view (measured: `vid=0000` on Default View, `vid=L2m2` on a second view of the
 * same table). Same rules as getActiveTableName: null whenever we cannot tell.
 */
export function getActiveViewName(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('vid');
    if (!raw) return null;
    const tableName = getActiveTableName();
    const views: any[] = (tableName ? getTableByName(tableName) : null)?.views || [];
    return views.find((v: any) => v?.name === raw || v?._id === raw)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Does `tableName` actually have a view called `viewName`? Guards the watchView
 * check: a base that predates the view must not lock the learner out of the step.
 */
export function tableHasView(tableName: string, viewName: string): boolean {
  try {
    const views: any[] = getTableByName(tableName)?.views || [];
    return views.some((v: any) => v?.name === viewName);
  } catch {
    return false;
  }
}

/**
 * Append rows as the learner (clean dtable-store INSERT ops, like manual new rows)
 * and return the _ids of exactly those rows, by diffing the table's ids around the
 * write. Rows are keyed by column NAME with display values.
 */
export async function appendRowsTracked(
  tableName: string,
  rows: Record<string, any>[]
): Promise<string[]> {
  const table = getTableByName(tableName);
  if (!table) throw new Error(`Table "${tableName}" not found in this base.`);
  const before = new Set<string>((table.rows || []).map((r: any) => r._id));

  rows.forEach((cellsByName) => sdk().appendRow(table, cellsByName, undefined));

  // The store applies the op locally and synchronously, so the new rows are already
  // on the (same) table object — re-read it anyway in case the store swapped it.
  const after = getTableByName(tableName);
  return ((after?.rows || []) as any[]).filter((r) => !before.has(r._id)).map((r) => r._id);
}

/** A resolved link holds the linked row ids; anything non-empty means "linked". */
function isLinked(value: any): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

export interface LinkStatus {
  /** Rows (of those we created) that still have at least one empty link column. */
  pending: number;
  total: number;
  /** Link columns still empty somewhere, for the failure message. */
  missing: string[];
}

/**
 * One read of the link columns on the tracked rows.
 *
 * ⚠️ A link cell's value is NOT on the row. The store keeps links in a structure of
 * its own (`value.links`), so `row[linkColumnKey]` is empty however long you wait —
 * which read as "your automation did nothing" while the base showed the links
 * plainly. `getTableLinkRows` is the accessor meant for this: it walks the table's
 * LINK columns, resolves each one's `link_id` / other table from `column.data`, and
 * returns `{ rowId: { linkColumnKey: [linked row ids] } }`. Reading the store, it
 * costs no API call.
 */
export function linkStatus(tableName: string, rowIds: string[], linkColumns: string[]): LinkStatus {
  const table = getTableByName(tableName);
  const columns: any[] = table?.columns || [];
  const cols = linkColumns.map((name) => ({ name, col: columns.find((c) => c.name === name) }));
  const rows: any[] = (table?.rows || []).filter((r: any) => rowIds.includes(r._id));
  const linksByRow: Record<string, Record<string, any>> = rows.length
    ? sdk()?.getTableLinkRows(rows, table) || {}
    : {};

  const missing = new Set<string>();
  let pending = 0;
  rows.forEach((row) => {
    let rowOk = true;
    cols.forEach(({ name, col }) => {
      // A column the base doesn't have can never fill — report it by name.
      if (!col || !isLinked(linksByRow[row._id]?.[col.key])) {
        missing.add(name);
        rowOk = false;
      }
    });
    if (!rowOk) pending += 1;
  });
  // Rows we created but can no longer find (deleted mid-demo) count as pending.
  pending += rowIds.length - rows.length;

  return { pending, total: rowIds.length, missing: Array.from(missing) };
}

export type LinkOutcome =
  | { kind: 'linked' }
  | { kind: 'partial'; progress: LinkStatus }
  | { kind: 'none'; progress: LinkStatus };

/**
 * Poll until every tracked row has all its link columns filled, or we give up.
 * `onTick` reports progress so the learner sees the links landing one by one
 * instead of a frozen button.
 */
export async function awaitLinks(
  tableName: string,
  rowIds: string[],
  linkColumns: string[],
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (s: LinkStatus) => void } = {}
): Promise<LinkOutcome> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 1000;
  const deadline = performance.now() + timeoutMs;

  // Named `progress`, not `status`: the CRA eslint config restricts that identifier
  // (it shadows window.status) and flags it even as a property key.
  let progress = linkStatus(tableName, rowIds, linkColumns);
  opts.onTick?.(progress);
  while (progress.pending > 0 && performance.now() < deadline) {
    await new Promise((res) => setTimeout(res, intervalMs));
    progress = linkStatus(tableName, rowIds, linkColumns);
    opts.onTick?.(progress);
  }

  if (progress.pending === 0) return { kind: 'linked' };
  return { kind: progress.pending === progress.total ? 'none' : 'partial', progress };
}
