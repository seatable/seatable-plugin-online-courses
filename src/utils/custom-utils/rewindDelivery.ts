/**
 * "Rewind the delivery" — the plugin action behind Course 4 Step 4.
 *
 * The learner has just built the AI chain that turns a photographed delivery note
 * into line items, and has nothing to feed it: the note the course ships with is
 * already in the base, lines and all. So the plugin puts the base back to the
 * moment before that truck pulled in — it deletes the delivery's line items, then
 * the document row itself — and the learner receives the same delivery for real,
 * through the app's form, letting the AI do the reading this time.
 *
 * Three things this module has to get right:
 *
 * 1. **Find every line of that delivery, not most of them.** The new document will
 *    carry the SAME reference (`INT-001` — it is the same delivery note), and links
 *    are made on the raw reference, so any line left behind would attach itself to
 *    the new document and be counted twice. We therefore take the UNION of the lines
 *    LINKED to the document and the lines whose reference cell matches it: a line
 *    the learner's automation never linked is exactly the kind that would survive a
 *    link-only sweep, and it is the one that does the damage.
 *
 * 2. **Delete the lines before the document.** Once the document row is gone the
 *    links are gone with it, and only the reference cells would be left to go on.
 *
 * 3. **Undo the stock those lines moved.** The lines validated in step 3 credited
 *    their product's `Stock`, and deleting a line does not take that back. Rather
 *    than restore hard-coded seed values — numbers that would be wrong the day the
 *    seeded base changes — we reverse exactly what step 3's script did: for each
 *    line being deleted that was validated and did enter sellable stock, subtract
 *    its received quantity from the product it is linked to. Mirror of the script
 *    in the course, `Damaged` / `Missing` included.
 *
 * ⚠️ A link cell's value is NOT on the row (`row[columnKey]` is empty forever) —
 * links live in the store's own structure and are read with `getTableLinkRows`.
 * See watchAutomation.ts for the full story.
 */

import { cellLabel, findRowByMatch, getColumn, getTableByName } from './sdkRead';
import { learnerAppendRows, learnerUpdateRow } from './learnerWrite';

function sdk(): any {
  return (window as any).dtableSDK;
}

export interface RewindSpec {
  /** The document to remove, found by its reference (e.g. Documents / INT-001). */
  document: { table_name: string; reference_column: string; reference: string };
  /** Its line items — matched both by link and by reference cell, then deleted. */
  lines: { table_name: string; reference_column: string; link_column: string };
  /**
   * Undo what step 3's `Validate` script credited. Omit to leave stock untouched.
   * `excluded_statuses` are the statuses that never entered sellable stock, so
   * there is nothing to take back for them.
   */
  stock?: {
    table_name: string;
    column: string;
    /** Link column on the LINE pointing at the product. */
    link_column: string;
    quantity_column: string;
    validated_column: string;
    status_column: string;
    excluded_statuses: string[];
  };
}

export interface RewindResult {
  /** Lines deleted. */
  lines: number;
  /** True when the document row itself was removed. */
  document: boolean;
  /** Products whose stock was put back. */
  products: number;
}

/**
 * Linked row ids for one link column, whatever shape the store hands back (ids, or
 * objects carrying one). Returns a map rowId → linked row ids.
 */
function linkedIdsByRow(table: any, rows: any[], columnName: string): Record<string, string[]> {
  const column = (table?.columns || []).find((c: any) => c.name === columnName);
  if (!column || !rows.length) return {};
  const raw = sdk()?.getTableLinkRows?.(rows, table) || {};
  const out: Record<string, string[]> = {};
  rows.forEach((row) => {
    const value = raw[row._id]?.[column.key];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    out[row._id] = list
      .map((v: any) => (typeof v === 'string' ? v : (v?.row_id ?? v?._id ?? null)))
      .filter(Boolean);
  });
  return out;
}

/**
 * The delivery's lines: linked to `documentRowId`, or carrying its reference — the
 * union, deliberately (see the header). `documentRowId` may be null when the
 * document is already gone, in which case only the reference match applies.
 */
function findDeliveryLines(spec: RewindSpec, documentRowId: string | null): any[] {
  const table = getTableByName(spec.lines.table_name);
  if (!table) throw new Error(`Table "${spec.lines.table_name}" not found in this base.`);
  const rows: any[] = table.rows || [];
  const refColumn = getColumn(table, spec.lines.reference_column);
  const links = documentRowId ? linkedIdsByRow(table, rows, spec.lines.link_column) : {};

  return rows.filter((row) => {
    const byReference =
      !!refColumn && cellLabel(refColumn, row[refColumn.key]) === spec.document.reference;
    const byLink = !!documentRowId && (links[row._id] || []).includes(documentRowId);
    return byReference || byLink;
  });
}

/**
 * How many lines of that delivery are in the base right now. Lets the safety net
 * name itself for what it is about to do: write the lines when the extraction left
 * none, fix them when it produced some.
 */
export function countDeliveryLines(spec: RewindSpec): number {
  try {
    const documentTable = getTableByName(spec.document.table_name);
    const documentRow = documentTable
      ? findRowByMatch(documentTable, spec.document.reference_column, spec.document.reference)
      : null;
    return findDeliveryLines(spec, documentRow?._id ?? null).length;
  } catch {
    return 0;
  }
}

/** Delete rows in one store op, tolerating an empty list. */
function deleteRows(tableName: string, rowIds: string[]): number {
  if (!rowIds.length) return 0;
  const table = getTableByName(tableName);
  if (!table) throw new Error(`Table "${tableName}" not found in this base.`);
  sdk().deleteRowsByIds(table, rowIds);
  return rowIds.length;
}

/**
 * Reverse the stock those lines credited, product by product. Returns how many
 * products were adjusted. Never throws on a line it cannot resolve: a line with no
 * product link moved no stock in the first place, which is precisely why step 3's
 * script skipped it.
 */
async function undoStock(spec: RewindSpec, lineRows: any[]): Promise<number> {
  const cfg = spec.stock;
  if (!cfg || !lineRows.length) return 0;
  const lineTable = getTableByName(spec.lines.table_name);
  const productTable = getTableByName(cfg.table_name);
  if (!lineTable || !productTable) return 0;

  const validatedCol = getColumn(lineTable, cfg.validated_column);
  const statusCol = getColumn(lineTable, cfg.status_column);
  const qtyCol = getColumn(lineTable, cfg.quantity_column);
  if (!validatedCol || !qtyCol) return 0;
  const productLinks = linkedIdsByRow(lineTable, lineRows, cfg.link_column);

  // Sum per product first: two lines of one delivery can point at the same product,
  // and a read-modify-write per line would lose one of them.
  const deltaByProduct: Record<string, number> = {};
  lineRows.forEach((row) => {
    if (!row[validatedCol.key]) return; // never validated → never credited
    const status = statusCol ? cellLabel(statusCol, row[statusCol.key]) : null;
    if (status && cfg.excluded_statuses.includes(status)) return;
    const qty = Number(row[qtyCol.key]) || 0;
    if (!qty) return;
    const productId = (productLinks[row._id] || [])[0];
    if (!productId) return;
    deltaByProduct[productId] = (deltaByProduct[productId] || 0) + qty;
  });

  const stockCol = getColumn(productTable, cfg.column);
  if (!stockCol) return 0;
  const ids = Object.keys(deltaByProduct);
  for (const productId of ids) {
    const product = (productTable.rows || []).find((r: any) => r._id === productId);
    if (!product) continue;
    const current = Number(product[stockCol.key]) || 0;
    await learnerUpdateRow(cfg.table_name, productId, {
      [cfg.column]: current - deltaByProduct[productId],
    });
  }
  return ids.length;
}

/**
 * Put the base back to the moment before the delivery arrived: stock first (it
 * needs the lines to still be there to know what to take back), then the lines,
 * then the document.
 */
export async function rewindDelivery(
  spec: RewindSpec,
  onTick?: (note: string) => void
): Promise<RewindResult> {
  const documentTable = getTableByName(spec.document.table_name);
  if (!documentTable) {
    throw new Error(`Table "${spec.document.table_name}" not found in this base.`);
  }
  const documentRow = findRowByMatch(
    documentTable,
    spec.document.reference_column,
    spec.document.reference
  );

  onTick?.('Looking for the delivery…');
  const lineRows = findDeliveryLines(spec, documentRow?._id ?? null);

  onTick?.('Putting the stock back…');
  const products = await undoStock(spec, lineRows);

  onTick?.('Removing the delivery lines…');
  const lines = deleteRows(
    spec.lines.table_name,
    lineRows.map((r) => r._id)
  );

  // The document goes last: its links are how we found part of the lines.
  if (documentRow) {
    onTick?.('Removing the document…');
    sdk().deleteRowById(documentTable, documentRow._id);
  }

  return { lines, document: !!documentRow, products };
}

/**
 * The safety net: lay down the delivery's correct lines when the extraction has
 * misfired. It REPLACES rather than appends — a run that produced two lines out of
 * three would otherwise leave the base with five — so what the learner ends up with
 * is exactly what a clean extraction would have written, no more.
 */
export async function reloadDeliveryLines(
  spec: RewindSpec,
  rows: Record<string, any>[],
  onTick?: (note: string) => void
): Promise<{
  removed: number;
  added: number;
  /** We put the note's reference on the learner's document, as the AI would have. */
  documentLabelled: boolean;
  /** Is there a document for these lines to attach to at all? */
  documentFound: boolean;
}> {
  const documentTable = getTableByName(spec.document.table_name);
  let documentRow = documentTable
    ? findRowByMatch(documentTable, spec.document.reference_column, spec.document.reference)
    : null;

  // The lines carry the note's reference, and the learner's step-2 rule links each one
  // to the document CARRYING THAT SAME REFERENCE. On the AI path the extraction writes
  // it; take the writing path instead and the document the learner just created from
  // the form holds a date and a file and nothing else — so the lines we are about to
  // write would match no document and sit there unlinked, while the step promised they
  // would attach themselves.
  //
  // So do the one thing the extraction would have done that the lines cannot do for
  // themselves: put the reference on the document. Only when exactly ONE document is
  // missing its reference — with none there is nothing to label (the learner has not
  // created it yet), and with several we cannot tell which is theirs, and a wrong
  // guess would attach this delivery's lines to somebody else's note.
  let documentLabelled = false;
  if (!documentRow && documentTable) {
    const refColumn = getColumn(documentTable, spec.document.reference_column);
    const unlabelled: any[] = refColumn
      ? (documentTable.rows || []).filter((r: any) => {
          const v = r[refColumn.key];
          return v === null || v === undefined || String(v).trim() === '';
        })
      : [];
    if (unlabelled.length === 1) {
      onTick?.('Labelling the document…');
      await learnerUpdateRow(spec.document.table_name, unlabelled[0]._id, {
        [spec.document.reference_column]: spec.document.reference,
      });
      documentRow = findRowByMatch(
        getTableByName(spec.document.table_name),
        spec.document.reference_column,
        spec.document.reference
      );
      documentLabelled = true;
    }
  }

  onTick?.('Clearing what the extraction produced…');
  const existing = findDeliveryLines(spec, documentRow?._id ?? null);
  // Stock is deliberately NOT touched here: these lines are the extraction's own
  // output, and nothing has been validated on them yet.
  const removed = deleteRows(
    spec.lines.table_name,
    existing.map((r) => r._id)
  );

  onTick?.('Writing the correct lines…');
  const added = await learnerAppendRows(spec.lines.table_name, rows);
  return { removed, added, documentLabelled, documentFound: !!documentRow };
}
