import {
  PerformanceCandidateColumn,
  ChainNode,
  ChainColumn,
  BenchmarkTimings,
  ViewLoadTiming,
  PerformanceAuditResult,
  PerformanceAuditView,
  PerformanceAuditTableArchival,
  ReplacementType,
  RemediatedColumn,
  RemediatedView,
  RemediatedColumnHide,
  AffectedRule,
} from '../custom-interfaces/AuditTypes';
import { getAuthContext } from './authHelper';

// Module-level access to dtable-store's compute functions. The SDK wires these to its own
// dtableStore.value; to benchmark remediations we need to call them against a mutated
// clone of that value, which requires reaching the module directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dtableStoreModule: any = require('dtable-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Yield to the event loop so React can re-render progress messages */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function resolveOtherTableId(currentTableId: string, colData: any): string {
  if (currentTableId === colData.table_id) return colData.other_table_id;
  return colData.table_id;
}

// ---------------------------------------------------------------------------
// 1. Per-view row counts — count visible rows per view against a given `value`
// (the dtable store state). Works on the SDK's live value for the audit, or on a
// cloned-and-mutated value for a test before/after. Used as the volume input
// for the theoretical view cost model (Σ per-cell × visibleRows).
//
// Migrated 2026-05-05: previously this measured wall-clock `Views.getViewRows`
// time per view. On a real customer base (8 tables × 75922 rows × 122 views)
// that took ~5 minutes because each call cloned the view, recomputed
// filter+sort+group from scratch, and materialized every row object. We only
// ever needed the row count (for the theoretical model) and a per-view "weight"
// signal — the wall-clock timing was supposed to be retired in favor of
// theoretical cost (see project_validation_decision_pending.md / R²~0.1 HTTP).
// `Views.getRowsLength` reads the cached `view.rows.length` (filter views) or
// `table.rows.length` (default views) without recomputing — near-instant.
//
// The original wall-clock implementation is preserved as commented reference
// at the bottom of this section in case it needs to come back (e.g. if a
// future signal needs per-call timing).
// ---------------------------------------------------------------------------

export async function countViewRows(
  value: any,
  onProgress?: (msg: string) => void,
  progressPrefix: string = 'Counting view rows',
  selectedTableIds?: string[] | null
): Promise<ViewLoadTiming[]> {
  const Views = dtableStoreModule.Views;
  const tables: any[] = value.tables || [];
  const selectedSet =
    selectedTableIds && selectedTableIds.length > 0 ? new Set(selectedTableIds) : null;
  const out: ViewLoadTiming[] = [];

  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    if (selectedSet && !selectedSet.has(t._id)) continue;
    if (onProgress) {
      onProgress(`${progressPrefix}: ${t.name} (table ${ti + 1}/${tables.length})...`);
      await tick();
    }
    for (const v of t.views || []) {
      let rowCount = 0;
      try {
        // Cheap path: cached filter result length, or full table length for default views.
        rowCount = Views.getRowsLength(v, t);
      } catch {
        // stale/invalid refs in mutated clones can throw; fall back to full table count.
        rowCount = (t.rows || []).length;
      }
      out.push({
        tableId: t._id,
        tableName: t.name,
        viewId: v._id,
        viewName: v.name,
        rowCount,
        privateFor: v.private_for ?? null,
        // ms now carries theoretical cost (populated by callers via
        // computeTheoreticalViewCosts). Kept as `ms` to avoid churning the
        // `ViewLoadTiming` shape across the test before/after delta paths.
        ms: 0,
      });
    }
    await tick();
  }
  return out;
}

/**
 * Backwards-compatible alias kept so any out-of-tree caller doesn't break. New
 * code should call `countViewRows` directly. The behavior changed: `ms` is no
 * longer wall-clock; it stays 0 here and gets populated with theoretical cost
 * downstream via `computeTheoreticalViewCosts`.
 */
export async function measureViewLoads(
  value: any,
  onProgress?: (msg: string) => void,
  progressPrefix: string = 'Measuring views'
): Promise<ViewLoadTiming[]> {
  return countViewRows(value, onProgress, progressPrefix);
}

/*
 * --- Archived 2026-05-05: original wall-clock measureViewLoads ---
 * Kept commented for reference. The wall-clock timing of `getViewRows` was
 * abandoned because: (a) HTTP measurement R² with theoretical was ~0.1 — no
 * useful correlation; (b) on large bases the recompute path (clone view,
 * recompute filter+sort+group, materialize rows) cost minutes per audit.
 *
 * If a future signal needs per-call timing again, restore from here:
 *
 * export async function measureViewLoads(
 *   value: any,
 *   onProgress?: (msg: string) => void,
 *   progressPrefix: string = 'Measuring views'
 * ): Promise<ViewLoadTiming[]> {
 *   const Views = dtableStoreModule.Views;
 *   const tables: any[] = value.tables || [];
 *   const out: ViewLoadTiming[] = [];
 *   for (let ti = 0; ti < tables.length; ti++) {
 *     const t = tables[ti];
 *     if (onProgress) {
 *       onProgress(`${progressPrefix}: ${t.name} (table ${ti + 1}/${tables.length})...`);
 *       await tick();
 *     }
 *     for (const v of t.views || []) {
 *       let rowCount = 0;
 *       let ms = 0;
 *       try {
 *         const t0 = performance.now();
 *         const rows = Views.getViewRows(v, t, value, '', '', {});
 *         ms = performance.now() - t0;
 *         rowCount = Array.isArray(rows) ? rows.length : 0;
 *       } catch {
 *         // stale/invalid refs in mutated clones can throw; treat as 0/0
 *       }
 *       out.push({ tableId: t._id, tableName: t.name, viewId: v._id, viewName: v.name, rowCount, ms });
 *     }
 *     await tick();
 *   }
 *   return out;
 * }
 */

/**
 * Run the in-memory benchmark for a test before/after. Returns one entry per
 * view with `ms` populated as the theoretical compute cost computed against
 * the supplied `value` (post-remediation when called for the "after" side).
 *
 * Requires `costByKey` from the audit's per-column cost detection — that
 * signal is intrinsic to each formula and stays valid across remediations
 * (deleting a column doesn't change the per-cell cost of the others), so the
 * caller can reuse the cached map from the original audit run.
 */
export async function benchmarkInMemory(
  value: any,
  costByKey: Map<string, number>,
  onProgress?: (msg: string) => void,
  progressPrefix: string = 'Benchmarking',
  selectedTableIds?: string[] | null
): Promise<BenchmarkTimings> {
  const viewLoads = await countViewRows(value, onProgress, progressPrefix, selectedTableIds);
  const theoreticalByKey = computeTheoreticalViewCosts(costByKey, viewLoads, value);
  for (const vl of viewLoads) {
    const ms = theoreticalByKey.get(`${vl.tableId}:${vl.viewId}`);
    if (ms !== undefined) vl.ms = ms;
  }
  return { viewLoads };
}

/**
 * Build a shallow-cloned dtable store value with the given remediations applied.
 * - Delete: drops the column from its table's columns array.
 * - Replace-static: changes the column's type (and data) in place, as if the formula
 *   had been swapped for a plain column of the replacement type.
 * - Delete-view: drops the view from its table's views array.
 * - Hide-in-view: appends the column key to the affected views' `hidden_columns`.
 *
 * Only tables touched by a remediation get a fresh columns/views array; everything
 * else — including rows, links, and untouched tables — is shared by reference. Memory
 * cost is independent of base size; it scales with the number of affected entities.
 */
export function applyRemediationsToValue(
  value: any,
  remediations: RemediatedColumn[],
  remediationViews: RemediatedView[] = [],
  remediationHides: RemediatedColumnHide[] = []
): any {
  if (
    (!remediations || remediations.length === 0) &&
    (!remediationViews || remediationViews.length === 0) &&
    (!remediationHides || remediationHides.length === 0)
  ) {
    return value;
  }

  const colsByTable: Record<string, RemediatedColumn[]> = {};
  for (const r of remediations || []) {
    if (!colsByTable[r.tableName]) colsByTable[r.tableName] = [];
    colsByTable[r.tableName].push(r);
  }

  const viewsByTable: Record<string, Set<string>> = {};
  for (const v of remediationViews || []) {
    if (!viewsByTable[v.tableName]) viewsByTable[v.tableName] = new Set();
    viewsByTable[v.tableName].add(v.viewId);
  }

  // Per-table, per-view set of column keys to add to hidden_columns. Keyed
  // first by tableName so the table loop hits it once, then by viewId so the
  // inner view loop can apply all the columns staged for that view at once.
  const hidesByTableAndView: Record<string, Record<string, Set<string>>> = {};
  for (const h of remediationHides || []) {
    if (!hidesByTableAndView[h.tableName]) hidesByTableAndView[h.tableName] = {};
    for (const v of h.views) {
      const set = hidesByTableAndView[h.tableName][v.viewId] || new Set<string>();
      set.add(h.columnKey);
      hidesByTableAndView[h.tableName][v.viewId] = set;
    }
  }

  const newTables = (value.tables || []).map((t: any) => {
    const affectedCols = colsByTable[t.name];
    const deletedViewIds = viewsByTable[t.name];
    const hidesForTable = hidesByTableAndView[t.name];
    if (!affectedCols && !deletedViewIds && !hidesForTable) return t;

    let newColumns = t.columns;
    if (affectedCols) {
      const deleteKeys = new Set<string>();
      const replaceByKey: Record<string, RemediatedColumn> = {};
      for (const r of affectedCols) {
        if (r.action === 'delete') deleteKeys.add(r.columnKey);
        else if (r.action === 'replace-static') replaceByKey[r.columnKey] = r;
      }
      newColumns = (t.columns || [])
        .filter((c: any) => !deleteKeys.has(c.key))
        .map((c: any) => {
          const rep = replaceByKey[c.key];
          if (rep && rep.replacementType) {
            return { ...c, type: rep.replacementType.type, data: rep.replacementType.data };
          }
          return c;
        });
    }

    let newViews: any = t.views;
    if (deletedViewIds || hidesForTable) {
      newViews = (t.views || [])
        .filter((v: any) => !(deletedViewIds && deletedViewIds.has(v._id)))
        .map((v: any) => {
          const toHide = hidesForTable?.[v._id];
          if (!toHide || toHide.size === 0) return v;
          const merged = new Set<string>(v.hidden_columns || []);
          toHide.forEach((k) => merged.add(k));
          return { ...v, hidden_columns: Array.from(merged) };
        });
    }

    return { ...t, columns: newColumns, views: newViews };
  });

  return { ...value, tables: newTables };
}

// ---------------------------------------------------------------------------
// Cleanup helpers — take current entity + deleted keys, return cleaned copy.
// Pure functions; no SDK / HTTP. Used by the apply helper to prepare payloads.
// ---------------------------------------------------------------------------

/** Strip leaf filters whose column_key is in `deletedKeys`; drop groups that become empty. */
function cleanupFilterList(filters: any[] | undefined, deletedKeys: Set<string>): any[] {
  if (!Array.isArray(filters)) return [];
  const out: any[] = [];
  for (const f of filters) {
    if (!f) continue;
    if (f.column_key) {
      if (!deletedKeys.has(f.column_key)) out.push(f);
    } else if (Array.isArray(f.filters)) {
      const cleaned = cleanupFilterList(f.filters, deletedKeys);
      if (cleaned.length > 0) out.push({ ...f, filters: cleaned });
    } else {
      out.push(f);
    }
  }
  return out;
}

/** Return a view object with all deleted-column references stripped. */
export function cleanupView(view: any, deletedKeys: Set<string>): any {
  const cleaned: any = { ...view };

  cleaned.filters = cleanupFilterList(view.filters, deletedKeys);
  cleaned.sorts = (view.sorts || []).filter((s: any) => !deletedKeys.has(s.column_key));
  cleaned.groupbys = (view.groupbys || []).filter((g: any) => !deletedKeys.has(g.column_key));

  // colorbys: clear color_by_column if it's a deleted key
  if (view.colorbys) {
    const cb = view.colorbys;
    if (cb.color_by_column && deletedKeys.has(cb.color_by_column)) {
      cleaned.colorbys = { ...cb, type: '', color_by_column: '' };
    }
  }

  // column_colors: record keyed by column_key
  if (view.column_colors) {
    const entries = Object.entries(view.column_colors).filter(([k]) => !deletedKeys.has(k));
    cleaned.column_colors = Object.fromEntries(entries);
  }

  // summaries: record keyed by column_key
  if (view.summaries) {
    const entries = Object.entries(view.summaries).filter(([k]) => !deletedKeys.has(k));
    cleaned.summaries = Object.fromEntries(entries);
  }

  return cleaned;
}

/**
 * For a link-formula column with conditions, strip any condition whose column_key is deleted.
 * Returns a new `data` object (may be identical if no matches).
 */
export function cleanupLinkFormulaData(colData: any, deletedKeysInLinkedTable: Set<string>): any {
  if (!colData?.include_condition || !Array.isArray(colData.conditions)) return colData;
  const keptConditions = colData.conditions.filter(
    (c: any) => c?.column_key && !deletedKeysInLinkedTable.has(c.column_key)
  );
  if (keptConditions.length === colData.conditions.length) return colData;
  return {
    ...colData,
    conditions: keptConditions,
    // If no conditions remain, disable the flag so SeaTable doesn't show a half-empty rule.
    include_condition: keptConditions.length > 0 ? colData.include_condition : false,
  };
}

/**
 * For a link column's row-filter rule, strip any filter referencing a deleted column.
 * - static: filter.column_key lives in the linked table
 * - dynamic: filter.linked_table_column_key (linked table) OR filter.column_key (this table)
 */
export function cleanupLinkRowFilterData(
  colData: any,
  deletedKeysInThisTable: Set<string>,
  deletedKeysInLinkedTable: Set<string>
): any {
  if (!colData?.enable_filter_row_selection || !Array.isArray(colData.filters)) return colData;
  const kept = colData.filters.filter((f: any) => {
    if (!f) return false;
    if (f.status === 'dynamic') {
      if (f.linked_table_column_key && deletedKeysInLinkedTable.has(f.linked_table_column_key))
        return false;
      if (f.column_key && deletedKeysInThisTable.has(f.column_key)) return false;
    } else {
      // static
      if (f.column_key && deletedKeysInLinkedTable.has(f.column_key)) return false;
    }
    return true;
  });
  if (kept.length === colData.filters.length) return colData;
  return {
    ...colData,
    filters: kept,
    enable_filter_row_selection: kept.length > 0 ? colData.enable_filter_row_selection : false,
  };
}

/**
 * Count how many "rules" a view has: filters (top-level items, groups count as one),
 * sorts, groupbys, active colorby, column_colors entries, summaries entries. Used to
 * decide whether a view becomes rule-less after cleanup.
 */
function viewRuleCount(v: any): number {
  return (
    (v.filters?.length || 0) +
    (v.sorts?.length || 0) +
    (v.groupbys?.length || 0) +
    (v.colorbys?.type ? 1 : 0) +
    Object.keys(v.column_colors || {}).length +
    Object.keys(v.summaries || {}).length
  );
}

export interface RulelessView {
  tableName: string;
  tableId: string;
  viewName: string;
  viewId: string;
}

/**
 * Find views that would become "rule-less" (no filters/sorts/groupbys/colorby/column-colors/
 * summaries remaining) after applying deletion remediations. Caller can offer to delete
 * these views entirely since without any rules they're effectively no-op "dump" views.
 */
export function findNowRulelessViews(value: any, remediations: RemediatedColumn[]): RulelessView[] {
  const tables: any[] = value?.tables || [];
  const tableByName: Record<string, any> = {};
  for (const t of tables) tableByName[t.name] = t;

  const deletedKeysByTableId: Record<string, Set<string>> = {};
  for (const r of remediations) {
    if (r.action !== 'delete') continue;
    const tbl = tableByName[r.tableName];
    if (!tbl) continue;
    (deletedKeysByTableId[tbl._id] ??= new Set()).add(r.columnKey);
  }

  const out: RulelessView[] = [];
  for (const t of tables) {
    const delKeys = deletedKeysByTableId[t._id];
    if (!delKeys || delKeys.size === 0) continue;
    for (const v of t.views || []) {
      const beforeCount = viewRuleCount(v);
      if (beforeCount === 0) continue;
      const cleaned = cleanupView(v, delKeys);
      const afterCount = viewRuleCount(cleaned);
      if (afterCount === 0) {
        out.push({ tableName: t.name, tableId: t._id, viewName: v.name, viewId: v._id });
      }
    }
  }
  return out;
}

/**
 * Recursively walk a filter list, invoking `onLeaf(columnKey)` for every leaf filter.
 * Filter groups are represented inline in the same array: leaves have `column_key`,
 * groups have `filter_conjunction` + their own `filters` array (possibly nested again).
 */
function walkFilterList(filters: any[] | undefined, onLeaf: (columnKey: string) => void): void {
  if (!filters) return;
  for (const f of filters) {
    if (!f) continue;
    if (f.column_key) {
      onLeaf(f.column_key);
    } else if (Array.isArray(f.filters)) {
      walkFilterList(f.filters, onLeaf);
    }
  }
}

// Maps the audit's "compute-requiring" rule kinds to short, user-facing labels
// for tooltips and badge text in the per-candidate / per-view drills.
export const RULE_KIND_LABEL_SHORT: Record<string, string> = {
  'view-filter': 'filter',
  'view-sort': 'sort',
  'view-groupby': 'group-by',
  'view-colorby': 'color-by',
  'view-column-color': 'column color',
  'view-summary': 'summary',
};

/**
 * Which compute-requiring rule kinds in `view` reference `columnKey`. Returns
 * the kinds (as in RULE_KIND_LABEL_SHORT) so callers can build a comma-joined
 * label like "filter, sort". Used by both the per-candidate drill (Overview)
 * and the per-view slider expansion (TableTab) to flag rule-bound entries.
 */
export function getColumnRuleKindsInView(view: any, columnKey: string): string[] {
  const kinds: string[] = [];
  let inFilter = false;
  walkFilterList(view?.filters, (ck) => {
    if (ck === columnKey) inFilter = true;
  });
  if (inFilter) kinds.push('view-filter');
  if ((view?.sorts || []).some((s: any) => s?.column_key === columnKey)) {
    kinds.push('view-sort');
  }
  if ((view?.groupbys || []).some((g: any) => g?.column_key === columnKey)) {
    kinds.push('view-groupby');
  }
  if (view?.colorbys?.color_by_column === columnKey) kinds.push('view-colorby');
  if ((view?.column_colors || {})[columnKey]) kinds.push('view-column-color');
  if ((view?.summaries || {})[columnKey]) kinds.push('view-summary');
  return kinds;
}

/**
 * Column keys referenced by a view's "compute-requiring" rules: filter, sort, groupby,
 * colorby, column_colors, summaries. Excludes `hidden_columns` (which is the *opposite*
 * — the visibility set, not a reference) and excludes link-formula conditions / link
 * row-filters (those reference columns in the LINKED table, not in the view's own table,
 * so they don't drive in-table compute).
 *
 * Used by computeTheoreticalViewCosts so a hidden but rule-referenced column still
 * incurs cost — SeaTable computes the column to evaluate the filter/sort/etc, even when
 * the column isn't displayed. Used by the UI to flag views as "rule-bound" — hiding
 * doesn't save compute when the column is referenced.
 */
export function getViewReferencedColumnKeys(view: any): Set<string> {
  const out = new Set<string>();
  walkFilterList(view?.filters, (ck) => out.add(ck));
  for (const s of view?.sorts || []) {
    if (s?.column_key) out.add(s.column_key);
  }
  for (const g of view?.groupbys || []) {
    if (g?.column_key) out.add(g.column_key);
  }
  if (view?.colorbys?.color_by_column) out.add(view.colorbys.color_by_column);
  for (const ck of Object.keys(view?.column_colors || {})) out.add(ck);
  for (const ck of Object.keys(view?.summaries || {})) out.add(ck);
  return out;
}

/**
 * Scan the whole base and build an index of all rule references to each column.
 * Covers three scopes:
 *  - Views: filters (incl. nested filter_groups), sorts, groupbys, hidden_columns,
 *    colorbys.color_by_column, column_colors keys, summaries keys.
 *  - Link-formula columns with "Only summarize records that meet the following conditions"
 *    enabled — each condition's column_key references a column in the LINKED table.
 *  - Link columns with "Limit row selection using a filter rule" enabled — each filter's
 *    column_key references a column in the LINKED table (static), plus an extra
 *    linked_table_column_key (filtered side) and column_key (value side) for dynamic filters.
 *
 * Returns a Map keyed by `${tableId}:${columnKey}` → list of AffectedRule entries.
 */
export function scanColumnReferences(value: any): Map<string, AffectedRule[]> {
  const index = new Map<string, AffectedRule[]>();
  const tables: any[] = value?.tables || [];

  const addRef = (tableId: string, columnKey: string, rule: AffectedRule) => {
    if (!columnKey || !tableId) return;
    const k = `${tableId}:${columnKey}`;
    const list = index.get(k);
    if (list) list.push(rule);
    else index.set(k, [rule]);
  };

  for (const t of tables) {
    // ---- Views ----
    for (const v of t.views || []) {
      const viewCtx = {
        tableName: t.name,
        tableId: t._id,
        viewName: v.name,
        viewId: v._id,
      } as const;

      walkFilterList(v.filters, (ck) => addRef(t._id, ck, { kind: 'view-filter', ...viewCtx }));

      for (const s of v.sorts || []) {
        if (s?.column_key) addRef(t._id, s.column_key, { kind: 'view-sort', ...viewCtx });
      }
      for (const g of v.groupbys || []) {
        if (g?.column_key) addRef(t._id, g.column_key, { kind: 'view-groupby', ...viewCtx });
      }
      // Skip hidden_columns — SeaTable auto-cleans the list on column deletion, and
      // being in a hidden list doesn't block anything. Noisy to report.
      if (v.colorbys?.color_by_column) {
        addRef(t._id, v.colorbys.color_by_column, { kind: 'view-colorby', ...viewCtx });
      }
      for (const ck of Object.keys(v.column_colors || {})) {
        addRef(t._id, ck, { kind: 'view-column-color', ...viewCtx });
      }
      for (const ck of Object.keys(v.summaries || {})) {
        addRef(t._id, ck, { kind: 'view-summary', ...viewCtx });
      }
    }

    // ---- Link-formula conditions & Link row-selection filters ----
    const colsByKey: Record<string, any> = {};
    for (const c of t.columns || []) colsByKey[c.key] = c;

    for (const c of t.columns || []) {
      // Link-formula: conditions reference columns in the LINKED table (via link_column_key)
      if (
        c.type === 'link-formula' &&
        c.data?.include_condition &&
        Array.isArray(c.data.conditions) &&
        c.data.conditions.length > 0
      ) {
        const linkColKey: string = c.data.link_column_key || '';
        const linkCol = colsByKey[linkColKey];
        const linkedTableId = linkCol?.data ? resolveOtherTableId(t._id, linkCol.data) : undefined;
        if (linkedTableId) {
          for (const cond of c.data.conditions) {
            if (cond?.column_key) {
              addRef(linkedTableId, cond.column_key, {
                kind: 'link-formula-condition',
                tableName: t.name,
                tableId: t._id,
                ownerColumnName: c.name,
                ownerColumnKey: c.key,
              });
            }
          }
        }
      }

      // Link: row-selection filter (static or dynamic)
      if (
        c.type === 'link' &&
        c.data?.enable_filter_row_selection &&
        Array.isArray(c.data.filters) &&
        c.data.filters.length > 0
      ) {
        const linkedTableId = resolveOtherTableId(t._id, c.data);
        for (const f of c.data.filters) {
          if (!f) continue;
          if (f.status === 'dynamic') {
            // linked_table_column_key -> column in the LINKED table (what's being filtered)
            if (f.linked_table_column_key && linkedTableId) {
              addRef(linkedTableId, f.linked_table_column_key, {
                kind: 'link-row-filter-dynamic',
                tableName: t.name,
                tableId: t._id,
                ownerColumnName: c.name,
                ownerColumnKey: c.key,
                dynamicRole: 'filtered',
              });
            }
            // column_key -> column in THIS table (value read from each row)
            if (f.column_key) {
              addRef(t._id, f.column_key, {
                kind: 'link-row-filter-dynamic',
                tableName: t.name,
                tableId: t._id,
                ownerColumnName: c.name,
                ownerColumnKey: c.key,
                dynamicRole: 'value',
              });
            }
          } else {
            // static: column_key -> column in the LINKED table
            if (f.column_key && linkedTableId) {
              addRef(linkedTableId, f.column_key, {
                kind: 'link-row-filter-static',
                tableName: t.name,
                tableId: t._id,
                ownerColumnName: c.name,
                ownerColumnKey: c.key,
              });
            }
          }
        }
      }
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// 2. Detect candidate columns with heuristic labels
// ---------------------------------------------------------------------------

const LINK_FUNCTIONS = ['countlinks', 'rollup', 'findmax', 'findmin'];

function extractFormulaRefs(formula: string): string[] {
  const regex = /\{([^}]+)\}/g;
  const refs: string[] = [];
  let match;
  while ((match = regex.exec(formula)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

function extractDotLookups(formula: string): { linkColName: string; targetColName: string }[] {
  const regex = /\{([^}.]+)\.([^}]+)\}/g;
  const results: { linkColName: string; targetColName: string }[] = [];
  let match;
  while ((match = regex.exec(formula)) !== null) {
    results.push({ linkColName: match[1], targetColName: match[2] });
  }
  return results;
}

function extractLinkFunctions(formula: string): { funcName: string; linkColName: string }[] {
  const results: { funcName: string; linkColName: string }[] = [];
  for (const fn of LINK_FUNCTIONS) {
    const regex = new RegExp(fn + '\\s*\\(\\s*\\{([^}]+)\\}', 'gi');
    let match;
    while ((match = regex.exec(formula)) !== null) {
      results.push({ funcName: fn, linkColName: match[1] });
    }
  }
  return results;
}

const COMPLEX_FUNCTIONS =
  /\b(dateadd|datediff|emonth|date|concatenate|trim|mid|left|right|substitute)\b/i;
const NESTED_IF = /\bif\s*\(.*\bif\s*\(/i;

/**
 * Scan the column's formula results across all rows; return true if any row's value
 * is an array with 2+ elements. Empty arrays and single-element arrays count as single-value.
 */
function detectMultiValue(formulaResults: any, table: any, colKey: string): boolean {
  const rows = table.rows || [];
  for (const row of rows) {
    const value = formulaResults?.[row._id]?.[colKey];
    if (Array.isArray(value) && value.length >= 2) return true;
  }
  return false;
}

/**
 * Return true if any row has 2+ linked records through the given link column.
 * This is the correct "multi-value" signal for link-formulas: a single linked record
 * may still produce an array result (e.g. lookup into a multi-select column), but that's
 * one cell's worth of data, not multiple.
 */
function hasMultipleLinkedRecords(
  linkRowsResult: Record<string, Record<string, string[]>> | null,
  linkColKey: string
): boolean {
  if (!linkRowsResult || !linkColKey) return false;
  for (const rowId in linkRowsResult) {
    const linked = linkRowsResult[rowId]?.[linkColKey];
    if (Array.isArray(linked) && linked.length >= 2) return true;
  }
  return false;
}

/** Plain target types we can safely replicate as a regular column. */
const REPLACEABLE_TARGET_TYPES = new Set([
  'text',
  'long-text',
  'number',
  'date',
  'checkbox',
  'single-select',
  'multiple-select',
  'url',
  'email',
  'rate',
  'duration',
]);

/** Rollup aggregations that preserve the target column's type (max/min return the winning value as-is). */
const TARGET_PRESERVING_ROLLUP_AGGS = new Set(['max', 'min']);

/** Map SeaTable's formula `result_type` to a plain column type. */
function baseTypeForResultType(resultType: string | undefined): string | undefined {
  if (resultType === 'string') return 'text';
  if (resultType === 'number') return 'number';
  if (resultType === 'bool') return 'checkbox';
  if (resultType === 'date') return 'date';
  return undefined;
}

/** Shallow-clone column-data fields that are relevant for plain column types (format, options, etc.). */
function cloneColumnData(sourceData: any, type: string): any | undefined {
  if (!sourceData) return undefined;
  if (type === 'single-select' || type === 'multiple-select') {
    return { options: JSON.parse(JSON.stringify(sourceData.options || [])) };
  }
  if (type === 'number') {
    return {
      format: sourceData.format,
      decimal: sourceData.decimal,
      thousands: sourceData.thousands,
      precision: sourceData.precision,
      enable_precision: sourceData.enable_precision,
      currency_symbol: sourceData.currency_symbol,
    };
  }
  if (type === 'date') {
    return { format: sourceData.format };
  }
  if (type === 'duration') {
    return { format: sourceData.format, duration_format: sourceData.duration_format };
  }
  return undefined;
}

/**
 * Compute the plain column type that would replace this candidate. Returns undefined when
 * we can't determine a safe replacement.
 *
 * Strategy for link-formulas that preserve the target column's type (lookup, findmax,
 * findmin, rollup with max/min): resolve the target column first so we keep its exact type
 * with options/format intact. Fall back to result_type / array_type only if target lookup fails.
 */
function computeReplacementType(
  col: any,
  colByKey: Record<string, any>,
  tableById: Record<string, any>,
  currentTable: any,
  visited: Set<string> = new Set()
): ReplacementType | undefined {
  const resultType: string | undefined = col.data?.result_type;

  // Base type derived from result_type (or array_type when result_type is 'array').
  // `array_type` is usually a column-type name (e.g. 'text', 'multiple-select'), but can also
  // be a result-type name ('string', 'number', 'bool', 'date') — fall back accordingly.
  let baseType: string | undefined;
  let baseData: any = undefined;
  if (resultType === 'array') {
    const itemType: string | undefined = col.data?.array_type;
    if (itemType && REPLACEABLE_TARGET_TYPES.has(itemType)) {
      baseType = itemType;
      // array_data mirrors the target column's data (format, options, etc.) for single-value items.
      const arrayData = col.data?.array_data;
      if (arrayData && Object.keys(arrayData).length > 0) {
        baseData = cloneColumnData(arrayData, itemType);
      }
    } else if (itemType) {
      baseType = baseTypeForResultType(itemType);
    }
  } else {
    baseType = baseTypeForResultType(resultType);
  }

  // For plain formula columns there's no target to upgrade to — trust baseType.
  if (col.type === 'formula') {
    return baseType ? { type: baseType, data: baseData } : undefined;
  }

  if (col.type !== 'link-formula') return undefined;

  const formulaType = col.data?.formula;

  // For formulas that preserve the target type, try the target column first — it has the
  // richest info (real column type, options, formats). Fall back to baseType on failure.
  const preservesTargetType =
    formulaType === 'lookup' ||
    formulaType === 'findmax' ||
    formulaType === 'findmin' ||
    (formulaType === 'rollup' && TARGET_PRESERVING_ROLLUP_AGGS.has(col.data?.summary_method));

  if (preservesTargetType) {
    const dependsOnKey = col.data?.link_column_key || '';
    const dependsOnCol = colByKey[dependsOnKey];
    if (dependsOnCol?.data) {
      const tgtTable = tableById[resolveOtherTableId(currentTable._id, dependsOnCol.data)];
      if (tgtTable) {
        const level1Key =
          formulaType === 'findmax' || formulaType === 'findmin'
            ? col.data?.column_key_for_comparison ||
              col.data?.level1_linked_table_column_key ||
              col.data?.column_key_in_linked_record
            : col.data?.level1_linked_table_column_key || col.data?.column_key_in_linked_record;

        // For nested lookups the level-1 key points to a link column and the leaf lives at
        // level2_linked_table_column_key in that link's other table. Walk the extra hop here.
        let leafTable = tgtTable;
        let leafCol: any = (tgtTable.columns || []).find((c: any) => c.key === level1Key);
        const level2Key: string | undefined = col.data?.level2_linked_table_column_key;
        if (level2Key && leafCol?.type === 'link' && leafCol.data) {
          const nextTable = tableById[resolveOtherTableId(leafTable._id, leafCol.data)];
          if (nextTable) {
            leafTable = nextTable;
            leafCol = (nextTable.columns || []).find((c: any) => c.key === level2Key);
          } else {
            leafCol = undefined;
          }
        }

        if (leafCol) {
          if (REPLACEABLE_TARGET_TYPES.has(leafCol.type)) {
            return { type: leafCol.type, data: cloneColumnData(leafCol.data, leafCol.type) };
          }
          // Leaf is itself a computed column — recursively resolve its replacement type so
          // chains like lookup→lookup or lookup→formula still yield a concrete scalar.
          if (leafCol.type === 'formula' || leafCol.type === 'link-formula') {
            const visitKey = `${leafTable._id}:${leafCol.key}`;
            if (!visited.has(visitKey)) {
              visited.add(visitKey);
              const leafColByKey: Record<string, any> = {};
              for (const c of leafTable.columns || []) leafColByKey[c.key] = c;
              const recursive = computeReplacementType(
                leafCol,
                leafColByKey,
                tableById,
                leafTable,
                visited
              );
              if (recursive) return recursive;
            }
          }
        }
      }
    }
  }

  // Fallback: use the base type (from result_type / array_type) when target resolution didn't work.
  return baseType ? { type: baseType, data: baseData } : undefined;
}

/**
 * Build a tree-structured chain for a link-formula column.
 * Groups columns by target table, with children for chained lookups.
 */
export function buildChainForLinkFormula(
  linkCol: any,
  targetColKey: string,
  currentTable: any,
  tableById: Record<string, any>,
  level2TargetKey?: string
): ChainNode[] {
  if (!linkCol?.data) return [];

  const targetTable = tableById[resolveOtherTableId(currentTable._id, linkCol.data)];
  if (!targetTable) return [];

  const targetRows = (targetTable.rows || []).length;
  const targetCol = (targetTable.columns || []).find((c: any) => c.key === targetColKey);

  const node: ChainNode = {
    tableName: targetTable.name,
    tableRows: targetRows,
    // countlinks has no target column — render only the table name
    columns: targetCol ? [{ name: targetCol.name, type: targetCol.type || 'text' }] : [],
    children: [],
  };

  if (targetCol) {
    const visited = new Set<string>([`${currentTable._id}:${linkCol.key}`]);
    // Nested lookup: the level-1 target is a link column; render the explicit level-2 leaf
    // instead of followChainTree's generic "first column" fallback.
    if (level2TargetKey && targetCol.type === 'link' && targetCol.data) {
      const level2Table = tableById[resolveOtherTableId(targetTable._id, targetCol.data)];
      if (level2Table) {
        const level2Col = (level2Table.columns || []).find((c: any) => c.key === level2TargetKey);
        node.children = [
          {
            tableName: level2Table.name,
            tableRows: (level2Table.rows || []).length,
            columns: level2Col ? [{ name: level2Col.name, type: level2Col.type || 'text' }] : [],
            children: [],
          },
        ];
      }
    } else {
      node.children = followChainTree(targetTable, targetCol, tableById, visited);
    }
  }

  return [node];
}

/**
 * Recursively follow a dependency chain, returning child ChainNodes.
 */
function followChainTree(
  table: any,
  col: any,
  tableById: Record<string, any>,
  visited: Set<string>,
  depth: number = 0
): ChainNode[] {
  if (!col || depth > 5) return [];

  const visitKey = `${table._id}:${col.key}`;
  if (visited.has(visitKey)) return [];
  visited.add(visitKey);

  if (col.type === 'link' && col.data) {
    const nextTable = tableById[resolveOtherTableId(table._id, col.data)];
    if (!nextTable) return [];
    const nextRows = (nextTable.rows || []).length;
    const displayCol = nextTable.columns?.[0];
    return [
      {
        tableName: nextTable.name,
        tableRows: nextRows,
        columns: displayCol ? [{ name: displayCol.name, type: displayCol.type || 'text' }] : [],
        children: [],
      },
    ];
  }

  if (col.type === 'link-formula' && col.data) {
    const parentLinkKey = col.data.link_column_key || '';
    const parentLinkCol = (table.columns || []).find((c: any) => c.key === parentLinkKey);
    const nextTable = parentLinkCol?.data
      ? tableById[resolveOtherTableId(table._id, parentLinkCol.data)]
      : null;
    if (!nextTable) return [];
    const nextRows = (nextTable.rows || []).length;

    const nextColKey =
      col.data.level1_linked_table_column_key ||
      col.data.column_key_in_linked_record ||
      col.data.column_key_for_comparison ||
      '';
    const nextCol = (nextTable.columns || []).find((c: any) => c.key === nextColKey);

    const node: ChainNode = {
      tableName: nextTable.name,
      tableRows: nextRows,
      columns: nextCol ? [{ name: nextCol.name, type: nextCol.type || 'text' }] : [],
      children: [],
    };

    if (nextCol) {
      node.children = followChainTree(nextTable, nextCol, tableById, visited, depth + 1);
    }

    return [node];
  }

  return [];
}

/**
 * Build chain nodes for formula columns with dot-lookups and link functions.
 * Groups multiple lookups to the same table into one node with multiple columns.
 */
function buildChainForFormula(
  dotLookups: { linkColName: string; targetColName: string }[],
  linkFuncs: { funcName: string; linkColName: string }[],
  colByName: Record<string, any>,
  currentTable: any,
  tableById: Record<string, any>
): ChainNode[] {
  // Group by target table ID
  const nodeMap: Record<string, ChainNode> = {};
  const nodeOrder: string[] = [];

  for (const dl of dotLookups) {
    const linkCol = colByName[dl.linkColName];
    if (!linkCol?.type || linkCol.type !== 'link' || !linkCol.data) continue;
    const targetTable = tableById[resolveOtherTableId(currentTable._id, linkCol.data)];
    if (!targetTable) continue;

    const tableKey = targetTable._id;
    if (!nodeMap[tableKey]) {
      nodeMap[tableKey] = {
        tableName: targetTable.name,
        tableRows: (targetTable.rows || []).length,
        columns: [],
        children: [],
      };
      nodeOrder.push(tableKey);
    }

    const targetCol = (targetTable.columns || []).find((c: any) => c.name === dl.targetColName);
    const colEntry: ChainColumn = {
      name: dl.targetColName,
      type: targetCol?.type || 'text',
    };
    // Deduplicate
    if (!nodeMap[tableKey].columns.some((c) => c.name === colEntry.name)) {
      nodeMap[tableKey].columns.push(colEntry);
    }
  }

  for (const lf of linkFuncs) {
    const linkCol = colByName[lf.linkColName];
    if (!linkCol?.type || linkCol.type !== 'link' || !linkCol.data) continue;
    const targetTable = tableById[resolveOtherTableId(currentTable._id, linkCol.data)];
    if (!targetTable) continue;

    const tableKey = targetTable._id;
    if (!nodeMap[tableKey]) {
      nodeMap[tableKey] = {
        tableName: targetTable.name,
        tableRows: (targetTable.rows || []).length,
        columns: [],
        children: [],
      };
      nodeOrder.push(tableKey);
    }

    const colEntry: ChainColumn = {
      name: `${lf.funcName}()`,
      type: 'link-formula',
    };
    if (!nodeMap[tableKey].columns.some((c) => c.name === colEntry.name)) {
      nodeMap[tableKey].columns.push(colEntry);
    }
  }

  // Sort columns within each node alphabetically
  for (const node of Object.values(nodeMap)) {
    node.columns.sort((a, b) => a.name.localeCompare(b.name));
  }

  return nodeOrder.map((k) => nodeMap[k]);
}

/**
 * Scan all tables for "candidate" formula / link-formula columns — those that look
 * suspicious based on heuristics (nested formulas, complex functions, large linked
 * tables, large row counts). Pure inventory: no timing, no sorting. Cost
 * measurement happens in a separate `measurePerColumnCost` pass so callers (and
 * progress reporting) can treat the two phases independently — on a customer
 * base of 75922 rows with ~50 formula columns, the scan is ~20s but the
 * subsequent cost measurement is ~70s.
 */
export async function scanCandidateColumns(
  onProgress?: (msg: string) => void,
  selectedTableIds?: string[] | null
): Promise<PerformanceCandidateColumn[]> {
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = dtableSDK.getTables();
  const tableById: Record<string, any> = {};
  for (const t of tables) tableById[t._id] = t;

  // tableById stays complete so chain construction can resolve references to
  // unselected tables (a selected formula may chain into an unselected one).
  const selectedSet =
    selectedTableIds && selectedTableIds.length > 0 ? new Set(selectedTableIds) : null;

  const candidates: PerformanceCandidateColumn[] = [];

  for (let ti = 0; ti < tables.length; ti++) {
    const table = tables[ti];
    if (selectedSet && !selectedSet.has(table._id)) continue;
    if (onProgress) {
      onProgress(`${table.name} (table ${ti + 1}/${tables.length})...`);
      await tick();
    }

    const columns: any[] = table.columns || [];
    const rowCount = (table.rows || []).length;

    // Compute formula results once per table, used for isMultiValue detection on candidates
    let formulaResults: any = null;
    const hasComputed = columns.some((c: any) => c.type === 'formula' || c.type === 'link-formula');
    if (hasComputed && rowCount > 0) {
      try {
        formulaResults = dtableSDK.getTableFormulaResults(table, table.rows || []);
      } catch {
        formulaResults = null;
      }
    }

    // Max linked records per row, keyed by link-column key. A lookup is only genuinely
    // multi-value when the underlying link has 2+ linked records for some row — otherwise
    // the result is one cell's worth (even if the cell itself is a multi-select array).
    let linkRowsResult: Record<string, Record<string, string[]>> | null = null;
    const hasLink = columns.some((c: any) => c.type === 'link');
    if (hasLink && rowCount > 0) {
      try {
        linkRowsResult = dtableSDK.getTableLinkRows(table.rows || [], table);
      } catch {
        linkRowsResult = null;
      }
    }

    // Build a map of column name → column for ref resolution
    const colByName: Record<string, any> = {};
    const colByKey: Record<string, any> = {};
    for (const c of columns) {
      colByName[c.name] = c;
      colByKey[c.key] = c;
    }

    for (const col of columns) {
      const labels: string[] = [];
      const isPrimaryColumn = col === columns[0];

      // --- Formula columns ---
      if (col.type === 'formula' && col.data?.formula) {
        const formulaText: string = col.data.formula;
        const refs = extractFormulaRefs(formulaText);

        // Check for references to other formula columns (nesting)
        const formulaRefs = refs.filter((name) => {
          const ref = colByName[name];
          return ref && (ref.type === 'formula' || ref.type === 'link-formula');
        });
        if (formulaRefs.length > 0) {
          // Count occurrences and format as "ColName x3" instead of repeating
          const refCounts: Record<string, number> = {};
          for (const name of formulaRefs) {
            refCounts[name] = (refCounts[name] || 0) + 1;
          }
          const refSummary = Object.entries(refCounts)
            .map(([name, count]) => (count > 1 ? `${name} - ${count} times` : name))
            .join(', ');
          labels.push(`nested formula (references: ${refSummary})`);
        }

        // Build chain from dot-lookups and link functions in formula
        const dotLookups = extractDotLookups(formulaText);
        const linkFuncs = extractLinkFunctions(formulaText);
        const chain = buildChainForFormula(dotLookups, linkFuncs, colByName, table, tableById);

        // Complex functions
        if (COMPLEX_FUNCTIONS.test(formulaText)) {
          labels.push('complex function (date/string operations)');
        }

        // Nested IF
        if (NESTED_IF.test(formulaText)) {
          labels.push('nested IF conditions');
        }

        // Even a simple formula on a large table is worth flagging
        if (labels.length === 0 && chain.length === 0 && rowCount > 1000) {
          labels.push(`formula on large table (${rowCount} rows)`);
        }

        if (labels.length > 0 || chain.length > 0) {
          const isMultiValue = formulaResults
            ? detectMultiValue(formulaResults, table, col.key)
            : false;
          const replacementType = computeReplacementType(col, colByKey, tableById, table);
          candidates.push({
            tableId: table._id,
            tableName: table.name,
            columnKey: col.key,
            columnName: col.name,
            columnType: 'formula',
            formulaType: 'formula',
            labels,
            chain,
            rowCount,
            isMultiValue,
            isPrimaryColumn,
            replacementType,
          });
        }
      }

      // --- Link-formula columns ---
      if (col.type === 'link-formula' && col.data) {
        const formulaType = col.data.formula || col.data.type || 'unknown';
        const dependsOnKey = col.data.link_column_key || '';
        const dependsOnCol = colByKey[dependsOnKey];

        if (dependsOnCol?.data) {
          const targetTable = tableById[resolveOtherTableId(table._id, dependsOnCol.data)];
          const targetRows = targetTable ? (targetTable.rows || []).length : 0;

          const targetColKey =
            col.data.level1_linked_table_column_key ||
            col.data.column_key_in_linked_record ||
            col.data.column_key_for_comparison ||
            '';

          const chain = buildChainForLinkFormula(
            dependsOnCol,
            targetColKey,
            table,
            tableById,
            col.data.level2_linked_table_column_key || undefined
          );

          // Flag large linked tables separately
          if (targetRows > 1000) {
            labels.push(`large linked table (${targetRows} rows)`);
          }

          // Always flag link-formulas (the chain itself is the reason)
          if (labels.length === 0 && chain.length === 0) {
            labels.push(formulaType);
          }

          // Only `lookup` can produce genuinely multi-value cells — countlinks / findmax /
          // findmin / rollup all collapse to a scalar (number or concatenated string)
          // regardless of how many records are linked.
          const isMultiValue =
            formulaType === 'lookup' && hasMultipleLinkedRecords(linkRowsResult, dependsOnKey);
          const replacementType = computeReplacementType(col, colByKey, tableById, table);
          candidates.push({
            tableId: table._id,
            tableName: table.name,
            columnKey: col.key,
            columnName: col.name,
            columnType: 'link-formula',
            formulaType,
            labels,
            chain,
            rowCount,
            isMultiValue,
            isPrimaryColumn,
            replacementType,
            dependsOnLinkColumnName: dependsOnCol.name,
          });
        }
      }
    }
  }

  return candidates;
}

/**
 * Group link-formula candidates by their compute signature, populating
 * `nearDuplicateGroup` on each member of any group of size >= 2. Two link-formula
 * columns are "near-duplicates" when they share:
 *   - formula kind (lookup / rollup / countlinks / findmax / findmin)
 *   - source link column (link_column_key)
 *   - source field(s) (level1_linked_table_column_key, level2 if nested)
 *   - aggregation key (summary_method for rollup; column_key_for_comparison for
 *     findmax/findmin)
 * They produce the same value per row at the same cost regardless of display
 * differences (result_type, array_type, format), so N-1 are wasted compute. Only
 * groups columns within the same table — cross-table dedup isn't a real
 * consolidation since columns can't be shared between tables in SeaTable.
 *
 * Mutates `candidates` in place; returns it for chaining.
 */
export function detectNearDuplicateLinkFormulas(
  candidates: PerformanceCandidateColumn[]
): PerformanceCandidateColumn[] {
  // Group keys: tableId → signature → members
  const groups = new Map<string, Map<string, PerformanceCandidateColumn[]>>();
  for (const c of candidates) {
    if (c.columnType !== 'link-formula') continue;
    const sig = computeLinkFormulaSignature(c);
    if (!sig) continue;
    let perTable = groups.get(c.tableId);
    if (!perTable) {
      perTable = new Map<string, PerformanceCandidateColumn[]>();
      groups.set(c.tableId, perTable);
    }
    const arr = perTable.get(sig) || [];
    arr.push(c);
    perTable.set(sig, arr);
  }

  Array.from(groups.values()).forEach((perTable) => {
    Array.from(perTable.values()).forEach((members: PerformanceCandidateColumn[]) => {
      if (members.length < 2) return;
      for (const m of members) {
        m.nearDuplicateGroup = members
          .filter((other) => other.columnKey !== m.columnKey)
          .map((other) => ({ columnKey: other.columnKey, columnName: other.columnName }));
      }
    });
  });

  return candidates;
}

/**
 * Build the compute signature for a link-formula candidate. Returns null when the
 * required fields can't be resolved (defensive — shouldn't happen for valid
 * link-formula candidates emitted by scanCandidateColumns, but guards against
 * partially-initialised columns from older base versions).
 *
 * Re-reads the column's `data` from the SDK because the candidate object only
 * carries `formulaType`, not the full data blob. Cheap — one map lookup per call.
 */
function computeLinkFormulaSignature(c: PerformanceCandidateColumn): string | null {
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = dtableSDK?.getTables?.() || [];
  const table = tables.find((t) => t._id === c.tableId);
  if (!table) return null;
  const col = (table.columns || []).find((x: any) => x.key === c.columnKey);
  if (!col || col.type !== 'link-formula' || !col.data) return null;

  const formula = col.data.formula || col.data.type || '';
  const linkKey = col.data.link_column_key || '';
  // countlinks doesn't read a source field — only the link itself matters.
  if (formula === 'countlinks') {
    return `countlinks|${linkKey}`;
  }
  const level1 =
    col.data.level1_linked_table_column_key ||
    col.data.column_key_in_linked_record ||
    '';
  const level2 = col.data.level2_linked_table_column_key || '';
  const summaryMethod = col.data.summary_method || '';
  const comparisonKey = col.data.column_key_for_comparison || '';
  // Empty source field → can't form a meaningful signature.
  if (!linkKey || (!level1 && !comparisonKey)) return null;
  return `${formula}|${linkKey}|${level1}|${level2}|${summaryMethod}|${comparisonKey}`;
}

/**
 * Per-column formula cost, in-isolation, median of 3.
 *
 * Calls `Views.getTableFormulaResults(table, rows, value, [col])` once per
 * formula/link-formula column, three times, taking the median. "Isolation" here means
 * we pass only that column — but dependency leakage still applies: if column A
 * references computed column B, computing A pulls B's compute along for the ride.
 * That's by design; it reflects what the editor actually pays when something touches
 * A (filter, sort, cell render). Ranking by this cost predicts where deletion /
 * replacement recovers the most compute.
 *
 * Typical wall time: a few ms per column on small tables, up to a few hundred ms on
 * large tables with nested lookups. Acceptable as part of the initial audit; too slow
 * for live feedback.
 */
export async function measurePerColumnCost(
  value: any,
  onProgress?: (msg: string) => void,
  selectedTableIds?: string[] | null
): Promise<Map<string, number>> {
  const Views = dtableStoreModule.Views;
  const result = new Map<string, number>();
  const tables: any[] = value.tables || [];
  const selectedSet =
    selectedTableIds && selectedTableIds.length > 0 ? new Set(selectedTableIds) : null;

  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    if (selectedSet && !selectedSet.has(t._id)) continue;
    const rows: any[] = t.rows || [];
    if (rows.length === 0) continue;
    const formulaCols = (t.columns || []).filter(
      (c: any) => c.type === 'formula' || c.type === 'link-formula'
    );
    if (!formulaCols.length) continue;

    if (onProgress) {
      onProgress(`${t.name} (table ${ti + 1}/${tables.length})...`);
      await tick();
    }

    for (const col of formulaCols) {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try {
          Views.getTableFormulaResults(t, rows, value, [col]);
        } catch {
          samples.push(NaN);
          continue;
        }
        samples.push(performance.now() - t0);
      }
      const clean = samples.filter((n) => !Number.isNaN(n));
      if (!clean.length) continue;
      result.set(`${t._id}:${col.key}`, +median(clean).toFixed(2));
    }
    await tick();
  }

  return result;
}

/**
 * Theoretical per-view compute cost, derived from the reproducible per-column cost
 * signal. For each view: cost = Σ (perColumnCostMs / tableRowCount × visibleRowCount)
 * over the view's *visible* computed columns (formula + link-formula minus
 * hidden_columns). Determinism is the point — anchors on cost-per-cell so view
 * weight no longer depends on the noisy single-pass `getViewRows` timing.
 *
 * Does NOT capture filter/sort/group cost. That's a known gap, recovered later by
 * residual analysis once the top-N HTTP measurements come back. Returns a Map keyed
 * by `${tableId}:${viewId}` → ms. Views with zero visible computed columns, zero
 * visible rows, or whose table has zero rows return undefined (left out of the map).
 */
export function computeTheoreticalViewCosts(
  costByKey: Map<string, number>,
  viewLoads: ViewLoadTiming[],
  value?: any
): Map<string, number> {
  const out = new Map<string, number>();
  // For sandbox before/after the caller passes a mutated clone of the live
  // value (with remediations applied); for the live audit we read the SDK's
  // current state. Either way, tables / columns / view definitions are read
  // off this value, so the cost reflects whatever schema is in scope.
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = value?.tables ?? dtableSDK?.getTables() ?? [];
  const tableById: Record<string, any> = {};
  for (const t of tables) tableById[t._id] = t;

  // Pre-index viewLoads so we can look up visibleRowCount by `${tableId}:${viewId}`
  // — saves rescanning the array for every view.
  const visibleRowsByKey = new Map<string, number>();
  for (const vl of viewLoads) {
    visibleRowsByKey.set(`${vl.tableId}:${vl.viewId}`, vl.rowCount);
  }

  for (const t of tables) {
    const tableRows = (t.rows || []).length;

    // Per-cell cost of each computed column in this table. Empty when the table has
    // zero rows (can't divide) or no computed columns at all — both legitimately
    // produce a theoretical cost of 0 for every view in this table.
    const perCellByColKey = new Map<string, number>();
    if (tableRows > 0) {
      for (const c of t.columns || []) {
        if (c.type !== 'formula' && c.type !== 'link-formula') continue;
        const total = costByKey.get(`${t._id}:${c.key}`);
        if (total === undefined) continue;
        perCellByColKey.set(c.key, total / tableRows);
      }
    }

    for (const v of t.views || []) {
      const viewKey = `${t._id}:${v._id}`;
      const visibleRows = visibleRowsByKey.get(viewKey);
      // No measurement for this view → can't compute. Skip (leaves theoreticalCostMs
      // undefined). Different from "0" which means definitively-zero compute cost.
      if (visibleRows === undefined) continue;

      // Definitively zero: empty view OR no measurable computed columns in the table.
      // Emit 0 explicitly so consumers see a present value rather than a missing one.
      if (visibleRows === 0 || perCellByColKey.size === 0) {
        out.set(viewKey, 0);
        continue;
      }

      // A column's compute cost in this view is incurred when it's *visible OR
      // referenced by any rule* (filter / sort / groupby / colorby / column_colors /
      // summary). Hiding a column doesn't save its cost when SeaTable still has to
      // compute its value to evaluate a filter or sort. Skipping the cost only for
      // columns that are both hidden AND not referenced is the honest accounting.
      const hidden = new Set<string>(v.hidden_columns || []);
      const referenced = getViewReferencedColumnKeys(v);
      let costMs = 0;
      perCellByColKey.forEach((perCell, colKey) => {
        if (hidden.has(colKey) && !referenced.has(colKey)) return;
        costMs += perCell * visibleRows;
      });
      // Round to 2 decimals to match other ms fields and keep spreadsheet diffs tidy.
      out.set(viewKey, +costMs.toFixed(2));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Sandbox lifecycle — copy base, benchmark, delete columns, re-benchmark
// ---------------------------------------------------------------------------

export async function createSandboxCopy(
  accountToken: string,
  onProgress?: (msg: string) => void
): Promise<{ copyName: string; copyUuid: string; copyWorkspaceId: number }> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  const workspaceId = config.workspaceID || config.workspace_id;
  const dtableName = config.dtableName || '';

  if (!serverUrl || !workspaceId || !accountToken) {
    throw new Error('Missing server URL, workspace ID, or account token');
  }

  if (onProgress) onProgress(`Creating sandbox copy of "${dtableName}"...`);

  // The POST /api/v2.1/dtable-copy/ "name" field identifies the SOURCE base (what to
  // copy from). SeaTable auto-generates the copy's name (usually "{name} copy" or
  // a numbered variant). To give the copy a custom name we rename it afterwards via
  // renameBase().
  const formData = new FormData();
  formData.append('src_workspace_id', String(workspaceId));
  formData.append('dst_workspace_id', String(workspaceId));
  formData.append('name', dtableName);

  const resp = await fetch(`${serverUrl}/api/v2.1/dtable-copy/`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accountToken}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to copy base (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const dtable = data.dtable || data;
  const copyName = dtable.name || dtableName;

  return {
    copyName,
    copyUuid: dtable.uuid,
    copyWorkspaceId: dtable.workspace_id || workspaceId,
  };
}

/**
 * Create a full sandbox copy — structure + rows + assets + scripts + automations —
 * by exporting the current base and importing the resulting file. Returns the same
 * shape as createSandboxCopy so the caller can branch on `fullCopy` without changing
 * its downstream plumbing.
 *
 * Slower than dtable-copy (the export/import round-trip includes packaging assets),
 * but preserves everything dtable-copy drops. Use when the sandbox needs scripts or
 * automations to produce realistic behavior.
 */
export async function createSandboxFullCopy(
  accountToken: string,
  onProgress?: (msg: string) => void
): Promise<{ copyName: string; copyUuid: string; copyWorkspaceId: number }> {
  const config = (window as any).dtable || {};
  const workspaceId = config.workspaceID || config.workspace_id;
  const dtableName = config.dtableName || '';

  if (!workspaceId || !accountToken) {
    throw new Error('Missing workspace ID or account token');
  }

  if (onProgress) onProgress(`Exporting "${dtableName}" (this may take a moment)...`);
  const blob = await exportBase(accountToken, workspaceId, dtableName, false);

  if (onProgress)
    onProgress(`Importing sandbox copy (${(blob.size / 1024 / 1024).toFixed(1)} MB)...`);
  const imported = await importBase(accountToken, workspaceId, blob);

  return {
    copyName: imported.name,
    copyUuid: imported.uuid,
    copyWorkspaceId: imported.workspaceId,
  };
}

/**
 * Rename a base in a workspace. Uses PUT /api/v2.1/workspace/{id}/dtable/ which takes
 * (name, new_name) — see SeaTable OpenAPI "Update Base". Used after createSandboxCopy
 * to give the auto-named copy a more descriptive name. Non-fatal — if the name is
 * already taken, the error is swallowed and the copy keeps its auto-generated name.
 */
export async function renameBase(
  accountToken: string,
  workspaceId: number,
  currentName: string,
  newName: string
): Promise<string> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  if (!serverUrl || !workspaceId || !accountToken) return currentName;
  const formData = new FormData();
  formData.append('name', currentName);
  formData.append('new_name', newName);
  try {
    const resp = await fetch(`${serverUrl}/api/v2.1/workspace/${workspaceId}/dtable/`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accountToken}`,
      },
      body: formData,
    });
    if (!resp.ok) return currentName;
    const data = await resp.json();
    const renamed = data.table?.name || data.dtable?.name || newName;
    return renamed;
  } catch {
    return currentName;
  }
}

/**
 * Delete a base in a workspace. Uses DELETE /api/v2.1/workspace/{id}/dtable/ with a
 * `name` form field (the base's current name). Used when the user overwrites an
 * existing sandbox — we destroy the old one before creating the replacement.
 * Returns true on success. Soft-fails (returns false) if the request fails so the
 * caller can decide whether to continue with the create step.
 */
/**
 * Export a base as a `.dtable` zip blob, via the synchronous-export endpoint.
 * Returns a Blob that can be fed directly to importBase. Includes assets/scripts/
 * automations by default (pass `ignoreAssets: true` if you need a structure-only
 * dump instead). Used by createSandboxFullCopy — the export/import path produces a
 * complete clone, unlike dtable-copy which only duplicates tables+rows.
 */
export async function exportBase(
  accountToken: string,
  workspaceId: number,
  baseName: string,
  ignoreAssets: boolean = false
): Promise<Blob> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  const url =
    `${serverUrl}/api/v2.1/workspace/${workspaceId}/synchronous-export/export-dtable/` +
    `?dtable_name=${encodeURIComponent(baseName)}` +
    (ignoreAssets ? '&ignore_asset=true' : '');
  const resp = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accountToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to export base (${resp.status}): ${text}`);
  }
  return await resp.blob();
}

/**
 * Import a `.dtable` blob into the given workspace. Returns the created base's
 * identifying info. The response's `table` field carries the new base immediately,
 * though asset ingestion may continue in the background keyed by `task_id`. For our
 * sandbox purposes the base is usable right away; we don't poll the task.
 */
export async function importBase(
  accountToken: string,
  workspaceId: number,
  blob: Blob
): Promise<{ name: string; uuid: string; workspaceId: number }> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  const formData = new FormData();
  formData.append('dtable', blob, 'sandbox.dtable');
  const resp = await fetch(`${serverUrl}/api/v2.1/workspace/${workspaceId}/import-dtable/`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accountToken}`,
    },
    body: formData,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to import base (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  const table = data.table || data;
  return {
    name: table.name,
    uuid: table.uuid,
    workspaceId: table.workspace_id || workspaceId,
  };
}

export async function deleteBase(
  accountToken: string,
  workspaceId: number,
  baseName: string
): Promise<boolean> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  if (!serverUrl || !workspaceId || !accountToken) return false;
  const formData = new FormData();
  formData.append('name', baseName);
  try {
    const resp = await fetch(`${serverUrl}/api/v2.1/workspace/${workspaceId}/dtable/`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accountToken}`,
      },
      body: formData,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Direct PUT of a view's hidden_columns on the original base. Replaces (does not
 * merge) the field, so caller must supply the full desired array. Used by the
 * "Apply visibility changes" action in TableTab when the user finishes editing
 * sliders and wants the change live without going through the test workflow.
 */
export async function setViewHiddenColumnsDirect(
  tableName: string,
  viewName: string,
  hiddenColumns: string[]
): Promise<boolean> {
  const auth = await getAuthContext();
  if (!auth) return false;
  const { serverUrl, dtableUuid, accessToken } = auth;
  try {
    const resp = await fetch(
      `${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/views/${encodeURIComponent(viewName)}/?table_name=${encodeURIComponent(tableName)}`,
      {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ hidden_columns: hiddenColumns }),
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function getSandboxToken(
  accountToken: string,
  workspaceId: number,
  baseName: string
): Promise<string> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';

  const resp = await fetch(
    `${serverUrl}/api/v2.1/workspace/${workspaceId}/dtable/${encodeURIComponent(baseName)}/access-token/`,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accountToken}`,
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to get sandbox token (${resp.status})`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Poll the api-gateway metadata endpoint until it returns 200 for the given uuid.
 *
 * SeaTable's `/api/v2.1/.../import-dtable/` and `/api/v2.1/dtable-copy/` create a
 * base record synchronously but the api-gateway (dtable-server-backed) loads it
 * asynchronously. `getSandboxToken` returns successfully as soon as the workspace
 * record exists, but subsequent api-gateway PUT/DELETE calls 404 until the
 * dtable-server cache has the new base. This poll bridges the gap.
 */
export async function waitForApiGatewayReady(
  uuid: string,
  accessToken: string,
  onProgress?: (msg: string) => void,
  maxAttempts: number = 15,
  delayMs: number = 1500
): Promise<void> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  for (let i = 0; i < maxAttempts; i++) {
    if (onProgress) {
      onProgress(
        i === 0
          ? 'Waiting for sandbox to be ready...'
          : `Waiting for sandbox to be ready (attempt ${i + 1}/${maxAttempts})...`
      );
    }
    try {
      const resp = await fetch(
        `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
        }
      );
      if (resp.ok) return;
      // Anything other than 404 likely means the gateway is reachable but the
      // request was malformed — bail rather than spam the loop.
      if (resp.status !== 404) {
        const bodyText = await resp.text().catch(() => '');
        throw new Error(`api-gateway metadata ${resp.status}: ${bodyText}`);
      }
    } catch (err: any) {
      // If we threw above (non-404 status), surface immediately.
      if (err?.message?.startsWith('api-gateway metadata')) throw err;
      // Otherwise treat as transient and continue polling.
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Sandbox not visible to api-gateway after ${maxAttempts} attempts (~${(maxAttempts * delayMs) / 1000}s).`
  );
}

// ---------------------------------------------------------------------------
// Apply remediations to a base (original or a remote copy).
//   - Column-level ops (delete, modify type, set data) use SDK for 'original' and
//     HTTP for 'remote'.
//   - View-level cleanups use HTTP for both (the SDK update* methods are hard-coded
//     to the store's currently-active view, so can't target arbitrary views).
//   - Link-formula condition / link row-filter cleanups use setColumnData on the SDK
//     for 'original'; skipped on 'remote' (there's no HTTP endpoint for editing raw
//     col.data, and sandboxes are throwaway — stale conditions are cosmetic).
// All cleanup payloads are built from `dtableSDK.dtableStore.value` since a sandbox
// is a copy of exactly that state at the moment it was made.
// ---------------------------------------------------------------------------

export type ApplyTarget =
  | { kind: 'original' }
  | { kind: 'remote'; accessToken: string; dtableUuid: string };

async function applyViewCleanupsHttp(
  accessToken: string,
  dtableUuid: string,
  updates: { tableName: string; viewName: string; viewPayload: any }[],
  onProgress?: (msg: string) => void
): Promise<void> {
  if (updates.length === 0) return;
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  for (const u of updates) {
    if (onProgress) {
      onProgress(`Cleaning up view "${u.viewName}" in ${u.tableName}...`);
    }
    const resp = await fetch(
      `${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/views/${encodeURIComponent(u.viewName)}/?table_name=${encodeURIComponent(u.tableName)}`,
      {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(u.viewPayload),
      }
    );
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.warn(
        `[performance-audit] view cleanup "${u.viewName}" in ${u.tableName}: HTTP ${resp.status} ${bodyText}`
      );
    }
  }
}

export async function applyRemediationsToBase(
  target: ApplyTarget,
  remediations: RemediatedColumn[],
  onProgress?: (msg: string) => void,
  viewsToDelete?: Array<{ tableName: string; viewName: string }>,
  remediationHides?: RemediatedColumnHide[]
): Promise<{ applied: number; failed: number; errors: string[] }> {
  const dtableSDK = (window as any).dtableSDK;
  const sdkTables: any[] = dtableSDK.getTables();
  const sdkTablesById: Record<string, any> = {};
  const sdkTableIdByName: Record<string, string> = {};
  for (const t of sdkTables) {
    sdkTablesById[t._id] = t;
    sdkTableIdByName[t.name] = t._id;
  }

  const isOriginal = target.kind === 'original';
  const remoteToken = target.kind === 'remote' ? target.accessToken : '';
  const remoteUuid = target.kind === 'remote' ? target.dtableUuid : '';
  // For original-base operations, resolve auth via the canonical helper (production:
  // window.dtable; dev: explicit token exchange via APIToken). One call; reused for
  // all sub-operations below.
  const originalAuth = isOriginal ? await getAuthContext() : null;
  const serverUrl = originalAuth?.serverUrl || (window as any).dtable?.server || '';

  const errors: string[] = [];
  let applied = 0;
  let failed = 0;

  // -------- 1. Prepare deleted-keys sets per table (for cleanup payload building)
  const deletedKeysByTableId: Record<string, Set<string>> = {};
  for (const r of remediations) {
    if (r.action !== 'delete') continue;
    const tId = sdkTableIdByName[r.tableName];
    if (!tId) continue;
    (deletedKeysByTableId[tId] ??= new Set()).add(r.columnKey);
  }

  // -------- 2. Build view-cleanup payloads from each affected view
  // One update per (tableName, viewName), merging cleanups across all deletions.
  const viewUpdates: {
    tableName: string;
    viewName: string;
    viewPayload: any;
  }[] = [];
  const viewSeen = new Set<string>();
  for (const r of remediations) {
    if (r.action !== 'delete' || !r.affectedRules) continue;
    for (const rule of r.affectedRules) {
      if (!rule.kind.startsWith('view-')) continue;
      const key = `${rule.tableName}::${rule.viewName || ''}`;
      if (viewSeen.has(key)) continue;
      viewSeen.add(key);
      const tbl = sdkTablesById[rule.tableId];
      if (!tbl) continue;
      const view = (tbl.views || []).find((v: any) => v._id === rule.viewId);
      if (!view) continue;
      const delKeys = deletedKeysByTableId[rule.tableId] || new Set<string>();
      const cleaned = cleanupView(view, delKeys);
      viewUpdates.push({
        tableName: rule.tableName,
        viewName: rule.viewName || view.name,
        viewPayload: {
          filters: cleaned.filters,
          filter_conjunction: cleaned.filter_conjunction,
          sorts: cleaned.sorts,
          groupbys: cleaned.groupbys,
          hidden_columns: cleaned.hidden_columns,
        },
      });
    }
  }

  // -------- 3. Build column-data cleanups for link-formula conditions and link row-filters
  // One update per owning column. Both kinds apply to col.data; we compute the full new
  // data object then call setColumnData (SDK) or skip (remote).
  const colDataCleanups: {
    tableId: string;
    tableName: string;
    columnKey: string;
    columnName: string;
    newData: any;
  }[] = [];
  const colSeen = new Set<string>();
  for (const r of remediations) {
    if (r.action !== 'delete' || !r.affectedRules) continue;
    for (const rule of r.affectedRules) {
      if (
        rule.kind !== 'link-formula-condition' &&
        rule.kind !== 'link-row-filter-static' &&
        rule.kind !== 'link-row-filter-dynamic'
      )
        continue;
      const ownerKey = `${rule.tableId}:${rule.ownerColumnKey || ''}`;
      if (colSeen.has(ownerKey)) continue;
      colSeen.add(ownerKey);

      const ownerTable = sdkTablesById[rule.tableId];
      if (!ownerTable) continue;
      const ownerCol = (ownerTable.columns || []).find((c: any) => c.key === rule.ownerColumnKey);
      if (!ownerCol?.data) continue;

      // Deleted keys in THIS table (where the link/link-formula column lives) vs the LINKED table
      const thisTableDeleted = deletedKeysByTableId[rule.tableId] || new Set<string>();
      let linkedTableId: string | undefined;
      if (ownerCol.type === 'link') {
        linkedTableId = resolveOtherTableId(rule.tableId, ownerCol.data);
      } else if (ownerCol.type === 'link-formula') {
        const linkCol = (ownerTable.columns || []).find(
          (c: any) => c.key === ownerCol.data.link_column_key
        );
        if (linkCol?.data) linkedTableId = resolveOtherTableId(rule.tableId, linkCol.data);
      }
      const linkedTableDeleted = linkedTableId
        ? deletedKeysByTableId[linkedTableId] || new Set<string>()
        : new Set<string>();

      let newData = ownerCol.data;
      if (ownerCol.type === 'link-formula') {
        newData = cleanupLinkFormulaData(newData, linkedTableDeleted);
      } else if (ownerCol.type === 'link') {
        newData = cleanupLinkRowFilterData(newData, thisTableDeleted, linkedTableDeleted);
      }
      if (newData !== ownerCol.data) {
        colDataCleanups.push({
          tableId: rule.tableId,
          tableName: rule.tableName,
          columnKey: rule.ownerColumnKey || '',
          columnName: rule.ownerColumnName || '',
          newData,
        });
      }
    }
  }

  // -------- 4. Apply view cleanups (HTTP for both kinds)
  // Skip cleanup for views that are about to be deleted entirely — PUT then DELETE
  // wastes a round-trip and can error if the cleanup leaves the view in an invalid state.
  const toDeleteSet = new Set((viewsToDelete || []).map((v) => `${v.tableName}::${v.viewName}`));
  const effectiveViewUpdates = viewUpdates.filter(
    (u) => !toDeleteSet.has(`${u.tableName}::${u.viewName}`)
  );
  if (effectiveViewUpdates.length > 0) {
    const token = isOriginal ? originalAuth?.accessToken : remoteToken;
    const uuid = isOriginal ? originalAuth?.dtableUuid : remoteUuid;
    if (token && uuid) {
      try {
        await applyViewCleanupsHttp(token, uuid, effectiveViewUpdates, onProgress);
      } catch (e: any) {
        errors.push(`view cleanup: ${e?.message || e}`);
      }
    }
  }

  // -------- 4b. Delete views entirely (user-opt-in for views that become rule-less)
  if (viewsToDelete && viewsToDelete.length > 0) {
    if (isOriginal) {
      for (const v of viewsToDelete) {
        if (onProgress) onProgress(`Deleting view "${v.viewName}" in ${v.tableName}...`);
        try {
          dtableSDK.deleteView(v.tableName, v.viewName);
        } catch (e: any) {
          errors.push(`deleteView "${v.viewName}": ${e?.message || e}`);
        }
      }
    } else {
      for (const v of viewsToDelete) {
        if (onProgress) onProgress(`Deleting view "${v.viewName}" in ${v.tableName}...`);
        try {
          const resp = await fetch(
            `${serverUrl}/api-gateway/api/v2/dtables/${remoteUuid}/views/${encodeURIComponent(v.viewName)}/?table_name=${encodeURIComponent(v.tableName)}`,
            {
              method: 'DELETE',
              headers: {
                accept: 'application/json',
                authorization: `Bearer ${remoteToken}`,
              },
            }
          );
          if (!resp.ok) {
            const bodyText = await resp.text().catch(() => '');
            const msg = `delete view "${v.viewName}": HTTP ${resp.status} ${bodyText}`;
            // eslint-disable-next-line no-console
            console.warn('[performance-audit]', msg);
            errors.push(msg);
          }
        } catch (e: any) {
          errors.push(`delete view "${v.viewName}": ${e?.message || e}`);
        }
      }
    }
  }

  // -------- 4c. Hide-in-view remediation (PUT view's hidden_columns)
  // Group staged hides by (tableName, viewId) so one PUT carries all columns
  // staged for that view. Skip views that are about to be deleted entirely
  // (already excluded from cleanup at step 4 via the same toDeleteSet).
  if (remediationHides && remediationHides.length > 0) {
    const hideToken = isOriginal ? originalAuth?.accessToken : remoteToken;
    const hideUuid = isOriginal ? originalAuth?.dtableUuid : remoteUuid;
    if (hideToken && hideUuid) {
      type HideUpdate = {
        tableName: string;
        viewName: string;
        viewId: string;
        columnKeys: Set<string>;
      };
      const byViewKey: Record<string, HideUpdate> = {};
      for (const h of remediationHides) {
        for (const v of h.views) {
          const k = `${h.tableName}::${v.viewId}`;
          if (!byViewKey[k]) {
            byViewKey[k] = {
              tableName: h.tableName,
              viewName: v.viewName,
              viewId: v.viewId,
              columnKeys: new Set<string>(),
            };
          }
          byViewKey[k].columnKeys.add(h.columnKey);
        }
      }

      for (const u of Object.values(byViewKey)) {
        if (toDeleteSet.has(`${u.tableName}::${u.viewName}`)) continue;
        // Look up the current view to merge with its existing hidden_columns —
        // the PUT replaces the field, so we must include the prior keys.
        const tbl = sdkTables.find((t: any) => t.name === u.tableName);
        const view = (tbl?.views || []).find((vv: any) => vv._id === u.viewId);
        const currentHidden: string[] = view?.hidden_columns || [];
        const mergedSet = new Set<string>(currentHidden);
        u.columnKeys.forEach((k) => mergedSet.add(k));
        const merged = Array.from(mergedSet);
        if (onProgress) {
          onProgress(`Hiding columns in view "${u.viewName}" of ${u.tableName}...`);
        }
        try {
          const resp = await fetch(
            `${serverUrl}/api-gateway/api/v2/dtables/${hideUuid}/views/${encodeURIComponent(u.viewName)}/?table_name=${encodeURIComponent(u.tableName)}`,
            {
              method: 'PUT',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${hideToken}`,
              },
              body: JSON.stringify({ hidden_columns: merged }),
            }
          );
          if (resp.ok) {
            applied += u.columnKeys.size;
          } else {
            const bodyText = await resp.text().catch(() => '');
            const msg = `hide columns in view "${u.viewName}": HTTP ${resp.status} ${bodyText}`;
            // eslint-disable-next-line no-console
            console.warn('[performance-audit]', msg);
            errors.push(msg);
            failed += u.columnKeys.size;
          }
        } catch (e: any) {
          errors.push(`hide in view "${u.viewName}": ${e?.message || e}`);
          failed += u.columnKeys.size;
        }
      }
    }
  }

  // -------- 5. Apply column-data cleanups (SDK for original; skipped for remote)
  if (isOriginal && colDataCleanups.length > 0) {
    for (const c of colDataCleanups) {
      if (onProgress) {
        onProgress(`Updating column "${c.columnName}" in ${c.tableName}...`);
      }
      try {
        const tableIndex = sdkTables.findIndex((t: any) => t._id === c.tableId);
        if (tableIndex >= 0) {
          dtableSDK.dtableStore.setColumnData(tableIndex, c.columnKey, c.newData);
        }
      } catch (e: any) {
        errors.push(`setColumnData ${c.columnName}: ${e?.message || e}`);
      }
    }
  }

  // -------- 6. Apply the remediations themselves
  for (const r of remediations) {
    if (onProgress) {
      onProgress(
        r.action === 'replace-static'
          ? `Replacing ${r.columnName} in ${r.tableName}...`
          : `Deleting ${r.columnName} in ${r.tableName}...`
      );
    }

    try {
      if (r.action === 'replace-static') {
        if (!r.replacementType) {
          failed++;
          continue;
        }
        if (isOriginal) {
          const tableIndex = sdkTables.findIndex((t: any) => t.name === r.tableName);
          if (tableIndex < 0) {
            failed++;
            continue;
          }
          dtableSDK.dtableStore.modifyColumnType(
            tableIndex,
            r.columnKey,
            r.replacementType.type,
            r.replacementType.data
          );
        } else {
          const resp = await fetch(
            `${serverUrl}/api-gateway/api/v2/dtables/${remoteUuid}/columns/`,
            {
              method: 'PUT',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${remoteToken}`,
              },
              body: JSON.stringify({
                op_type: 'modify_column_type',
                table_name: r.tableName,
                column: r.columnKey,
                new_column_type: r.replacementType.type,
                column_data: r.replacementType.data,
              }),
            }
          );
          if (!resp.ok) {
            const bodyText = await resp.text().catch(() => '');
            const msg = `modify_column_type ${r.columnName}: HTTP ${resp.status} ${bodyText}`;
            // eslint-disable-next-line no-console
            console.warn('[performance-audit]', msg);
            failed++;
            errors.push(msg);
            continue;
          }
        }
      } else {
        // delete
        if (isOriginal) {
          const tableIndex = sdkTables.findIndex((t: any) => t.name === r.tableName);
          if (tableIndex < 0) {
            failed++;
            continue;
          }
          const tbl = sdkTables[tableIndex];
          const col = (tbl.columns || []).find((c: any) => c.key === r.columnKey);
          if (!col) {
            failed++;
            continue;
          }
          dtableSDK.dtableStore.deleteColumn(tableIndex, col.key, col);
        } else {
          const resp = await fetch(
            `${serverUrl}/api-gateway/api/v2/dtables/${remoteUuid}/columns/`,
            {
              method: 'DELETE',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${remoteToken}`,
              },
              body: JSON.stringify({
                table_name: r.tableName,
                column: r.columnKey,
              }),
            }
          );
          if (!resp.ok) {
            const bodyText = await resp.text().catch(() => '');
            const msg = `delete ${r.columnName}: HTTP ${resp.status} ${bodyText}`;
            // eslint-disable-next-line no-console
            console.warn('[performance-audit]', msg);
            failed++;
            errors.push(msg);
            continue;
          }
        }
      }
      applied++;
    } catch (e: any) {
      failed++;
      errors.push(`${r.action} ${r.columnName}: ${e?.message || e}`);
    }
  }

  return { applied, failed, errors };
}

// ---------------------------------------------------------------------------
// 4. Full audit: detect candidates + view sizes + row archival
// (no sandbox — that's UI-driven; no headline benchmark — absolute ms is
// machine-dependent and we only show before/after deltas in tests)
// ---------------------------------------------------------------------------

export async function runPerformanceAudit(
  onProgress?: (msg: string) => void,
  rowArchivalThresholdDays: number = 730,
  // Subset of table IDs to audit. Undefined / null / empty = audit all tables.
  // When provided, only the listed tables produce candidates, view weights, or
  // archival output. The cross-table link scan inside archival still walks all
  // tables (a non-selected table can reference a selected one).
  selectedTableIds?: string[] | null
): Promise<PerformanceAuditResult> {
  const TOTAL_STEPS = 4;
  const stepOnProgress = (step: number, label: string) => (msg: string) => {
    if (onProgress) onProgress(`Step ${step}/${TOTAL_STEPS} — ${label}: ${msg}`);
  };

  const dtableSDK = (window as any).dtableSDK;

  // ---- Step 1: Inventory candidate formula columns (heuristic scan) ----
  // Pure structural analysis — formula text, link chains, row counts.
  // No timing here; that's step 2. Roughly ~20s on a 75922-row, 50-formula base.
  const step1 = stepOnProgress(1, 'Scanning formulas');
  step1('Inventorying formula columns...');
  await tick();
  const candidates = await scanCandidateColumns(step1, selectedTableIds);

  // Attach affected-rule references to each candidate so the UI can surface "used by N
  // rule(s)" upfront (before the user commits to a test). One scan, all candidates.
  const refIndex = scanColumnReferences(dtableSDK.dtableStore.value);
  for (const c of candidates) {
    const rules = refIndex.get(`${c.tableId}:${c.columnKey}`);
    if (rules && rules.length > 0) c.affectedRules = rules;
  }

  // Identify groups of link-formula columns with identical compute signatures
  // (same formula, link, source field(s), aggregation). Surfaces as a label on
  // each member so the user can stage all-but-one for deletion via the existing
  // delete-column remediation path.
  detectNearDuplicateLinkFormulas(candidates);

  // ---- Step 2: Measure per-column formula cost (median-of-3 timing) ----
  // The expensive phase on large bases — typically the longest single step.
  // Each formula/link-formula column gets `getTableFormulaResults` called 3
  // times, median taken to dampen noise. Output feeds both the candidate
  // "Cost" column in the UI and the theoretical view-weight rollup in step 3.
  const step2 = stepOnProgress(2, 'Measuring formula cost');
  step2('Timing each formula column...');
  await tick();
  const costByKey = await measurePerColumnCost(
    dtableSDK.dtableStore.value,
    step2,
    selectedTableIds
  );
  for (const c of candidates) {
    const cost = costByKey.get(`${c.tableId}:${c.columnKey}`);
    if (cost !== undefined) c.measuredCostMs = cost;
  }
  // Sort: measured cost desc, then row count desc. Defensive on missing cost.
  candidates.sort((a, b) => {
    const ca = a.measuredCostMs ?? -1;
    const cb = b.measuredCostMs ?? -1;
    if (ca !== cb) return cb - ca;
    return b.rowCount - a.rowCount;
  });

  // ---- Step 3: Compute per-view weights (count rows + theoretical rollup) ----
  // Counts only — no wall-clock timing. The previous getViewRows-timing path
  // was abandoned: HTTP correlation R²~0.1 made it useless as a UX predictor,
  // and the recompute cost was minutes on large bases. See
  // project_validation_decision_pending.md for the migration rationale.
  const step3 = stepOnProgress(3, 'Computing view weights');
  step3('Counting visible rows per view...');
  await tick();
  const viewLoads = await countViewRows(
    dtableSDK.dtableStore.value,
    step3,
    'Counting view rows',
    selectedTableIds
  );

  // Theoretical per-view cost from per-column compute × visible rows. Cheap rollup
  // (no extra measurement), deterministic, anchored on the reproducible per-column
  // median. Excludes hidden columns; doesn't capture filter/sort/group cost — that's
  // an accepted gap (no reliable signal for it on SeaTable's client-side compute model).
  const theoreticalByKey = computeTheoreticalViewCosts(costByKey, viewLoads);

  const views: PerformanceAuditView[] = viewLoads
    .map((v) => {
      const cost = theoreticalByKey.get(`${v.tableId}:${v.viewId}`) ?? 0;
      return {
        tableId: v.tableId,
        tableName: v.tableName,
        viewId: v.viewId,
        viewName: v.viewName,
        rowCount: v.rowCount,
        privateFor: v.privateFor ?? null,
        // `loadMs` and `theoreticalCostMs` carry the same value now that wall-clock
        // timing is retired. Both populated for backwards-compat with consumers that
        // still read `loadMs` (UI weight, test delta).
        loadMs: cost,
        theoreticalCostMs: cost,
      };
    })
    .sort((a, b) => b.loadMs - a.loadMs);

  // ---- Step 4: Find archivable rows (stale rows + incoming-link safety scan) ----
  const step4 = stepOnProgress(4, 'Finding archivable rows');
  step4('Scanning row staleness and incoming links...');
  await tick();
  const archival = await measureRowArchival(rowArchivalThresholdDays, step4, selectedTableIds);

  return {
    candidates,
    views,
    archival,
    costByKey,
  };
}

/**
 * Diagnostic tag for a candidate column based on its cost-per-row vs. the median
 * cost-per-row across all candidates:
 *   - 'structural' → costPerRow >= 2× median. Formula is intrinsically expensive.
 *     Even on small tables it'll bite; gets worse linearly as the table grows.
 *     Action: rewrite the formula.
 *   - 'volume' → costPerRow <= 0.5× median AND total share >= 5%. Formula is
 *     fine per row but appears in the candidates because the table has many rows.
 *     Action: archive/filter rows.
 *   - null → either similar to median, or share is too small to bother tagging.
 *
 * Median + multiplier (vs. percentiles) means tags only fire when there's real
 * spread in costPerRow — if all candidates are similar, no misleading labels.
 *
 * Returns a map keyed by `${tableId}:${columnKey}` so callers can look up a
 * candidate's tag without re-deriving the median context.
 */
export function computeCostPerRowTags(
  candidates: PerformanceCandidateColumn[],
  archival: PerformanceAuditTableArchival[]
): Map<string, 'structural' | 'volume'> {
  const tags = new Map<string, 'structural' | 'volume'>();
  if (!candidates || candidates.length === 0) return tags;

  const totalCostMs = candidates.reduce((s, c) => s + (c.measuredCostMs || 0), 0);
  if (totalCostMs <= 0) return tags;

  const rowsByTableId = new Map<string, number>();
  for (const a of archival || []) rowsByTableId.set(a.tableId, a.totalRows);

  // Per-candidate cost/row, skipping those without usable row count or cost.
  type Sample = { key: string; cprow: number; sharePct: number };
  const samples: Sample[] = [];
  for (const c of candidates) {
    const rows = rowsByTableId.get(c.tableId);
    if (!rows || rows <= 0) continue;
    const cost = c.measuredCostMs || 0;
    if (cost <= 0) continue;
    samples.push({
      key: `${c.tableId}:${c.columnKey}`,
      cprow: cost / rows,
      sharePct: (cost / totalCostMs) * 100,
    });
  }
  if (samples.length === 0) return tags;

  const sorted = [...samples].map((s) => s.cprow).sort((a, b) => a - b);
  const medianCpRow = sorted[Math.floor(sorted.length / 2)];
  if (medianCpRow <= 0) return tags;

  const STRUCTURAL_MULT = 2;
  const VOLUME_MULT = 0.5;
  const VOLUME_MIN_SHARE = 5;

  for (const s of samples) {
    if (s.cprow >= STRUCTURAL_MULT * medianCpRow) {
      tags.set(s.key, 'structural');
    } else if (s.cprow <= VOLUME_MULT * medianCpRow && s.sharePct >= VOLUME_MIN_SHARE) {
      tags.set(s.key, 'volume');
    }
  }
  return tags;
}

/**
 * Per-table row-archival analysis.
 *
 * For each table:
 *   1. Count rows where both `_ctime` AND `_mtime` are older than `thresholdDays`.
 *      AND-condition matters: rows with old ctime but recent mtime are still active
 *      (someone keeps editing them), not archival candidates.
 *   2. Cross-table incoming-link scan — for every other table that has link columns
 *      pointing to this one, walk each row's link cells to build the set of "ever
 *      referenced" row IDs in this table. Candidates not in that set are the
 *      "no incoming links" subset — safest to archive without breaking references.
 *   3. Detect existing `ctime` / `mtime` column types so the "Create archival view"
 *      action can decide whether it can build a filter without schema modification.
 *
 * Cost: O(totalRows + sum_over_tables(rows × linkColumns)). Acceptable within the
 * Performance audit's overall budget for typical bases.
 */
async function measureRowArchival(
  thresholdDays: number,
  onProgress?: (msg: string) => void,
  selectedTableIds?: string[] | null
): Promise<PerformanceAuditTableArchival[]> {
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = dtableSDK.getTables();
  // Step 1 (incoming-link scan) walks ALL tables — an unselected table can
  // still reference a selected one, and the safety subset depends on it.
  // Step 2 only emits archival counts for selected tables.
  const selectedSet =
    selectedTableIds && selectedTableIds.length > 0 ? new Set(selectedTableIds) : null;
  const thresholdMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const thresholdDateISO = new Date(thresholdMs).toISOString();

  // --- 1. Build incoming-link index: tableId → Set<rowId> ever referenced ---
  // A link column in table X with data.table_id / other_table_id tells us which tables
  // it connects. Cell values in a link column are arrays of linked row IDs.
  const incomingLinkedRowIds: Record<string, Set<string>> = {};
  for (const t of tables) incomingLinkedRowIds[t._id] = new Set<string>();

  for (let si = 0; si < tables.length; si++) {
    const srcTable = tables[si];
    if (onProgress) {
      onProgress(
        `Scanning incoming links from ${srcTable.name} (table ${si + 1}/${tables.length})...`
      );
      await tick();
    }
    const linkCols = (srcTable.columns || []).filter((c: any) => c.type === 'link');
    if (linkCols.length === 0) continue;
    const rows: any[] = srcTable.rows || [];
    for (const col of linkCols) {
      const data = col.data || {};
      // A link in srcTable points at the *other* side of the relation. If data.table_id
      // equals srcTable._id, other_table_id is the target; otherwise data.table_id is.
      const targetTableId = data.table_id === srcTable._id ? data.other_table_id : data.table_id;
      if (!targetTableId || !incomingLinkedRowIds[targetTableId]) continue;
      const targetSet = incomingLinkedRowIds[targetTableId];
      for (const row of rows) {
        const val = row[col.key];
        // Link cell values are arrays of row-ID strings (or objects with row_id in
        // some SeaTable versions — handle both).
        if (!Array.isArray(val)) continue;
        for (const entry of val) {
          if (typeof entry === 'string') targetSet.add(entry);
          else if (entry && typeof entry === 'object' && entry.row_id) targetSet.add(entry.row_id);
        }
      }
    }
  }

  // --- 2. Per-table count of archival candidates + safe subset ---
  const out: PerformanceAuditTableArchival[] = [];
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    if (selectedSet && !selectedSet.has(t._id)) continue;
    if (onProgress) {
      onProgress(`Scanning rows in ${t.name} (table ${ti + 1}/${tables.length})...`);
      await tick();
    }
    const rows: any[] = t.rows || [];
    const totalRows = rows.length;

    // Find ctime/mtime column keys if present. These are SeaTable column TYPES that
    // surface the built-in _ctime/_mtime fields; when present, user-visible filters
    // can reference them.
    const ctimeCol = (t.columns || []).find((c: any) => c.type === 'ctime');
    const mtimeCol = (t.columns || []).find((c: any) => c.type === 'mtime');

    // Threshold comparison uses the raw _ctime / _mtime metadata (always present
    // regardless of whether a display column exists). They're ISO-like strings, so
    // a lexicographic compare against a reference ISO string works.
    let candidateCount = 0;
    let candidateCountNoIncomingLinks = 0;
    const referencedRowIds = incomingLinkedRowIds[t._id] || new Set<string>();
    for (const row of rows) {
      const c = row._ctime || '';
      const m = row._mtime || '';
      // Skip rows missing either timestamp — can't decide, treat as not a candidate.
      if (!c || !m) continue;
      if (c <= thresholdDateISO && m <= thresholdDateISO) {
        candidateCount++;
        if (!referencedRowIds.has(row._id)) {
          candidateCountNoIncomingLinks++;
        }
      }
    }

    out.push({
      tableId: t._id,
      tableName: t.name,
      totalRows,
      candidateCount,
      candidateCountNoIncomingLinks,
      ctimeColumnKey: ctimeCol?.key,
      mtimeColumnKey: mtimeCol?.key,
      thresholdDate: thresholdDateISO,
    });
    await tick();
  }

  out.sort((a, b) => b.candidateCount - a.candidateCount);
  return out;
}
