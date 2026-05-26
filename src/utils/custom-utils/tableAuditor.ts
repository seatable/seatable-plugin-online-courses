import {
  ColumnAuditInfo,
  TableAuditResult,
  ViewAuditInfo,
  AuditTableDisplayState,
} from '../custom-interfaces/AuditTypes';

function isEmpty(val: any): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

// Normalize a cell value to a comparable string, regardless of column type
function normalizeValue(val: any): string {
  if (isEmpty(val)) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    // Handle arrays (multi-select, collaborator, file, image, link values)
    return val
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && item !== null) {
          // Link rows have display_value or name; files have name; collaborators have email
          return item.display_value || item.name || item.email || JSON.stringify(item);
        }
        return String(item);
      })
      .sort()
      .join('|');
  }
  if (typeof val === 'object' && val !== null) {
    return JSON.stringify(val);
  }
  return String(val);
}

function colNameByKey(columns: any[], key: string): string {
  const col = columns.find((c: any) => c.key === key);
  return col ? col.name : key;
}

/**
 * Recursively summarize a filter list. Filters can be leaves ({column_key, filter_predicate,
 * filter_term}) or nested groups ({filter_conjunction, filters: [...]}). Groups are rendered
 * in parens with their own conjunction so the boolean structure is readable.
 */
function summarizeFilterItems(
  items: any[],
  conjunction: string | undefined,
  columns: any[]
): string {
  const conj = conjunction === 'Or' ? ' OR ' : ' AND ';
  return items
    .map((f: any) => {
      if (!f) return '';
      if (f.column_key) {
        return `${colNameByKey(columns, f.column_key)} ${f.filter_predicate || ''} ${f.filter_term || ''}`.trim();
      }
      if (Array.isArray(f.filters)) {
        const inner = summarizeFilterItems(f.filters, f.filter_conjunction, columns);
        return inner ? `(${inner})` : '';
      }
      return '';
    })
    .filter(Boolean)
    .join(conj);
}

function summarizeFilters(filters: any[], conjunction: string | undefined, columns: any[]): string {
  if (!filters || filters.length === 0) return '';
  return summarizeFilterItems(filters, conjunction, columns);
}

function summarizeSorts(sorts: any[], columns: any[]): string {
  if (!sorts || sorts.length === 0) return '';
  return sorts
    .map((s: any) => `${colNameByKey(columns, s.column_key)} ${s.sort_type || ''}`.trim())
    .join(', ');
}

function summarizeGroupbys(groupbys: any[], columns: any[]): string {
  if (!groupbys || groupbys.length === 0) return '';
  return groupbys
    .map((g: any) => `${colNameByKey(columns, g.column_key)} (${g.sort_type || ''})`.trim())
    .join(', ');
}

// Yield to the event loop so the browser can paint & handle input between tables.
// Without this, a large base with many views freezes the UI during audit (per-table
// getViewRows + fill-rate computation can total multiple seconds).
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function auditAllTables(
  excludeTableNames: string[] = [],
  onProgress?: (msg: string) => void,
  displayState?: AuditTableDisplayState
): Promise<TableAuditResult[]> {
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = dtableSDK.getTables();
  const results: TableAuditResult[] = [];

  for (const table of tables) {
    await tick();
    if (excludeTableNames.includes(table.name)) continue;

    // If displayState is provided, skip tables not selected
    if (displayState && !displayState.selectedTables.includes(table._id)) continue;

    if (onProgress) {
      onProgress(`Auditing table: ${table.name}`);
    }

    const allColumns = table.columns || [];

    // Always audit every non-button, non-system column. The earlier
    // "audit only columns visible in a chosen view" path was dropped — it
    // added settings complexity (a per-table view selector) that nobody
    // used and confused the perf audit's denominator semantics.
    const columnsToAudit = allColumns.filter(
      (col: any) => col.type !== 'button' && !col.name.startsWith('(')
    );
    const allColumnsFiltered = columnsToAudit;
    const rows: any[] = table.rows || [];
    const rowCount = rows.length;
    const columnCount = columnsToAudit.length;
    const totalColumnCount = allColumnsFiltered.length;

    // Get link data for link columns (stored separately from regular row data)
    const linkColumns = allColumns.filter((col: any) => col.type === 'link');
    let linkRows: Record<string, Record<string, any[]>> = {};
    if (linkColumns.length > 0) {
      try {
        linkRows = dtableSDK.getTableLinkRows(rows, table) || {};
      } catch {
        linkRows = {};
      }
    }

    const FORMULA_TYPES = new Set(['formula', 'link-formula']);
    const FORMULA_ERROR_PATTERN = /^#[A-Z!?]+/;

    const auditColumns: ColumnAuditInfo[] = columnsToAudit.map((col: any) => {
      let filled: number;
      if (col.type === 'link') {
        filled = rows.filter((row) => {
          const rowLinks = linkRows[row._id];
          return rowLinks && !isEmpty(rowLinks[col.key]);
        }).length;
      } else {
        filled = rows.filter((row) => !isEmpty(row[col.key])).length;
      }

      // Detect formula errors (#VALUE!, #NAME?, #REF!, etc.)
      let errorRate: number | null = null;
      if (FORMULA_TYPES.has(col.type) && rowCount > 0) {
        const errorCount = rows.filter((row) => {
          const val = row[col.key];
          return typeof val === 'string' && FORMULA_ERROR_PATTERN.test(val);
        }).length;
        errorRate = errorCount / rowCount;
      }

      // Detect date columns that always match _ctime (could be replaced by ctime column)
      let matchesCtime = false;
      if (col.type === 'date' && filled > 0) {
        const allMatch = rows.every((row) => {
          const val = row[col.key];
          if (isEmpty(val)) return true; // skip empty rows
          const ctime = row._ctime;
          if (!ctime || !val) return false;
          // Compare date part only (YYYY-MM-DD)
          const valDate = String(val).slice(0, 10);
          const ctimeDate = String(ctime).slice(0, 10);
          return valDate === ctimeDate;
        });
        matchesCtime = allMatch;
      }

      // Last activity: most recent _mtime among rows with data in this column
      let lastActivity: string | null = null;
      if (col.type === 'link') {
        for (const row of rows) {
          const rowLinks = linkRows[row._id];
          if (rowLinks && !isEmpty(rowLinks[col.key]) && row._mtime) {
            if (!lastActivity || row._mtime > lastActivity) lastActivity = row._mtime;
          }
        }
      } else {
        for (const row of rows) {
          if (!isEmpty(row[col.key]) && row._mtime) {
            if (!lastActivity || row._mtime > lastActivity) lastActivity = row._mtime;
          }
        }
      }

      return {
        name: col.name,
        type: col.type,
        fillRate: rowCount > 0 ? filled / rowCount : null,
        errorRate,
        matchesCtime,
        duplicateOf: [] as string[],
        lastActivity,
      };
    });

    // Detect duplicate columns: columns with identical data across all rows
    if (rowCount > 0) {
      const fingerprints: Record<string, string[]> = {};
      for (const col of columnsToAudit) {
        const values = rows.map((row) => {
          if (col.type === 'link') {
            const rowLinks = linkRows[row._id];
            const linkedValues = rowLinks ? rowLinks[col.key] : null;
            return normalizeValue(linkedValues);
          }
          return normalizeValue(row[col.key]);
        });
        const fp = values.join('\n\t\n');
        if (!fingerprints[fp]) fingerprints[fp] = [];
        fingerprints[fp].push(col.name);
      }
      // Only flag groups with 2+ columns that have at least some non-empty data
      for (const [fp, names] of Object.entries(fingerprints)) {
        if (names.length < 2) continue;
        // Skip if all values are empty
        if (fp.split('\n\t\n').every((v) => v === '')) continue;
        for (const auditCol of auditColumns) {
          if (names.includes(auditCol.name)) {
            auditCol.duplicateOf = names.filter((n) => n !== auditCol.name);
          }
        }
      }
    }

    const views: any[] = table.views || [];
    // Build a stable signature per view (filters + sorts + groupbys + hidden columns +
    // filter conjunction). Views sharing a signature are behaviorally identical — same
    // rows, same order, same columns shown — and are flagged as duplicates.
    //
    // Use a canonical (key-sorted) stringifier instead of plain JSON.stringify because
    // SeaTable filter/sort/groupby objects can have keys in different insertion orders
    // depending on which code path created them. Plain stringify is order-sensitive,
    // which made some duplicates appear unique. Across 3+ logically-identical views,
    // this could surface as "each view shows only one duplicate" — A matched B by luck,
    // but C had a slightly different key order and looked unique.
    const canonicalStringify = (v: any): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
      const keys = Object.keys(v).sort();
      return (
        '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}'
      );
    };
    const viewSignatures = views.map((view: any) => {
      const sortedHidden = [...(view.hidden_columns || [])].sort();
      return canonicalStringify({
        conj: view.filter_conjunction || 'And',
        filters: view.filters || [],
        sorts: view.sorts || [],
        groupbys: view.groupbys || [],
        hidden: sortedHidden,
      });
    });

    const auditViews: ViewAuditInfo[] = views.map((view: any, viewIdx: number) => {
      const filters = view.filters || [];
      const sorts = view.sorts || [];
      const groupbys = view.groupbys || [];

      const mySig = viewSignatures[viewIdx];
      const duplicateOf = views
        .filter((_, i) => i !== viewIdx && viewSignatures[i] === mySig)
        .map((v: any) => v.name);

      return {
        name: view.name,
        viewId: view._id,
        filterCount: filters.length,
        filterSummary: summarizeFilters(filters, view.filter_conjunction, allColumns),
        sortCount: sorts.length,
        sortSummary: summarizeSorts(sorts, allColumns),
        groupbyCount: groupbys.length,
        groupbySummary: summarizeGroupbys(groupbys, allColumns),
        duplicateOf,
        privateFor: view.private_for ?? null,
      };
    });

    // Table-level last added / last modified
    let lastRowAdded: string | null = null;
    let lastRowModified: string | null = null;
    for (const row of rows) {
      if (row._ctime && (!lastRowAdded || row._ctime > lastRowAdded)) lastRowAdded = row._ctime;
      if (row._mtime && (!lastRowModified || row._mtime > lastRowModified))
        lastRowModified = row._mtime;
    }

    results.push({
      tableName: table.name,
      tableId: table._id,
      rowCount,
      columnCount,
      totalColumnCount,
      viewCount: views.length,
      lastRowAdded,
      lastRowModified,
      columns: auditColumns,
      views: auditViews,
    });
  }

  return results;
}
