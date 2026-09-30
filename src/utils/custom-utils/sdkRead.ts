/**
 * Tiny read-only helpers over the in-session dtable SDK store. Shared by the
 * declarative grader (grader.ts) and the course UI so there's ONE implementation
 * of "find a table", "find a row by a display value" and "resolve a cell label".
 *
 * All reads go through window.dtableSDK.getTables() — the learner's own session,
 * no API calls. See [[plugin-codebase-map]] SDK access patterns.
 */

function sdk(): any {
  return (window as any).dtableSDK;
}

export function getTables(): any[] {
  return sdk()?.getTables?.() || [];
}

export function getTableByName(name: string): any | null {
  return getTables().find((t) => t.name === name) || null;
}

/** Resolve a single-select option id to its label; pass through plain text/values. */
export function cellLabel(column: any, raw: any): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const options = column?.data?.options;
  if (Array.isArray(options)) {
    const opt = options.find((o: any) => o.id === raw || o.name === raw);
    if (opt) return opt.name;
  }
  return typeof raw === 'string' ? raw : String(raw);
}

/** Column lookup by name; '' / undefined → the first (primary) column. */
export function getColumn(table: any, columnName?: string): any | null {
  const columns: any[] = table?.columns || [];
  return (columnName ? columns.find((c) => c.name === columnName) : columns[0]) || null;
}

/** Find the first row whose `matchColumn` display value equals `matchValue`. */
export function findRowByMatch(
  table: any,
  matchColumnName: string,
  matchValue: string
): any | null {
  const matchCol = getColumn(table, matchColumnName);
  if (!matchCol) return null;
  return (
    (table?.rows || []).find((r: any) => cellLabel(matchCol, r[matchCol.key]) === matchValue) ||
    null
  );
}
