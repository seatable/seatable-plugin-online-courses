import React, { useEffect, useMemo, useState } from 'react';
import intl from 'react-intl-universal';
import {
  ColumnAuditInfo,
  TableAuditResult,
  PerformanceAuditResult,
  RemediationAction,
  RemediatedView,
  RemediatedColumnHide,
} from '../../../utils/custom-interfaces/AuditTypes';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import FillRateBar from './FillRateBar';
import PercentBar, { MIN_RELEVANT_PCT } from '../shared/PercentBar';
import { COLUMN_TYPE_ICONS } from '../shared/columnTypeIcons';
import ContextMenu from '../shared/ContextMenu';
import ChainGraph from '../shared/ChainGraph';
import PerfIcon from '../shared/PerfIcon';
import { deleteColumnDirect, deleteViewDirect } from '../shared/sdkActions';
import ViewVisibilityDrill from '../shared/ViewVisibilityDrill';
import CandidateExpansion, {
  hasCandidateExpansionContent,
} from '../shared/CandidateExpansion';
import { buildCandidateMenuExtras } from '../shared/candidateMenu';
import { showToast } from '../shared/showToast';
import {
  computeCostPerRowTags,
  getViewReferencedColumnKeys,
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
  setViewHiddenColumnsDirect,
} from '../../../utils/custom-utils/performanceAuditRunner';

interface TableTabProps {
  result: TableAuditResult;
  onRefresh: () => void;
  // Performance data for this table. When present, Columns section shows cost %,
  // chain graph, and problem labels for each candidate; Views section shows the
  // row-count column.
  perfResult?: PerformanceAuditResult | null;
  // Archival actions delegated to the embedded PerformanceAudit (which owns the
  // modals and the deletion bookkeeping). Pass `tableId` so the host can look up
  // the right archival entry and open its flow.
  onCreateArchivalView?: (tableId: string) => void;
  onDeleteArchivalRows?: (tableId: string) => void;
  // Mark a column candidate as "replace by static data" via the embedded
  // PerformanceAudit's remediation flow, then switch to the Overview tab so the
  // user can sandbox-test before applying. Mirrors the same option in the
  // Overview's CandidateRow ContextMenu.
  onSelectColumnForReplacement?: (tableId: string, columnKey: string) => void;
  // Toggle stage-delete for a candidate column / a view via the embedded
  // PerformanceAudit. Same auto-switch-to-Overview behavior as
  // onSelectColumnForReplacement.
  onToggleColumnDelete?: (tableId: string, columnKey: string) => void;
  onToggleViewDelete?: (payload: RemediatedView) => void;
  // Drop a staged column/view in the embedded PerformanceAudit when a direct-delete
  // happens on this surface. Keeps the staging set consistent.
  onUnstageColumn?: (tableId: string, columnKey: string) => void;
  onUnstageView?: (tableId: string, viewId: string) => void;
  // Toggle one (column, view) hide pair in the embedded PerformanceAudit.
  onToggleHideInView?: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string,
    view: { viewId: string; viewName: string }
  ) => void;
  // Column-level visibility commit handlers — exposed by PA's imperative
  // handle so TableTab can drive the same Stage / Apply flow as Overview.
  onStageColumnVisibility?: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onApplyColumnVisibility?: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  // Shared per-view local visibility edits (mirrored from PerformanceAudit).
  // Same Map both surfaces read so toggling in either place produces the
  // "(unsaved)" mention in the other and gets committed by Stage / Apply.
  viewEdits?: Map<string, Set<string>>;
  onSetViewEdit?: (viewId: string, hidden: Set<string>) => void;
  onClearViewEdit?: (viewId: string) => void;
  // Mirrored staged maps so the menu can render Stage / Unstage labels reactively.
  stagedColumns?: Map<string, RemediationAction>;
  stagedViews?: Map<string, RemediatedView>;
  stagedHides?: Map<string, RemediatedColumnHide>;
  // Set of table ids whose archival rows have been deleted via the plugin since the
  // last performance rerun. Used to render strikethrough on the archival cell.
  deletedArchivalTableIds?: Set<string>;
  // Trigger a performance audit rerun. Called from the "Rerun performance analysis"
  // link that appears next to the archival cell when the structural row count no
  // longer matches the count snapshotted by the perf audit.
  onRequestPerfRerun?: () => void;
  // Disables the rerun link while a perf audit is already in flight.
  perfRunning?: boolean;
}

const NO_FILL_RATE_TYPES = new Set(['formula', 'link-formula', 'auto-number']);

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return dateStr.slice(0, 10);
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 16,
  color: '#333',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  userSelect: 'none',
  padding: '8px 0',
};

type SortKey = 'name' | 'lastActivity' | 'fillRate' | 'cost';
type SortDir = 'asc' | 'desc';

const sortableThStyle: React.CSSProperties = {
  cursor: 'pointer',
  userSelect: 'none',
};

function compareColumns(
  a: ColumnAuditInfo,
  b: ColumnAuditInfo,
  key: SortKey,
  dir: SortDir,
  costOf?: (colName: string) => number | undefined
): number {
  let cmp = 0;
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name);
      break;
    case 'lastActivity': {
      const da = a.lastActivity || '';
      const db = b.lastActivity || '';
      cmp = da.localeCompare(db);
      break;
    }
    case 'fillRate': {
      const aNull = a.fillRate == null;
      const bNull = b.fillRate == null;
      if (aNull !== bNull) return aNull ? 1 : -1; // N/A always last
      cmp = (a.fillRate ?? 0) - (b.fillRate ?? 0);
      break;
    }
    case 'cost': {
      // "(not computed)" rows are treated as 0 so they sort alongside real zero-cost
      // candidates — which means they cluster on the cheap end of the sort and flip
      // with direction, rather than always sitting at the end.
      const ca = (costOf ? costOf(a.name) : undefined) ?? 0;
      const cb = (costOf ? costOf(b.name) : undefined) ?? 0;
      cmp = ca - cb;
      break;
    }
  }
  return dir === 'asc' ? cmp : -cmp;
}

const TableTab: React.FC<TableTabProps> = ({
  result,
  onRefresh,
  perfResult,
  onCreateArchivalView,
  onDeleteArchivalRows,
  onSelectColumnForReplacement,
  onToggleColumnDelete,
  onToggleViewDelete,
  onUnstageColumn,
  onUnstageView,
  onToggleHideInView,
  onStageColumnVisibility,
  onApplyColumnVisibility,
  viewEdits,
  onSetViewEdit,
  onClearViewEdit,
  stagedColumns,
  stagedViews,
  stagedHides,
  deletedArchivalTableIds,
  onRequestPerfRerun,
  perfRunning,
}) => {
  // Build lookup maps for performance enrichment — candidates by column name, views
  // by view name. Scoped to this table so we only need the relevant subset.
  const candidateByColName = useMemo(() => {
    const m = new Map<string, NonNullable<PerformanceAuditResult['candidates']>[number]>();
    if (!perfResult) return m;
    for (const c of perfResult.candidates) {
      if (c.tableName === result.tableName) m.set(c.columnName, c);
    }
    return m;
  }, [perfResult, result.tableName]);

  const viewRowCountByName = useMemo(() => {
    const m = new Map<string, number>();
    if (!perfResult) return m;
    for (const v of perfResult.views || []) {
      if (v.tableName === result.tableName) m.set(v.viewName, v.rowCount);
    }
    return m;
  }, [perfResult, result.tableName]);

  // Load weight % per view in this table — share of base-wide theoretical view
  // cost (loadMs mirrors theoreticalCostMs since the wall-clock signal was
  // retired) so cross-table comparisons stay consistent with the Overview's
  // Views section. Total denominator is the sum across ALL views, not just
  // this table's.
  const viewWeightPctByName = useMemo(() => {
    const m = new Map<string, number>();
    if (!perfResult) return m;
    const totalLoadMs = (perfResult.views || []).reduce((s, v) => s + (v.loadMs || 0), 0);
    if (totalLoadMs <= 0) return m;
    for (const v of perfResult.views || []) {
      if (v.tableName === result.tableName) m.set(v.viewName, (v.loadMs / totalLoadMs) * 100);
    }
    return m;
  }, [perfResult, result.tableName]);

  // visibleRowsByKey + totalViewLoadMs — feed CandidateExpansion's drill so
  // the "% saved" estimate is consistent with the Overview's per-candidate
  // drill (same data, same math).
  const visibleRowsByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of perfResult?.views || []) {
      m.set(`${v.tableId}:${v.viewId}`, v.rowCount);
    }
    return m;
  }, [perfResult]);
  const totalViewLoadMs = useMemo(() => {
    return (perfResult?.views || []).reduce((s, v) => s + (v.loadMs || 0), 0);
  }, [perfResult]);

  // Archival info for this table — used to show the small file-cabinet hint in the
  // Views section when the table has rows that could be archived.
  const archivalForThisTable = useMemo(() => {
    if (!perfResult) return undefined;
    return (perfResult.archival || []).find(
      (a) => a.tableName === result.tableName && a.candidateCountNoIncomingLinks > 0
    );
  }, [perfResult, result.tableName]);

  // Total compute cost across ALL candidates in the whole audit (not just this table)
  // — used for the percentage-of-total badge so cross-table comparison stays consistent.
  const totalCostMs = useMemo(() => {
    if (!perfResult) return 0;
    return perfResult.candidates.reduce((s, c) => s + (c.measuredCostMs || 0), 0);
  }, [perfResult]);

  // Per-candidate "structural" / "volume" tag for this table's columns. Computed
  // against the whole-audit candidate set so the median cost-per-row context is
  // consistent with what the Overview shows.
  const costPerRowTags = useMemo(() => {
    if (!perfResult) return new Map<string, 'structural' | 'volume'>();
    return computeCostPerRowTags(perfResult.candidates, perfResult.archival || []);
  }, [perfResult]);

  const [showColumns, setShowColumns] = useState(true);
  const [expandedColumnChains, setExpandedColumnChains] = useState<Set<string>>(new Set());
  const toggleColumnChain = (colName: string) => {
    setExpandedColumnChains((prev) => {
      const next = new Set(prev);
      if (next.has(colName)) next.delete(colName);
      else next.add(colName);
      return next;
    });
  };
  const [showViews, setShowViews] = useState(true);
  // Per-view expansion state for the in-row "manage visibility" drill. Set of
  // viewIds currently expanded.
  const [expandedViewIds, setExpandedViewIds] = useState<Set<string>>(new Set());
  // Per-view "Show all columns" toggle. Off by default (only formula /
  // link-formula columns shown); on shows everything.
  const [showAllInView, setShowAllInView] = useState<Set<string>>(new Set());
  const [colSortKey, setColSortKey] = useState<SortKey | null>(null);
  const [colSortDir, setColSortDir] = useState<SortDir>('asc');
  // 'name', 'rows' and 'weight' are sortable today — the other view columns are
  // multi-line summaries that don't have a meaningful scalar ordering.
  const [viewSortKey, setViewSortKey] = useState<'name' | 'rows' | 'weight' | null>(null);
  const [viewSortDir, setViewSortDir] = useState<SortDir>('asc');

  // Local "deleted" sets — items deleted since the last audit. We mark them visually
  // (strikethrough + gray) and suppress the context menu rather than re-running the
  // audit after each deletion. Re-running is expensive on large bases (per-view
  // getTableRows + per-column formula cost). Users trigger a real rerun via the preset
  // context menu when they want fresh numbers.
  const [deletedCols, setDeletedCols] = useState<Set<string>>(new Set());
  const [deletedViews, setDeletedViews] = useState<Set<string>>(new Set());

  // When a fresh audit result arrives (rerun), reset the deleted sets — the result's
  // own columns/views array will no longer include them, so the strikethrough state
  // is stale.
  useEffect(() => {
    setDeletedCols(new Set());
    setDeletedViews(new Set());
  }, [result]);

  const toggleColSort = (key: SortKey) => {
    if (colSortKey === key) {
      if (colSortDir === 'asc') {
        setColSortDir('desc');
      } else {
        setColSortKey(null);
      }
    } else {
      setColSortKey(key);
      setColSortDir('asc');
    }
  };

  const sortedColumns = useMemo(() => {
    if (!colSortKey) return result.columns;
    const costOf = (colName: string) => candidateByColName.get(colName)?.measuredCostMs;
    return [...result.columns].sort((a, b) => compareColumns(a, b, colSortKey, colSortDir, costOf));
  }, [result.columns, colSortKey, colSortDir, candidateByColName]);

  const sortIndicator = (key: SortKey) => {
    if (colSortKey !== key)
      return (
        <i
          className="dtable-font dtable-icon-sort"
          style={{ marginLeft: 4, fontSize: 12, color: '#ccc' }}
        />
      );
    return <span style={{ marginLeft: 4, fontSize: 11 }}>{colSortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const toggleViewSort = (key: 'name' | 'rows' | 'weight') => {
    if (viewSortKey === key) {
      if (viewSortDir === 'asc') setViewSortDir('desc');
      else setViewSortKey(null);
    } else {
      setViewSortKey(key);
      setViewSortDir('asc');
    }
  };

  const viewSortIndicator = (key: 'name' | 'rows' | 'weight') => {
    if (viewSortKey !== key)
      return (
        <i
          className="dtable-font dtable-icon-sort"
          style={{ marginLeft: 4, fontSize: 12, color: '#ccc' }}
        />
      );
    return <span style={{ marginLeft: 4, fontSize: 11 }}>{viewSortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const sortedViews = useMemo(() => {
    if (!viewSortKey) return result.views;
    if (viewSortKey === 'name') {
      return [...result.views].sort((a, b) => {
        const cmp = a.name.localeCompare(b.name);
        return viewSortDir === 'asc' ? cmp : -cmp;
      });
    }
    // Unmeasured views sort as 0 so they cluster with the smallest views (same
    // pattern as the Compute cost column).
    const lookup =
      viewSortKey === 'rows'
        ? (n: string) => viewRowCountByName.get(n) ?? 0
        : (n: string) => viewWeightPctByName.get(n) ?? 0;
    return [...result.views].sort((a, b) => {
      const va = lookup(a.name);
      const vb = lookup(b.name);
      return viewSortDir === 'asc' ? va - vb : vb - va;
    });
  }, [result.views, viewSortKey, viewSortDir, viewRowCountByName, viewWeightPctByName]);

  // Per-column dirty check — true iff any view has viewEdits whose state for
  // this column differs from the committed (base ∪ staged) state. Drives the
  // Stage/Apply views-changes items in the column three-dots menu.
  const hasUnsavedHidesForColumn = (candidate: { tableId: string; columnKey: string }) => {
    const tables = liveValue?.tables ?? [];
    const t = tables.find((tt: any) => tt._id === candidate.tableId);
    if (!t) return false;
    const stagedSetForCol = new Set<string>();
    if (stagedHides) {
      const entry = stagedHides.get(`${candidate.tableId}:${candidate.columnKey}`);
      if (entry) entry.views.forEach((v) => stagedSetForCol.add(v.viewId));
    }
    for (const v of t.views || []) {
      const edits = viewEdits?.get(v._id);
      if (!edits) continue;
      const baseHas = (v.hidden_columns || []).includes(candidate.columnKey);
      const committed = baseHas || stagedSetForCol.has(v._id);
      const editsHas = edits.has(candidate.columnKey);
      if (editsHas !== committed) return true;
    }
    return false;
  };

  const handleDeleteColumn = (colName: string) => {
    if (deleteColumnDirect(result.tableName, colName)) {
      showToast(
        intl
          .get('tables.col_deleted', { name: colName, table: result.tableName })
          .d(`Column "${colName}" deleted from ${result.tableName}`)
      );
      setDeletedCols((prev) => {
        const next = new Set(prev);
        next.add(colName);
        return next;
      });
      // Drop any staging for this column in the embedded PerformanceAudit.
      const candidate = candidateByColName.get(colName);
      if (candidate && onUnstageColumn) {
        onUnstageColumn(candidate.tableId, candidate.columnKey);
      }
    }
  };

  // ------------------------------------------------------------------------
  // Per-view "manage visibility" panel — slider drill that lets the user
  // edit hidden_columns locally (`viewEdits` mirrored from PerformanceAudit)
  // and commit either via Stage (queue as hide-in-view remediations) or
  // Apply (direct PUT to the base). viewEdits is shared with the Overview
  // per-candidate drill so toggling there updates the slider state here
  // and produces the "(unsaved)" mention until committed.
  // ------------------------------------------------------------------------

  const liveValue = (window as any).dtableSDK?.dtableStore?.value;

  const getLiveView = (viewId: string): any | null => {
    const tables = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === result.tableId);
    return t?.views?.find((v: any) => v._id === viewId) || null;
  };

  const getBaseHidden = (viewId: string): Set<string> => {
    const v = getLiveView(viewId);
    return new Set<string>(v?.hidden_columns || []);
  };

  // Column keys in stagedHides whose `views` array includes this view.
  // Read-only — produced from the mirrored staged map.
  const getStagedHiddenForView = (viewId: string): Set<string> => {
    const out = new Set<string>();
    if (!stagedHides) return out;
    stagedHides.forEach((h) => {
      if (h.tableId !== result.tableId) return;
      if (h.views.some((v) => v.viewId === viewId)) out.add(h.columnKey);
    });
    return out;
  };

  // Committed hidden = base ∪ stagedHides_for_view. The slider considers any
  // column "currently hidden" if it's either in base or staged (a Stage
  // commits the user's intent into stagedHides; the slider reflects that
  // immediately even before Apply pushes it to base).
  const getCommittedHidden = (viewId: string): Set<string> => {
    const base = getBaseHidden(viewId);
    const staged = getStagedHiddenForView(viewId);
    if (staged.size === 0) return base;
    const merged = new Set<string>(base);
    staged.forEach((k) => merged.add(k));
    return merged;
  };

  // Effective = viewEdits if set (the user's local desired state), else
  // committed. viewEdits, when first written by toggleColumnInView, is
  // initialized from `committed` so existing staged hides aren't dropped.
  const getEffectiveHidden = (viewId: string): Set<string> => {
    return viewEdits?.get(viewId) ?? getCommittedHidden(viewId);
  };

  const toggleColumnInView = (viewId: string, colKey: string) => {
    if (!onSetViewEdit) return;
    const current = viewEdits?.get(viewId) ?? getCommittedHidden(viewId);
    const next = new Set(current);
    if (next.has(colKey)) next.delete(colKey);
    else next.add(colKey);
    onSetViewEdit(viewId, next);
  };

  const hasUnsavedVisibilityChanges = (viewId: string): boolean => {
    const edits = viewEdits?.get(viewId);
    if (!edits) return false;
    const committed = getCommittedHidden(viewId);
    if (edits.size !== committed.size) return true;
    for (const k of Array.from(edits)) {
      if (!committed.has(k)) return true;
    }
    return false;
  };

  // Diff is computed against the *committed* set. "added" = needs staging.
  // "removedFromStaged" = needs un-staging. "removedFromBase" = un-hide
  // intent (Stage can't commit; needs Apply).
  const computeVisibilityDiff = (viewId: string) => {
    const base = getBaseHidden(viewId);
    const staged = getStagedHiddenForView(viewId);
    const committed = new Set<string>(base);
    staged.forEach((k) => committed.add(k));
    const edits = viewEdits?.get(viewId) ?? committed;
    const added: string[] = [];
    const removedFromStaged: string[] = [];
    const removedFromBase: string[] = [];
    edits.forEach((k) => {
      if (!committed.has(k)) added.push(k);
    });
    committed.forEach((k) => {
      if (!edits.has(k)) {
        if (staged.has(k)) removedFromStaged.push(k);
        else removedFromBase.push(k);
      }
    });
    return {
      added,
      removedFromStaged,
      removedFromBase,
      desired: Array.from(edits),
    };
  };

  const applyVisibilityChanges = async (viewId: string, viewName: string) => {
    const { desired } = computeVisibilityDiff(viewId);
    const ok = await setViewHiddenColumnsDirect(result.tableName, viewName, desired);
    if (ok) {
      showToast(
        intl
          .get('performance.visibility_applied', { view: viewName })
          .d(`View "${viewName}" visibility updated.`)
      );
      const v = getLiveView(viewId);
      if (v) v.hidden_columns = desired;
      if (onClearViewEdit) onClearViewEdit(viewId);
    } else {
      showToast(
        intl
          .get('performance.visibility_apply_failed', { view: viewName })
          .d(`Failed to update visibility for view "${viewName}".`)
      );
    }
  };

  const stageVisibilityChanges = (viewId: string, viewName: string) => {
    if (!onToggleHideInView || !onClearViewEdit) return;
    const { added, removedFromStaged, removedFromBase } = computeVisibilityDiff(viewId);
    const liveCols: any[] =
      liveValue?.tables?.find((t: any) => t._id === result.tableId)?.columns ?? [];
    // Both `added` (needs staging) and `removedFromStaged` (needs unstaging)
    // map to the same toggleHideRemediation call — it adds when not present,
    // removes when present. removedFromBase is the un-hide-from-base case
    // which Stage can't handle and is dropped here.
    for (const colKey of [...added, ...removedFromStaged]) {
      const col = liveCols.find((c: any) => c.key === colKey);
      const colName = col?.name || colKey;
      onToggleHideInView(result.tableId, result.tableName, colKey, colName, {
        viewId,
        viewName,
      });
    }
    onClearViewEdit(viewId);
    const stagedTotal = added.length + removedFromStaged.length;
    if (stagedTotal > 0 && removedFromBase.length > 0) {
      showToast(
        intl
          .get('performance.visibility_staged_mixed', {
            staged: stagedTotal,
            dropped: removedFromBase.length,
            view: viewName,
          })
          .d(
            `${stagedTotal} change(s) staged for "${viewName}"; ${removedFromBase.length} un-hide(s) discarded — use Apply for those.`
          )
      );
    } else if (stagedTotal > 0) {
      showToast(
        intl
          .get('performance.visibility_staged', { count: stagedTotal, view: viewName })
          .d(`${stagedTotal} change(s) staged for "${viewName}".`)
      );
    } else {
      showToast(
        intl
          .get('performance.visibility_stage_no_adds')
          .d('Stage only commits new hides — nothing to stage. Use Apply for un-hides.')
      );
    }
  };

  const toggleViewExpand = (viewId: string) => {
    setExpandedViewIds((prev) => {
      const next = new Set(prev);
      if (next.has(viewId)) next.delete(viewId);
      else next.add(viewId);
      return next;
    });
  };

  const toggleShowAllInView = (viewId: string) => {
    setShowAllInView((prev) => {
      const next = new Set(prev);
      if (next.has(viewId)) next.delete(viewId);
      else next.add(viewId);
      return next;
    });
  };

  const handleDeleteView = (viewName: string, viewId?: string) => {
    if (deleteViewDirect(result.tableName, viewName)) {
      showToast(
        intl
          .get('tables.view_deleted', { name: viewName, table: result.tableName })
          .d(`View "${viewName}" deleted from ${result.tableName}`)
      );
      setDeletedViews((prev) => {
        const next = new Set(prev);
        next.add(viewName);
        return next;
      });
      if (viewId && onUnstageView) onUnstageView(result.tableId, viewId);
    }
  };

  return (
    <div>
      <style>{'.audit-row:hover { background-color: #eef6fb !important; }'}</style>
      <div style={{ marginBottom: 16, fontSize: 14, lineHeight: 1.8 }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={{ paddingRight: 12, color: '#555' }}>
                {intl.get('common.rows').d('Rows')}
              </td>
              <td style={{ paddingRight: 8, textAlign: 'right' }}>
                {result.rowCount}
              </td>
              {archivalForThisTable &&
                archivalForThisTable.candidateCount > 0 &&
                (() => {
                  const a = archivalForThisTable;
                  // Deleted via the plugin since the last perf rerun → strikethrough,
                  // hide the action menu. Cleared when a perf rerun completes.
                  const archivalDeleted = !!deletedArchivalTableIds?.has(a.tableId);
                  // Structural row count diverged from the perf-audit snapshot
                  // (rows added/removed outside the plugin, or after a structural-only
                  // rerun following a plugin-side delete) → mention is stale.
                  const archivalStale = !archivalDeleted && result.rowCount !== a.totalRows;
                  const pct = a.totalRows > 0 ? (a.candidateCount / a.totalRows) * 100 : 0;
                  const baseLabel =
                    a.candidateCountNoIncomingLinks === a.candidateCount
                      ? intl
                          .get('performance.rows_archival_with_all_safe', {
                            count: a.candidateCount,
                            pct: Math.round(pct),
                          })
                          .d(`${a.candidateCount} archival (${Math.round(pct)}%) — all safe`)
                      : intl
                          .get('performance.rows_archival_with_n_safe', {
                            count: a.candidateCount,
                            pct: Math.round(pct),
                            safe: a.candidateCountNoIncomingLinks,
                          })
                          .d(
                            `${a.candidateCount} archival (${Math.round(pct)}%) — ${a.candidateCountNoIncomingLinks} safe`
                          );
                  const cellStyle: React.CSSProperties = {
                    paddingLeft: 12,
                    fontSize: 13,
                    fontWeight: 500,
                    color: archivalDeleted || archivalStale ? '#999' : '#555',
                    fontStyle: archivalStale ? 'italic' : 'normal',
                    textDecoration: archivalDeleted ? 'line-through' : 'none',
                  };
                  const tooltip = archivalDeleted
                    ? intl
                        .get('performance.rows_archival_tooltip_deleted')
                        .d(
                          'These rows were deleted since the last performance analysis. Counts will refresh on the next performance rerun.'
                        )
                    : archivalStale
                      ? intl
                          .get('performance.rows_archival_tooltip_stale')
                          .d(
                            'Row count changed since the last performance analysis — these archival figures may be outdated.'
                          )
                      : intl
                          .get('performance.rows_archival_tooltip_combined')
                          .d(
                            'Rows whose creation and modification times are both older than the archival threshold. "Safe" rows are not referenced by any link column elsewhere — safest to archive first.'
                          );
                  return (
                    <>
                      <td style={cellStyle} title={tooltip}>
                        <PerfIcon
                          size={12}
                          color={archivalDeleted || archivalStale ? '#999' : '#ff8000'}
                          style={{ marginRight: 6 }}
                        />
                        {baseLabel}
                      </td>
                      {archivalStale ? (
                        <td style={{ paddingLeft: 8, verticalAlign: 'middle' }}>
                          <span
                            onClick={() => {
                              if (!perfRunning && onRequestPerfRerun) onRequestPerfRerun();
                            }}
                            style={{
                              fontSize: 12,
                              color: perfRunning ? '#999' : '#ff8000',
                              cursor: perfRunning ? 'default' : 'pointer',
                              userSelect: 'none',
                            }}>
                            {intl
                              .get('performance.rerun_analysis')
                              .d('Rerun performance analysis')}
                          </span>
                        </td>
                      ) : archivalDeleted ? null : (
                        <td style={{ paddingLeft: 8, verticalAlign: 'middle' }}>
                          <ContextMenu
                            onDelete={() => onDeleteArchivalRows && onDeleteArchivalRows(a.tableId)}
                            confirmDelete={false}
                            label={intl
                              .get('performance.rows_delete_with_snapshot')
                              .d('Delete with snapshot')}
                            extraActions={[
                              {
                                label: intl
                                  .get('performance.rows_create_archival_view')
                                  .d('Create archival view'),
                                icon: 'dtable-icon-archive-view',
                                onClick: () =>
                                  onCreateArchivalView && onCreateArchivalView(a.tableId),
                              },
                            ]}
                          />
                        </td>
                      )}
                    </>
                  );
                })()}
            </tr>
            <tr>
              <td style={{ paddingRight: 12, color: '#555' }}>
                {intl.get('common.columns').d('Columns')}
              </td>
              <td style={{ paddingRight: 8, textAlign: 'right' }}>
                {result.totalColumnCount}
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 12, color: '#555' }}>
                {intl.get('common.views').d('Views')}
              </td>
              <td style={{ paddingRight: 8, textAlign: 'right' }}>
                {result.viewCount}
              </td>
            </tr>
            {result.lastRowAdded && (
              <tr>
                <td style={{ paddingRight: 12, color: '#555' }}>
                  {intl.get('tables.last_row_added').d('Last row added')}
                </td>
                <td style={{ paddingRight: 8, color: '#888' }}>
                  {formatDate(result.lastRowAdded)}
                </td>
              </tr>
            )}
            {result.lastRowModified && (
              <tr>
                <td style={{ paddingRight: 12, color: '#555' }}>
                  {intl.get('tables.last_row_modified').d('Last row modified')}
                </td>
                <td style={{ paddingRight: 8, color: '#888' }}>
                  {formatDate(result.lastRowModified)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Views section */}
      <div onClick={() => setShowViews(!showViews)} style={sectionHeaderStyle}>
        <i
          className={`dtable-font ${showViews ? 'dtable-icon-down' : 'dtable-icon-right'}`}
          style={{ fontSize: 12 }}
        />
        {intl
          .get('tables.views_title', { count: result.viewCount })
          .d(`Views (${result.viewCount})`)}
      </div>
      {showViews && (
        <table
          className="audit-table"
          style={{
            width: '100%',
            tableLayout: 'fixed',
            borderCollapse: 'collapse',
            fontSize: 14,
            marginBottom: 24,
          }}>
          <colgroup>
            <col style={{ width: '22%' }} />
            <col />
            <col style={{ width: '18%' }} />
            <col style={{ width: '15%' }} />
            {perfResult && <col style={{ width: 130 }} />}
            {perfResult && <col style={{ width: 140 }} />}
            <col style={{ width: 32 }} />
          </colgroup>
          <thead>
            <tr
              style={{
                borderBottom: '2px solid #dee2e6',
                textAlign: 'left',
              }}>
              <th
                style={{ padding: '8px 12px', ...sortableThStyle }}
                onClick={() => toggleViewSort('name')}>
                {intl.get('common.view').d('View')}
                {viewSortIndicator('name')}
              </th>
              <th style={{ padding: '8px 12px' }}>
                {intl.get('tables.view_filters').d('Filters')}
              </th>
              <th style={{ padding: '8px 12px' }}>
                {intl.get('tables.view_sorting').d('Sorting')}
              </th>
              <th style={{ padding: '8px 12px' }}>
                {intl.get('tables.view_grouping').d('Grouping')}
              </th>
              {perfResult && (
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', ...sortableThStyle }}
                  title={intl
                    .get('tables.view_rows_hint')
                    .d('Rows displayed — from the most recent Performance analysis.')}
                  onClick={() => toggleViewSort('rows')}>
                  <PerfIcon size={12} style={{ marginRight: 4 }} />
                  {intl.get('common.rows').d('Rows')}
                  {viewSortIndicator('rows')}
                </th>
              )}
              {perfResult && (
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', ...sortableThStyle }}
                  title={intl
                    .get('performance.view_weight_tooltip')
                    .d(
                      'This view\'s share of total view-load time (rowCount × ms) before the remediation.'
                    )}
                  onClick={() => toggleViewSort('weight')}>
                  <PerfIcon size={12} style={{ marginRight: 4 }} />
                  {intl.get('performance.weight').d('Weight')}
                  {viewSortIndicator('weight')}
                </th>
              )}
              <th style={{ padding: '8px 4px' }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedViews.map((view, i) => {
              const isDeleted = deletedViews.has(view.name);
              const isStaged =
                !isDeleted && !!stagedViews?.has(`${result.tableId}:${view.viewId}`);
              const viewWeightPct = viewWeightPctByName.get(view.name);
              const expandable =
                !isDeleted &&
                !isStaged &&
                viewWeightPct !== undefined &&
                viewWeightPct >= MIN_RELEVANT_PCT;
              const isExpanded = expandedViewIds.has(view.viewId);
              const isDirty = hasUnsavedVisibilityChanges(view.viewId);
              const colSpanForExpand = perfResult ? 7 : 5;
              return (
                <React.Fragment key={view.name}>
                  <tr
                  className="audit-row"
                  style={{
                    borderBottom: '1px solid #eee',
                    backgroundColor: i % 2 === 0 ? '#fff' : '#f9f9f9',
                    opacity: isDeleted ? 0.5 : 1,
                    color: isDeleted ? '#888' : isStaged ? '#777' : undefined,
                  }}>
                    <td style={{ padding: '6px 12px', wordBreak: 'break-word' }}>
                      {expandable && (
                      <i
                        onClick={() => toggleViewExpand(view.viewId)}
                        className={`dtable-font ${isExpanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                        style={{
                          fontSize: 10,
                          color: '#888',
                          marginRight: 6,
                          cursor: 'pointer',
                        }}
                      />
                    )}
                      <span
                      style={{
                        textDecoration:
                          isDeleted || isStaged ? 'line-through' : undefined,
                      }}>
                        {view.name}
                      </span>
                      {isDirty && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 11,
                            color: '#e6a117',
                            fontStyle: 'italic',
                          }}>
                          {intl.get('performance.unsaved_visibility').d('(unsaved)')}
                        </span>
                      )}
                      {view.privateFor && (
                      <span
                        title={intl
                          .get('performance.private_view_tooltip', { owner: view.privateFor })
                          .d(`Private view (owner: ${view.privateFor})`)}
                        style={{ marginLeft: 6 }}>
                        <i
                          className="dtable-font dtable-icon-private-database"
                          style={{ fontSize: 14, color: '#888' }}
                        />
                      </span>
                    )}
                      {view.duplicateOf && view.duplicateOf.length > 0 && (
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: 11,
                          color: '#856404',
                          backgroundColor: '#fff3cd',
                          padding: '1px 6px',
                          borderRadius: 3,
                          marginLeft: 6,
                          fontWeight: 400,
                        }}>
                        {intl
                          .get('tables.view_duplicate', { names: view.duplicateOf.join(', ') })
                          .d(`same rules as: ${view.duplicateOf.join(', ')}`)}
                      </span>
                    )}
                      {isStaged && (
                      <span
                        style={{
                          fontSize: 11,
                          color: '#dc3545',
                          fontStyle: 'italic',
                          marginLeft: 6,
                        }}>
                        · {intl.get('performance.marked_delete').d('marked for deletion')}
                      </span>
                    )}
                    </td>
                    <td
                    style={{
                      padding: '6px 12px',
                      color: view.filterCount > 0 ? '#333' : '#ccc',
                      fontSize: 13,
                      wordBreak: 'break-word',
                    }}>
                      {view.filterCount > 0 ? view.filterSummary : intl.get('common.none').d('None')}
                    </td>
                    <td
                    style={{
                      padding: '6px 12px',
                      color: view.sortCount > 0 ? '#333' : '#ccc',
                      fontSize: 13,
                      wordBreak: 'break-word',
                    }}>
                      {view.sortCount > 0 ? view.sortSummary : intl.get('common.none').d('None')}
                    </td>
                    <td
                    style={{
                      padding: '6px 12px',
                      color: view.groupbyCount > 0 ? '#333' : '#ccc',
                      fontSize: 13,
                      wordBreak: 'break-word',
                    }}>
                      {view.groupbyCount > 0
                      ? view.groupbySummary
                      : intl.get('common.none').d('None')}
                    </td>
                    {perfResult &&
                    (() => {
                      const rc = viewRowCountByName.get(view.name);
                      return (
                        <td
                          style={{
                            padding: '6px 12px',
                            textAlign: 'left',
                            color: '#666',
                          }}>
                          {rc !== undefined ? (
                            <>
                              {rc}
                              <span style={{ color: '#aaa' }}> / {result.rowCount}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      );
                    })()}
                    {perfResult &&
                    (() => {
                      const pct = viewWeightPctByName.get(view.name);
                      if (pct === undefined || pct < MIN_RELEVANT_PCT) {
                        return (
                          <td
                            style={{
                              padding: '6px 12px',
                              textAlign: 'left',
                              color: '#aaa',
                              fontSize: 13,
                              fontStyle: 'italic',
                            }}>
                            {intl.get('performance.not_relevant').d('not relevant')}
                          </td>
                        );
                      }
                      return (
                        <td style={{ padding: '6px 12px', textAlign: 'left' }}>
                          <PercentBar pct={pct} />
                        </td>
                      );
                    })()}
                    <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                      {!isDeleted && (() => {
                      const stagedViewKey = `${result.tableId}:${view.viewId}`;
                      const stageActive = !!stagedViews?.has(stagedViewKey);
                      const weightPct = viewWeightPctByName.get(view.name);
                      const stageNotRelevant =
                        weightPct === undefined || weightPct < MIN_RELEVANT_PCT;
                      const stageLabel = stageActive
                        ? intl
                            .get('performance.unstage_delete_view')
                            .d('Unstage delete view')
                        : intl.get('performance.stage_delete_view').d('Stage delete view');
                      const directLabel = view.privateFor
                        ? intl
                            .get('performance.delete_private_view_now')
                            .d('Delete private view now')
                        : intl
                            .get('performance.delete_view_now')
                            .d('Delete view now');
                      // Build the menu in two banks separated by a divider:
                      //   Stage bank (gauge) — Stage update view, Stage delete view
                      //   ----- divider -----
                      //   Direct "now" bank — Update view now, Delete view now
                      // (Delete view now is appended automatically by ContextMenu via onDelete.)
                      const extras: any[] = [];
                      if (expandable) {
                        extras.push({
                          label: intl
                            .get('performance.stage_update_view')
                            .d('Stage update view'),
                          icon: 'dtable-icon-gauge',
                          color: isDirty ? '#dc3545' : '#999',
                          disabled: !isDirty,
                          disabledTooltip: intl
                            .get('performance.no_unsaved_visibility')
                            .d('Toggle the column sliders first.'),
                          onClick: () => stageVisibilityChanges(view.viewId, view.name),
                        });
                      }
                      if (onToggleViewDelete) {
                        extras.push({
                          label: stageLabel,
                          icon: 'dtable-icon-gauge',
                          color: stageActive ? '#999' : '#dc3545',
                          disabled: stageNotRelevant && !stageActive,
                          disabledTooltip: intl
                            .get('performance.stage_not_relevant_tooltip')
                            .d(
                              'Not significant — staging this won\'t measurably improve performance.'
                            ),
                          onClick: () =>
                            onToggleViewDelete({
                              tableId: result.tableId,
                              tableName: result.tableName,
                              viewId: view.viewId,
                              viewName: view.name,
                              privateFor: view.privateFor ?? null,
                            }),
                        });
                      }
                      if (extras.length > 0) {
                        extras.push({ divider: true, label: '', onClick: () => {} });
                      }
                      if (expandable) {
                        extras.push({
                          label: intl
                            .get('performance.update_view_now')
                            .d('Update view now'),
                          icon: 'dtable-icon-eye',
                          color: isDirty ? '#0066cc' : '#999',
                          disabled: !isDirty,
                          disabledTooltip: intl
                            .get('performance.no_unsaved_visibility')
                            .d('Toggle the column sliders first.'),
                          onClick: () => applyVisibilityChanges(view.viewId, view.name),
                        });
                      }
                      return (
                        <ContextMenu
                          onDelete={() => handleDeleteView(view.name, view.viewId)}
                          label={directLabel}
                          extraActions={extras.length > 0 ? extras : undefined}
                        />
                      );
                    })()}
                    </td>
                  </tr>
                  {isExpanded && (() => {
                    const liveView = getLiveView(view.viewId);
                    if (!liveView) return null;
                    const effectiveHidden = getEffectiveHidden(view.viewId);
                    const candidateKeys = new Set(
                      perfResult?.candidates
                        .filter((c) => c.tableId === result.tableId)
                        .map((c) => c.columnKey) ?? []
                    );
                    const cols = (liveValue?.tables?.find(
                      (t: any) => t._id === result.tableId
                    )?.columns ?? []) as any[];
                    return (
                      <tr style={{ backgroundColor: '#fafbfc' }}>
                        <td
                          colSpan={colSpanForExpand}
                          style={{ padding: 0, borderBottom: '1px solid #eee' }}>
                          <ViewVisibilityDrill
                            tableId={result.tableId}
                            viewId={view.viewId}
                            liveView={liveView}
                            liveColumns={cols}
                            candidateColumnKeys={candidateKeys}
                            effectiveHidden={effectiveHidden}
                            onToggleColumn={(colKey) =>
                              toggleColumnInView(view.viewId, colKey)
                            }
                          />
                        </td>
                      </tr>
                    );
                  })()}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Columns section */}
      <div onClick={() => setShowColumns(!showColumns)} style={sectionHeaderStyle}>
        <i
          className={`dtable-font ${showColumns ? 'dtable-icon-down' : 'dtable-icon-right'}`}
          style={{ fontSize: 12 }}
        />
        {intl
          .get('tables.columns_title', { count: result.columnCount })
          .d(`Columns (${result.columnCount})`)}
        {result.selectedViewName && (
          <span style={{ fontWeight: 400, fontSize: 13, color: '#888', marginLeft: 8 }}>
            {intl
              .get('tables.columns_view', { name: result.selectedViewName })
              .d(`view: ${result.selectedViewName}`)}
          </span>
        )}
      </div>
      {showColumns && (
        <table
          className="audit-table"
          style={{
            width: '100%',
            tableLayout: 'fixed',
            borderCollapse: 'collapse',
            fontSize: 14,
            marginBottom: 24,
          }}>
          <colgroup>
            <col />
            <col style={{ width: 140 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 32 }} />
          </colgroup>
          <thead>
            <tr
              style={{
                borderBottom: '2px solid #dee2e6',
                textAlign: 'left',
              }}>
              <th
                style={{ padding: '8px 12px', ...sortableThStyle }}
                onClick={() => toggleColSort('name')}>
                {intl.get('tables.col_header').d('Column')}
                {sortIndicator('name')}
              </th>
              <th
                style={{ padding: '8px 12px', ...sortableThStyle }}
                onClick={() => toggleColSort('lastActivity')}>
                {intl.get('tables.col_last_activity').d('Last activity')}
                {sortIndicator('lastActivity')}
              </th>
              <th
                style={{ padding: '8px 12px', ...sortableThStyle }}
                onClick={() => toggleColSort('fillRate')}>
                {intl.get('tables.col_fill_rate').d('Fill rate')}
                {sortIndicator('fillRate')}
              </th>
              <th
                style={{ padding: '8px 12px', textAlign: 'left', ...sortableThStyle }}
                title={intl
                  .get('tables.col_compute_hint')
                  .d('Share of total compute time — from the most recent Performance analysis.')}
                onClick={() => toggleColSort('cost')}>
                <PerfIcon size={12} style={{ marginRight: 4 }} />
                {intl.get('tables.col_compute').d('Compute %')}
                {sortIndicator('cost')}
              </th>
              <th style={{ padding: '8px 4px' }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedColumns.map((col, i) => {
              const isDeleted = deletedCols.has(col.name);
              const candidate = candidateByColName.get(col.name);
              const stagedAction = candidate
                ? stagedColumns?.get(`${candidate.tableId}:${candidate.columnKey}`)
                : undefined;
              const isStaged = !isDeleted && !!stagedAction;
              const stagedMention =
                stagedAction === 'delete'
                  ? intl.get('performance.marked_delete').d('marked for deletion')
                  : stagedAction === 'replace-static'
                    ? intl
                        .get('performance.marked_replace', {
                          type: candidate?.replacementType?.type || '',
                        })
                        .d('marked for replacement ({type})')
                    : '';
              const costPct =
                candidate?.measuredCostMs !== undefined && totalCostMs > 0
                  ? (candidate.measuredCostMs / totalCostMs) * 100
                  : undefined;
              const costLabel =
                costPct === undefined
                  ? ''
                  : costPct < 0.1
                    ? '<0.1%'
                    : costPct < 10
                      ? `${costPct.toFixed(1)}%`
                      : `${Math.round(costPct)}%`;
              // The chevron drives both the chain graph and the per-view
              // visibility drill (same UX as Overview's CandidateRow).
              // Available iff the column is a candidate AND has at least one
              // of those — non-candidates don't get any expansion.
              const expandable =
                !!candidate &&
                !isDeleted &&
                hasCandidateExpansionContent(candidate, liveValue);
              const isExpanded = expandedColumnChains.has(col.name);
              // structural/volume tags are now surfaced in the labels list (with
              // their tooltips), and "formula on large table" is suppressed when the
              // empirical "volume" tag fires — same logic as the Overview's CandidateRow.
              const tag = candidate
                ? costPerRowTags.get(`${candidate.tableId}:${candidate.columnKey}`)
                : undefined;
              const structuralLabel =
                tag === 'structural'
                  ? {
                      text: intl
                        .get('performance.label_structural')
                        .d('structural cost (high cost per row)'),
                      tooltip: intl
                        .get('performance.tag_structural_tooltip')
                        .d(
                          'High cost per row — the formula itself is expensive. Will get worse as the table grows. Action: rewrite the formula.'
                        ),
                    }
                  : null;
              const volumeLabel =
                tag === 'volume'
                  ? {
                      text: intl
                        .get('performance.label_volume')
                        .d('volume cost (large table, low cost per row)'),
                      tooltip: intl
                        .get('performance.tag_volume_tooltip')
                        .d(
                          'Low cost per row but high total cost — the formula is fine, the table just has many rows. Action: archive or filter rows.'
                        ),
                    }
                  : null;
              const baseLabels = candidate
                ? tag === 'volume'
                  ? candidate.labels.filter((l) => !l.startsWith('formula on large table'))
                  : candidate.labels
                : [];
              const nearDupLabel =
                candidate?.nearDuplicateGroup && candidate.nearDuplicateGroup.length > 0
                  ? {
                      text: intl
                        .get('performance.label_near_duplicate', {
                          count: candidate.nearDuplicateGroup.length,
                          names: candidate.nearDuplicateGroup
                            .map((p) => p.columnName)
                            .join(', '),
                        })
                        .d(
                          `near-duplicate of ${candidate.nearDuplicateGroup.length} other column(s): ${candidate.nearDuplicateGroup.map((p) => p.columnName).join(', ')}`
                        ),
                      tooltip: intl
                        .get('performance.label_near_duplicate_tooltip')
                        .d(
                          'These columns share the same compute (same link, source field, and aggregation) — only their display config differs. Each one re-does the same work. Keep one and delete the rest to recover the duplicate compute.'
                        ),
                    }
                  : null;
              const displayLabels: Array<{ text: string; tooltip?: string }> = [
                ...(structuralLabel ? [structuralLabel] : []),
                ...(volumeLabel ? [volumeLabel] : []),
                ...(nearDupLabel ? [nearDupLabel] : []),
                ...baseLabels.map((text) => ({ text })),
              ];
              const hasLabels = displayLabels.length > 0;
              return (
                <tr
                  key={col.name}
                  className="audit-row"
                  style={{
                    borderBottom: '1px solid #eee',
                    backgroundColor: i % 2 === 0 ? '#fff' : '#f9f9f9',
                    opacity: isDeleted ? 0.5 : 1,
                    color: isDeleted ? '#888' : isStaged ? '#777' : undefined,
                    cursor: expandable ? 'pointer' : undefined,
                  }}
                  onClick={expandable ? () => toggleColumnChain(col.name) : undefined}>
                  <td style={{ padding: '6px 12px' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                        minWidth: 0,
                        wordBreak: 'break-word',
                      }}>
                      {expandable && (
                        <i
                          className={`dtable-font ${isExpanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                          style={{ fontSize: 10, color: '#888', flexShrink: 0 }}
                        />
                      )}
                      <i
                        className={`dtable-font ${COLUMN_TYPE_ICONS[col.type] || 'dtable-icon-single-line-text'}`}
                        style={{ fontSize: 14, color: '#aaa', flexShrink: 0 }}
                      />
                      <span
                        style={{
                          textDecoration:
                            isDeleted || stagedAction === 'delete' ? 'line-through' : undefined,
                          fontStyle:
                            stagedAction === 'replace-static' ? 'italic' : undefined,
                        }}>
                        {col.name}
                      </span>
                      <span style={{ color: '#aaa', fontSize: 12 }}>{col.type}</span>
                      {isStaged && stagedMention && (
                        <span
                          style={{
                            fontSize: 11,
                            color: stagedAction === 'delete' ? '#dc3545' : '#e6a117',
                            fontStyle: 'italic',
                          }}>
                          · {stagedMention}
                        </span>
                      )}
                      {candidate && !isStaged && hasUnsavedHidesForColumn(candidate) && (
                        <span
                          style={{
                            marginLeft: 4,
                            fontSize: 11,
                            color: '#e6a117',
                            fontStyle: 'italic',
                          }}>
                          {intl.get('performance.unsaved_visibility').d('(unsaved)')}
                        </span>
                      )}
                      {col.matchesCtime && (
                        <span
                          style={{
                            fontSize: 11,
                            color: '#856404',
                            backgroundColor: '#fff3cd',
                            padding: '1px 6px',
                            borderRadius: 3,
                            marginLeft: 4,
                          }}>
                          {intl
                            .get('tables.col_matches_ctime')
                            .d('matches created time — use ctime column?')}
                        </span>
                      )}
                      {col.duplicateOf.length > 0 && (
                        <span
                          style={{
                            fontSize: 11,
                            color: '#856404',
                            backgroundColor: '#fff3cd',
                            padding: '1px 6px',
                            borderRadius: 3,
                            marginLeft: 4,
                          }}>
                          {intl
                            .get('tables.col_duplicate', { names: col.duplicateOf.join(', ') })
                            .d(`same data as: ${col.duplicateOf.join(', ')}`)}
                        </span>
                      )}
                    </div>
                    {/* Performance enrichment: chain graph + per-view drill +
                      problem labels. The chain graph + drill are indented 20px
                      so their nesting visually reads as "under" the column name
                      rather than flush with it. Same component as Overview's
                      CandidateRow expansion — single source of truth. */}
                    {expandable && isExpanded && candidate && perfResult && (
                      <CandidateExpansion
                        candidate={candidate}
                        liveValue={liveValue}
                        viewEdits={viewEdits ?? new Map()}
                        onSetViewEdit={(viewId, hidden) =>
                          onSetViewEdit && onSetViewEdit(viewId, hidden)
                        }
                        stagedHides={stagedHides ?? new Map()}
                        costByKey={perfResult.costByKey}
                        visibleRowsByKey={visibleRowsByKey}
                        totalViewLoadMs={totalViewLoadMs}
                      />
                    )}
                    {hasLabels && (
                      <div style={{ marginTop: 4, marginLeft: 20 }}>
                        {displayLabels.map((label, idx) => (
                          <div
                            key={idx}
                            title={label.tooltip}
                            style={{
                              fontSize: 11,
                              color: '#6b7d72',
                              lineHeight: '18px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}>
                            <span style={{ color: '#e6a117', fontSize: 9 }}>&#9679;</span>
                            {label.text}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '6px 12px',
                      fontSize: 12,
                      color: '#888',
                      whiteSpace: 'nowrap',
                    }}>
                    {formatDate(col.lastActivity)}
                  </td>
                  <td style={{ padding: '6px 12px' }}>
                    {NO_FILL_RATE_TYPES.has(col.type) ? (
                      col.errorRate != null && col.errorRate > 0 ? (
                        <span style={{ color: '#dc3545', fontSize: 13 }}>
                          {intl
                            .get('tables.col_errors', { pct: (col.errorRate * 100).toFixed(0) })
                            .d(`${(col.errorRate * 100).toFixed(0)}% errors`)}
                        </span>
                      ) : (
                        <span style={{ color: '#ccc', fontSize: 13 }}>
                          {intl.get('tables.col_na_computed').d('N/A (computed)')}
                        </span>
                      )
                    ) : (
                      <FillRateBar rate={col.fillRate} />
                    )}
                  </td>
                  {/* Compute % cell — shows when perf data is available and this column
                    is a candidate. Otherwise "(not computed)" in muted grey. */}
                  <td style={{ padding: '6px 12px', textAlign: 'left' }}>
                    {candidate?.measuredCostMs !== undefined &&
                    costPct !== undefined &&
                    costPct >= MIN_RELEVANT_PCT ? (
                      <span
                        title={intl
                          .get('performance.cost_tooltip')
                          .d('Share of total formula compute time across all formula columns.')}>
                        <PercentBar pct={costPct} />
                      </span>
                    ) : (
                      <span style={{ color: '#aaa', fontSize: 13, fontStyle: 'italic' }}>
                        {intl.get('performance.not_relevant').d('not relevant')}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                    {!isDeleted &&
                      (() => {
                        // Non-candidate columns: simpler menu (just direct delete).
                        if (!candidate) {
                          return (
                            <ContextMenu
                              onDelete={() => handleDeleteColumn(col.name)}
                              label={intl
                                .get('performance.delete_column_now')
                                .d('Delete column now')}
                            />
                          );
                        }
                        // Candidate columns: same shared menu as Overview's
                        // CandidateRow. The notRelevant gate is set when the
                        // column's cost share is below the threshold (TableTab
                        // shows below-threshold candidates that Overview filters
                        // out).
                        const notRelevant =
                          costPct === undefined || costPct < MIN_RELEVANT_PCT;
                        const isColumnDirty = candidate
                          ? hasUnsavedHidesForColumn(candidate)
                          : false;
                        const extras = buildCandidateMenuExtras({
                          candidate,
                          remediations: stagedColumns ?? new Map(),
                          isColumnDirty,
                          notRelevant,
                          onToggleAction: (key, action) => {
                            const [tableId, columnKey] = key.split(':');
                            if (action === 'delete') {
                              if (onToggleColumnDelete)
                                onToggleColumnDelete(tableId, columnKey);
                            } else if (onSelectColumnForReplacement) {
                              onSelectColumnForReplacement(tableId, columnKey);
                            }
                          },
                          onStageColumnVisibility: (
                            tableId,
                            tableName,
                            columnKey,
                            columnName
                          ) => {
                            if (onStageColumnVisibility)
                              onStageColumnVisibility(
                                tableId,
                                tableName,
                                columnKey,
                                columnName
                              );
                          },
                          onApplyColumnVisibility: (
                            tableId,
                            tableName,
                            columnKey,
                            columnName
                          ) => {
                            if (onApplyColumnVisibility)
                              onApplyColumnVisibility(
                                tableId,
                                tableName,
                                columnKey,
                                columnName
                              );
                          },
                        });
                        return (
                          <ContextMenu
                            onDelete={() => handleDeleteColumn(col.name)}
                            label={intl
                              .get('performance.delete_column_now')
                              .d('Delete column now')}
                            deleteDisabled={candidate.isPrimaryColumn}
                            deleteDisabledTooltip={intl
                              .get('performance.delete_disabled_primary')
                              .d('Cannot delete — this is the table\'s first column')}
                            extraActions={extras}
                          />
                        );
                      })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default TableTab;
