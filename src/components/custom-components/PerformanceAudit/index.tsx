/* eslint-disable no-restricted-globals */
// The no-restricted-globals rule produces false positives on type-level property
// names like `status: AuditStatus` (it can't distinguish property definitions from
// bare references to window.status). Disabled at the file level.
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useCallback,
  useRef,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import intl from 'react-intl-universal';
import {
  PerformanceAuditResult,
  PerformanceAuditTableArchival,
  PerformanceAuditView,
  BenchmarkTimings,
  SandboxState,
  AuditStatus,
  RemediationAction,
  RemediatedColumn,
  RemediatedView,
  RemediatedColumnHide,
  PerformanceTest,
  PerformanceTestSandbox,
  AffectedRule,
  TableAuditResult,
  FrozenColumnRecord,
} from '../../../utils/custom-interfaces/AuditTypes';
import { PLUGIN_NAME } from '../../../utils/template-constants';
import {
  unfreezeColumnViaIndirection,
  freezeColumnViaIndirection,
} from '../../../utils/custom-utils/freezeColumn';
import { getAuthContext } from '../../../utils/custom-utils/authHelper';
import { formatNow, formatTimestamp } from '../../../utils/custom-utils/formatters';
import {
  runPerformanceAudit,
  benchmarkInMemory,
  applyRemediationsToValue,
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
  setViewHiddenColumnsDirect,
  applyRemediationsToBase,
  createSandboxCopy,
  getSandboxToken,
  waitForApiGatewayReady,
  buildSandboxSDK,
  pollMetadataUntilApplied,
  ApplyPostCondition,
  renameBase,
  deleteBase,
  createSandboxFullCopy,
  ExportBaseError,
  scanColumnReferences,
  findNowRulelessViews,
  computeCostPerRowTags,
} from '../../../utils/custom-utils/performanceAuditRunner';
// Side-effect imports: expose window.__perfAuditTest{1,1b,2,3,4,7} for
// console-driven diagnostics. See the respective files.
import '../../../utils/custom-utils/performanceAuditTest1';
import '../../../utils/custom-utils/performanceAuditTest1b';
import '../../../utils/custom-utils/performanceAuditTest2';
import '../../../utils/custom-utils/performanceAuditTest3';
import '../../../utils/custom-utils/performanceAuditTest4';
import '../../../utils/custom-utils/performanceAuditTest7';
import { DEFAULT_ROW_ARCHIVAL_DAYS } from '../../../utils/custom-interfaces/AuditTypes';
import { showToast } from '../shared/showToast';
import { createSnapshot } from '../shared/createSnapshot';
import ContextMenu from '../shared/ContextMenu';
import PercentBar from '../shared/PercentBar';
import ImpactBadge, { DeltaBadge } from '../shared/ImpactBadge';
import { MIN_RELEVANT_PCT, impactBandFromPct } from '../shared/impactBands';
import PerfIcon from '../shared/PerfIcon';
import { deleteColumnDirect, deleteViewDirect } from '../shared/sdkActions';
import { COLUMN_TYPE_ICONS } from '../shared/columnTypeIcons';
import ViewVisibilityDrill from '../shared/ViewVisibilityDrill';
import CandidateExpansion, { hasCandidateExpansionContent } from '../shared/CandidateExpansion';
import { buildCandidateMenuExtras } from '../shared/candidateMenu';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';

// ---------------------------------------------------------------------------
// Types & cache
// ---------------------------------------------------------------------------

export interface SavedPerformanceAudit {
  result: PerformanceAuditResult;
  date: string;
  tests: PerformanceTest[];
  // Map serialized as entries for JSON persistence
  remediations?: Array<[string, RemediationAction]>;
  // Staged view deletions, serialized as entries for JSON persistence. Key is
  // `${tableId}:${viewId}`. Value carries the metadata needed to rebuild a
  // RemediatedView when the test is created.
  remediationViews?: Array<[string, RemediatedView]>;
  // Staged hide-in-view entries, serialized as entries. Key is `${tableId}:${columnKey}`.
  // Each entry's `views` field accumulates the views in which the column should be
  // hidden — toggling a single (column, view) pair edits the array on the entry.
  remediationHides?: Array<[string, RemediatedColumnHide]>;
  // Threshold used at the time of this run — lets PluginSettings detect when the
  // user has changed the setting since and prompt for a rerun.
  rowArchivalThresholdDaysAtRun?: number;
}

interface PerformanceAuditProps {
  accountToken: string;
  presetId: string;
  rerunAt?: number;
  autoRerun?: boolean;
  savedAudit?: SavedPerformanceAudit | null;
  onSaveAudit?: (data: SavedPerformanceAudit) => void;
  // Row archival threshold in days. Defaults applied at audit-run time if undefined.
  rowArchivalThresholdDays?: number;
  // Subset of table IDs the host wants audited. Undefined / null / empty
  // means "audit all tables". When narrowed, the runner skips non-selected
  // tables in scan / cost / view-rows / archival emission, and a useMemo on
  // the rendered result filters cached audits by the same set so toggling the
  // selection between runs gives a consistent view without forcing a rerun.
  selectedTableIds?: string[] | null;
  // When true, this component is rendered inside another audit (Tables audit's
  // Performance analysis area). Suppresses auto-run on mount and on preset change —
  // the host provides its own Run button. Also swaps the full-height column layout
  // for a natural flow so the host can frame it.
  embedded?: boolean;
  // Fires whenever the internal audit result changes (including initial load from
  // savedAudit). Tables audit uses this to mirror the result up and pass it to
  // per-table tabs for enrichment.
  onResultChange?: (result: PerformanceAuditResult | null, date: string) => void;
  // Fires on status transitions (idle → running → done/error). Lets the host disable
  // the Run button while an audit is in flight.
  onStatusChange?: (status: AuditStatus) => void;
  // Fires true while a background operation (freeze-now, unfreeze) is in flight.
  // Separate from onStatusChange because these are NOT audit runs — they're
  // single-column mutations triggered from the candidate menu. The host uses
  // this to surface the same header spinner without conflating with `status`.
  onBusyChange?: (busy: boolean) => void;
  // Fires whenever the in-component "tables we deleted archival rows from since the
  // last perf rerun" set changes. The host uses this to render strikethrough state
  // on per-table tabs (tabs are siblings of the embedded PerformanceAudit, not
  // children, so they can't read the state directly).
  onDeletedArchivalTableIdsChange?: (ids: Set<string>) => void;
  // Fires whenever the union of session-frozen + persisted-frozen keys changes
  // (`${tableId}:${columnKey}` format). Mirrored up so per-table tabs can render
  // the same frozen treatment Overview's CandidateRow uses (strikethrough +
  // "frozen" label + suppressed menu).
  onFrozenKeysChange?: (keys: Set<string>) => void;
  // Fires whenever the audit's progressMsg changes. Lets the host render the
  // running spinner + step text in its own header, instead of in the embedded
  // body — useful when the host wants progress visible regardless of which tab
  // is active.
  onProgressChange?: (msg: string) => void;
  // Fires whenever the staged column-remediation map changes. The host mirrors
  // this so per-table tabs (TableTab) can render menu labels reactively (Stage /
  // Unstage) without reading the imperative handle.
  onStagedColumnsChange?: (m: Map<string, RemediationAction>) => void;
  // Same as onStagedColumnsChange, for view-deletion staging.
  onStagedViewsChange?: (m: Map<string, RemediatedView>) => void;
  // Same as onStagedColumnsChange, for hide-in-view staging.
  onStagedHidesChange?: (m: Map<string, RemediatedColumnHide>) => void;
  // Mirrors the local per-view visibility edits so per-table tabs (TableTab)
  // can render the slider state + "(unsaved)" mention reactively.
  onViewEditsChange?: (m: Map<string, Set<string>>) => void;
  // Per-table audit results from the host's tables audit. When provided, the
  // top-of-overview key figures (Tables / Rows / Columns / Views) are summed
  // from this instead of the perf audit's own archival data — so they refresh
  // on a tables-audit rerun, not only on a perf-test rerun.
  tablesAuditResults?: TableAuditResult[];
  // When provided, the perf audit awaits this callback BEFORE starting its own
  // run. Used by the Tables audit host to rerun the tables audit first so the
  // two surfaces stay in sync (impact badges, candidate lists, view weights all
  // come from the same snapshot). The callback receives a progress reporter so
  // tables-audit messages can flow through the perf-audit's single spinner
  // (instead of triggering a separate spinner that would unmount the embedded
  // PerformanceAudit mid-chain). Failures in the callback don't block the perf
  // audit — it proceeds even if the tables audit had a hiccup.
  onRequestTablesAuditRerun?: (onProgress: (msg: string) => void) => Promise<void>;
}

// Imperative handle exposed via ref, used by the Tables audit host to trigger an
// audit run from its own "Run performance analysis" button, and to invoke the
// archival actions from per-table tabs (modals are owned by this component but
// triggered from the host's table tabs by tableId).
export interface PerformanceAuditHandle {
  run: () => void;
  status: AuditStatus;
  // Open the "Create archival view" flow for the given table. No-op if the table
  // has no archival data in the most recent audit result.
  createArchivalViewForTable: (tableId: string) => void;
  // Open the "Delete with snapshot" flow for the given table. No-op if the table
  // has no archival data in the most recent audit result.
  deleteArchivalRowsForTable: (tableId: string) => void;
  // Mark a candidate column as "replace by static data" in the remediations map.
  // Idempotent — sets the action regardless of prior state. Used by per-table tabs
  // (TableTab) so the user can pick the same option that's offered in the Overview.
  selectColumnForReplacement: (tableId: string, columnKey: string) => void;
  // Toggle a column's stage-delete state. When set, applies to test sandbox + apply.
  toggleColumnDelete: (tableId: string, columnKey: string) => void;
  // Toggle a view's stage-delete state. Payload carries the metadata needed to
  // assemble a RemediatedView at test creation time.
  toggleViewDelete: (payload: RemediatedView) => void;
  // True if the column is currently staged with the given action (or any if action omitted).
  isColumnStaged: (tableId: string, columnKey: string, action?: RemediationAction) => boolean;
  // True if the view is currently staged for deletion.
  isViewStaged: (tableId: string, viewId: string) => boolean;
  // Drop a staged column/view if present. Used by direct-delete handlers in
  // sibling surfaces (TableTab) to keep the staging set consistent after a
  // direct mutation. No-op if the entity wasn't staged.
  unstageColumn: (tableId: string, columnKey: string) => void;
  unstageView: (tableId: string, viewId: string) => void;
  // Toggle a (column, view) hide pair. Mutually exclusive with delete/replace
  // for the column — toggling clears any column action for that key.
  toggleHideInView: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string,
    view: { viewId: string; viewName: string }
  ) => void;
  isHideStaged: (tableId: string, columnKey: string, viewId: string) => boolean;
  unstageAllHidesForColumn: (tableId: string, columnKey: string) => void;
  // Set / clear the local desired hidden_columns set for a view. The set is
  // shared across surfaces (per-candidate drill + per-view slider expansion).
  setViewEdit: (viewId: string, hidden: Set<string>) => void;
  clearViewEdit: (viewId: string) => void;
  // Stage / Apply this column's visibility edits across all dirty views.
  // Used by both Overview's CandidateRow three-dots and TableTab's Columns
  // three-dots when the column is a perf candidate.
  stageColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  applyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => Promise<void>;
}

const perfResultCache: Record<string, SavedPerformanceAudit> = {};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PerformanceAudit = forwardRef<PerformanceAuditHandle, PerformanceAuditProps>(
  (
    {
      accountToken,
      presetId,
      rerunAt,
      autoRerun,
      savedAudit,
      onSaveAudit,
      rowArchivalThresholdDays,
      selectedTableIds,
      embedded = false,
      onResultChange,
      onStatusChange,
      onBusyChange,
      onDeletedArchivalTableIdsChange,
      onFrozenKeysChange,
      onProgressChange,
      onStagedColumnsChange,
      onStagedViewsChange,
      onStagedHidesChange,
      onViewEditsChange,
      tablesAuditResults,
      onRequestTablesAuditRerun,
    },
    ref
  ) => {
    const cached = perfResultCache[presetId] || savedAudit;
    // Rehydrate `costByKey` if the cache came from JSON-serialized settings —
    // a Map round-trips through JSON as `{}`, so without this the sandbox tests
    // see an empty cost map after a page reload and produce nonsense deltas.
    // Settings round-trip stores entries as a `[string, number][]` shape on
    // the same field name; both forms are handled here.
    const cachedResult = cached?.result
      ? {
          ...cached.result,
          costByKey:
            cached.result.costByKey instanceof Map
              ? cached.result.costByKey
              : new Map<string, number>(
                  Array.isArray(cached.result.costByKey)
                    ? (cached.result.costByKey as Array<[string, number]>)
                    : []
                ),
        }
      : null;
    const [result, setResult] = useState<PerformanceAuditResult | null>(cachedResult);
    const [status, setStatus] = useState<AuditStatus>(cached ? 'done' : 'idle');
    const [progressMsg, setProgressMsg] = useState('');
    const [auditDate, setAuditDate] = useState<string>(cached?.date || '');
    const hasAutoRun = useRef(!!cached);
    const lastRerunAt = useRef<number | undefined>(rerunAt);

    // Sandbox state — currently only used to track benchmark status. Phase 3 will wire
    // this back into a real sandbox copy for manual inspection.
    const [sandbox, setSandbox] = useState<SandboxState>({ status: 'idle' });
    const [remediations, setRemediations] = useState<Map<string, RemediationAction>>(
      () => new Map(cached?.remediations || [])
    );
    // Staged view deletions, keyed by `${tableId}:${viewId}`. The value carries
    // the metadata needed to assemble a RemediatedView at test-creation time.
    const [viewRemediations, setViewRemediations] = useState<Map<string, RemediatedView>>(
      () => new Map(cached?.remediationViews || [])
    );
    // Staged hide-in-view entries, keyed by `${tableId}:${columnKey}`. Each
    // entry's `views` array accumulates the views the column should be hidden
    // in. Toggling a single (column, view) pair edits the array; the entry is
    // dropped when its array becomes empty.
    const [hideRemediations, setHideRemediations] = useState<Map<string, RemediatedColumnHide>>(
      () => new Map(cached?.remediationHides || [])
    );
    // Per-view local visibility edits (desired hidden_columns set per viewId),
    // shared between the per-candidate drill (Overview) and the per-view
    // slider expansion (TableTab + Overview Views section). Toggling a slider
    // in either surface writes to this map, producing the "(unsaved)" mention
    // until the user commits via "Stage update view" or "Update view now".
    // Not persisted — local edits are ephemeral by design.
    const [viewEdits, setViewEdits] = useState<Map<string, Set<string>>>(new Map());
    const [tests, setTests] = useState<PerformanceTest[]>(cached?.tests || []);
    const [applyingTestId, setApplyingTestId] = useState<string | null>(null);
    const [applyModalTestId, setApplyModalTestId] = useState<string | null>(null);
    const [copyModalTestId, setCopyModalTestId] = useState<string | null>(null);
    const [deleteModalTestId, setDeleteModalTestId] = useState<string | null>(null);
    // True while the delete-test modal's "also delete sandbox" path is mid-flight.
    // Disables modal buttons + dismissal so the user can't double-trigger.
    const [deleteModalProcessing, setDeleteModalProcessing] = useState(false);
    // Set when the user clicks "Create archival view" on a row whose table is
    // missing one or both of the ctime/mtime columns needed for the view filter.
    // Not opened for tables that already have both columns — the view is created
    // immediately in that case.
    const [archivalViewModalRow, setArchivalViewModalRow] =
      useState<PerformanceAuditTableArchival | null>(null);
    // Set when the user clicks "Delete with snapshot". The candidate row IDs are
    // re-scanned at modal-open time so the count reflects the current state of
    // the base, not the (possibly stale) audit count. Both `allRowIds` (every
    // archival candidate) and `safeRowIds` (subset with no incoming links) are
    // computed up-front so the modal can offer a scope choice.
    const [archivalDeleteModalRow, setArchivalDeleteModalRow] = useState<{
      archival: PerformanceAuditTableArchival;
      allRowIds: string[];
      safeRowIds: string[];
    } | null>(null);
    // Which subset to delete when both scopes are available. Defaults to 'safe'
    // (conservative). When safeRowIds.length === allRowIds.length there's no
    // distinction and the modal hides the radio.
    const [archivalDeleteScope, setArchivalDeleteScope] = useState<'all' | 'safe'>('safe');
    const [archivalDeleting, setArchivalDeleting] = useState(false);
    // Tables whose archival rows have been deleted in this session — render the
    // RowsSection entry with strikethrough until the next perf audit run, mirroring
    // the deletedViewKeys pattern used for views.
    const [deletedArchivalTableIds, setDeletedArchivalTableIds] = useState<Set<string>>(new Set());
    // Candidate column keys (`${tableId}:${columnKey}`) that have been directly
    // deleted via "Delete column now" since the last audit run. Rendered with
    // strikethrough; cleared when a fresh audit completes.
    const [deletedCandidateKeys, setDeletedCandidateKeys] = useState<Set<string>>(new Set());

    // Multi-array warning gate. The freeze function calls confirmMultiArray
    // when it detects a column will reshape from typed-array to long-text.
    // We park the resolve handle in state, render a modal that calls it on
    // Confirm/Cancel. Promise-based pause inside the apply flow — no other
    // remediations proceed until the user has answered.
    const [multiArrayModalState, setMultiArrayModalState] = useState<{
      info: { tableName: string; columnName: string; rowCount: number; arrayType?: string };
      resolve: (confirmed: boolean) => void;
    } | null>(null);

    // Frozen-columns state (Phase B). Records persisted in plugin settings —
    // refreshCounter bumps after unfreeze to force the useMemo re-read.
    const [frozenRefreshCounter, setFrozenRefreshCounter] = useState(0);
    const [unfreezingKey, setUnfreezingKey] = useState<string | null>(null);
    const [freezingNowKey, setFreezingNowKey] = useState<string | null>(null);
    // Rows whose Unfreeze just succeeded but the audit hasn't been rerun yet.
    // We keep these visible (strikethrough) instead of forcing an auto-rerun —
    // batching multiple unfreezes into one rerun is much faster on big bases.
    // Cleared when status transitions from running → done (audit completes).
    const [pendingUnfrozen, setPendingUnfrozen] = useState<Map<string, FrozenColumnRecord>>(
      new Map()
    );
    // Column full-keys (`${tableId}:${columnKey}`) of columns frozen via the
    // direct "Freeze column now" action since the last audit completion. Used
    // only as an "audit is stale" signal — the columns themselves are already
    // in `frozenColumns`. Cleared when status transitions to done.
    const [pendingFrozenNow, setPendingFrozenNow] = useState<Set<string>>(new Set());
    const frozenColumns = useMemo<Record<string, FrozenColumnRecord>>(() => {
      try {
        const settings = (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME);
        return settings?.frozenColumns || {};
      } catch {
        return {};
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frozenRefreshCounter]);

    // Union of "frozen this session" + "persisted as frozen". Used to drive
    // strikethrough + action labels on candidate rows. Without the persisted
    // half, a candidate that's frozen in plugin settings but unknown to the
    // session (e.g. after a plugin refresh before re-running the audit) would
    // render as if it were still a live candidate.
    const allFrozenKeys = useMemo(() => {
      const keys = new Set<string>(pendingFrozenNow);
      for (const fc of Object.values(frozenColumns)) {
        keys.add(`${fc.tableId}:${fc.columnKey}`);
      }
      return keys;
    }, [pendingFrozenNow, frozenColumns]);

    // True iff a persisted freeze post-dates the last audit run. This survives
    // a plugin refresh, so the "Performance analysis is outdated" rerun link
    // shows after refresh too — not just within the session that did the freeze.
    const hasStaleFreezeAcrossSessions = useMemo(() => {
      if (!auditDate) return false;
      const auditTime = new Date(auditDate).getTime();
      if (Number.isNaN(auditTime)) return false;
      return Object.values(frozenColumns).some((fc) => {
        if (!fc.frozenAt) return false;
        const frozenTime = new Date(fc.frozenAt).getTime();
        return !Number.isNaN(frozenTime) && frozenTime > auditTime;
      });
    }, [auditDate, frozenColumns]);

    // Orphans = freeze-mechanism artifacts no longer paired with a healthy
    // FrozenColumnRecord ↔ live-column relationship. Two patterns:
    //   • `stale`: settings record points at a column that no longer exists
    //              (user deleted the frozen column via the SeaTable UI).
    //   • `stranded`: a `_frozen_*` / `_frozenLink_*` helper column exists in
    //                 the base but no settings record references it.
    // Each gets a one-click cleanup; pendingCleanupOrphan stores the row
    // currently being worked on so we can dim it + serialise the action.
    const [pendingCleanupOrphan, setPendingCleanupOrphan] = useState<string | null>(null);
    const [pendingDeletedOrphans, setPendingDeletedOrphans] = useState<Set<string>>(new Set());
    type Orphan =
      | {
          kind: 'stale';
          key: string;
          record: FrozenColumnRecord;
        }
      | {
          kind: 'stranded';
          key: string;
          tableId: string;
          tableName: string;
          columnKey: string;
          columnName: string;
        };
    const orphans = useMemo<Orphan[]>(() => {
      const out: Orphan[] = [];
      try {
        const tables: any[] = (window as any).dtableSDK?.getTables?.() || [];
        const tableById: Record<string, any> = {};
        for (const t of tables) tableById[t._id] = t;

        // Stale settings entries: settings has a record whose column key isn't
        // present in the base anymore (manual delete bypassing our Unfreeze).
        for (const [key, record] of Object.entries(frozenColumns)) {
          if (pendingDeletedOrphans.has(`stale:${key}`)) continue;
          const tbl = tableById[record.tableId];
          if (!tbl) {
            out.push({ kind: 'stale', key, record });
            continue;
          }
          const col = (tbl.columns || []).find((c: any) => c.key === record.columnKey);
          if (!col) out.push({ kind: 'stale', key, record });
        }

        // Stranded helpers: columns whose name marks them as freeze artifacts
        // but no settings record references their key.
        const referencedKeys = new Set<string>();
        for (const record of Object.values(frozenColumns)) {
          if (record.snapshotColumnKey) {
            referencedKeys.add(`${record.tableId}:${record.snapshotColumnKey}`);
          }
          if (record.selfLinkColumnKey) {
            referencedKeys.add(`${record.tableId}:${record.selfLinkColumnKey}`);
          }
        }
        for (const tbl of tables) {
          for (const col of tbl.columns || []) {
            const name: string = col.name || '';
            const looksLikeHelper = name.startsWith('_frozen_') || name.startsWith('_frozenLink_');
            if (!looksLikeHelper) continue;
            const fullKey = `${tbl._id}:${col.key}`;
            if (referencedKeys.has(fullKey)) continue;
            const dedupKey = `stranded:${fullKey}`;
            if (pendingDeletedOrphans.has(dedupKey)) continue;
            out.push({
              kind: 'stranded',
              key: dedupKey,
              tableId: tbl._id,
              tableName: tbl.name,
              columnKey: col.key,
              columnName: name,
            });
          }
        }
      } catch {
        // ignore
      }
      return out;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frozenColumns, frozenRefreshCounter, pendingDeletedOrphans, result]);

    const handleCleanupOrphan = async (orphan: Orphan) => {
      if (pendingCleanupOrphan) return;
      setPendingCleanupOrphan(orphan.key);
      try {
        const auth = await getAuthContext();
        if (!auth) {
          showToast('Cleanup failed: missing auth context');
          return;
        }
        const { httpDeleteColumn } = await import('../../../utils/custom-utils/freezeColumn');
        if (orphan.kind === 'stale') {
          // Best-effort delete of the helper columns the stale record references —
          // they may already be gone, in which case the 404 is just noise.
          const { record } = orphan;
          if (record.snapshotColumnKey) {
            await httpDeleteColumn(
              auth.serverUrl,
              auth.dtableUuid,
              auth.accessToken,
              record.tableName,
              record.snapshotColumnKey,
              90 * 1000
            );
          }
          // Only delete the self-link if no other settings entry shares it.
          if (record.selfLinkColumnKey) {
            const otherRefs = Object.entries(frozenColumns).filter(
              ([k, fc]) =>
                k !== orphan.key &&
                fc.tableId === record.tableId &&
                fc.selfLinkColumnKey === record.selfLinkColumnKey
            ).length;
            if (otherRefs === 0) {
              await httpDeleteColumn(
                auth.serverUrl,
                auth.dtableUuid,
                auth.accessToken,
                record.tableName,
                record.selfLinkColumnKey,
                90 * 1000
              );
            }
          }
          // Clear the settings entry.
          try {
            const current = (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME) || {};
            const existing: Record<string, FrozenColumnRecord> = current.frozenColumns || {};
            const updated = { ...existing };
            delete updated[orphan.key];
            (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
              ...current,
              frozenColumns: updated,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[performance-audit] failed to clear stale entry:', e);
          }
          showToast(
            intl
              .get('performance.orphan_cleaned', { name: orphan.record.columnName })
              .d(`Cleaned up stale entry for ${orphan.record.columnName}`)
          );
        } else {
          // stranded helper: just delete the column.
          const res = await httpDeleteColumn(
            auth.serverUrl,
            auth.dtableUuid,
            auth.accessToken,
            orphan.tableName,
            orphan.columnKey,
            90 * 1000
          );
          if (!res.ok && res.status !== 404) {
            showToast(`Cleanup failed: HTTP ${res.status}`);
            return;
          }
          showToast(
            intl
              .get('performance.orphan_helper_deleted', { name: orphan.columnName })
              .d(`Deleted helper column ${orphan.columnName}`)
          );
        }
        setPendingDeletedOrphans((prev) => {
          const next = new Set(prev);
          next.add(orphan.key);
          return next;
        });
        setFrozenRefreshCounter((c) => c + 1);
      } catch (e: any) {
        showToast(`Cleanup failed: ${e?.message || e}`);
      } finally {
        setPendingCleanupOrphan(null);
      }
    };
    // When the audit finishes, drop the pending-unfrozen rows — the rerun has
    // picked up the unfrozen columns into the live candidate list, so the
    // strikethrough placeholder is no longer needed.
    const prevStatusRef = useRef(status);
    useEffect(() => {
      if (prevStatusRef.current === 'running' && status === 'done') {
        setPendingUnfrozen(new Map());
        setPendingFrozenNow(new Set());
        // Orphan deletions land in the audit's fresh SDK snapshot — drop the
        // optimistic "already gone" set so we recompute against live state.
        setPendingDeletedOrphans(new Set());
      }
      prevStatusRef.current = status;
    }, [status]);

    // Refs for persistence access without triggering dep cycles
    const remediationsRef = useRef(remediations);
    const viewRemediationsRef = useRef(viewRemediations);
    const hideRemediationsRef = useRef(hideRemediations);
    const testsRef = useRef(tests);
    useEffect(() => {
      remediationsRef.current = remediations;
    }, [remediations]);
    useEffect(() => {
      viewRemediationsRef.current = viewRemediations;
    }, [viewRemediations]);
    useEffect(() => {
      hideRemediationsRef.current = hideRemediations;
    }, [hideRemediations]);
    useEffect(() => {
      testsRef.current = tests;
    }, [tests]);

    // -------------------------------------------------------------------------
    // Persist helper — saves audit result + tests + draft remediations
    // -------------------------------------------------------------------------

    const rowArchivalThresholdDaysRef = useRef(rowArchivalThresholdDays);
    rowArchivalThresholdDaysRef.current = rowArchivalThresholdDays;

    // Snapshot of `selectedTableIds` for closures — doAudit and the three
    // benchmarkInMemory callsites are memoized on `[presetId]`, so a direct
    // capture would freeze the selection at first render. Read through the
    // ref to always pick up the host's latest selection.
    const selectedTableIdsRef = useRef(selectedTableIds);
    selectedTableIdsRef.current = selectedTableIds;

    // Read savedAudit through a ref so the persist callback below (memoized on
    // [presetId]) sees the latest persisted value rather than the one captured
    // at mount. Without this, the auto-persist that fires when doAudit resets
    // remediations/tests would overwrite a freshly saved threshold with the
    // stale closure-captured one — which kept the staleness notification on.
    const savedAuditRef = useRef(savedAudit);
    savedAuditRef.current = savedAudit;

    const persist = useCallback(
      (
        auditResult: PerformanceAuditResult,
        date: string,
        testList: PerformanceTest[],
        remediationsMap?: Map<string, RemediationAction>,
        thresholdAtRun?: number,
        viewRemediationsMap?: Map<string, RemediatedView>,
        hideRemediationsMap?: Map<string, RemediatedColumnHide>
      ) => {
        const rem = remediationsMap ?? remediationsRef.current;
        const viewRem = viewRemediationsMap ?? viewRemediationsRef.current;
        const hideRem = hideRemediationsMap ?? hideRemediationsRef.current;
        // Serialize costByKey as entries — the Map type doesn't round-trip
        // through JSON.stringify when settings are pushed to the SeaTable
        // store. The hydration path at component init handles both shapes.
        const persistedResult: any = {
          ...auditResult,
          costByKey:
            auditResult.costByKey instanceof Map
              ? Array.from(auditResult.costByKey.entries())
              : auditResult.costByKey,
        };
        const data: SavedPerformanceAudit = {
          result: persistedResult,
          date,
          tests: testList,
          remediations: rem.size > 0 ? Array.from(rem.entries()) : undefined,
          remediationViews: viewRem.size > 0 ? Array.from(viewRem.entries()) : undefined,
          remediationHides: hideRem.size > 0 ? Array.from(hideRem.entries()) : undefined,
          // Freeze the threshold value used. Non-audit changes (remediations, tests)
          // preserve whatever was saved previously; audit runs overwrite with the
          // value that was just used.
          rowArchivalThresholdDaysAtRun:
            thresholdAtRun ??
            savedAuditRef.current?.rowArchivalThresholdDaysAtRun ??
            rowArchivalThresholdDaysRef.current ??
            DEFAULT_ROW_ARCHIVAL_DAYS,
        };
        perfResultCache[presetId] = data;
        if (onSaveAudit) onSaveAudit(data);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [presetId]
    );

    // Auto-persist when remediations or tests change after the initial audit is loaded.
    useEffect(() => {
      if (!result || !auditDate) return;
      persist(
        result,
        auditDate,
        testsRef.current,
        remediations,
        undefined,
        viewRemediations,
        hideRemediations
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remediations, viewRemediations, hideRemediations, tests]);

    // -------------------------------------------------------------------------
    // Run initial audit (benchmark + detect candidates)
    // -------------------------------------------------------------------------

    // Stable reference so we don't re-create doAudit when the host's callback
    // identity changes (which it would on every parent render otherwise).
    const onRequestTablesAuditRerunRef = useRef(onRequestTablesAuditRerun);
    useEffect(() => {
      onRequestTablesAuditRerunRef.current = onRequestTablesAuditRerun;
    }, [onRequestTablesAuditRerun]);

    const doAudit = useCallback(
      (silent = false) => {
        if (!silent) {
          setStatus('running');
          setProgressMsg(intl.get('performance.starting').d('Starting performance audit...'));
        }

        setTimeout(
          async () => {
            try {
              // When the host (TablesAudit) provides a tables-audit rerun hook,
              // run it first so both audits share the same data snapshot — keeps
              // the perf audit's candidate list, badges, and view weights in
              // sync with the tables audit. Tables-audit progress messages flow
              // through this component's setProgressMsg (prefixed for clarity)
              // so a single spinner stays visible across the whole chain.
              // Errors don't block the perf flow.
              if (onRequestTablesAuditRerunRef.current) {
                if (!silent) {
                  setProgressMsg(
                    intl
                      .get('performance.rerunning_tables_audit_first')
                      .d('Rerunning tables audit first...')
                  );
                }
                try {
                  await onRequestTablesAuditRerunRef.current((msg) => {
                    if (!silent) {
                      setProgressMsg(
                        intl
                          .get('performance.tables_audit_progress', { msg })
                          .d(`Tables audit: ${msg}`)
                      );
                    }
                  });
                } catch (e: any) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    '[performance-audit] tables-audit rerun threw; proceeding anyway:',
                    e
                  );
                }
              }
              // Read threshold via the ref so a rerun-from-settings flow sees the
              // value the user just changed, not the value captured when doAudit
              // was first memoized.
              const thresholdNow = rowArchivalThresholdDaysRef.current ?? DEFAULT_ROW_ARCHIVAL_DAYS;
              const auditResult = await runPerformanceAudit(
                (msg) => {
                  if (!silent) setProgressMsg(msg);
                },
                thresholdNow,
                selectedTableIdsRef.current
              );
              const now = formatNow();
              setResult(auditResult);
              setAuditDate(now);
              setStatus('done');
              // Spreadsheet-friendly export for Playwright comparison.
              // The Playwright research script (pending team validation, see
              // project_validation_decision_pending.md) measures real per-view
              // click-to-spinner-gone times; this dump is what gets pasted next
              // to the script's column to compute R² between theoretical and
              // observed UX. Names list pastes once into a fixed column; the
              // value lists paste into adjacent columns aligned by row order.
              try {
                const fmt = (n?: number) => (n === undefined || n === null ? '' : n.toFixed(2));

                // ---- Candidates: names + measured cost (ms) ----
                const sortedCands = [...auditResult.candidates].sort(
                  (a, b) =>
                    a.tableName.localeCompare(b.tableName) ||
                    a.columnName.localeCompare(b.columnName)
                );
                const candNames = sortedCands.map((c) => `${c.tableName}\t${c.columnName}`);
                const candCosts = sortedCands.map((c) => fmt(c.measuredCostMs));
                // eslint-disable-next-line no-console
                console.log(
                  `=== Perf audit @ ${now} — Candidate names (table\\tcolumn) ===\n` +
                    candNames.join('\n')
                );
                // eslint-disable-next-line no-console
                console.log(
                  `=== Perf audit @ ${now} — Candidate cost (ms) ===\n` + candCosts.join('\n')
                );

                // ---- Views: names + theoretical ms (the predicted side; Playwright supplies the observed side) ----
                const views = auditResult.views || [];
                const sortedViews = [...views].sort(
                  (a, b) =>
                    a.tableName.localeCompare(b.tableName) || a.viewName.localeCompare(b.viewName)
                );
                const viewNames = sortedViews.map((v) => `${v.tableName}\t${v.viewName}`);
                const viewTheoretical = sortedViews.map((v) => fmt(v.theoreticalCostMs));
                // eslint-disable-next-line no-console
                console.log(
                  `=== Perf audit @ ${now} — View names (table\\tview) ===\n` + viewNames.join('\n')
                );
                // eslint-disable-next-line no-console
                console.log(
                  `=== Perf audit @ ${now} — View theoretical cost (ms) ===\n` +
                    viewTheoretical.join('\n')
                );
              } catch {
                // diagnostics only — never let logging break the audit
              }
              // Fresh audit reflects post-deletion counts — clear the strikethrough
              // markers so the new numbers display normally.
              setDeletedArchivalTableIds(new Set());
              setDeletedCandidateKeys(new Set());
              // Reset candidate selections and per-audit sandbox results, but keep the sandbox
              // itself — it's a standalone copy the user explicitly created and can reuse or
              // delete manually. Column keys tied to the old audit no longer match the new one.
              setRemediations(new Map());
              setViewRemediations(new Map());
              setHideRemediations(new Map());
              setTests([]);
              persist(auditResult, now, [], new Map(), thresholdNow, new Map(), new Map());
            } catch (err: any) {
              if (!silent) {
                setProgressMsg(`Error: ${err.message}`);
                setStatus('error');
              }
            }
          },
          silent ? 0 : 50
        );
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [presetId, persist]
    );

    useEffect(() => {
      // In embedded mode the host (Tables audit) owns the trigger — don't auto-run.
      if (embedded) return;
      if (!hasAutoRun.current || autoRerun) {
        hasAutoRun.current = true;
        doAudit();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Per-table archival actions are owned by this component (modals, state) but the
    // imperative handle below has to be set up before the action handlers are defined.
    // Dispatch through a ref that gets updated each render with the latest handlers
    // so the host can trigger the actions for any table by id.
    const archivalDispatchRef = useRef<{
      create: (tableId: string) => void;
      delete: (tableId: string) => void;
    }>({ create: () => {}, delete: () => {} });

    // Expose an imperative handle so the Tables audit host can trigger a run, read
    // current status from its own "Run performance analysis" button, and trigger
    // archival actions from per-table tabs.
    useImperativeHandle(
      ref,
      () => ({
        run: () => doAudit(),
        status,
        createArchivalViewForTable: (tableId: string) =>
          archivalDispatchRef.current.create(tableId),
        deleteArchivalRowsForTable: (tableId: string) =>
          archivalDispatchRef.current.delete(tableId),
        selectColumnForReplacement: (tableId: string, columnKey: string) =>
          setColumnAction(`${tableId}:${columnKey}`, 'replace-static'),
        toggleColumnDelete: (tableId: string, columnKey: string) =>
          toggleColumnAction(`${tableId}:${columnKey}`, 'delete'),
        toggleViewDelete: (payload: RemediatedView) =>
          toggleViewRemediation(`${payload.tableId}:${payload.viewId}`, payload),
        isColumnStaged: (tableId: string, columnKey: string, action?: RemediationAction) => {
          const cur = remediationsRef.current.get(`${tableId}:${columnKey}`);
          if (!cur) return false;
          return action ? cur === action : true;
        },
        isViewStaged: (tableId: string, viewId: string) =>
          viewRemediationsRef.current.has(`${tableId}:${viewId}`),
        unstageColumn: (tableId: string, columnKey: string) => {
          const k = `${tableId}:${columnKey}`;
          setRemediations((prev) => {
            if (!prev.has(k)) return prev;
            const next = new Map(prev);
            next.delete(k);
            return next;
          });
        },
        unstageView: (tableId: string, viewId: string) => {
          const k = `${tableId}:${viewId}`;
          setViewRemediations((prev) => {
            if (!prev.has(k)) return prev;
            const next = new Map(prev);
            next.delete(k);
            return next;
          });
        },
        setViewEdit: (viewId: string, hidden: Set<string>) => {
          setViewEdits((prev) => {
            const next = new Map(prev);
            next.set(viewId, hidden);
            return next;
          });
        },
        clearViewEdit: (viewId: string) => {
          setViewEdits((prev) => {
            if (!prev.has(viewId)) return prev;
            const next = new Map(prev);
            next.delete(viewId);
            return next;
          });
        },
        toggleHideInView: toggleHideRemediation,
        isHideStaged: (tableId: string, columnKey: string, viewId: string) => {
          const entry = hideRemediationsRef.current.get(`${tableId}:${columnKey}`);
          return !!entry?.views.some((v) => v.viewId === viewId);
        },
        unstageAllHidesForColumn: (tableId: string, columnKey: string) => {
          const k = `${tableId}:${columnKey}`;
          setHideRemediations((prev) => {
            if (!prev.has(k)) return prev;
            const next = new Map(prev);
            next.delete(k);
            return next;
          });
        },
        stageColumnVisibility: handleStageColumnVisibility,
        applyColumnVisibility: handleApplyColumnVisibility,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [doAudit, status]
    );

    // Notify the host of result changes so it can enrich per-table tabs with the same
    // data (measured column costs, view row counts). Fires on initial mount with the
    // cached/saved result, and again whenever an audit run completes.
    useEffect(() => {
      if (onResultChange) onResultChange(result, auditDate);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, auditDate]);

    useEffect(() => {
      if (onStatusChange) onStatusChange(status);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    // Mirror freeze-now / unfreeze in-flight state up so the host can show its
    // header spinner during these single-column ops too.
    useEffect(() => {
      if (onBusyChange) onBusyChange(freezingNowKey !== null || unfreezingKey !== null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [freezingNowKey, unfreezingKey]);

    // Mirror the union of session + persisted frozen keys up so per-table tabs
    // can render the same strikethrough/"frozen" treatment as Overview.
    useEffect(() => {
      if (onFrozenKeysChange) onFrozenKeysChange(allFrozenKeys);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allFrozenKeys]);

    // Mirror the deleted-archival set up to the host so per-table tabs can render
    // strikethrough on the archival cell after a delete.
    useEffect(() => {
      if (onDeletedArchivalTableIdsChange) onDeletedArchivalTableIdsChange(deletedArchivalTableIds);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deletedArchivalTableIds]);

    // Mirror staged column- and view-remediation maps up to the host so TableTab
    // can render menu labels reactively (Stage vs Unstage).
    useEffect(() => {
      if (onStagedColumnsChange) onStagedColumnsChange(remediations);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remediations]);
    useEffect(() => {
      if (onStagedViewsChange) onStagedViewsChange(viewRemediations);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewRemediations]);
    useEffect(() => {
      if (onStagedHidesChange) onStagedHidesChange(hideRemediations);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hideRemediations]);
    useEffect(() => {
      if (onViewEditsChange) onViewEditsChange(viewEdits);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewEdits]);

    // Mirror the live progress message up so embedding hosts can render the running
    // spinner + step text in their own header (TablesAudit does this).
    useEffect(() => {
      if (onProgressChange) onProgressChange(progressMsg);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [progressMsg]);

    useEffect(() => {
      // Preset-change reruns also skipped in embedded mode — Tables audit handles them.
      if (embedded) return;
      if (rerunAt && rerunAt !== lastRerunAt.current) {
        lastRerunAt.current = rerunAt;
        delete perfResultCache[presetId];
        doAudit();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rerunAt]);

    // -------------------------------------------------------------------------
    // Column selection
    // -------------------------------------------------------------------------

    const setColumnAction = (key: string, action: RemediationAction | null) => {
      setRemediations((prev) => {
        const next = new Map(prev);
        if (action === null) next.delete(key);
        else next.set(key, action);
        return next;
      });
    };

    const toggleColumnAction = (key: string, action: RemediationAction) => {
      setRemediations((prev) => {
        const next = new Map(prev);
        if (prev.get(key) === action) next.delete(key);
        else next.set(key, action);
        return next;
      });
      // Staging delete/replace clears any hide-in-view staging for the same
      // column — those are mutually exclusive (a deleted/replaced column has
      // no hide concept). Skip if we just toggled OFF (the user un-staged).
      setHideRemediations((prev) => {
        if (!prev.has(key)) return prev;
        const wasStaged = remediationsRef.current.get(key) === action;
        if (wasStaged) return prev; // un-staging delete/replace, leave hides alone
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    };

    // Toggle staging of a view deletion. Key is `${tableId}:${viewId}`.
    const toggleViewRemediation = (key: string, payload: RemediatedView) => {
      setViewRemediations((prev) => {
        const next = new Map(prev);
        if (next.has(key)) next.delete(key);
        else next.set(key, payload);
        return next;
      });
    };

    // Toggle staging of "hide column in view" for one (column, view) pair.
    // The map is keyed `${tableId}:${columnKey}`; each entry's `views` array
    // accumulates the views the column should be hidden in. Mutually
    // exclusive with delete/replace-static for the same column — toggling
    // hide on a column staged for delete/replace clears the column action
    // first; staging delete/replace on a hide-staged column clears the
    // hides (handled at toggleColumnAction below by re-checking).
    const toggleHideRemediation = (
      tableId: string,
      tableName: string,
      columnKey: string,
      columnName: string,
      view: { viewId: string; viewName: string }
    ) => {
      const colKey = `${tableId}:${columnKey}`;
      // If the column is currently staged for delete/replace, hide is
      // disallowed — earlier checks at the menu level should prevent this,
      // but be defensive: silently clear the column action.
      setRemediations((prev) => {
        if (!prev.has(colKey)) return prev;
        const next = new Map(prev);
        next.delete(colKey);
        return next;
      });
      setHideRemediations((prev) => {
        const next = new Map(prev);
        const existing = next.get(colKey);
        if (existing) {
          const hasView = existing.views.some((v) => v.viewId === view.viewId);
          const newViews = hasView
            ? existing.views.filter((v) => v.viewId !== view.viewId)
            : [...existing.views, view];
          if (newViews.length === 0) next.delete(colKey);
          else next.set(colKey, { ...existing, views: newViews });
        } else {
          next.set(colKey, {
            tableId,
            tableName,
            columnKey,
            columnName,
            views: [view],
          });
        }
        return next;
      });
    };

    // Direct-delete a candidate column from the live base. Bypasses the test workflow.
    // Strikes through the row visually; clears any staged action for this key. The
    // audit becomes stale until the next rerun (header button or auto-rerun).
    const handleDeleteCandidateNow = (
      tableName: string,
      tableId: string,
      columnName: string,
      columnKey: string
    ) => {
      const ok = deleteColumnDirect(tableName, columnName);
      if (!ok) {
        showToast(intl.get('performance.delete_column_failed').d('Failed to delete column.'));
        return;
      }
      const fullKey = `${tableId}:${columnKey}`;
      setDeletedCandidateKeys((prev) => {
        const next = new Set(prev);
        next.add(fullKey);
        return next;
      });
      setRemediations((prev) => {
        if (!prev.has(fullKey)) return prev;
        const next = new Map(prev);
        next.delete(fullKey);
        return next;
      });
    };

    // Direct one-column freeze. Skips the test/sandbox workflow — goes straight
    // to freezeColumnViaIndirection against the original base, persists the
    // record to plugin settings, and bumps the refresh counter so the Currently
    // frozen section reflects the change immediately. Same audit-staleness
    // pattern as unfreeze: doesn't auto-rerun, the "rerun needed" link below
    // the Currently frozen section handles it.
    const handleFreezeNow = async (
      tableId: string,
      tableName: string,
      columnKey: string,
      columnName: string
    ) => {
      if (freezingNowKey || unfreezingKey) return; // serialize — one freeze/unfreeze at a time
      const fullKey = `${tableId}:${columnKey}`;
      setFreezingNowKey(fullKey);
      setProgressMsg(`Freezing ${columnName}...`);
      try {
        const auth = await getAuthContext();
        if (!auth) {
          showToast('Freeze failed: missing auth context');
          return;
        }
        const dtableSDK = (window as any).dtableSDK;
        const result = await freezeColumnViaIndirection({
          dtableSDK,
          tableName,
          columnName,
          accessToken: auth.accessToken,
          dtableUuid: auth.dtableUuid,
          serverUrl: auth.serverUrl,
          onProgress: (msg) => setProgressMsg(`Freezing ${columnName}: ${msg}`),
          confirmMultiArray: (info) =>
            new Promise<boolean>((resolve) => {
              setMultiArrayModalState({ info, resolve });
            }),
        });
        if (!result.ok) {
          showToast(
            intl
              .get('performance.freeze_now_failed', { error: result.error || 'unknown' })
              .d(`Freeze failed: ${result.error || 'unknown'}`)
          );
          return;
        }
        // Persist to plugin settings.
        try {
          const current = (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME) || {};
          const existing: Record<string, FrozenColumnRecord> = current.frozenColumns || {};
          const updated = {
            ...existing,
            [`${tableId}.${result.lfColumnKey}`]: {
              tableId,
              tableName,
              columnKey: result.lfColumnKey,
              columnName,
              originalData: result.originalData,
              snapshotColumnKey: result.snapshotColumnKey,
              selfLinkColumnKey: result.selfLinkColumnKey,
              selfLinkId: result.selfLinkId,
              shapeMode: result.shapeMode,
              frozenAt: new Date().toISOString(),
            },
          };
          (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
            ...current,
            frozenColumns: updated,
          });
          setFrozenRefreshCounter((c) => c + 1);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[performance-audit] failed to persist frozen entry:', e);
        }
        // Clear any staged remediation for this column (now redundant).
        setRemediations((prev) => {
          if (!prev.has(fullKey)) return prev;
          const next = new Map(prev);
          next.delete(fullKey);
          return next;
        });
        // Mark audit stale until the user reruns.
        setPendingFrozenNow((prev) => {
          const next = new Set(prev);
          next.add(fullKey);
          return next;
        });
        showToast(
          intl.get('performance.frozen_now', { name: columnName }).d(`Frozen ${columnName}`)
        );
      } catch (e: any) {
        showToast(`Freeze failed: ${e?.message || e}`);
      } finally {
        setFreezingNowKey(null);
        setProgressMsg('');
      }
    };

    // -------------------------------------------------------------------------
    // Test lifecycle
    // -------------------------------------------------------------------------

    const isBusy =
      sandbox.status === 'creating' ||
      sandbox.status === 'applying' ||
      sandbox.status === 'benchmarking' ||
      sandbox.status === 'cleaning' ||
      applyingTestId !== null ||
      freezingNowKey !== null ||
      unfreezingKey !== null;

    // Snapshot the current remediations draft into a new pending Test; reset the draft.
    const handleCreateTestCase = () => {
      if (
        !result ||
        (remediations.size === 0 && viewRemediations.size === 0 && hideRemediations.size === 0) ||
        isBusy
      )
        return;

      // Scan once; reuse for all remediations.
      const dtableSDK = (window as any).dtableSDK;
      const refIndex = scanColumnReferences(dtableSDK.dtableStore.value);

      const snapshot: RemediatedColumn[] = [];
      for (const c of result.candidates) {
        const key = `${c.tableId}:${c.columnKey}`;
        const action = remediations.get(key);
        if (!action) continue;
        const rules = refIndex.get(key) || [];
        snapshot.push({
          tableName: c.tableName,
          columnKey: c.columnKey,
          columnName: c.columnName,
          columnType: c.columnType,
          action,
          replacementType: action === 'replace-static' ? c.replacementType : undefined,
          affectedRules: rules.length > 0 ? rules : undefined,
        });
      }

      const viewSnapshot: RemediatedView[] = Array.from(viewRemediations.values());
      const hideSnapshot: RemediatedColumnHide[] = Array.from(hideRemediations.values());

      if (snapshot.length === 0 && viewSnapshot.length === 0 && hideSnapshot.length === 0) return;

      const newTest: PerformanceTest = {
        id: `test-${Date.now()}`,
        createdAt: formatNow(),
        remediations: snapshot,
        remediationViews: viewSnapshot.length > 0 ? viewSnapshot : undefined,
        remediationHides: hideSnapshot.length > 0 ? hideSnapshot : undefined,
        status: 'pending',
      };
      setTests((prev) => [...prev, newTest]);
      setRemediations(new Map());
      setViewRemediations(new Map());
      setHideRemediations(new Map());
    };

    const handleDeleteTest = async (testId: string, deleteSandbox: boolean) => {
      if (isBusy) return;
      const test = testsRef.current.find((t) => t.id === testId);
      // Sandbox cleanup is soft-fail: if the base is already gone or the API
      // hiccups, we still remove the test locally — leaving a deleted test
      // around because the orphan-cleanup failed is worse UX than the rare
      // case of a stranded sandbox base the user can manually delete.
      if (deleteSandbox && test?.lastSandbox && accountToken) {
        setDeleteModalProcessing(true);
        try {
          await deleteBase(accountToken, test.lastSandbox.workspaceId, test.lastSandbox.name);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[performance-audit] sandbox delete failed:', e);
        } finally {
          setDeleteModalProcessing(false);
        }
      }
      setTests((prev) => prev.filter((t) => t.id !== testId));
      setDeleteModalTestId(null);
    };

    // Remove a single remediation from a test. Resets the test's benchmark since the
    // old result no longer matches the smaller remediation set.
    const handleRemoveRemediation = (testId: string, tableName: string, columnKey: string) => {
      if (isBusy) return;
      setTests((prev) =>
        prev.map((t) => {
          if (t.id !== testId) return t;
          const remediations = t.remediations.filter(
            (r) => !(r.tableName === tableName && r.columnKey === columnKey)
          );
          return {
            ...t,
            remediations,
            status: 'pending',
            beforeBenchmark: undefined,
            afterBenchmark: undefined,
            errorMessage: undefined,
          };
        })
      );
    };

    // Same as handleRemoveRemediation, for staged views. Resets the benchmark for
    // the same reason.
    const handleRemoveRemediationView = (testId: string, tableId: string, viewId: string) => {
      if (isBusy) return;
      setTests((prev) =>
        prev.map((t) => {
          if (t.id !== testId) return t;
          const remediationViews = (t.remediationViews || []).filter(
            (v) => !(v.tableId === tableId && v.viewId === viewId)
          );
          return {
            ...t,
            remediationViews: remediationViews.length > 0 ? remediationViews : undefined,
            status: 'pending',
            beforeBenchmark: undefined,
            afterBenchmark: undefined,
            errorMessage: undefined,
          };
        })
      );
    };

    // Remove a (column, view) hide pair from a test. If that pair is the last
    // entry in the column's `views` list, the whole hide entry is dropped.
    const handleRemoveRemediationHide = (
      testId: string,
      tableId: string,
      columnKey: string,
      viewId: string
    ) => {
      if (isBusy) return;
      setTests((prev) =>
        prev.map((t) => {
          if (t.id !== testId) return t;
          const newHides: RemediatedColumnHide[] = [];
          for (const h of t.remediationHides || []) {
            if (h.tableId !== tableId || h.columnKey !== columnKey) {
              newHides.push(h);
              continue;
            }
            const remainingViews = h.views.filter((v) => v.viewId !== viewId);
            if (remainingViews.length > 0) {
              newHides.push({ ...h, views: remainingViews });
            }
          }
          return {
            ...t,
            remediationHides: newHides.length > 0 ? newHides : undefined,
            status: 'pending',
            beforeBenchmark: undefined,
            afterBenchmark: undefined,
            errorMessage: undefined,
          };
        })
      );
    };

    // Internal test runner — no is-busy guard (the public handlers below hold that).
    // Runs entirely in memory: clones the SDK's current value with the test's remediations
    // applied, then times dtable-store's compute on the original vs the clone. No network
    // calls, no sandbox, so the signal is stable and independent of network conditions.
    // `sharedBefore` lets run-all supply a once-measured baseline so every test in the
    // batch compares against the same Before.
    const runTestInternal = async (testId: string, sharedBefore?: BenchmarkTimings) => {
      if (!result) return;
      const test = testsRef.current.find((t) => t.id === testId);
      if (!test) return;

      const updateTest = (patch: Partial<PerformanceTest>) =>
        setTests((prev) => prev.map((t) => (t.id === testId ? { ...t, ...patch } : t)));

      updateTest({ status: 'running', errorMessage: undefined });
      setSandbox({ status: 'benchmarking', runningTestId: testId });
      // Yield so React paints the 'running' state + loader before CPU-heavy compute starts;
      // two frames is usually enough for the status transition + spinner to land.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      try {
        const dtableSDK = (window as any).dtableSDK;
        const baseValue = dtableSDK.dtableStore.value;

        const beforeLabel = intl
          .get('performance.benchmark_original')
          .d('Benchmarking original base');
        const afterLabel = intl
          .get('performance.benchmark_remediated')
          .d('Benchmarking remediated base');

        const testIdx = testsRef.current.findIndex((t) => t.id === testId);
        const testLabel = `Test #${testIdx + 1}`;

        let beforeBenchmark: BenchmarkTimings;
        if (sharedBefore) {
          beforeBenchmark = sharedBefore;
        } else {
          beforeBenchmark = await benchmarkInMemory(
            baseValue,
            result.costByKey,
            (msg) => setProgressMsg(msg),
            beforeLabel,
            selectedTableIdsRef.current
          );
        }

        const mutatedValue = applyRemediationsToValue(
          baseValue,
          test.remediations,
          test.remediationViews,
          test.remediationHides
        );
        const afterBenchmark = await benchmarkInMemory(
          mutatedValue,
          result.costByKey,
          (msg) => setProgressMsg(msg),
          afterLabel,
          selectedTableIdsRef.current
        );

        updateTest({
          status: 'ready',
          beforeBenchmark,
          afterBenchmark,
          errorMessage: undefined,
        });
        setSandbox({ status: 'idle' });
        setProgressMsg('');
      } catch (err: any) {
        updateTest({ status: 'error', errorMessage: err.message });
        setSandbox({ status: 'idle' });
        setProgressMsg('');
      }
    };

    const handleRunTest = async (testId: string) => {
      if (!result || isBusy) return;
      await runTestInternal(testId);
    };

    const runAllTestsInternal = async () => {
      if (!result) return;
      const ids = testsRef.current.map((t) => t.id);
      // Measure the original base ONCE at the start of the batch so every test in this
      // run-all invocation compares against the identical Before. In-memory measurement,
      // so cost is trivial.
      const dtableSDK = (window as any).dtableSDK;
      let sharedBefore: BenchmarkTimings | undefined;
      try {
        sharedBefore = await benchmarkInMemory(
          dtableSDK.dtableStore.value,
          result.costByKey,
          (msg) => setProgressMsg(msg),
          intl.get('performance.benchmark_original').d('Benchmarking original base'),
          selectedTableIdsRef.current
        );
      } catch {
        sharedBefore = undefined;
      }
      for (const id of ids) {
        await runTestInternal(id, sharedBefore);
      }
    };

    const handleRunAllTests = async () => {
      if (!result || isBusy || testsRef.current.length === 0) return;
      await runAllTestsInternal();
    };

    const openApplyModal = (testId: string) => {
      if (isBusy) return;
      setApplyModalTestId(testId);
    };

    const closeApplyModal = () => setApplyModalTestId(null);

    const openCopyModal = (testId: string) => {
      if (isBusy) return;
      setCopyModalTestId(testId);
    };

    const closeCopyModal = () => setCopyModalTestId(null);

    const openDeleteModal = (testId: string) => {
      if (isBusy) return;
      setDeleteModalTestId(testId);
    };

    const closeDeleteModal = () => {
      if (deleteModalProcessing) return;
      setDeleteModalTestId(null);
    };

    // Phase 3 — Create a sandbox copy, apply this test's remediations against it.
    // Useful for visually inspecting the remediated base in SeaTable before committing
    // the same changes to the original via Apply.
    const handleCopyToSandbox = async (
      testId: string,
      viewsToDelete: Array<{ tableName: string; viewName: string }>,
      fullCopy: boolean = false
    ) => {
      if (!accountToken) {
        showToast(
          intl
            .get('performance.error_no_token')
            .d('Account token required for sandbox testing. Configure it in Settings.')
        );
        return;
      }
      if (!result || isBusy) return;
      const test = testsRef.current.find((t) => t.id === testId);
      if (!test) return;

      setApplyingTestId(testId);
      setCopyModalTestId(null);
      try {
        // If a previous sandbox exists for this test, delete it first so the new one
        // can take the same name. The user was warned via the "Overwrite existing sandbox?"
        // confirm step. Soft-fails — if deletion errors (e.g., base already gone), we
        // continue and let the create step proceed; worst case the new base gets an
        // auto-numbered name.
        if (test.lastSandbox) {
          setProgressMsg(
            intl.get('performance.deleting_existing_sandbox').d('Deleting existing sandbox...')
          );
          await deleteBase(accountToken, test.lastSandbox.workspaceId, test.lastSandbox.name);
        }

        setProgressMsg(
          fullCopy
            ? intl
                .get('performance.creating_full_sandbox')
                .d('Creating full sandbox copy (export/import)...')
            : intl.get('performance.creating_sandbox').d('Creating sandbox copy...')
        );
        const creator = fullCopy ? createSandboxFullCopy : createSandboxCopy;
        const { copyName, copyUuid, copyWorkspaceId } = await creator(accountToken, (msg) =>
          setProgressMsg(msg)
        );
        if (!copyUuid || !copyWorkspaceId) {
          throw new Error(
            `Sandbox creation returned no usable identifiers (uuid=${copyUuid}, workspaceId=${copyWorkspaceId})`
          );
        }

        // Rename the auto-named copy to "{db name} - Test #N". Non-fatal — if a base
        // with that name already exists (e.g., previous sandbox from this test), the
        // helper returns the existing auto-name and we proceed.
        const testIndex = testsRef.current.findIndex((t) => t.id === testId);
        const config = (window as any).dtable || {};
        const dbName: string = config.dtableName || 'Base';
        const desiredName = `${dbName} - Test #${testIndex + 1}`;
        setProgressMsg(
          intl
            .get('performance.renaming_sandbox', { name: desiredName })
            .d(`Renaming sandbox to "${desiredName}"...`)
        );
        const finalName = await renameBase(accountToken, copyWorkspaceId, copyName, desiredName);

        setProgressMsg(intl.get('performance.getting_token').d('Getting sandbox access token...'));
        const sandboxToken = await getSandboxToken(accountToken, copyWorkspaceId, finalName);

        // The api-gateway (dtable-server-backed) loads new bases asynchronously
        // — without this poll the next PUT/DELETE 404s with "Dtable not found".
        await waitForApiGatewayReady(copyUuid, sandboxToken, (msg) => setProgressMsg(msg));

        // Decide the route per-batch:
        //   - At least one `replace-static` → build sandbox SDK and route every op
        //     through it (modify_column_type via HTTP 504s on large tables).
        //   - Otherwise → pure HTTP (faster end-to-end; skips the 5-30s syncWithServer).
        const hasReplaceStatic = test.remediations.some((r) => r.action === 'replace-static');
        let sandboxSDK: any = null;
        if (hasReplaceStatic) {
          try {
            sandboxSDK = await buildSandboxSDK(
              copyUuid,
              copyWorkspaceId,
              finalName,
              sandboxToken,
              (msg) => setProgressMsg(msg)
            );
          } catch (err: any) {
            // Per the design decision: fail loudly when SDK init fails — no silent
            // fallback to HTTP for the replace-static remediations (would 504 anyway).
            throw new Error(
              `Sandbox SDK initialization failed: ${err?.message || err}. Replace-static remediations require it.`
            );
          }
        }

        const { applied, failed, errors } = await applyRemediationsToBase(
          {
            kind: 'remote',
            accessToken: sandboxToken,
            dtableUuid: copyUuid,
            sandboxSDK,
          },
          test.remediations,
          (msg) => setProgressMsg(msg),
          viewsToDelete,
          test.remediationHides,
          (info) =>
            new Promise<boolean>((resolve) => {
              setMultiArrayModalState({ info, resolve });
            })
        );

        // When ops went via SDK websocket, the server processes them asynchronously.
        // Poll metadata until the changes are observable, otherwise the user opens
        // the sandbox and sees stale state. Only poll for the slow ops — fast ones
        // (view cleanups, hidden_columns) complete within seconds server-side.
        //
        // replace-static is NOT polled here: the new indirection mechanism keeps
        // the column type unchanged (stays formula / link-formula) and only mutates
        // data + adds helper columns. Polling /metadata/ for a type transition
        // would never resolve. The freeze function itself verifies via SQL sample
        // before returning, so by the time we reach this code the change has
        // committed; /metadata/ may still serve stale column data for a window
        // (cache lag known issue), but SQL is ground truth and the user can
        // hard-refresh the sandbox tab if the UI looks stale.
        if (sandboxSDK) {
          const conditions: ApplyPostCondition[] = [];
          for (const r of test.remediations) {
            if (r.action === 'delete') {
              conditions.push({
                kind: 'columnAbsent',
                tableName: r.tableName,
                columnKey: r.columnKey,
              });
            }
          }
          for (const v of viewsToDelete) {
            conditions.push({
              kind: 'viewAbsent',
              tableName: v.tableName,
              viewName: v.viewName,
            });
          }
          if (conditions.length > 0) {
            const { done, unmet } = await pollMetadataUntilApplied(
              copyUuid,
              sandboxToken,
              conditions,
              (msg) => setProgressMsg(msg)
            );
            if (!done) {
              // eslint-disable-next-line no-console
              console.warn('[performance-audit] sandbox poll timed out — unmet:', unmet);
              showToast(
                intl
                  .get('performance.sandbox_poll_timeout', { count: unmet.length })
                  .d(
                    `${unmet.length} change(s) didn't commit within the polling window. The sandbox may still be processing — refresh it to verify.`
                  )
              );
            }
          }
        }

        if (failed > 0) {
          // eslint-disable-next-line no-console
          console.warn('[performance-audit] sandbox apply errors:', errors);
          showToast(
            intl
              .get('performance.sandbox_partial_failures', { failed })
              .d(`${failed} change(s) failed to apply to the sandbox — see browser console.`)
          );
        }

        // Record sandbox info on the test itself so the TestBlock can render a link to it.
        // Check existence synchronously via the ref — a setState updater's side effects
        // run during React's render phase, so a `let updated = false` flag set inside
        // the updater would always read false at the synchronous check below.
        const testStillExists = testsRef.current.some((t) => t.id === testId);
        if (testStillExists) {
          setTests((prev) =>
            prev.map((t) =>
              t.id === testId
                ? {
                    ...t,
                    lastSandbox: {
                      name: finalName,
                      workspaceId: copyWorkspaceId,
                      appliedCount: applied,
                      failedCount: failed > 0 ? failed : undefined,
                      createdAt: formatNow(),
                    },
                  }
                : t
            )
          );
          if (failed === 0) {
            showToast(
              intl
                .get('performance.sandbox_ready', { name: finalName })
                .d(`Sandbox "${finalName}" ready.`)
            );
          }
        } else {
          // The test was removed from state mid-flight (e.g., audit rerun cleared
          // tests). The sandbox base IS in the user's workspace; surface that fact
          // so they can find it manually.
          showToast(
            intl
              .get('performance.sandbox_orphaned', { name: finalName })
              .d(
                `Sandbox "${finalName}" was created but the test it belonged to is gone. Open it from your SeaTable workspace.`
              )
          );
        }
        setApplyingTestId(null);
        setProgressMsg('');
      } catch (err: any) {
        setApplyingTestId(null);
        setProgressMsg('');
        if (err instanceof ExportBaseError) {
          // Log the full diagnostic detail to the console for backend
          // investigation — toast text is intentionally short.
          // eslint-disable-next-line no-console
          console.error('[performance-audit] export-base request failed:', {
            status: err.status,
            body: err.body,
            requestId: err.requestId,
            url: err.url,
          });
          if (err.status >= 500) {
            showToast(
              intl
                .get('performance.sandbox_export_500_hint', { status: err.status })
                .d(
                  `Sandbox creation failed: SeaTable couldn't export the base (HTTP ${err.status}). On large bases this is usually the asset-packaging step on the server side. Try unchecking "Include assets, scripts, and automations" to use the lighter copy path. (See console for request-id.)`
                )
            );
          } else {
            showToast(`Sandbox error: ${err.message}`);
          }
        } else {
          showToast(`Sandbox error: ${err?.message || err}`);
        }
      }
    };

    // Apply the chosen test's remediations to the original base, then wipe all tests +
    // sandbox and re-audit — the base structure has changed, so old tests are stale.
    const handleApplyTest = async (
      testId: string,
      viewsToDelete: Array<{ tableName: string; viewName: string }>,
      deleteSandbox: boolean
    ) => {
      if (!result || isBusy) return;
      const test = testsRef.current.find((t) => t.id === testId);
      if (!test) return;
      const sandboxToDelete = deleteSandbox && test.lastSandbox ? test.lastSandbox : null;

      setApplyingTestId(testId);
      setApplyModalTestId(null);

      const { applied, failed, errors, frozenColumns } = await applyRemediationsToBase(
        { kind: 'original' },
        test.remediations,
        (msg) => setProgressMsg(msg),
        viewsToDelete,
        test.remediationHides,
        (info) =>
          new Promise<boolean>((resolve) => {
            setMultiArrayModalState({ info, resolve });
          })
      );
      if (failed > 0) {
        // eslint-disable-next-line no-console
        console.warn('[performance-audit] apply-to-original errors:', errors);
      }

      // Persist freeze records so Unfreeze can restore the original formula
      // later (survives page reload + cross-session). Sandbox path skips this —
      // the sandbox is discarded so its frozen state doesn't need persistence.
      if (frozenColumns.length > 0) {
        try {
          const current = (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME) || {};
          const existing: Record<string, FrozenColumnRecord> = current.frozenColumns || {};
          const updated = { ...existing };
          for (const fc of frozenColumns) {
            updated[`${fc.tableId}.${fc.columnKey}`] = fc;
          }
          (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
            ...current,
            frozenColumns: updated,
          });
          // Bump so the useMemo re-reads — the "Currently frozen" section
          // is otherwise stale until the next render that happens to recompute.
          setFrozenRefreshCounter((c) => c + 1);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            '[performance-audit] failed to persist frozenColumns — unfreeze will need manual recovery via the original formula in console:',
            err,
            frozenColumns
          );
        }
      }

      // Delete the sandbox base if the user opted in AND the apply succeeded.
      // Skipping on failure leaves the sandbox available for debugging or retry.
      // Soft-fail: a sandbox we can't delete is a minor inconvenience, not a
      // reason to mask the (successful) original-base apply from the user.
      if (sandboxToDelete && failed === 0 && accountToken) {
        try {
          setProgressMsg(
            intl.get('performance.deleting_sandbox_after_apply').d('Cleaning up sandbox...')
          );
          await deleteBase(accountToken, sandboxToDelete.workspaceId, sandboxToDelete.name);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[performance-audit] post-apply sandbox delete failed:', e);
        }
      }

      // Wipe all tests — base structure changed, old tests are stale
      setTests([]);
      setSandbox({ status: 'idle' });
      setApplyingTestId(null);
      setProgressMsg('');

      if (failed > 0) {
        showToast(
          intl
            .get('performance.applied_with_errors', { applied, failed })
            .d(`Applied ${applied} change(s); ${failed} failed — see browser console for details`)
        );
      } else {
        showToast(
          intl
            .get('performance.applied_changes', { count: applied })
            .d(`Applied changes: ${applied} column(s) remediated in original base`)
        );
      }

      doAudit();
    };

    // -------------------------------------------------------------------------
    // Unfreeze a previously-frozen column (Phase B). Restores original formula
    // via applyLocalOperation, refcounts shared self-link before deleting, and
    // clears the plugin-settings entry. Refresh counter bumps so the UI reflects
    // the change.
    // -------------------------------------------------------------------------
    const handleUnfreeze = async (key: string) => {
      const record = frozenColumns[key];
      if (!record) return;
      if (unfreezingKey) return; // serialize — one at a time
      setUnfreezingKey(key);
      setProgressMsg(`Unfreezing ${record.tableName} › ${record.columnName}...`);
      try {
        const auth = await getAuthContext();
        if (!auth) {
          showToast('Unfreeze failed: missing auth context');
          return;
        }
        // Refcount: any other frozen records on this same table that share the
        // self-link key? If yes, leave the self-link in place; otherwise delete it.
        const otherUsersOfSelfLink = Object.entries(frozenColumns).filter(
          ([k, fc]) =>
            k !== key &&
            !!record.selfLinkColumnKey &&
            fc.tableId === record.tableId &&
            fc.selfLinkColumnKey === record.selfLinkColumnKey
        ).length;
        const deleteSelfLink = !!record.selfLinkColumnKey && otherUsersOfSelfLink === 0;

        const result = await unfreezeColumnViaIndirection({
          dtableSDK: (window as any).dtableSDK,
          tableName: record.tableName,
          columnKey: record.columnKey,
          originalData: record.originalData,
          snapshotColumnKey: record.snapshotColumnKey,
          selfLinkColumnKey: record.selfLinkColumnKey,
          deleteSelfLink,
          accessToken: auth.accessToken,
          dtableUuid: auth.dtableUuid,
          serverUrl: auth.serverUrl,
          onProgress: (msg) => setProgressMsg(msg),
        });

        // Clear the settings entry whenever the column itself was restored —
        // helper-column cleanup failures are warnings, not blockers.
        let restoredOk = false;
        if (result.ok || result.restored) {
          try {
            const current = (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME) || {};
            const existing: Record<string, FrozenColumnRecord> = current.frozenColumns || {};
            const updated = { ...existing };
            delete updated[key];
            (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
              ...current,
              frozenColumns: updated,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[performance-audit] failed to clear frozen entry:', e);
          }
          showToast(
            intl
              .get('performance.unfrozen', { name: record.columnName })
              .d(`Unfrozen ${record.columnName}`)
          );
          restoredOk = true;
        } else {
          showToast(
            intl
              .get('performance.unfreeze_failed', { error: result.error || 'unknown' })
              .d(`Unfreeze failed: ${result.error || 'unknown'}`)
          );
        }
        // Keep the row visible (strikethrough) until the user runs a rerun.
        // Batching multiple unfreezes into one audit pass is much faster than
        // auto-rerunning after each one on big bases.
        if (restoredOk) {
          setPendingUnfrozen((prev) => {
            const next = new Map(prev);
            next.set(key, record);
            return next;
          });
        }
      } catch (e: any) {
        showToast(`Unfreeze failed: ${e?.message || e}`);
      } finally {
        setUnfreezingKey(null);
        setProgressMsg('');
        setFrozenRefreshCounter((c) => c + 1);
      }
    };

    // -------------------------------------------------------------------------
    // Group candidates by table for Links-audit-style display
    // -------------------------------------------------------------------------

    // Total measured compute cost across all candidates — the denominator used to
    // display each row's cost as a percentage. If zero, percentage display is suppressed.
    const totalCostMs = result
      ? result.candidates.reduce((s, c) => s + (c.measuredCostMs || 0), 0)
      : 0;

    // Per-candidate "structural" / "volume" tag based on cost-per-row vs. median.
    // Computed once and shared across all CandidateRow renders. Empty map when no
    // result — CandidateRow handles the missing-key case.
    const costPerRowTags = result
      ? computeCostPerRowTags(result.candidates, result.archival || [])
      : new Map<string, 'structural' | 'volume'>();

    // Denominator for each view's "Weight" badge — sum of loadMs over all views.
    // Live SDK value snapshot — used by the per-candidate drill to read the
    // current views' hidden_columns + rule references. Read on every render
    // because the user might toggle visibility outside the plugin while
    // viewing the audit; cheap (just reads a reference).
    const liveValue = (window as any).dtableSDK?.dtableStore?.value;

    // Overview-only noise filter: hide candidates and views below this share of their
    // total. Keeps the cross-base summary readable on bases with hundreds of items.
    // Per-table tabs are not filtered — there, in-context exploration is the point.
    const OVERVIEW_MIN_SHARE_PCT = 2;
    const displayedCandidates = result
      ? totalCostMs > 0
        ? result.candidates.filter(
            (c) => ((c.measuredCostMs || 0) / totalCostMs) * 100 >= OVERVIEW_MIN_SHARE_PCT
          )
        : result.candidates
      : [];
    const hiddenCandidatesCount = result
      ? result.candidates.length - displayedCandidates.length
      : 0;

    const tableNames = Array.from(new Set(displayedCandidates.map((c) => c.tableName)));

    // Concentration: what share of total compute do the top 5 columns account for?
    // Only meaningful when there are more than a handful of candidates and total > 0.
    // When high (>50%) it tells the user "a few columns dominate — focus there"; when
    // low it tells them "no silver bullet, improvements need broader refactoring".
    const top5SharePct = (() => {
      if (!result || result.candidates.length < 6 || totalCostMs <= 0) return null;
      const sorted = [...result.candidates].sort(
        (a, b) => (b.measuredCostMs || 0) - (a.measuredCostMs || 0)
      );
      const top5 = sorted.slice(0, 5).reduce((s, c) => s + (c.measuredCostMs || 0), 0);
      return (top5 / totalCostMs) * 100;
    })();

    // View mode: grouped (current default) keeps the per-table grouping; flat lists all
    // candidates globally sorted by cost with the table name prefixed on each row.
    const [candidatesViewMode, setCandidatesViewMode] = useState<'grouped' | 'flat'>('grouped');

    // Sort on the Compute cost column. asc → desc → null cycle, matching the
    // Views section's Weight column. `null` falls back to the runner's natural
    // order (cost desc, then row count desc) — same data the user sees by default.
    const [candidatesSortDir, setCandidatesSortDir] = useState<'asc' | 'desc' | null>(null);
    const toggleCandidatesSort = () => {
      setCandidatesSortDir((prev) => (prev === null ? 'asc' : prev === 'asc' ? 'desc' : null));
    };
    const sortCandidates = (
      cs: PerformanceAuditResult['candidates']
    ): PerformanceAuditResult['candidates'] => {
      if (candidatesSortDir === null) return cs;
      const dir = candidatesSortDir === 'asc' ? 1 : -1;
      return [...cs].sort((a, b) => ((a.measuredCostMs ?? 0) - (b.measuredCostMs ?? 0)) * dir);
    };

    // Deleted views — marked visually with strikethrough, removed from real base
    // immediately, but we don't rerun the audit since measuring view sizes is expensive.
    // Still tracked here because TableTab's per-table tab also surfaces views.
    const [deletedViewKeys, setDeletedViewKeys] = useState<Set<string>>(new Set());

    // Collapsible state for the Columns section in the Overview. Default open
    // so users see everything after the first run. Archival has its own umbrella
    // section without a toggle. Views moved to TableTab — no longer shown here.

    const handleDeleteView = (tableName: string, viewName: string, keyStr: string) => {
      try {
        (window as any).dtableSDK.deleteView(tableName, viewName);
        setDeletedViewKeys((prev) => {
          const next = new Set(prev);
          next.add(keyStr);
          return next;
        });
        // If the view was staged for deletion in a future test case, drop the
        // staging — the column is already gone, no test is going to make sense.
        setViewRemediations((prev) => {
          if (!prev.has(keyStr)) return prev;
          const next = new Map(prev);
          next.delete(keyStr);
          return next;
        });
      } catch (err: any) {
        showToast(`Failed to delete view: ${err?.message || err}`);
      }
    };

    // ----- Visibility commit helpers (shared with TableTab via mirroring) -----

    const getBaseHiddenForView = (tableId: string, viewId: string): Set<string> => {
      const dtableSDK = (window as any).dtableSDK;
      const t = (dtableSDK?.dtableStore?.value?.tables || []).find((tt: any) => tt._id === tableId);
      const v = t?.views?.find((vv: any) => vv._id === viewId);
      return new Set<string>(v?.hidden_columns || []);
    };

    // Column keys staged-hidden for this view, sourced from hideRemediations.
    const getStagedHiddenForView = (tableId: string, viewId: string): Set<string> => {
      const out = new Set<string>();
      hideRemediations.forEach((h) => {
        if (h.tableId !== tableId) return;
        if (h.views.some((v) => v.viewId === viewId)) out.add(h.columnKey);
      });
      return out;
    };

    const getCommittedHiddenForView = (tableId: string, viewId: string): Set<string> => {
      const base = getBaseHiddenForView(tableId, viewId);
      const staged = getStagedHiddenForView(tableId, viewId);
      if (staged.size === 0) return base;
      const merged = new Set<string>(base);
      staged.forEach((k) => merged.add(k));
      return merged;
    };

    const computeViewVisibilityDiff = (tableId: string, viewId: string) => {
      const base = getBaseHiddenForView(tableId, viewId);
      const staged = getStagedHiddenForView(tableId, viewId);
      const committed = new Set<string>(base);
      staged.forEach((k) => committed.add(k));
      const edits = viewEdits.get(viewId) ?? committed;
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

    const handleStageVisibilityChanges = (
      tableId: string,
      tableName: string,
      viewId: string,
      viewName: string
    ) => {
      const { added, removedFromStaged, removedFromBase } = computeViewVisibilityDiff(
        tableId,
        viewId
      );
      const dtableSDK = (window as any).dtableSDK;
      const liveCols: any[] =
        (dtableSDK?.dtableStore?.value?.tables || []).find((t: any) => t._id === tableId)
          ?.columns ?? [];
      // toggleHideRemediation flips: present → unstage, absent → stage.
      // Both `added` and `removedFromStaged` map to the same call.
      for (const colKey of [...added, ...removedFromStaged]) {
        const col = liveCols.find((c: any) => c.key === colKey);
        const colName = col?.name || colKey;
        toggleHideRemediation(tableId, tableName, colKey, colName, { viewId, viewName });
      }
      // Always clear edits — committed staged adds/removes are flushed,
      // un-hides discarded.
      setViewEdits((prev) => {
        if (!prev.has(viewId)) return prev;
        const next = new Map(prev);
        next.delete(viewId);
        return next;
      });
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

    // For one column, find every view in viewEdits where this column's
    // visibility differs from the *committed* state (base ∪ staged). Used
    // to drive column-level Stage / Apply and the "(unsaved)" mention.
    const findDirtyViewsForColumn = (
      tableId: string,
      columnKey: string
    ): Array<{
      viewId: string;
      viewName: string;
      baseHas: boolean;
      stagedHas: boolean;
      editsHas: boolean;
    }> => {
      const dtableSDK = (window as any).dtableSDK;
      const t = (dtableSDK?.dtableStore?.value?.tables || []).find((tt: any) => tt._id === tableId);
      if (!t) return [];
      const out: Array<{
        viewId: string;
        viewName: string;
        baseHas: boolean;
        stagedHas: boolean;
        editsHas: boolean;
      }> = [];
      for (const v of t.views || []) {
        const edits = viewEdits.get(v._id);
        if (!edits) continue;
        const baseHas = (v.hidden_columns || []).includes(columnKey);
        const stagedHas = getStagedHiddenForView(tableId, v._id).has(columnKey);
        const editsHas = edits.has(columnKey);
        const committed = baseHas || stagedHas;
        if (editsHas !== committed) {
          out.push({
            viewId: v._id,
            viewName: v.name,
            baseHas,
            stagedHas,
            editsHas,
          });
        }
      }
      return out;
    };

    // Drop one column from a view's edit set; if the resulting set matches
    // the view's base hidden_columns, drop the entry entirely. Used after
    // column-level Stage / Apply commits the column's portion of the edits.
    const dropColumnFromViewEdit = (tableId: string, viewId: string, columnKey: string) => {
      setViewEdits((prev) => {
        const current = prev.get(viewId);
        if (!current) return prev;
        const newSet = new Set(current);
        newSet.delete(columnKey);
        const t = ((window as any).dtableSDK?.dtableStore?.value?.tables || []).find(
          (tt: any) => tt._id === tableId
        );
        const v = t?.views?.find((vv: any) => vv._id === viewId);
        const base = new Set<string>(v?.hidden_columns || []);
        const next = new Map(prev);
        if (newSet.size === base.size) {
          let allMatch = true;
          for (const k of Array.from(newSet)) {
            if (!base.has(k)) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            next.delete(viewId);
            return next;
          }
        }
        next.set(viewId, newSet);
        return next;
      });
    };

    const handleStageColumnVisibility = (
      tableId: string,
      tableName: string,
      columnKey: string,
      columnName: string
    ) => {
      const dirty = findDirtyViewsForColumn(tableId, columnKey);
      if (dirty.length === 0) return;
      let stagedCount = 0;
      let droppedCount = 0;
      for (const dv of dirty) {
        const wantHidden = dv.editsHas;
        const wasCommitted = dv.baseHas || dv.stagedHas;
        if (wantHidden && !wasCommitted) {
          // Add a new staged hide.
          toggleHideRemediation(tableId, tableName, columnKey, columnName, {
            viewId: dv.viewId,
            viewName: dv.viewName,
          });
          stagedCount++;
        } else if (!wantHidden && dv.stagedHas) {
          // Un-stage (toggle off).
          toggleHideRemediation(tableId, tableName, columnKey, columnName, {
            viewId: dv.viewId,
            viewName: dv.viewName,
          });
          stagedCount++;
        } else {
          // Un-hide from base — Stage can't commit; needs Apply.
          droppedCount++;
        }
        dropColumnFromViewEdit(tableId, dv.viewId, columnKey);
      }
      if (stagedCount > 0 && droppedCount > 0) {
        showToast(
          intl
            .get('performance.col_visibility_staged_mixed', {
              staged: stagedCount,
              dropped: droppedCount,
              col: columnName,
            })
            .d(
              `${stagedCount} change(s) staged for "${columnName}"; ${droppedCount} un-hide(s) discarded — use Apply for those.`
            )
        );
      } else if (stagedCount > 0) {
        showToast(
          intl
            .get('performance.col_visibility_staged', {
              count: stagedCount,
              col: columnName,
            })
            .d(`${stagedCount} change(s) staged for "${columnName}".`)
        );
      } else {
        showToast(
          intl
            .get('performance.col_visibility_stage_no_adds')
            .d('Stage only commits new hides — nothing to stage. Use Apply for un-hides.')
        );
      }
    };

    const handleApplyColumnVisibility = async (
      tableId: string,
      tableName: string,
      columnKey: string,
      columnName: string
    ) => {
      const dirty = findDirtyViewsForColumn(tableId, columnKey);
      if (dirty.length === 0) return;
      let okCount = 0;
      let failCount = 0;
      const dtableSDK = (window as any).dtableSDK;
      for (const dv of dirty) {
        const t = (dtableSDK?.dtableStore?.value?.tables || []).find(
          (tt: any) => tt._id === tableId
        );
        const v = t?.views?.find((vv: any) => vv._id === dv.viewId);
        const base = new Set<string>(v?.hidden_columns || []);
        const desired = new Set(base);
        if (dv.editsHas) desired.add(columnKey);
        else desired.delete(columnKey);
        const arr = Array.from(desired);
        const ok = await setViewHiddenColumnsDirect(tableName, dv.viewName, arr);
        if (ok) {
          okCount++;
          if (v) v.hidden_columns = arr;
          dropColumnFromViewEdit(tableId, dv.viewId, columnKey);
          // If this (col, view) was staged, drop the staged entry too — base
          // is now the source of truth.
          if (dv.stagedHas) {
            toggleHideRemediation(tableId, tableName, columnKey, columnName, {
              viewId: dv.viewId,
              viewName: dv.viewName,
            });
          }
        } else {
          failCount++;
        }
      }
      if (okCount > 0) {
        showToast(
          intl
            .get('performance.col_visibility_applied', {
              count: okCount,
              col: columnName,
            })
            .d(`${okCount} view(s) updated for "${columnName}".`)
        );
      }
      if (failCount > 0) {
        showToast(
          intl
            .get('performance.col_visibility_apply_failed', {
              count: failCount,
              col: columnName,
            })
            .d(`Failed to update ${failCount} view(s) for "${columnName}".`)
        );
      }
    };

    const handleApplyVisibilityChanges = async (
      tableId: string,
      tableName: string,
      viewId: string,
      viewName: string
    ) => {
      const { desired } = computeViewVisibilityDiff(tableId, viewId);
      const ok = await setViewHiddenColumnsDirect(tableName, viewName, desired);
      if (!ok) {
        showToast(
          intl
            .get('performance.visibility_apply_failed', { view: viewName })
            .d(`Failed to update visibility for view "${viewName}".`)
        );
        return;
      }
      showToast(
        intl
          .get('performance.visibility_applied', { view: viewName })
          .d(`View "${viewName}" visibility updated.`)
      );
      // Mutate the live SDK value so subsequent reads reflect the new state.
      const dtableSDK = (window as any).dtableSDK;
      const t = (dtableSDK?.dtableStore?.value?.tables || []).find((tt: any) => tt._id === tableId);
      const v = t?.views?.find((vv: any) => vv._id === viewId);
      if (v) v.hidden_columns = desired;
      setViewEdits((prev) => {
        if (!prev.has(viewId)) return prev;
        const next = new Map(prev);
        next.delete(viewId);
        return next;
      });
      // Drop any staged-hides whose viewId matches this view — they're now
      // in base, no longer "staged". Avoids the test workflow re-trying an
      // already-applied change.
      setHideRemediations((prev) => {
        let mutated = false;
        const next = new Map<string, RemediatedColumnHide>();
        prev.forEach((h, key) => {
          if (h.tableId !== tableId) {
            next.set(key, h);
            return;
          }
          const newViews = h.views.filter((vv) => vv.viewId !== viewId);
          if (newViews.length === h.views.length) {
            next.set(key, h);
          } else {
            mutated = true;
            if (newViews.length > 0) {
              next.set(key, { ...h, views: newViews });
            }
          }
        });
        return mutated ? next : prev;
      });
    };

    // ----- Archival actions on RowsSection three-dots menu --------------------

    // Build the viewData for a SeaTable view filtering archival candidates. Filter
    // on the user-added ctime/mtime columns when present (their column_keys are
    // hard-coded to '_ctime'/'_mtime' by dtable-store.insertColumn). The audit's
    // thresholdDate is a full ISO timestamp — view filters take YYYY-MM-DD only.
    const buildArchivalViewData = (
      a: PerformanceAuditTableArchival,
      hasCtime: boolean,
      hasMtime: boolean
    ): any => {
      const dateOnly = (a.thresholdDate || '').slice(0, 10);
      const filters: any[] = [];
      if (hasCtime) {
        filters.push({
          column_key: '_ctime',
          filter_predicate: 'is_on_or_before',
          filter_term: dateOnly,
          filter_term_modifier: 'exact_date',
        });
      }
      if (hasMtime) {
        filters.push({
          column_key: '_mtime',
          filter_predicate: 'is_on_or_before',
          filter_term: dateOnly,
          filter_term_modifier: 'exact_date',
        });
      }
      return {
        name: intl
          .get('performance.archival_view_name', { date: dateOnly })
          .d(`Archival candidates (older than ${dateOnly})`),
        type: 'table',
        filter_conjunction: 'And',
        filters,
      };
    };

    // dtable-store.insertColumn forces column_key to '_ctime'/'_mtime' for these
    // types, so we don't need to track the generated key — the filter can reference
    // the well-known constant.
    const addCtimeOrMtimeColumn = (tableIndex: number, type: 'ctime' | 'mtime') => {
      const dtableSDK = (window as any).dtableSDK;
      const table = dtableSDK.getTables()[tableIndex];
      const anchorIdx = Math.max(0, (table.columns?.length || 1) - 1);
      const colName =
        type === 'ctime'
          ? intl.get('performance.archival_col_ctime').d('Created time')
          : intl.get('performance.archival_col_mtime').d('Last modified');
      dtableSDK.dtableStore.insertColumn(tableIndex, colName, type, anchorIdx, {}, undefined);
    };

    const createArchivalViewForTable = (
      a: PerformanceAuditTableArchival,
      hasCtime: boolean,
      hasMtime: boolean
    ): boolean => {
      const dtableSDK = (window as any).dtableSDK;
      try {
        const viewData = buildArchivalViewData(a, hasCtime, hasMtime);
        dtableSDK.migratePluginView(a.tableName, viewData);
        showToast(
          intl
            .get('performance.archival_view_created', {
              name: viewData.name,
              table: a.tableName,
            })
            .d(`Created view "${viewData.name}" on ${a.tableName}`),
          'success'
        );
        return true;
      } catch (err: any) {
        showToast(
          intl
            .get('performance.archival_view_create_failed', {
              table: a.tableName,
              error: err?.message || String(err),
            })
            .d(`Failed to create archival view on ${a.tableName}: ${err?.message || err}`),
          'error'
        );
        return false;
      }
    };

    const handleCreateArchivalView = (a: PerformanceAuditTableArchival) => {
      const hasCtime = !!a.ctimeColumnKey;
      const hasMtime = !!a.mtimeColumnKey;
      if (hasCtime && hasMtime) {
        // State 1 — both columns exist, create view directly.
        createArchivalViewForTable(a, true, true);
      } else {
        // State 2 (one missing) or State 3 (both missing) — confirm with the user
        // before adding columns to their base.
        setArchivalViewModalRow(a);
      }
    };

    const handleArchivalViewModalConfirm = () => {
      const a = archivalViewModalRow;
      if (!a) return;
      const dtableSDK = (window as any).dtableSDK;
      const tables: any[] = dtableSDK.getTables();
      const tableIndex = tables.findIndex((t) => t._id === a.tableId);
      if (tableIndex < 0) {
        setArchivalViewModalRow(null);
        return;
      }
      try {
        if (!a.ctimeColumnKey) addCtimeOrMtimeColumn(tableIndex, 'ctime');
        if (!a.mtimeColumnKey) addCtimeOrMtimeColumn(tableIndex, 'mtime');
        createArchivalViewForTable(a, true, true);
      } catch (err: any) {
        showToast(
          intl
            .get('performance.archival_col_add_failed', {
              table: a.tableName,
              error: err?.message || String(err),
            })
            .d(`Failed to add date column on ${a.tableName}: ${err?.message || err}`),
          'error'
        );
      }
      setArchivalViewModalRow(null);
    };

    const handleArchivalViewModalCancel = () => {
      const a = archivalViewModalRow;
      setArchivalViewModalRow(null);
      if (!a) return;
      const hasCtime = !!a.ctimeColumnKey;
      const hasMtime = !!a.mtimeColumnKey;
      if (hasCtime || hasMtime) {
        // State 2 fallback — create with the single available column and warn.
        createArchivalViewForTable(a, hasCtime, hasMtime);
        showToast(
          intl
            .get('performance.archival_view_weaker_filter', { table: a.tableName })
            .d(
              `View created on "${a.tableName}" with a weaker filter — only one of created/modified time is available.`
            ),
          'warning'
        );
      } else {
        // State 3 — no column to fall back to. Let the user know nothing was created.
        showToast(
          intl
            .get('performance.archival_view_not_created_no_columns', { table: a.tableName })
            .d(`No archival view created on "${a.tableName}" — date columns required.`),
          'warning'
        );
      }
    };

    // Re-scan the table for archival candidates at delete time using the same
    // criteria as the audit (`_ctime` AND `_mtime` both <= thresholdDate). Doing
    // this fresh — rather than caching IDs in the audit result — means rows the
    // user has touched since the audit (newer _mtime) are correctly excluded, and
    // rows added since are correctly included. Threshold is the one frozen at
    // audit time so the user's intent matches.
    //
    // Also computes the "safe" subset (no incoming links from any other table)
    // by scanning every link column across the base. O(rows × link cols) on the
    // referencing tables — cheap on most bases, tolerable on huge ones since
    // it's a one-shot at modal-open time.
    const collectArchivalRowIds = (
      a: PerformanceAuditTableArchival
    ): { all: string[]; safe: string[] } => {
      const dtableSDK = (window as any).dtableSDK;
      const tables: any[] = dtableSDK.getTables();
      const t = tables.find((x) => x._id === a.tableId);
      if (!t) return { all: [], safe: [] };

      // 1. Archival candidates (ctime AND mtime ≤ threshold).
      const threshold = a.thresholdDate || '';
      const all: string[] = [];
      for (const row of t.rows || []) {
        const c = row._ctime || '';
        const m = row._mtime || '';
        if (!c || !m) continue;
        if (c <= threshold && m <= threshold) all.push(row._id);
      }
      if (all.length === 0) return { all: [], safe: [] };

      // 2. Build the set of row IDs in `t` that are referenced by any link column
      // anywhere in the base. Same logic as runner.measureRowArchival, scoped to
      // the target table only.
      const referenced = new Set<string>();
      for (const srcTable of tables) {
        const linkCols = (srcTable.columns || []).filter((c: any) => c.type === 'link');
        if (linkCols.length === 0) continue;
        for (const col of linkCols) {
          const data = col.data || {};
          const targetTableId =
            data.table_id === srcTable._id ? data.other_table_id : data.table_id;
          if (targetTableId !== a.tableId) continue;
          for (const row of srcTable.rows || []) {
            const val = row[col.key];
            if (!Array.isArray(val)) continue;
            for (const entry of val) {
              if (typeof entry === 'string') referenced.add(entry);
              else if (entry && typeof entry === 'object' && entry.row_id)
                referenced.add(entry.row_id);
            }
          }
        }
      }

      const safe = all.filter((id) => !referenced.has(id));
      return { all, safe };
    };

    const handleDeleteArchivalRows = (a: PerformanceAuditTableArchival) => {
      const { all, safe } = collectArchivalRowIds(a);
      if (all.length === 0) {
        showToast(
          intl
            .get('performance.archival_delete_no_rows', { table: a.tableName })
            .d(`No archival rows to delete on "${a.tableName}".`),
          'warning'
        );
        return;
      }
      // Default scope: 'safe' when there's a meaningful subset (some rows are
      // referenced); 'all' when every candidate is already safe (no choice to make).
      setArchivalDeleteScope(safe.length < all.length ? 'safe' : 'all');
      setArchivalDeleteModalRow({ archival: a, allRowIds: all, safeRowIds: safe });
    };

    const handleArchivalDeleteModalCancel = () => {
      if (archivalDeleting) return;
      setArchivalDeleteModalRow(null);
    };

    const handleArchivalDeleteModalConfirm = async () => {
      if (!archivalDeleteModalRow || archivalDeleting) return;
      const { archival: a, allRowIds, safeRowIds } = archivalDeleteModalRow;
      const idsToDelete = archivalDeleteScope === 'safe' ? safeRowIds : allRowIds;
      if (idsToDelete.length === 0) {
        setArchivalDeleteModalRow(null);
        return;
      }
      setArchivalDeleting(true);
      try {
        const snapOk = await createSnapshot();
        if (!snapOk) {
          showToast(
            intl
              .get('performance.archival_delete_snapshot_failed', { table: a.tableName })
              .d(`Snapshot failed — aborting deletion of archival rows on "${a.tableName}".`),
            'error'
          );
          setArchivalDeleting(false);
          return;
        }
        const dtableSDK = (window as any).dtableSDK;
        const tables: any[] = dtableSDK.getTables();
        const t = tables.find((x) => x._id === a.tableId);
        if (!t) {
          setArchivalDeleting(false);
          setArchivalDeleteModalRow(null);
          return;
        }
        dtableSDK.deleteRowsByIds(t, idsToDelete);
        setDeletedArchivalTableIds((prev) => {
          const next = new Set(prev);
          next.add(a.tableId);
          return next;
        });
        showToast(
          intl
            .get('performance.archival_delete_done', {
              count: idsToDelete.length,
              table: a.tableName,
            })
            .d(`Deleted ${idsToDelete.length} archival row(s) from "${a.tableName}".`),
          'success'
        );
      } catch (err: any) {
        showToast(
          intl
            .get('performance.archival_delete_failed', {
              table: a.tableName,
              error: err?.message || String(err),
            })
            .d(`Failed to delete archival rows on "${a.tableName}": ${err?.message || err}`),
          'error'
        );
      } finally {
        setArchivalDeleting(false);
        setArchivalDeleteModalRow(null);
      }
    };

    // Update the imperative-handle dispatcher with the latest handler closures so the
    // host's per-table tabs can invoke them. Lives at the bottom of the component body
    // (after both result state and the action handlers are in scope) and runs every
    // render — refs don't trigger re-renders.
    archivalDispatchRef.current = {
      create: (tableId: string) => {
        const a = result?.archival?.find((x) => x.tableId === tableId);
        if (a) handleCreateArchivalView(a);
      },
      delete: (tableId: string) => {
        const a = result?.archival?.find((x) => x.tableId === tableId);
        if (a) handleDeleteArchivalRows(a);
      },
    };

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    const applyModalTest = applyModalTestId
      ? tests.find((t) => t.id === applyModalTestId) || null
      : null;
    const copyModalTest = copyModalTestId
      ? tests.find((t) => t.id === copyModalTestId) || null
      : null;
    const deleteModalTest = deleteModalTestId
      ? tests.find((t) => t.id === deleteModalTestId) || null
      : null;

    // When embedded inside Tables audit, we inherit the host's scrolling container and
    // layout flow naturally. Standalone mode keeps the full-height column layout it's
    // had since the preset days.
    const outerStyle: React.CSSProperties = embedded
      ? {}
      : { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' };

    return (
      <div style={outerStyle}>
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          .audit-row:hover { background-color: #eef6fb !important; }
          .audit-table th { font-weight: normal; }
        `}</style>

        {/* Standalone mode shows its own "Last audit" line. When embedded inside
            Tables audit, the host's page header already shows both the structural
            audit date and the perf-test date with the gauge icon — suppress this
            one to avoid the confusing duplicate label. */}
        {auditDate && !embedded && (
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
            {intl.get('performance.last_audit', { date: auditDate }).d(`Last audit: ${auditDate}`)}
          </div>
        )}

        {/* Loading spinner — top-of-page only for the initial audit run.
          Sandbox-busy states render their own inline loader below the "Sandbox testing" title.
          When embedded, the host (TablesAudit) renders its own running indicator in
          the header — suppress this one to avoid double-rendering. */}
        {status === 'running' && !embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 18,
                height: 18,
                border: '2px solid #ff8000',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <span style={{ fontSize: 13, color: '#666' }}>{progressMsg}</span>
          </div>
        )}

        {status === 'error' && <div style={{ color: '#dc3545', padding: 20 }}>{progressMsg}</div>}

        {status === 'done' && result && (
          <div style={embedded ? {} : { flex: 1, overflow: 'auto', paddingRight: 16 }}>
            {/* ---- Base-wide key figures ----
                Source of truth, in order of preference:
                  1. tablesAuditResults (host-provided) — refreshes on tables-audit rerun.
                  2. result.archival + live SDK — fallback for standalone mode and the
                     pre-tables-audit case where the host hasn't passed results yet. */}
            {(() => {
              let totalTables: number;
              let totalRows: number;
              let totalColumns: number;
              let totalViews: number;
              if (tablesAuditResults && tablesAuditResults.length > 0) {
                totalTables = tablesAuditResults.length;
                totalRows = tablesAuditResults.reduce((s, t) => s + (t.rowCount || 0), 0);
                totalColumns = tablesAuditResults.reduce((s, t) => s + (t.columnCount || 0), 0);
                totalViews = tablesAuditResults.reduce((s, t) => s + (t.viewCount || 0), 0);
              } else {
                totalTables = result.archival?.length ?? 0;
                totalRows = (result.archival || []).reduce((s, a) => s + (a.totalRows || 0), 0);
                totalViews = result.views?.length ?? 0;
                try {
                  const sdkTables: any[] = (window as any).dtableSDK?.getTables() || [];
                  totalColumns = sdkTables.reduce((s, t) => s + ((t.columns || []).length || 0), 0);
                } catch {
                  totalColumns = 0;
                }
              }
              return (
                <div style={{ marginBottom: 16, fontSize: 14, lineHeight: 1.8 }}>
                  <table style={{ borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr>
                        <td style={{ paddingRight: 12, color: '#555' }}>
                          {intl.get('common.tables').d('Tables')}
                        </td>
                        <td style={{ paddingRight: 8, textAlign: 'right' }}>{totalTables}</td>
                      </tr>
                      <tr>
                        <td style={{ paddingRight: 12, color: '#555' }}>
                          {intl.get('common.rows').d('Rows')}
                        </td>
                        <td style={{ paddingRight: 8, textAlign: 'right' }}>{totalRows}</td>
                      </tr>
                      <tr>
                        <td style={{ paddingRight: 12, color: '#555' }}>
                          {intl.get('common.columns').d('Columns')}
                        </td>
                        <td style={{ paddingRight: 8, textAlign: 'right' }}>{totalColumns}</td>
                      </tr>
                      <tr>
                        <td style={{ paddingRight: 12, color: '#555' }}>
                          {intl.get('common.views').d('Views')}
                        </td>
                        <td style={{ paddingRight: 8, textAlign: 'right' }}>{totalViews}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {/* ---- Archival candidates umbrella ----
                Separate top-level section because archival uses a different mechanism
                (snapshot + direct delete) than the schema-level Performance candidates
                below (test-case workflow). Hidden entirely when no table clears the
                base-share threshold. */}
            {hasSignificantArchival(result.archival || []) && (
              <div style={{ marginBottom: 24 }}>
                <div
                  style={{
                    fontSize: 18,
                    color: '#212529',
                    marginTop: 16,
                    marginBottom: 4,
                    paddingBottom: 6,
                    borderBottom: '1px solid #dee2e6',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                  <PerfIcon size={16} />
                  {intl.get('performance.section_title_archival').d('Archival candidates')}
                </div>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
                  {intl
                    .get('performance.section_subtitle_archival')
                    .d('Archiving old rows reduces compute time on every view.')}
                </div>
                <RowsSection
                  archival={result.archival || []}
                  deletedTableIds={deletedArchivalTableIds}
                  onCreateArchivalView={handleCreateArchivalView}
                  onDeleteArchivalRows={handleDeleteArchivalRows}
                />
              </div>
            )}

            {/* ---- Currently frozen columns (Phase B) ----
                Active frozen rows + recently-unfrozen rows shown with
                strikethrough until the next audit rerun picks them back up. */}
            {(Object.keys(frozenColumns).length > 0 ||
              pendingUnfrozen.size > 0 ||
              orphans.length > 0) &&
              (() => {
                // Pending unfrozen rows are guaranteed to NOT overlap frozenColumns
                // (the settings entry is cleared before we add to pendingUnfrozen),
                // so a flat concat with a per-row `pending` flag is enough.
                const rows: Array<{ key: string; fc: FrozenColumnRecord; pending: boolean }> = [
                  ...Object.entries(frozenColumns).map(([key, fc]) => ({
                    key,
                    fc,
                    pending: false,
                  })),
                  ...Array.from(pendingUnfrozen.entries()).map(([key, fc]) => ({
                    key,
                    fc,
                    pending: true,
                  })),
                ];
                const activeCount = Object.keys(frozenColumns).length;
                return (
                  <div style={{ marginTop: 16, marginBottom: 24 }}>
                    <div
                      style={{
                        fontSize: 18,
                        color: '#212529',
                        marginBottom: 12,
                        paddingBottom: 6,
                        borderBottom: '1px solid #dee2e6',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}>
                      <PerfIcon size={16} />
                      {intl
                        .get('performance.frozen_section_title', { count: activeCount })
                        .d(`Currently frozen (${activeCount})`)}
                    </div>
                    {rows.length > 0 && (
                      <table
                        className="audit-table"
                        style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <colgroup>
                          <col />
                          <col style={{ width: 140 }} />
                          <col style={{ width: 120 }} />
                        </colgroup>
                        <thead>
                          <tr style={{ borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
                            <th style={{ padding: '8px 12px', color: '#666' }}>
                              {intl.get('performance.frozen_col_column').d('Column')}
                            </th>
                            <th style={{ padding: '8px 12px', color: '#666' }}>
                              {intl.get('performance.frozen_col_when').d('Frozen at')}
                            </th>
                            <th style={{ padding: '8px 12px', color: '#666' }} />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(({ key, fc, pending }, i) => (
                            <tr
                              key={key}
                              className="audit-row"
                              style={{
                                backgroundColor: i % 2 === 0 ? '#fff' : '#f9f9f9',
                                borderBottom: '1px solid #eee',
                              }}>
                              <td
                                style={{
                                  padding: '6px 12px',
                                  fontSize: 14,
                                  textDecoration: pending ? 'line-through' : 'none',
                                  color: pending ? '#999' : 'inherit',
                                }}>
                                <span style={{ fontWeight: 700 }}>{fc.tableName}</span>
                                <span style={{ color: '#999' }}> &rsaquo; </span>
                                {fc.columnName}
                              </td>
                              <td
                                style={{
                                  padding: '6px 12px',
                                  fontSize: 14,
                                  color: pending ? '#bbb' : '#666',
                                  textDecoration: pending ? 'line-through' : 'none',
                                }}>
                                {(() => {
                                  try {
                                    return formatTimestamp(new Date(fc.frozenAt));
                                  } catch {
                                    return fc.frozenAt;
                                  }
                                })()}
                              </td>
                              <td style={{ padding: '6px 4px', fontSize: 14, textAlign: 'right' }}>
                                {pending ? null : (
                                  <button
                                    type="button"
                                    onClick={() => handleUnfreeze(key)}
                                    disabled={!!unfreezingKey}
                                    style={{
                                      background: 'none',
                                      border: '1px solid #ced4da',
                                      borderRadius: 4,
                                      padding: '4px 10px',
                                      fontSize: 13,
                                      color: unfreezingKey === key ? '#999' : '#212529',
                                      cursor: unfreezingKey ? 'not-allowed' : 'pointer',
                                    }}>
                                    {unfreezingKey === key
                                      ? intl.get('performance.unfreezing').d('Unfreezing...')
                                      : intl.get('performance.unfreeze').d('Unfreeze')}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {(pendingUnfrozen.size > 0 ||
                      pendingFrozenNow.size > 0 ||
                      hasStaleFreezeAcrossSessions) && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 13,
                          color: unfreezingKey || freezingNowKey ? '#999' : '#ff8000',
                          cursor: unfreezingKey || freezingNowKey ? 'default' : 'pointer',
                          userSelect: 'none',
                        }}
                        onClick={() => {
                          if (unfreezingKey || freezingNowKey) return;
                          setTests([]);
                          setSandbox({ status: 'idle' });
                          doAudit();
                        }}>
                        {intl
                          .get('performance.freeze_audit_stale')
                          .d(
                            "Performance analysis is outdated — recent freeze/unfreeze changes haven't been measured. Click to rerun now."
                          )}
                      </div>
                    )}
                    {/* Orphan freeze helpers — stale settings entries or stranded
                      helper columns. Rendered as a sibling sub-block within the
                      Currently frozen umbrella so the related state stays
                      grouped, but with a distinct title + cleanup affordance. */}
                    {orphans.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <div
                          style={{
                            fontSize: 14,
                            color: '#555',
                            fontWeight: 500,
                            marginBottom: 6,
                          }}>
                          {intl
                            .get('performance.orphan_helpers_title', {
                              count: orphans.length,
                            })
                            .d(`Orphan freeze helpers (${orphans.length})`)}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: '#888',
                            marginBottom: 8,
                            fontStyle: 'italic',
                          }}>
                          {intl
                            .get('performance.orphan_helpers_hint')
                            .d(
                              'Freeze-mechanism artifacts whose linked column or settings record is missing. Safe to clean up.'
                            )}
                        </div>
                        <table
                          className="audit-table"
                          style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <colgroup>
                            <col />
                            <col style={{ width: 200 }} />
                            <col style={{ width: 120 }} />
                          </colgroup>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
                              <th style={{ padding: '8px 12px', color: '#666' }}>
                                {intl.get('performance.orphan_col_what').d('Orphan')}
                              </th>
                              <th style={{ padding: '8px 12px', color: '#666' }}>
                                {intl.get('performance.orphan_col_reason').d('Reason')}
                              </th>
                              <th style={{ padding: '8px 12px', color: '#666' }} />
                            </tr>
                          </thead>
                          <tbody>
                            {orphans.map((o, i) => {
                              const isWorking = pendingCleanupOrphan === o.key;
                              const display =
                                o.kind === 'stale'
                                  ? {
                                      tableName: o.record.tableName,
                                      columnName: o.record.columnName,
                                      reason: intl
                                        .get('performance.orphan_reason_stale')
                                        .d('Frozen column missing — manually deleted?'),
                                    }
                                  : {
                                      tableName: o.tableName,
                                      columnName: o.columnName,
                                      reason: intl
                                        .get('performance.orphan_reason_stranded')
                                        .d('Helper column with no owning frozen entry'),
                                    };
                              return (
                                <tr
                                  key={o.key}
                                  className="audit-row"
                                  style={{
                                    backgroundColor: i % 2 === 0 ? '#fff' : '#f9f9f9',
                                    borderBottom: '1px solid #eee',
                                  }}>
                                  <td style={{ padding: '6px 12px', fontSize: 14 }}>
                                    <span style={{ fontWeight: 700 }}>{display.tableName}</span>
                                    <span style={{ color: '#999' }}> &rsaquo; </span>
                                    {display.columnName}
                                  </td>
                                  <td
                                    style={{
                                      padding: '6px 12px',
                                      fontSize: 12,
                                      color: '#666',
                                      fontStyle: 'italic',
                                    }}>
                                    {display.reason}
                                  </td>
                                  <td
                                    style={{
                                      padding: '6px 4px',
                                      fontSize: 14,
                                      textAlign: 'right',
                                    }}>
                                    <button
                                      type="button"
                                      onClick={() => handleCleanupOrphan(o)}
                                      disabled={!!pendingCleanupOrphan}
                                      style={{
                                        background: 'none',
                                        border: '1px solid #ced4da',
                                        borderRadius: 4,
                                        padding: '4px 10px',
                                        fontSize: 13,
                                        color: isWorking ? '#999' : '#212529',
                                        cursor: pendingCleanupOrphan ? 'not-allowed' : 'pointer',
                                      }}>
                                      {isWorking
                                        ? intl
                                            .get('performance.orphan_cleaning_up')
                                            .d('Cleaning up...')
                                        : intl.get('performance.orphan_cleanup').d('Clean up')}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* ---- Performance candidate columns umbrella ----
                Schema-level remediations (delete / freeze) staged through the
                test workflow or applied directly via "Freeze column now". The
                section used to have a subsection labeled "Columns" with its
                own chevron, but views are no longer surfaced here so the
                redundant header was dropped. */}
            <div
              style={{
                fontSize: 18,
                color: '#212529',
                marginTop: 16,
                marginBottom: 12,
                paddingBottom: 6,
                borderBottom: '1px solid #dee2e6',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
              <PerfIcon size={16} />
              <span style={{ flex: 1 }}>
                {intl.get('performance.section_title_main').d('Performance candidate columns')}
              </span>
              {result.candidates.length > 0 && (
                <ViewModeToggle
                  mode={candidatesViewMode}
                  onChange={setCandidatesViewMode}
                  flatLabel={intl.get('performance.view_banded').d('Grouped by impact')}
                />
              )}
            </div>

            <div style={{ marginBottom: 24 }}>
              {result.candidates.length === 0 && (
                <div style={{ color: '#28a745', fontSize: 13, padding: '4px 0' }}>
                  {intl
                    .get('performance.no_candidates')
                    .d('No performance candidates detected — base looks clean.')}
                </div>
              )}

              {top5SharePct !== null && (
                <div
                  style={{
                    fontSize: 12,
                    color: '#555',
                    fontStyle: 'italic',
                    marginBottom: 8,
                    padding: '4px 0',
                  }}>
                  {top5SharePct >= 50
                    ? intl
                        .get('performance.concentration_high')
                        .d('A few columns drive most of the load — focus on those first.')
                    : intl
                        .get('performance.concentration_low')
                        .d(
                          'Load is spread across many columns — no silver bullet, broader cleanup needed.'
                        )}
                </div>
              )}

              {displayedCandidates.length > 0 && (
                <table
                  className="audit-table"
                  style={{
                    width: '100%',
                    tableLayout: 'fixed',
                    borderCollapse: 'collapse',
                    fontSize: 14,
                  }}>
                  <colgroup>
                    <col />
                    <col style={{ width: 280 }} />
                    <col style={{ width: 32 }} />
                  </colgroup>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px' }}>
                        {intl.get('common.column').d('Column')}
                      </th>
                      <th
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          userSelect: 'none',
                          textAlign: 'center',
                        }}
                        title={intl
                          .get('performance.cost_tooltip')
                          .d(
                            'How much this column weighs on the base. Higher impact = more time spent computing this column when something is loaded.'
                          )}
                        onClick={toggleCandidatesSort}>
                        {intl.get('performance.impact_header').d('Impact')}
                        {sortIndicator(candidatesSortDir !== null, candidatesSortDir ?? 'asc')}
                      </th>
                      <th />
                    </tr>
                  </thead>
                  {candidatesViewMode === 'grouped'
                    ? tableNames.map((tName) => {
                        const tableCandidates = sortCandidates(
                          displayedCandidates.filter((c) => c.tableName === tName)
                        );
                        return (
                          <CandidateTableGroup
                            key={tName}
                            tableName={tName}
                            candidates={tableCandidates}
                            remediations={remediations}
                            onToggleAction={toggleColumnAction}
                            onDeleteNow={handleDeleteCandidateNow}
                            deletedCandidateKeys={deletedCandidateKeys}
                            frozenNowKeys={allFrozenKeys}
                            totalCostMs={totalCostMs}
                            costPerRowTags={costPerRowTags}
                            liveValue={liveValue}
                            costByKey={result.costByKey}
                            viewEdits={viewEdits}
                            onSetViewEdit={(viewId, hidden) =>
                              setViewEdits((prev) => {
                                const next = new Map(prev);
                                next.set(viewId, hidden);
                                return next;
                              })
                            }
                            stagedHides={hideRemediations}
                            onStageColumnVisibility={handleStageColumnVisibility}
                            onApplyColumnVisibility={handleApplyColumnVisibility}
                            onFreezeNow={handleFreezeNow}
                          />
                        );
                      })
                    : (['high', 'medium', 'low'] as const).map((band) => {
                        // Filter candidates whose cost-share lands in this band.
                        // The runner already orders by cost desc; preserve that
                        // within each band so the heaviest column always heads
                        // the High group.
                        const inBand = displayedCandidates.filter((c) => {
                          const pct =
                            c.measuredCostMs !== undefined && totalCostMs > 0
                              ? (c.measuredCostMs / totalCostMs) * 100
                              : 0;
                          return impactBandFromPct(pct) === band;
                        });
                        if (inBand.length === 0) return null;
                        return (
                          <CandidateBandGroup
                            key={band}
                            band={band}
                            candidates={inBand}
                            remediations={remediations}
                            onToggleAction={toggleColumnAction}
                            onDeleteNow={handleDeleteCandidateNow}
                            deletedCandidateKeys={deletedCandidateKeys}
                            frozenNowKeys={allFrozenKeys}
                            totalCostMs={totalCostMs}
                            costPerRowTags={costPerRowTags}
                            liveValue={liveValue}
                            costByKey={result.costByKey}
                            viewEdits={viewEdits}
                            onSetViewEdit={(viewId, hidden) =>
                              setViewEdits((prev) => {
                                const next = new Map(prev);
                                next.set(viewId, hidden);
                                return next;
                              })
                            }
                            stagedHides={hideRemediations}
                            onStageColumnVisibility={handleStageColumnVisibility}
                            onApplyColumnVisibility={handleApplyColumnVisibility}
                            onFreezeNow={handleFreezeNow}
                          />
                        );
                      })}
                </table>
              )}

              {hiddenCandidatesCount > 0 && (
                <div
                  style={{
                    fontSize: 12,
                    color: '#888',
                    fontStyle: 'italic',
                    padding: '6px 8px',
                  }}>
                  {intl
                    .get('performance.minor_candidates_hidden', {
                      count: hiddenCandidatesCount,
                    })
                    .d(
                      `+${hiddenCandidatesCount} negligible-impact column(s) hidden — see the per-table tab to inspect them.`
                    )}
                </div>
              )}
            </div>

            {/* ---- Create test case ---- */}
            {(result.candidates.length > 0 ||
              viewRemediations.size > 0 ||
              hideRemediations.size > 0) &&
              (() => {
                const stagedHideViewCount = Array.from(hideRemediations.values()).reduce(
                  (s, h) => s + h.views.length,
                  0
                );
                const stagedCount = remediations.size + viewRemediations.size + stagedHideViewCount;
                const enabled = stagedCount > 0 && !isBusy;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <button
                      onClick={handleCreateTestCase}
                      disabled={!enabled}
                      style={{
                        padding: '6px 16px',
                        fontSize: 13,
                        border: '1px solid #ff8000',
                        borderRadius: 4,
                        backgroundColor: enabled ? '#ff8000' : '#e9ecef',
                        color: enabled ? '#fff' : '#999',
                        cursor: enabled ? 'pointer' : 'default',
                      }}>
                      {intl
                        .get('performance.create_test_case', { count: stagedCount })
                        .d(`Create test case (${stagedCount} change(s))`)}
                    </button>
                  </div>
                );
              })()}

            {/* ---- Tests ---- */}
            {tests.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}>
                  <div
                    style={{
                      fontSize: 16,
                      color: '#333',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}>
                    <PerfIcon size={14} />
                    {intl.get('performance.results_title').d('Test results')}
                  </div>
                  <button
                    onClick={handleRunAllTests}
                    disabled={isBusy}
                    style={{
                      marginLeft: 12,
                      padding: '4px 12px',
                      fontSize: 12,
                      border: '1px solid #ff8000',
                      borderRadius: 4,
                      backgroundColor: isBusy ? '#e9ecef' : '#fff',
                      color: isBusy ? '#999' : '#ff8000',
                      cursor: isBusy ? 'default' : 'pointer',
                    }}>
                    {intl
                      .get('performance.run_all_tests', { count: tests.length })
                      .d(`Run all tests (${tests.length})`)}
                  </button>
                </div>

                {tests.map((t, idx) => (
                  <TestBlock
                    key={t.id}
                    test={t}
                    index={idx}
                    isBusy={isBusy}
                    isApplyingThis={applyingTestId === t.id}
                    progressMsg={progressMsg}
                    onRun={() => handleRunTest(t.id)}
                    onDelete={() =>
                      t.lastSandbox ? openDeleteModal(t.id) : handleDeleteTest(t.id, false)
                    }
                    confirmDeleteInDropdown={!t.lastSandbox}
                    onApply={() => openApplyModal(t.id)}
                    onCopyToSandbox={accountToken ? () => openCopyModal(t.id) : undefined}
                    onRemoveRemediation={(tableName, columnKey) =>
                      handleRemoveRemediation(t.id, tableName, columnKey)
                    }
                    onRemoveRemediationView={(tableId, viewId) =>
                      handleRemoveRemediationView(t.id, tableId, viewId)
                    }
                    onRemoveRemediationHide={(tableId, columnKey, viewId) =>
                      handleRemoveRemediationHide(t.id, tableId, columnKey, viewId)
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- Multi-array freeze confirmation ----
            Fires from inside an apply flow when a column's freeze would
            reshape its array result into long-text. Resolve/reject the
            pending Promise depending on the user's choice. */}
        {multiArrayModalState && (
          <ConfirmModal
            title={intl
              .get('performance.multi_array_modal_title')
              .d('Freeze will change column shape')}
            warning={intl
              .get('performance.multi_array_modal_warning', {
                tableName: multiArrayModalState.info.tableName,
                columnName: multiArrayModalState.info.columnName,
              })
              .d(
                `${multiArrayModalState.info.tableName} › ${multiArrayModalState.info.columnName} currently returns an array of values. Freezing will store the values joined as a comma-separated string in a long-text column.`
              )}
            body={
              <div style={{ fontSize: 13, color: '#555' }}>
                {intl
                  .get('performance.multi_array_modal_body')
                  .d(
                    'Downstream consumers (forms, automations, scripts, integrations) reading this column will receive a string instead of an array. Anything that calls .length or accesses individual elements will break.'
                  )}
                {/* Static "before / after" illustration. Concrete enough to ground
                    the user's mental model without piping actual row samples
                    through the callback. Upgrade to live data later if anyone
                    finds the abstraction unclear. */}
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 10px',
                    background: '#f8f9fa',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#333',
                  }}>
                  <span style={{ color: '#888' }}>
                    {intl.get('performance.multi_array_example_label').d('Example:')}
                  </span>{' '}
                  <span style={{ display: 'inline-flex', gap: 4, verticalAlign: 'middle' }}>
                    {['apple', 'banana', 'cherry'].map((s) => (
                      <span
                        key={s}
                        style={{
                          padding: '1px 8px',
                          borderRadius: 10,
                          background: '#e9ecef',
                          color: '#495057',
                          fontSize: 11,
                        }}>
                        {s}
                      </span>
                    ))}
                  </span>
                  <span style={{ color: '#888', margin: '0 6px' }}>→</span>
                  <span style={{ fontFamily: 'monospace', color: '#212529' }}>
                    &quot;apple, banana, cherry&quot;
                  </span>
                </div>
                <div style={{ marginTop: 8, color: '#888' }}>
                  {intl
                    .get('performance.multi_array_modal_rows', {
                      count: multiArrayModalState.info.rowCount,
                      arrayType: multiArrayModalState.info.arrayType || 'value',
                    })
                    .d(
                      `${multiArrayModalState.info.rowCount} rows · element type: ${multiArrayModalState.info.arrayType || 'unknown'}`
                    )}
                </div>
              </div>
            }
            confirmLabel={intl.get('performance.multi_array_freeze_anyway').d('Freeze anyway')}
            confirmColor="#dc3545"
            onCancel={() => {
              multiArrayModalState.resolve(false);
              setMultiArrayModalState(null);
            }}
            onConfirm={() => {
              multiArrayModalState.resolve(true);
              setMultiArrayModalState(null);
            }}
          />
        )}

        {/* ---- Apply confirmation modal ---- */}
        {applyModalTest && (
          <ApplyChangesModal
            test={applyModalTest}
            canDeleteSandbox={!!accountToken}
            onCancel={closeApplyModal}
            onConfirm={(viewsToDelete, deleteSandbox) =>
              handleApplyTest(applyModalTest.id, viewsToDelete, deleteSandbox)
            }
          />
        )}

        {/* ---- Delete test confirmation modal ---- */}
        {deleteModalTest && (
          <DeleteTestModal
            test={deleteModalTest}
            canDeleteSandbox={!!accountToken}
            isProcessing={deleteModalProcessing}
            onCancel={closeDeleteModal}
            onConfirm={(deleteSandbox) => handleDeleteTest(deleteModalTest.id, deleteSandbox)}
          />
        )}

        {/* ---- Copy-to-sandbox confirmation modal ---- */}
        {copyModalTest && (
          <CopyToSandboxModal
            test={copyModalTest}
            onCancel={closeCopyModal}
            onConfirm={(viewsToDelete, fullCopy) =>
              handleCopyToSandbox(copyModalTest.id, viewsToDelete, fullCopy)
            }
          />
        )}

        {/* ---- Delete archival rows with snapshot ----
            Portaled to document.body so it isn't hidden when triggered from a
            per-table tab (PerformanceAudit's container is display:none in that case). */}
        {archivalDeleteModalRow &&
          (() => {
            const { archival: a, allRowIds, safeRowIds } = archivalDeleteModalRow;
            const showRadio = safeRowIds.length < allRowIds.length;
            const selectedIds = archivalDeleteScope === 'safe' ? safeRowIds : allRowIds;
            const count = selectedIds.length;
            return createPortal(
              <ConfirmModal
                title={intl
                  .get('performance.archival_delete_title', { count, table: a.tableName })
                  .d(`Delete ${count} archival row(s) from "${a.tableName}"?`)}
                warning={intl
                  .get('performance.archival_delete_warning')
                  .d(
                    'These rows will be permanently deleted. A snapshot is taken first so you can restore the table data if needed. Note: snapshots back up rows but NOT asset files (uploaded images, attachments).'
                  )}
                body={
                  <div style={{ fontSize: 13, color: '#444' }}>
                    {intl
                      .get('performance.archival_delete_body', { count, table: a.tableName })
                      .d(
                        `${count} row(s) in "${a.tableName}" have not been created or modified since the audit threshold.`
                      )}
                    {showRadio && (
                      <div
                        style={{
                          marginTop: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            cursor: 'pointer',
                          }}>
                          <input
                            type="radio"
                            name="archival-delete-scope"
                            checked={archivalDeleteScope === 'safe'}
                            onChange={() => setArchivalDeleteScope('safe')}
                            style={{ marginTop: 3 }}
                          />
                          <span>
                            {intl
                              .get('performance.archival_scope_safe', {
                                count: safeRowIds.length,
                              })
                              .d(
                                `Only ${safeRowIds.length} safe row(s) — not referenced by any other table.`
                              )}
                          </span>
                        </label>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            cursor: 'pointer',
                          }}>
                          <input
                            type="radio"
                            name="archival-delete-scope"
                            checked={archivalDeleteScope === 'all'}
                            onChange={() => setArchivalDeleteScope('all')}
                            style={{ marginTop: 3 }}
                          />
                          <span>
                            {intl
                              .get('performance.archival_scope_all', {
                                count: allRowIds.length,
                                referenced: allRowIds.length - safeRowIds.length,
                              })
                              .d(
                                `All ${allRowIds.length} row(s) — including ${allRowIds.length - safeRowIds.length} referenced from other tables (those references will be cleared).`
                              )}
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                }
                confirmLabel={
                  archivalDeleting
                    ? intl.get('performance.archival_delete_running').d('Snapshotting & deleting…')
                    : intl.get('performance.archival_delete_confirm').d('Snapshot and delete')
                }
                confirmColor="#dc3545"
                doubleConfirmLabel={intl
                  .get('performance.archival_delete_double_confirm', { count })
                  .d(`Confirm: delete ${count} row(s)?`)}
                isProcessing={archivalDeleting}
                onCancel={handleArchivalDeleteModalCancel}
                onConfirm={handleArchivalDeleteModalConfirm}
              />,
              document.body
            );
          })()}

        {/* ---- Add ctime/mtime column confirmation (Create archival view) ---- */}
        {archivalViewModalRow &&
          (() => {
            const a = archivalViewModalRow;
            const hasCtime = !!a.ctimeColumnKey;
            const hasMtime = !!a.mtimeColumnKey;
            const bothMissing = !hasCtime && !hasMtime;
            // State 2 → cancel still creates the view (with weaker filter); State 3 → cancel aborts.
            const cancelLabel = bothMissing
              ? intl.get('performance.cancel').d('Cancel')
              : intl.get('performance.archival_modal_skip').d('Skip and create with weaker filter');
            const title = bothMissing
              ? intl
                  .get('performance.archival_modal_title_both', { table: a.tableName })
                  .d(`Add date columns to "${a.tableName}"?`)
              : intl
                  .get('performance.archival_modal_title_one', { table: a.tableName })
                  .d(`Add the missing date column to "${a.tableName}"?`);
            const body = bothMissing
              ? intl
                  .get('performance.archival_modal_body_both', { table: a.tableName })
                  .d(
                    `"${a.tableName}" has no created-time or last-modified column. Adding both lets the new view filter rows by age. The columns are based on built-in row metadata — no data loss.`
                  )
              : intl
                  .get('performance.archival_modal_body_one', {
                    table: a.tableName,
                    existing: hasCtime
                      ? intl.get('performance.archival_col_ctime').d('Created time')
                      : intl.get('performance.archival_col_mtime').d('Last modified'),
                    missing: hasCtime
                      ? intl.get('performance.archival_col_mtime').d('Last modified')
                      : intl.get('performance.archival_col_ctime').d('Created time'),
                  })
                  .d(
                    `"${a.tableName}" has only the ${hasCtime ? 'created-time' : 'last-modified'} column. Add the missing one for a stricter filter (rows older than the threshold on BOTH timestamps), or skip to create the view with the single available filter.`
                  );
            return createPortal(
              <ConfirmModal
                title={title}
                body={<div style={{ fontSize: 13, color: '#444' }}>{body}</div>}
                confirmLabel={intl
                  .get('performance.archival_modal_confirm')
                  .d('Add column(s) and create view')}
                confirmColor="#ff8000"
                cancelLabel={cancelLabel}
                onCancel={handleArchivalViewModalCancel}
                onConfirm={handleArchivalViewModalConfirm}
              />,
              document.body
            );
          })()}
      </div>
    );
  }
);
PerformanceAudit.displayName = 'PerformanceAudit';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Table group — collapsible, Links-audit style, with context menus */
// Views-by-size section. Renders either grouped by table (one block per table with a
// collapsible header) or flat (single list sorted by row count desc). Each row shows the
// view name, row count, weight bar, and a delete action. Deletion happens immediately
// in the base; the row is marked with strikethrough until the next audit rerun.

const ViewsSection: React.FC<{
  views: PerformanceAuditView[];
  // Optional override for the weight % denominator. When the parent has filtered
  // `views` for noise but wants weights computed against the original total, it
  // passes the unfiltered total here. Falls back to summing the passed-in views.
  totalLoadMsOverride?: number;
  archival: PerformanceAuditTableArchival[];
  mode: 'grouped' | 'flat';
  deletedViewKeys: Set<string>;
  viewRemediations: Map<string, RemediatedView>;
  // Per-view visibility drill props — shared with TableTab via PA-level state.
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  // Read-only view of staged hides for the slider state.
  hideRemediations: Map<string, RemediatedColumnHide>;
  liveValue: any;
  candidateColumnKeys: Set<string>;
  onApplyVisibility: (tableId: string, tableName: string, viewId: string, viewName: string) => void;
  onStageVisibility: (tableId: string, tableName: string, viewId: string, viewName: string) => void;
  onDelete: (tableName: string, viewName: string, keyStr: string) => void;
  onToggleStage: (payload: RemediatedView) => void;
}> = ({
  views,
  totalLoadMsOverride,
  archival,
  mode,
  deletedViewKeys,
  viewRemediations,
  viewEdits,
  onSetViewEdit,
  hideRemediations,
  liveValue,
  candidateColumnKeys,
  onApplyVisibility,
  onStageVisibility,
  onDelete,
  onToggleStage,
}) => {
  const [expandedViewIds, setExpandedViewIds] = useState<Set<string>>(new Set());
  const toggleViewExpand = (viewId: string) =>
    setExpandedViewIds((prev) => {
      const next = new Set(prev);
      if (next.has(viewId)) next.delete(viewId);
      else next.add(viewId);
      return next;
    });

  // Staged hidden columns for one view (any column in this table whose
  // staged-hides list includes this viewId).
  const getStagedHiddenForView = (tableId: string, viewId: string): Set<string> => {
    const out = new Set<string>();
    hideRemediations.forEach((h) => {
      if (h.tableId !== tableId) return;
      if (h.views.some((v) => v.viewId === viewId)) out.add(h.columnKey);
    });
    return out;
  };

  const getCommittedHiddenForView = (tableId: string, viewId: string): Set<string> => {
    const t = liveValue?.tables?.find((tt: any) => tt._id === tableId);
    const v = t?.views?.find((vv: any) => vv._id === viewId);
    const base = new Set<string>(v?.hidden_columns || []);
    const staged = getStagedHiddenForView(tableId, viewId);
    if (staged.size === 0) return base;
    const merged = new Set<string>(base);
    staged.forEach((k) => merged.add(k));
    return merged;
  };

  const getEffectiveHiddenForView = (tableId: string, viewId: string): Set<string> => {
    return viewEdits.get(viewId) ?? getCommittedHiddenForView(tableId, viewId);
  };

  const hasUnsavedFor = (tableId: string, viewId: string): boolean => {
    const edits = viewEdits.get(viewId);
    if (!edits) return false;
    const committed = getCommittedHiddenForView(tableId, viewId);
    if (edits.size !== committed.size) return true;
    for (const k of Array.from(edits)) {
      if (!committed.has(k)) return true;
    }
    return false;
  };

  const toggleColumnInView = (tableId: string, viewId: string, colKey: string) => {
    const current = new Set(viewEdits.get(viewId) ?? getCommittedHiddenForView(tableId, viewId));
    if (current.has(colKey)) current.delete(colKey);
    else current.add(colKey);
    onSetViewEdit(viewId, current);
  };
  type SortKey = 'view' | 'rows' | 'weight';
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else setSortKey(null);
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const totalLoadMs = totalLoadMsOverride ?? views.reduce((s, v) => s + (v.loadMs || 0), 0);
  const archivalByTableId = new Map<string, PerformanceAuditTableArchival>();
  // Per-table total row count, keyed by tableId — used to display "viewRows / tableRows".
  const tableRowsByTableId = new Map<string, number>();
  for (const a of archival) {
    if (a.candidateCountNoIncomingLinks > 0) archivalByTableId.set(a.tableId, a);
    tableRowsByTableId.set(a.tableId, a.totalRows);
  }

  if (views.length === 0) {
    return (
      <div style={{ fontSize: 13, color: '#888', padding: '4px 0' }}>
        {intl.get('performance.no_views').d('No views in this base.')}
      </div>
    );
  }

  const sortViews = (vs: PerformanceAuditView[]): PerformanceAuditView[] => {
    if (!sortKey) return vs;
    return [...vs].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'view') cmp = a.viewName.localeCompare(b.viewName);
      else if (sortKey === 'rows') cmp = a.rowCount - b.rowCount;
      else cmp = (a.loadMs ?? 0) - (b.loadMs ?? 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  };

  // Render a single body row as a <tr>. `rowIdx` is the alternating-bg index local to the
  // current tbody segment (flat: full list, grouped: within the current group).
  const renderRow = (v: PerformanceAuditView, showTableName: boolean, rowIdx: number) => {
    const keyStr = `${v.tableId}:${v.viewId}`;
    const isDeleted = deletedViewKeys.has(keyStr);
    const isStaged = !isDeleted && viewRemediations.has(keyStr);
    const weightPct = totalLoadMs > 0 ? (v.loadMs / totalLoadMs) * 100 : 0;
    const archivalHint = archivalByTableId.get(v.tableId);
    const expandable = !isDeleted && !isStaged && weightPct >= MIN_RELEVANT_PCT;
    const isExpanded = expandedViewIds.has(v.viewId);
    const isDirty = hasUnsavedFor(v.tableId, v.viewId);
    return (
      <React.Fragment key={keyStr}>
        <tr
          className="audit-row"
          style={{
            borderBottom: '1px solid #eee',
            backgroundColor: rowIdx % 2 === 0 ? '#fff' : '#f9f9f9',
            opacity: isDeleted ? 0.5 : 1,
            color: isDeleted ? '#888' : isStaged ? '#777' : undefined,
          }}>
          <td style={{ padding: '6px 12px', wordBreak: 'break-word' }}>
            {expandable && (
              <i
                onClick={() => toggleViewExpand(v.viewId)}
                className={`dtable-font ${isExpanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                style={{
                  fontSize: 10,
                  color: '#888',
                  marginRight: 6,
                  cursor: 'pointer',
                }}
              />
            )}
            {showTableName && (
              <>
                <span style={{ fontWeight: 700 }}>{v.tableName}</span>
                <span style={{ color: '#999', marginLeft: 4, marginRight: 4 }}>&rsaquo;</span>
              </>
            )}
            <span
              style={{
                textDecoration: isDeleted || isStaged ? 'line-through' : undefined,
              }}>
              {v.viewName}
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
            {v.privateFor && (
              <span
                title={intl
                  .get('performance.private_view_tooltip', { owner: v.privateFor })
                  .d(`Private view (owner: ${v.privateFor})`)}
                style={{ marginLeft: 6 }}>
                <i
                  className="dtable-font dtable-icon-private-database"
                  style={{ fontSize: 14, color: '#888' }}
                />
              </span>
            )}
            {archivalHint && (
              <span
                title={intl
                  .get('performance.archival_hint', {
                    count: archivalHint.candidateCountNoIncomingLinks,
                    table: v.tableName,
                  })
                  .d(
                    `${archivalHint.candidateCountNoIncomingLinks} archivable rows in ${v.tableName} — archiving may reduce this view`
                  )}
                style={{ marginLeft: 6 }}>
                <i
                  className="dtable-font dtable-icon-archive-view"
                  style={{ fontSize: 14, color: '#888' }}
                />
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
            title={intl
              .get('performance.view_rows_tooltip')
              .d('Rows returned by this view, out of total rows in the table.')}
            style={{ padding: '6px 12px', color: '#666' }}>
            {v.rowCount}
            {tableRowsByTableId.has(v.tableId) && (
              <span style={{ color: '#aaa' }}> / {tableRowsByTableId.get(v.tableId)}</span>
            )}
          </td>
          <td
            title={intl
              .get('performance.view_weight_tooltip')
              .d(
                "Share of total view-load time (rowCount × ms). Deleting removes this view as a switching destination but doesn't reduce overall base compute work."
              )}
            style={{ padding: '6px 12px' }}>
            <PercentBar pct={weightPct} />
          </td>
          <td style={{ padding: '6px 4px', textAlign: 'center' }}>
            {!isDeleted &&
              (() => {
                const isStaged = viewRemediations.has(keyStr);
                const stageDeleteLabel = isStaged
                  ? intl.get('performance.unstage_delete_view').d('Unstage delete view')
                  : intl.get('performance.stage_delete_view').d('Stage delete view');
                const directLabel = v.privateFor
                  ? intl.get('performance.delete_private_view_now').d('Delete private view now')
                  : intl.get('performance.delete_view_now').d('Delete view now');
                const extras: any[] = [];
                if (expandable) {
                  extras.push({
                    label: intl.get('performance.stage_update_view').d('Stage update view'),
                    icon: 'dtable-icon-gauge',
                    color: isDirty ? '#dc3545' : '#999',
                    disabled: !isDirty,
                    disabledTooltip: intl
                      .get('performance.no_unsaved_visibility')
                      .d('Toggle the column sliders first.'),
                    onClick: () => onStageVisibility(v.tableId, v.tableName, v.viewId, v.viewName),
                  });
                }
                extras.push({
                  label: stageDeleteLabel,
                  icon: 'dtable-icon-gauge',
                  color: isStaged ? '#999' : '#dc3545',
                  onClick: () =>
                    onToggleStage({
                      tableId: v.tableId,
                      tableName: v.tableName,
                      viewId: v.viewId,
                      viewName: v.viewName,
                      privateFor: v.privateFor ?? null,
                    }),
                });
                extras.push({ divider: true, label: '', onClick: () => {} });
                if (expandable) {
                  extras.push({
                    label: intl.get('performance.update_view_now').d('Update view now'),
                    icon: 'dtable-icon-eye',
                    color: isDirty ? '#0066cc' : '#999',
                    disabled: !isDirty,
                    disabledTooltip: intl
                      .get('performance.no_unsaved_visibility')
                      .d('Toggle the column sliders first.'),
                    onClick: () => onApplyVisibility(v.tableId, v.tableName, v.viewId, v.viewName),
                  });
                }
                return (
                  <ContextMenu
                    onDelete={() => onDelete(v.tableName, v.viewName, keyStr)}
                    label={directLabel}
                    extraActions={extras}
                  />
                );
              })()}
          </td>
        </tr>
        {isExpanded &&
          (() => {
            const t = liveValue?.tables?.find((tt: any) => tt._id === v.tableId);
            const liveView = t?.views?.find((vv: any) => vv._id === v.viewId);
            if (!liveView) return null;
            const cols = (t?.columns ?? []) as any[];
            const effectiveHidden = getEffectiveHiddenForView(v.tableId, v.viewId);
            return (
              <tr style={{ backgroundColor: '#fafbfc' }}>
                <td colSpan={4} style={{ padding: 0, borderBottom: '1px solid #eee' }}>
                  <ViewVisibilityDrill
                    tableId={v.tableId}
                    viewId={v.viewId}
                    liveView={liveView}
                    liveColumns={cols}
                    candidateColumnKeys={candidateColumnKeys}
                    effectiveHidden={effectiveHidden}
                    onToggleColumn={(colKey) => toggleColumnInView(v.tableId, v.viewId, colKey)}
                  />
                </td>
              </tr>
            );
          })()}
      </React.Fragment>
    );
  };

  const head = (
    <thead>
      <tr style={{ borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
        <th style={{ padding: '8px 12px', ...SORTABLE_TH }} onClick={() => toggleSort('view')}>
          {intl.get('common.view').d('View')}
          {sortIndicator(sortKey === 'view', sortDir)}
        </th>
        <th
          style={{ padding: '8px 12px', ...SORTABLE_TH }}
          title={intl
            .get('performance.view_rows_tooltip')
            .d('Rows returned by this view, out of total rows in the table.')}
          onClick={() => toggleSort('rows')}>
          {intl.get('common.rows').d('Rows')}
          {sortIndicator(sortKey === 'rows', sortDir)}
        </th>
        <th
          style={{ padding: '8px 12px', ...SORTABLE_TH }}
          title={intl
            .get('performance.view_weight_tooltip')
            .d("This view's share of total view-load time (rowCount × ms) before the remediation.")}
          onClick={() => toggleSort('weight')}>
          {intl.get('performance.weight').d('Weight')}
          {sortIndicator(sortKey === 'weight', sortDir)}
        </th>
        <th />
      </tr>
    </thead>
  );

  const tableStyle: React.CSSProperties = {
    width: '100%',
    tableLayout: 'fixed',
    borderCollapse: 'collapse',
    fontSize: 14,
  };
  const colgroup = (
    <colgroup>
      <col />
      <col style={{ width: 130 }} />
      <col style={{ width: 140 }} />
      <col style={{ width: 32 }} />
    </colgroup>
  );

  if (mode === 'flat') {
    const sorted = sortViews(views);
    return (
      <table className="audit-table" style={tableStyle}>
        {colgroup}
        {head}
        <tbody>{sorted.map((v, i) => renderRow(v, true, i))}</tbody>
      </table>
    );
  }

  // Grouped: preserve the ordering of tables by their first-appearing (heaviest) view.
  // Sorting (when active) applies within each group.
  const tableNames: string[] = [];
  for (const v of views) {
    if (!tableNames.includes(v.tableName)) tableNames.push(v.tableName);
  }
  const isViewStaged = (v: PerformanceAuditView) =>
    viewRemediations.has(`${v.tableId}:${v.viewId}`);
  const isViewRelevant = (v: PerformanceAuditView) =>
    totalLoadMs > 0 && (v.loadMs / totalLoadMs) * 100 >= MIN_RELEVANT_PCT;
  return (
    <table className="audit-table" style={tableStyle}>
      {colgroup}
      {head}
      {tableNames.map((tName) => {
        const inTable = sortViews(views.filter((v) => v.tableName === tName));
        return (
          <ViewsTableGroupBody
            key={tName}
            tableName={tName}
            views={inTable}
            renderRow={renderRow}
            isViewStaged={isViewStaged}
            isViewRelevant={isViewRelevant}
            onToggleStage={onToggleStage}
            onDelete={onDelete}
          />
        );
      })}
    </table>
  );
};

// Renders a collapsible group inside the views <table>: a header row with the table
// name + view count, and the per-view rows when open. Each group has its own open
// state, so the user can collapse big tables independently.
const ViewsTableGroupBody: React.FC<{
  tableName: string;
  views: PerformanceAuditView[];
  renderRow: (v: PerformanceAuditView, showTableName: boolean, rowIdx: number) => React.ReactNode;
  isViewStaged: (v: PerformanceAuditView) => boolean;
  isViewRelevant: (v: PerformanceAuditView) => boolean;
  onToggleStage: (payload: RemediatedView) => void;
  onDelete: (tableName: string, viewName: string, keyStr: string) => void;
}> = ({ tableName, views, renderRow, isViewStaged, isViewRelevant, onToggleStage, onDelete }) => {
  const [open, setOpen] = useState(true);
  // Group-level batch helpers. Stage-all toggles: if every relevant view is already
  // staged, "Stage all" becomes "Unstage all"; otherwise it stages every relevant
  // unstaged view in this group. Non-relevant views are skipped both ways.
  const relevantViews = views.filter(isViewRelevant);
  const allRelevantStaged = relevantViews.length > 0 && relevantViews.every(isViewStaged);
  const someUnstagedRelevant = relevantViews.some((v) => !isViewStaged(v));
  const handleStageAll = () => {
    if (allRelevantStaged) {
      // Unstage everything currently staged in this group.
      for (const v of views) {
        if (isViewStaged(v)) {
          onToggleStage({
            tableId: v.tableId,
            tableName: v.tableName,
            viewId: v.viewId,
            viewName: v.viewName,
            privateFor: v.privateFor ?? null,
          });
        }
      }
    } else {
      // Stage every relevant unstaged view.
      for (const v of relevantViews) {
        if (!isViewStaged(v)) {
          onToggleStage({
            tableId: v.tableId,
            tableName: v.tableName,
            viewId: v.viewId,
            viewName: v.viewName,
            privateFor: v.privateFor ?? null,
          });
        }
      }
    }
  };
  const handleDeleteAll = () => {
    for (const v of views) {
      onDelete(v.tableName, v.viewName, `${v.tableId}:${v.viewId}`);
    }
  };
  return (
    <tbody>
      <tr className="asset-audit-group" style={{ userSelect: 'none' }}>
        <td
          colSpan={3}
          style={{ padding: '6px 12px', cursor: 'pointer' }}
          onClick={() => setOpen(!open)}>
          <i
            className={`dtable-font ${open ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 10, color: '#666', marginRight: 6 }}
          />
          <span style={{ fontWeight: 700 }}>{tableName}</span>
          <span style={{ color: '#888', fontSize: 12, marginLeft: 6 }}>
            ({views.length} view{views.length !== 1 ? 's' : ''})
          </span>
        </td>
        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
          <ContextMenu
            onDelete={handleDeleteAll}
            label={intl
              .get('performance.delete_all_views_now', { table: tableName })
              .d(`Delete all views in "${tableName}" now`)}
            extraActions={[
              {
                label: allRelevantStaged
                  ? intl.get('performance.unstage_all_views').d('Unstage all views in this table')
                  : intl
                      .get('performance.stage_all_views')
                      .d('Stage all relevant views in this table'),
                icon: 'dtable-icon-gauge',
                color: allRelevantStaged ? '#999' : '#dc3545',
                disabled: !allRelevantStaged && !someUnstagedRelevant,
                disabledTooltip: intl
                  .get('performance.stage_all_views_no_relevant')
                  .d('No views in this table are significant enough to stage.'),
                onClick: handleStageAll,
              },
              { divider: true, label: '', onClick: () => {} },
            ]}
          />
        </td>
      </tr>
      {open && views.map((v, i) => renderRow(v, false, i))}
    </tbody>
  );
};

// Rows section — per-table archival analysis list. Only surfaces tables with at
// least one archival candidate. The safe-to-archive count (rows with no incoming
// links) is shown in parens next to the total candidate count.
//
// Rendered as a real <table> with <colgroup> so column widths are guaranteed
// consistent across the header and every body row — same pattern as TableTab.
const SORTABLE_TH: React.CSSProperties = { cursor: 'pointer', userSelect: 'none' };

function sortIndicator(active: boolean, dir: 'asc' | 'desc'): React.ReactNode {
  if (!active) {
    return (
      <i
        className="dtable-font dtable-icon-sort"
        style={{ marginLeft: 4, fontSize: 12, color: '#ccc' }}
      />
    );
  }
  return <span style={{ marginLeft: 4, fontSize: 11 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
}

// Inclusion threshold for the Rows section: a table only appears when it has at
// least this many archival candidates. Absolute count rather than a base-share
// percentage — paired-state validation (R² ≈ 0.9, 2026-05-06) showed that even
// tables below 5% of base rows produce real measurable speedups when archived,
// so a percent-of-base gate was hiding actionable wins.
const ROWS_MIN_CANDIDATES = 100;

// Cheap check used by the parent to decide whether to render the Rows section at
// all. Returns true iff at least one table has enough archival candidates to be
// worth surfacing; when false the parent suppresses the whole section.
function hasSignificantArchival(archival: PerformanceAuditTableArchival[]): boolean {
  return archival.some((a) => a.candidateCount >= ROWS_MIN_CANDIDATES);
}

const RowsSection: React.FC<{
  archival: PerformanceAuditTableArchival[];
  deletedTableIds?: Set<string>;
  onCreateArchivalView?: (a: PerformanceAuditTableArchival) => void;
  onDeleteArchivalRows?: (a: PerformanceAuditTableArchival) => void;
}> = ({ archival, deletedTableIds, onCreateArchivalView, onDeleteArchivalRows }) => {
  type SortKey = 'table' | 'rows' | 'candidates';
  // Default sort: most archival candidates first. Biggest absolute wins lead.
  const [sortKey, setSortKey] = useState<SortKey | null>('candidates');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else setSortKey(null);
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // Filter: only show tables with enough archival candidates to be worth acting on.
  const significant = archival.filter((a) => a.candidateCount >= ROWS_MIN_CANDIDATES);
  // Tables that *do* have archival candidates but fall below the threshold — surfaced
  // as a footnote so users know per-table tabs still expose those numbers.
  const belowThresholdCount = archival.filter(
    (a) => a.candidateCount > 0 && a.candidateCount < ROWS_MIN_CANDIDATES
  ).length;
  const sorted = !sortKey
    ? significant
    : [...significant].sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'table') cmp = a.tableName.localeCompare(b.tableName);
        else if (sortKey === 'rows') cmp = a.totalRows - b.totalRows;
        else cmp = a.candidateCount - b.candidateCount;
        return sortDir === 'asc' ? cmp : -cmp;
      });

  if (archival.length === 0) {
    return (
      <div style={{ fontSize: 13, color: '#888', padding: '4px 0' }}>
        {intl.get('performance.no_archival_data').d('No row data available.')}
      </div>
    );
  }
  // Note: when no table clears ROWS_MIN_CANDIDATES, the parent suppresses the
  // whole section via hasSignificantArchival, so we never render an empty body.

  return (
    <>
      <table
        className="audit-table"
        style={{
          width: '100%',
          tableLayout: 'fixed',
          borderCollapse: 'collapse',
          fontSize: 14,
        }}>
        <colgroup>
          <col />
          <col style={{ width: 100 }} />
          <col style={{ width: 280 }} />
          <col style={{ width: 32 }} />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: '2px solid #dee2e6', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px', ...SORTABLE_TH }} onClick={() => toggleSort('table')}>
              {intl.get('common.table').d('Table')}
              {sortIndicator(sortKey === 'table', sortDir)}
            </th>
            <th style={{ padding: '8px 12px', ...SORTABLE_TH }} onClick={() => toggleSort('rows')}>
              {intl.get('common.rows').d('Rows')}
              {sortIndicator(sortKey === 'rows', sortDir)}
            </th>
            <th
              style={{ padding: '8px 12px', textAlign: 'center', ...SORTABLE_TH }}
              onClick={() => toggleSort('candidates')}>
              {intl.get('performance.rows_archival_header').d('Archival candidates')}
              {sortIndicator(sortKey === 'candidates', sortDir)}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, i) => {
            const pct = a.totalRows > 0 ? (a.candidateCount / a.totalRows) * 100 : 0;
            const isDeleted = deletedTableIds?.has(a.tableId) === true;
            return (
              <tr
                key={a.tableId}
                className="audit-row"
                style={{
                  borderBottom: '1px solid #eee',
                  backgroundColor: i % 2 === 0 ? '#fff' : '#f9f9f9',
                  textDecoration: isDeleted ? 'line-through' : 'none',
                  color: isDeleted ? '#999' : undefined,
                }}>
                <td style={{ padding: '6px 12px', fontWeight: 700, wordBreak: 'break-word' }}>
                  {a.tableName}
                </td>
                <td style={{ padding: '6px 12px', color: '#888' }}>{a.totalRows}</td>
                <td
                  style={{ padding: '6px 12px', color: '#555', textAlign: 'center' }}
                  title={intl
                    .get('performance.rows_archival_tooltip_combined')
                    .d(
                      'Rows whose creation and modification times are both older than the archival threshold. "Safe" rows are not referenced by any link column elsewhere — safest to archive first.'
                    )}>
                  {a.candidateCountNoIncomingLinks === a.candidateCount
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
                        )}
                </td>
                <td style={{ padding: '6px 4px' }}>
                  <ContextMenu
                    onDelete={() => onDeleteArchivalRows && onDeleteArchivalRows(a)}
                    confirmDelete={false}
                    deleteDisabled={isDeleted}
                    deleteDisabledTooltip={
                      isDeleted
                        ? intl
                            .get('performance.archival_already_deleted')
                            .d('Already deleted in this session')
                        : undefined
                    }
                    label={intl
                      .get('performance.rows_delete_with_snapshot')
                      .d('Delete with snapshot')}
                    extraActions={[
                      {
                        label: intl
                          .get('performance.rows_create_archival_view')
                          .d('Create archival view'),
                        icon: 'dtable-icon-archive-view',
                        onClick: () => onCreateArchivalView && onCreateArchivalView(a),
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {belowThresholdCount > 0 && (
        <div
          style={{
            fontSize: 12,
            color: '#888',
            fontStyle: 'italic',
            padding: '6px 8px',
          }}>
          {intl
            .get('performance.rows_belowthreshold_footer', {
              count: belowThresholdCount,
              threshold: ROWS_MIN_CANDIDATES,
            })
            .d(
              `+${belowThresholdCount} table(s) with fewer than ${ROWS_MIN_CANDIDATES} archival candidates — see individual table tabs for details.`
            )}
        </div>
      )}
    </>
  );
};

// Small segmented control to switch between grouped-by-table and flat-global ordering
// of the Performance Candidates list.
const ViewModeToggle: React.FC<{
  mode: 'grouped' | 'flat';
  onChange: (m: 'grouped' | 'flat') => void;
  flatLabel?: string;
  groupedLabel?: string;
}> = ({ mode, onChange, flatLabel, groupedLabel }) => {
  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    border: '1px solid #ccc',
    backgroundColor: active ? '#ff8000' : '#fff',
    color: active ? '#fff' : '#555',
    cursor: 'pointer',
  });
  return (
    <div style={{ display: 'inline-flex' }}>
      <button
        style={{ ...btnStyle(mode === 'grouped'), borderRadius: '4px 0 0 4px' }}
        onClick={() => onChange('grouped')}>
        {groupedLabel ?? intl.get('performance.view_grouped').d('Grouped by table')}
      </button>
      <button
        style={{ ...btnStyle(mode === 'flat'), borderRadius: '0 4px 4px 0', borderLeft: 'none' }}
        onClick={() => onChange('flat')}>
        {flatLabel ?? intl.get('performance.view_flat').d('Flat by cost')}
      </button>
    </div>
  );
};

// Single candidate row. State (chain expand, rules expand) lives here so the row is
// self-contained and can be composed into either the grouped or flat view without the
// parent tracking per-row state.
const CandidateRow: React.FC<{
  c: PerformanceAuditResult['candidates'][number];
  remediations: Map<string, RemediationAction>;
  onToggleAction: (key: string, action: RemediationAction) => void;
  onDeleteNow: (tableName: string, tableId: string, columnName: string, columnKey: string) => void;
  deletedCandidateKeys: Set<string>;
  // Column full-keys frozen via "Freeze column now" since the last audit.
  // Rendered grayed-out + strikethrough + "frozen" mention — same visual
  // shorthand as deletedCandidateKeys, but reversible (live in Currently
  // frozen, can be unfrozen). Cleared on next audit completion.
  frozenNowKeys: Set<string>;
  totalCostMs: number;
  costPerRowTag?: 'structural' | 'volume';
  showTableName?: boolean;
  rowIdx: number;
  // Hide-in-view drill props. Pass live value (for current hidden_columns +
  // view rules), viewLoadsByKey (for visibleRows), costByKey (for per-cell),
  // and the shared per-view edit map + setter. Stage/Apply column-level
  // commit handlers are passed in too for the menu.
  liveValue: any;
  costByKey: Map<string, number>;
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  // Read-only view of staged hides — included in the drill's effective state
  // so freshly-staged hides show as toggled-off immediately.
  stagedHides: Map<string, RemediatedColumnHide>;
  onStageColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onApplyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onFreezeNow: (tableId: string, tableName: string, columnKey: string, columnName: string) => void;
}> = ({
  c,
  remediations,
  onToggleAction,
  onDeleteNow,
  deletedCandidateKeys,
  frozenNowKeys,
  totalCostMs,
  costPerRowTag,
  showTableName,
  rowIdx,
  liveValue,
  costByKey,
  viewEdits,
  onSetViewEdit,
  stagedHides,
  onFreezeNow,
  onStageColumnVisibility,
  onApplyColumnVisibility,
}) => {
  const [expandedChain, setExpandedChain] = useState(false);
  const [expandedRules, setExpandedRules] = useState(false);

  const key = `${c.tableId}:${c.columnKey}`;
  const icon = COLUMN_TYPE_ICONS[c.columnType] || 'dtable-icon-formula';
  const action = remediations.get(key);
  const isSelected = !!action;
  const isDeletedNow = deletedCandidateKeys.has(key);
  const isFrozenNow = frozenNowKeys.has(key);

  // The (col, view) pairs currently staged-hidden for this column. Used by
  // the dirty check below to know whether viewEdits' state matches the
  // committed state.
  const stagedViewIdsForCol = (() => {
    const entry = stagedHides.get(`${c.tableId}:${c.columnKey}`);
    if (!entry) return new Set<string>();
    return new Set(entry.views.map((v) => v.viewId));
  })();

  // Whether the chevron should be available — either chain or drill content.
  const expandable =
    !isSelected &&
    !isDeletedNow &&
    !isFrozenNow &&
    hasCandidateExpansionContent(c, liveValue, false);

  // True iff this column has uncommitted visibility edits in any view.
  // Compares viewEdits against `(base ∪ staged)` — once Stage commits a hide
  // into stagedHides, the column is no longer dirty against the committed
  // state and the "(unsaved)" mention disappears.
  const isColumnDirty = (() => {
    if (isSelected || isDeletedNow) return false;
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    if (!t) return false;
    for (const v of t.views || []) {
      const edits = viewEdits.get(v._id);
      if (!edits) continue;
      const baseHas = (v.hidden_columns || []).includes(c.columnKey);
      const stagedHas = stagedViewIdsForCol.has(v._id);
      const committed = baseHas || stagedHas;
      const editsHas = edits.has(c.columnKey);
      if (editsHas !== committed) return true;
    }
    return false;
  })();

  // Multi-value LFs are no longer hard-blocked: the freeze mechanism handles
  // multi-array via long-text snapshot, and the apply-time modal warns about
  // the resulting shape change for downstream consumers.
  const canReplace = !!c.replacementType;
  const disabledTooltip = !c.replacementType
    ? intl.get('performance.replace_disabled_type').d('Cannot freeze this column type')
    : undefined;

  const replaceLabel =
    action === 'replace-static'
      ? intl.get('performance.unselect_replace').d('Unstage freeze column')
      : intl.get('performance.select_replace').d('Stage freeze column');
  const stageDeleteLabel =
    action === 'delete'
      ? intl.get('performance.unstage_delete_column').d('Unstage delete column')
      : intl.get('performance.stage_delete_column').d('Stage delete column');

  // Frozen-now takes precedence over staged-action labels — the freeze has
  // already happened, so any prior staging is irrelevant.
  const actionLabel = isFrozenNow
    ? intl.get('performance.candidate_frozen').d('frozen')
    : action === 'delete'
      ? intl.get('performance.marked_delete').d('marked for deletion')
      : action === 'replace-static'
        ? intl.get('performance.marked_replace').d('marked for freeze')
        : '';

  // Share of total formula compute. Drives the dedicated "Compute cost" column
  // (PercentBar with the standard ≥25 red / ≥10 amber / else grey thresholds);
  // shown as italic muted "not relevant" below MIN_RELEVANT_PCT, mirroring the
  // per-table tab in TableTab.tsx for visual consistency.
  const costPct =
    c.measuredCostMs !== undefined && totalCostMs > 0
      ? (c.measuredCostMs / totalCostMs) * 100
      : undefined;

  // Build the rendered label list. structural/volume tags (when present) get prepended
  // as labels with their own tooltips. When "volume" applies, suppress the heuristic
  // "formula on large table (...)" string the runner emits during candidate detection
  // — empirical volume is strictly more informative; showing both is just noise.
  const structuralLabel =
    costPerRowTag === 'structural'
      ? {
          text: intl.get('performance.label_structural').d('structural cost (high cost per row)'),
          tooltip: intl
            .get('performance.tag_structural_tooltip')
            .d(
              'High cost per row — the formula itself is expensive. Will get worse as the table grows. Action: rewrite the formula.'
            ),
        }
      : null;
  const volumeLabel =
    costPerRowTag === 'volume'
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
  // Near-duplicate link-formula peers: same compute signature, just different display.
  // Surfaced as a label so the user can stage N-1 for delete via the regular menu.
  const nearDupLabel =
    c.nearDuplicateGroup && c.nearDuplicateGroup.length > 0
      ? {
          text: intl
            .get('performance.label_near_duplicate', {
              count: c.nearDuplicateGroup.length,
              names: c.nearDuplicateGroup.map((p) => p.columnName).join(', '),
            })
            .d(
              `near-duplicate of ${c.nearDuplicateGroup.length} other column(s): ${c.nearDuplicateGroup.map((p) => p.columnName).join(', ')}`
            ),
          tooltip: intl
            .get('performance.label_near_duplicate_tooltip')
            .d(
              'These columns share the same compute (same link, source field, and aggregation) — only their display config differs. Each one re-does the same work. Keep one and delete the rest to recover the duplicate compute.'
            ),
        }
      : null;
  const baseLabels =
    costPerRowTag === 'volume'
      ? c.labels.filter((l) => !l.startsWith('formula on large table'))
      : c.labels;
  const displayLabels: Array<{ text: string; tooltip?: string }> = [
    ...(structuralLabel ? [structuralLabel] : []),
    ...(volumeLabel ? [volumeLabel] : []),
    ...(nearDupLabel ? [nearDupLabel] : []),
    ...baseLabels.map((text) => ({ text })),
  ];

  return (
    <tr
      className="audit-row"
      onClick={expandable ? () => setExpandedChain((v) => !v) : undefined}
      style={{
        borderBottom: '1px solid #eee',
        backgroundColor: rowIdx % 2 === 0 ? '#fff' : '#f9f9f9',
        cursor: expandable ? 'pointer' : undefined,
        userSelect: expandable ? 'none' : undefined,
      }}>
      <td style={{ padding: '6px 12px', wordBreak: 'break-word', verticalAlign: 'top' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {expandable ? (
            <i
              className={`dtable-font ${expandedChain ? 'dtable-icon-down' : 'dtable-icon-right'}`}
              style={{ fontSize: 10, color: '#888', flexShrink: 0 }}
            />
          ) : (
            <span style={{ width: 10, flexShrink: 0 }} />
          )}
          {showTableName && (
            <>
              <span style={{ fontWeight: 700 }}>{c.tableName}</span>
              <span style={{ color: '#999' }}>&rsaquo;</span>
            </>
          )}
          <i className={`dtable-font ${icon}`} style={{ fontSize: 14, color: '#aaa' }} />
          <span
            style={{
              textDecoration:
                action === 'delete' || isDeletedNow || isFrozenNow ? 'line-through' : 'none',
              fontStyle: action === 'replace-static' ? 'italic' : undefined,
              color: isSelected || isDeletedNow || isFrozenNow ? '#777' : undefined,
            }}>
            {c.columnName}
          </span>
          <span style={{ color: '#888', fontSize: 12 }}>{c.formulaType || c.columnType}</span>
          {actionLabel && (
            <span
              style={{
                fontSize: 11,
                color: isFrozenNow ? '#777' : action === 'delete' ? '#dc3545' : '#e6a117',
                fontStyle: 'italic',
              }}>
              · {actionLabel}
            </span>
          )}
          {isColumnDirty && (
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
        </div>

        {expandedChain && (
          <CandidateExpansion
            candidate={c}
            liveValue={liveValue}
            viewEdits={viewEdits}
            onSetViewEdit={onSetViewEdit}
            stagedHides={stagedHides}
            showHideDrill={false}
          />
        )}

        {!isSelected &&
          (displayLabels.length > 0 || (c.affectedRules && c.affectedRules.length > 0)) && (
            <div style={{ marginTop: 4, marginLeft: 20 }}>
              {displayLabels.map((label, i) => (
                <div
                  key={i}
                  title={label.tooltip}
                  style={{
                    fontSize: 12,
                    color: '#000',
                    lineHeight: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                  <span style={{ color: '#e6a117', fontSize: 10 }}>&#9679;</span>
                  {label.text}
                </div>
              ))}
              {c.affectedRules && c.affectedRules.length > 0 && (
                <>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedRules((v) => !v);
                    }}
                    style={{
                      fontSize: 12,
                      color: '#000',
                      lineHeight: '20px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}>
                    <i
                      className={`dtable-font ${expandedRules ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                      style={{ fontSize: 10, color: '#888', flexShrink: 0 }}
                    />
                    <span style={{ color: '#e6a117', fontSize: 10 }}>&#9679;</span>
                    {intl
                      .get('performance.used_by_rules', { count: c.affectedRules.length })
                      .d(`used by ${c.affectedRules.length} rule(s)`)}
                  </div>
                  {expandedRules && (
                    <div style={{ paddingLeft: 22 }}>
                      {groupAffectedRules(c.affectedRules).map((grp, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#6b7d72', lineHeight: '18px' }}>
                          {grp.label}
                          <span style={{ color: '#999', marginLeft: 6 }}>
                            — {grp.kinds.join(', ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
      </td>
      <td style={{ padding: '6px 12px', textAlign: 'center', verticalAlign: 'top' }}>
        <span
          title={intl
            .get('performance.cost_tooltip')
            .d(
              'How much this column weighs on the base. Higher impact = more time spent computing this column when something is loaded.'
            )}>
          <ImpactBadge pct={costPct} surface="column" />
        </span>
      </td>
      <td
        style={{ padding: '6px 4px', textAlign: 'center', verticalAlign: 'top' }}
        onClick={(e) => e.stopPropagation()}>
        {!isDeletedNow &&
          !isFrozenNow &&
          (() => {
            const extras = buildCandidateMenuExtras({
              candidate: c,
              remediations,
              isColumnDirty,
              onToggleAction,
              onApplyColumnVisibility,
              onFreezeNow,
            });
            return (
              <ContextMenu
                onDelete={() => onDeleteNow(c.tableName, c.tableId, c.columnName, c.columnKey)}
                confirmDelete={true}
                label={intl.get('performance.delete_column_now').d('Delete column now')}
                deleteDisabled={c.isPrimaryColumn}
                deleteDisabledTooltip={intl
                  .get('performance.delete_disabled_primary')
                  .d("Cannot delete — this is the table's first column")}
                extraActions={extras}
              />
            );
          })()}
      </td>
    </tr>
  );
};

const CandidateTableGroup: React.FC<{
  tableName: string;
  candidates: PerformanceAuditResult['candidates'];
  remediations: Map<string, RemediationAction>;
  onToggleAction: (key: string, action: RemediationAction) => void;
  onDeleteNow: (tableName: string, tableId: string, columnName: string, columnKey: string) => void;
  deletedCandidateKeys: Set<string>;
  frozenNowKeys: Set<string>;
  totalCostMs: number;
  costPerRowTags: Map<string, 'structural' | 'volume'>;
  liveValue: any;
  costByKey: Map<string, number>;
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  stagedHides: Map<string, RemediatedColumnHide>;
  onStageColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onApplyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onFreezeNow: (tableId: string, tableName: string, columnKey: string, columnName: string) => void;
}> = ({
  tableName,
  candidates,
  remediations,
  onToggleAction,
  onDeleteNow,
  deletedCandidateKeys,
  frozenNowKeys,
  totalCostMs,
  costPerRowTags,
  liveValue,
  costByKey,
  viewEdits,
  onSetViewEdit,
  stagedHides,
  onStageColumnVisibility,
  onApplyColumnVisibility,
  onFreezeNow,
}) => {
  const [open, setOpen] = useState(true);

  const allKeys = candidates.map((c) => `${c.tableId}:${c.columnKey}`);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => remediations.has(k));

  const handleSelectAllForDeletion = () => {
    for (const c of candidates) {
      if (c.isPrimaryColumn) continue;
      const key = `${c.tableId}:${c.columnKey}`;
      if (!remediations.has(key)) onToggleAction(key, 'delete');
    }
  };

  const handleUnselectAll = () => {
    for (const key of allKeys) {
      const current = remediations.get(key);
      if (current) onToggleAction(key, current);
    }
  };

  return (
    <tbody>
      <tr
        onClick={() => setOpen(!open)}
        className="asset-audit-group"
        style={{ cursor: 'pointer', userSelect: 'none' }}>
        <td colSpan={2} style={{ padding: '6px 12px' }}>
          <i
            className={`dtable-font ${open ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 10, color: '#666', marginRight: 6 }}
          />
          <span style={{ fontWeight: 700 }}>{tableName}</span>
          <span style={{ color: '#888', fontSize: 12, marginLeft: 6 }}>
            ({candidates.length} column{candidates.length !== 1 ? 's' : ''})
          </span>
        </td>
        <td
          style={{ padding: '6px 4px', textAlign: 'center' }}
          onClick={(e) => e.stopPropagation()}>
          <ContextMenu
            onDelete={allSelected ? handleUnselectAll : handleSelectAllForDeletion}
            confirmDelete={false}
            label={
              allSelected
                ? intl.get('performance.unselect_table').d('Unselect all columns in this table')
                : intl.get('performance.select_table').d('Select all columns for deletion')
            }
          />
        </td>
      </tr>
      {open &&
        candidates.map((c, i) => (
          <CandidateRow
            key={`${c.tableId}:${c.columnKey}`}
            c={c}
            remediations={remediations}
            onToggleAction={onToggleAction}
            onDeleteNow={onDeleteNow}
            deletedCandidateKeys={deletedCandidateKeys}
            frozenNowKeys={frozenNowKeys}
            totalCostMs={totalCostMs}
            costPerRowTag={costPerRowTags.get(`${c.tableId}:${c.columnKey}`)}
            rowIdx={i}
            liveValue={liveValue}
            costByKey={costByKey}
            viewEdits={viewEdits}
            onSetViewEdit={onSetViewEdit}
            stagedHides={stagedHides}
            onStageColumnVisibility={onStageColumnVisibility}
            onApplyColumnVisibility={onApplyColumnVisibility}
            onFreezeNow={onFreezeNow}
          />
        ))}
    </tbody>
  );
};

// Group candidates by impact band (high → medium → low). Mirrors
// CandidateTableGroup's shape (collapsible header + bulk-select-all-for-delete)
// but the grouping axis is the cost band, not the table — surfaced when the
// user picks "Grouped by impact" in the candidates toggle. Lets a user stage
// every High-impact column for deletion in one click.
const CandidateBandGroup: React.FC<{
  band: 'high' | 'medium' | 'low';
  candidates: PerformanceAuditResult['candidates'];
  remediations: Map<string, RemediationAction>;
  onToggleAction: (key: string, action: RemediationAction) => void;
  onDeleteNow: (tableName: string, tableId: string, columnName: string, columnKey: string) => void;
  deletedCandidateKeys: Set<string>;
  frozenNowKeys: Set<string>;
  totalCostMs: number;
  costPerRowTags: Map<string, 'structural' | 'volume'>;
  liveValue: any;
  costByKey: Map<string, number>;
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  stagedHides: Map<string, RemediatedColumnHide>;
  onStageColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onApplyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onFreezeNow: (tableId: string, tableName: string, columnKey: string, columnName: string) => void;
}> = ({
  band,
  candidates,
  remediations,
  onToggleAction,
  onDeleteNow,
  deletedCandidateKeys,
  frozenNowKeys,
  totalCostMs,
  costPerRowTags,
  liveValue,
  costByKey,
  viewEdits,
  onSetViewEdit,
  stagedHides,
  onStageColumnVisibility,
  onApplyColumnVisibility,
  onFreezeNow,
}) => {
  const [open, setOpen] = useState(true);

  const allKeys = candidates.map((c) => `${c.tableId}:${c.columnKey}`);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => remediations.has(k));

  const handleSelectAllForDeletion = () => {
    for (const c of candidates) {
      if (c.isPrimaryColumn) continue;
      const key = `${c.tableId}:${c.columnKey}`;
      if (!remediations.has(key)) onToggleAction(key, 'delete');
    }
  };

  const handleUnselectAll = () => {
    for (const key of allKeys) {
      const current = remediations.get(key);
      if (current) onToggleAction(key, current);
    }
  };

  return (
    <tbody>
      <tr
        onClick={() => setOpen(!open)}
        className="asset-audit-group"
        style={{ cursor: 'pointer', userSelect: 'none' }}>
        <td colSpan={2} style={{ padding: '6px 12px' }}>
          <i
            className={`dtable-font ${open ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 10, color: '#666', marginRight: 6 }}
          />
          <ImpactBadge band={band} surface="column" />
          <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
            ({candidates.length} column{candidates.length !== 1 ? 's' : ''})
          </span>
        </td>
        <td
          style={{ padding: '6px 4px', textAlign: 'center' }}
          onClick={(e) => e.stopPropagation()}>
          <ContextMenu
            onDelete={allSelected ? handleUnselectAll : handleSelectAllForDeletion}
            confirmDelete={false}
            label={
              allSelected
                ? intl.get('performance.unselect_band').d('Unselect all columns in this band')
                : intl
                    .get('performance.select_band')
                    .d('Stage all columns in this band for deletion')
            }
          />
        </td>
      </tr>
      {open &&
        candidates.map((c, i) => (
          <CandidateRow
            key={`${c.tableId}:${c.columnKey}`}
            c={c}
            remediations={remediations}
            onToggleAction={onToggleAction}
            onDeleteNow={onDeleteNow}
            deletedCandidateKeys={deletedCandidateKeys}
            frozenNowKeys={frozenNowKeys}
            totalCostMs={totalCostMs}
            costPerRowTag={costPerRowTags.get(`${c.tableId}:${c.columnKey}`)}
            showTableName
            rowIdx={i}
            liveValue={liveValue}
            costByKey={costByKey}
            viewEdits={viewEdits}
            onSetViewEdit={onSetViewEdit}
            stagedHides={stagedHides}
            onStageColumnVisibility={onStageColumnVisibility}
            onApplyColumnVisibility={onApplyColumnVisibility}
            onFreezeNow={onFreezeNow}
          />
        ))}
    </tbody>
  );
};

/**
 * Headline delta for a test: change in total theoretical compute cost across views.
 *
 *   delta % = Σ(after - before) / Σ(before) × 100
 *
 * Iterates `before.viewLoads` so views that were deleted (and therefore absent
 * from `after.viewLoads`) still contribute to the denominator — their `after.ms`
 * is treated as 0, which is the correct accounting for "this view no longer
 * incurs any compute". Iterating `after` instead would silently exclude deleted
 * views from `weightedBefore` and undercount the real improvement.
 *
 * `ms` on each view is theoretical compute cost (Σ per-cell × visibleRows),
 * already total-cost-for-the-view — it inherently weights big views more, so we
 * sum directly without an extra rowCount multiplier.
 */
const DeltaDisplay: React.FC<{ before: BenchmarkTimings; after: BenchmarkTimings }> = ({
  before,
  after,
}) => {
  // Composite key `${tableId}:${viewId}` because SeaTable view _ids are only
  // unique WITHIN a table — every table's "Default View" shares _id "0000".
  // Keying by viewId alone collapses cross-table default views into a single
  // Map entry, causing every lookup to return the wrong match.
  const afterByView = new Map((after.viewLoads || []).map((v) => [`${v.tableId}:${v.viewId}`, v]));
  let weightedBefore = 0;
  let weightedDiff = 0;
  // Weighted-sum-of-savings, with each view's saving weighted by its own ms
  // share. Divided by weightedBefore below to give the expected ms saved per
  // typical view-open (probability ≈ view weight in the cost model).
  let weightedSavedSum = 0;
  for (const b of before.viewLoads || []) {
    weightedBefore += b.ms;
    const a = afterByView.get(`${b.tableId}:${b.viewId}`);
    const aMs = a ? a.ms : 0;
    weightedDiff += aMs - b.ms;
    weightedSavedSum += b.ms * (b.ms - aMs);
  }
  const pct = weightedBefore > 0 ? (weightedDiff / weightedBefore) * 100 : 0;
  // Weighted-average absolute ms saved per typical view-open. Heavy views
  // dominate (they're opened more / felt more strongly) so a localized win on
  // a heavy view DOES raise the headline, but a localized win on a light view
  // (drowned out by unchanged heavy views) doesn't — matches user intuition
  // for "broad improvement" vs "best-case improvement".
  //
  // Why not max-per-view: 1 view saving 500ms on a base of 10 otherwise-
  // unchanged views shouldn't headline "Significant" — 90% of view-opens feel
  // identical. Why not sum: 10 views each saving 100ms shouldn't headline
  // "Major" — none individually feel any different.
  const absSavedMs = weightedBefore > 0 ? Math.max(0, weightedSavedSum / weightedBefore) : 0;
  return <DeltaBadge pct={pct} absSavedMs={absSavedMs} />;
};

/**
 * Headline delta + collapsible per-view breakdown + caveat. Wrapping the three
 * pieces keeps the test row tidy and lets the breakdown live behind a toggle.
 */
const TestResultDisplay: React.FC<{
  before: BenchmarkTimings;
  after: BenchmarkTimings;
}> = ({ before, after }) => {
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Pre-compute whether the breakdown will have anything to show. Mirrors the
  // weightPct >= MIN_RELEVANT_PCT filter inside PerViewDeltaTable; if zero rows
  // pass it, the button is dead weight.
  const hasRelevantBreakdownRows = (() => {
    // Composite key — view _ids aren't globally unique. See DeltaDisplay.
    const beforeByView = new Map(
      (before.viewLoads || []).map((v) => [`${v.tableId}:${v.viewId}`, v])
    );
    const totalBeforeWeighted = (before.viewLoads || []).reduce((s, v) => s + v.ms, 0);
    if (totalBeforeWeighted <= 0) return false;
    for (const a of after.viewLoads || []) {
      const b = beforeByView.get(`${a.tableId}:${a.viewId}`);
      if (!b) continue;
      const weightPct = (b.ms / totalBeforeWeighted) * 100;
      if (weightPct >= MIN_RELEVANT_PCT) return true;
    }
    return false;
  })();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontSize: 13 }}>
        <div>
          <div
            style={{ fontWeight: 500, marginBottom: 4 }}
            title={intl
              .get('performance.test_comparison_tooltip')
              .d(
                'Estimated improvement of the modified base compared to the original. Computed across all views, weighted so heavier views count more.'
              )}>
            {intl.get('performance.test_comparison').d('Comparison with original base')}
          </div>
          <DeltaDisplay before={before} after={after} />
        </div>
        {hasRelevantBreakdownRows && (
          <button
            onClick={() => setShowBreakdown((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: '#ff8000',
              cursor: 'pointer',
              fontSize: 12,
              padding: 0,
              textDecoration: 'underline',
            }}>
            {showBreakdown
              ? intl.get('performance.hide_per_view').d('Hide per-view breakdown')
              : intl.get('performance.show_per_view').d('Show per-view breakdown')}
          </button>
        )}
      </div>
      {showBreakdown && hasRelevantBreakdownRows && (
        <div style={{ marginTop: 8 }}>
          <PerViewDeltaTable before={before} after={after} />
        </div>
      )}
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: '#888',
          fontStyle: 'italic',
          lineHeight: '15px',
        }}>
        {intl
          .get('performance.benchmark_caveat')
          .d(
            "Theoretical compute cost compared before/after, summed across views. Filter/sort/group cost, DOM rendering and network sync aren't included — actual editor responsiveness may differ."
          )}
      </div>
    </>
  );
};

/**
 * Per-view breakdown table for a test — shown collapsed by default. Highlights
 * which views actually changed (so the user can sanity-check that the headline
 * delta reflects views they care about).
 */
const PerViewDeltaTable: React.FC<{
  before: BenchmarkTimings;
  after: BenchmarkTimings;
}> = ({ before, after }) => {
  // Composite key — see DeltaDisplay for the why (view _ids aren't globally unique).
  const beforeByView = new Map(
    (before.viewLoads || []).map((v) => [`${v.tableId}:${v.viewId}`, v])
  );
  // `ms` is already total theoretical cost for the view (Σ per-cell × visibleRows),
  // so it doubles as both the "weight" and the comparison value — no rowCount multiplier.
  const totalBeforeWeighted = (before.viewLoads || []).reduce((s, v) => s + v.ms, 0);
  const allRows = (after.viewLoads || [])
    .map((a) => {
      const b = beforeByView.get(`${a.tableId}:${a.viewId}`);
      if (!b) return null;
      const deltaPct = b.ms > 0 ? ((a.ms - b.ms) / b.ms) * 100 : 0;
      const weightPct = totalBeforeWeighted > 0 ? (b.ms / totalBeforeWeighted) * 100 : 0;
      // Positive when improved (after < before); used by DeltaBadge's absolute floor.
      const absSavedMs = Math.max(0, b.ms - a.ms);
      return {
        tableName: a.tableName,
        viewName: a.viewName,
        rowCount: a.rowCount,
        deltaPct,
        absSavedMs,
        weightPct,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  // Drop low-weight views: their delta percentages are often huge nonsense (a view
  // with 1 ms baseline showing +800% from a 9 ms after measurement) but their actual
  // contribution to perceived load is negligible. Same MIN_RELEVANT_PCT threshold
  // used elsewhere for "not relevant" labelling.
  const rows = allRows
    .filter((r) => r.weightPct >= MIN_RELEVANT_PCT)
    .sort((a, b) => b.weightPct - a.weightPct);
  const hiddenCount = allRows.length - rows.length;

  if (allRows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#888' }}>
        {intl.get('performance.no_views').d('No views in this base.')}
      </div>
    );
  }

  return (
    <>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #ddd', color: '#666', textAlign: 'left' }}>
            <th style={{ padding: '4px 8px', fontWeight: 500 }}>
              {intl.get('performance.view_col').d('View')}
            </th>
            <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>
              {intl.get('performance.rows').d('Rows')}
            </th>
            <th
              style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'left' }}
              title={intl
                .get('performance.view_loading_tooltip')
                .d(
                  'How long this view takes to load relative to the rest. Slow-loading views feel sluggish when a user opens them.'
                )}>
              {intl.get('performance.loading_header').d('Loading')}
            </th>
            <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'left' }}>
              {intl.get('performance.test_comparison_short').d('Comparison')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.tableName}/${r.viewName}/${i}`}
              style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '4px 8px' }}>
                <span style={{ fontWeight: 700 }}>{r.tableName}</span>{' '}
                <span style={{ color: '#999' }}>&rsaquo;</span> {r.viewName}
              </td>
              <td style={{ padding: '4px 8px', textAlign: 'right', color: '#666' }}>
                {r.rowCount}
              </td>
              <td style={{ padding: '4px 8px', textAlign: 'left' }}>
                <ImpactBadge pct={r.weightPct} surface="view" />
              </td>
              <td style={{ padding: '4px 8px', textAlign: 'left' }}>
                <DeltaBadge pct={r.deltaPct} absSavedMs={r.absSavedMs} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenCount > 0 && (
        <div
          style={{
            fontSize: 12,
            color: '#888',
            fontStyle: 'italic',
            padding: '6px 8px',
          }}>
          {intl
            .get('performance.minor_views_hidden', {
              count: hiddenCount,
              threshold: MIN_RELEVANT_PCT,
            })
            .d(
              `+${hiddenCount} view(s) hidden (each <${MIN_RELEVANT_PCT}% of total weight) — their deltas can swing wildly on tiny baselines and rarely affect perceived load.`
            )}
        </div>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Remediated-columns list (grouped by table) — shared by TestBlock + modal
// ---------------------------------------------------------------------------

// Humanize an AffectedRule kind into a short label used inline
const RULE_KIND_LABEL: Record<string, string> = {
  'view-filter': 'filter',
  'view-sort': 'sort',
  'view-groupby': 'group-by',
  'view-hidden': 'hidden',
  'view-colorby': 'color-by',
  'view-column-color': 'column color',
  'view-summary': 'summary',
  'link-formula-condition': 'condition',
  'link-row-filter-static': 'row filter',
  'link-row-filter-dynamic': 'row filter (dynamic)',
};

// Group affected rules for readable display. View-* kinds collapse per view; link-*
// kinds collapse per owner column.
function groupAffectedRules(rules: AffectedRule[]): { label: string; kinds: string[] }[] {
  const bucket: Record<string, { label: string; kinds: string[]; order: number }> = {};
  let order = 0;
  for (const r of rules) {
    let key: string;
    let label: string;
    if (r.kind.startsWith('view-')) {
      key = `v:${r.tableId}:${r.viewId || r.viewName || ''}`;
      label = intl
        .get('performance.rule_owner_view', { view: r.viewName || '?', table: r.tableName })
        .d(`View "${r.viewName || '?'}" in ${r.tableName}`);
    } else {
      key = `c:${r.tableId}:${r.ownerColumnKey || ''}`;
      label = intl
        .get('performance.rule_owner_column', {
          column: r.ownerColumnName || '?',
          table: r.tableName,
        })
        .d(`Column "${r.ownerColumnName || '?'}" in ${r.tableName}`);
    }
    if (!bucket[key]) {
      bucket[key] = { label, kinds: [], order: order++ };
    }
    const kindText =
      r.kind === 'link-row-filter-dynamic' && r.dynamicRole
        ? `${RULE_KIND_LABEL[r.kind]} (${r.dynamicRole})`
        : RULE_KIND_LABEL[r.kind] || r.kind;
    if (!bucket[key].kinds.includes(kindText)) bucket[key].kinds.push(kindText);
  }
  return Object.values(bucket).sort((a, b) => a.order - b.order);
}

const RemediatedColumnsList: React.FC<{
  cols: RemediatedColumn[];
  views?: RemediatedView[];
  hides?: RemediatedColumnHide[];
  verbose?: boolean;
  onRemove?: (tableName: string, columnKey: string) => void;
  onRemoveView?: (tableId: string, viewId: string) => void;
  onRemoveHide?: (tableId: string, columnKey: string, viewId: string) => void;
}> = ({ cols, views, hides, verbose, onRemove, onRemoveView, onRemoveHide }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Combine columns, deleted views, and hide-in-view stages into per-table
  // groups so a single test renders as one section per table.
  const grouped: {
    tableName: string;
    cols: RemediatedColumn[];
    views: RemediatedView[];
    hides: RemediatedColumnHide[];
  }[] = [];
  const idxByTable: Record<string, number> = {};
  const ensure = (tableName: string) => {
    if (idxByTable[tableName] === undefined) {
      idxByTable[tableName] = grouped.length;
      grouped.push({ tableName, cols: [], views: [], hides: [] });
    }
    return grouped[idxByTable[tableName]];
  };
  for (const c of cols) ensure(c.tableName).cols.push(c);
  for (const v of views || []) ensure(v.tableName).views.push(v);
  for (const h of hides || []) ensure(h.tableName).hides.push(h);
  return (
    <div>
      {grouped.map((grp) => (
        <div key={grp.tableName} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 2 }}>
            {grp.tableName}
            <span style={{ fontWeight: 400, color: '#999', marginLeft: 6 }}>
              ({grp.cols.length + grp.views.length + grp.hides.length})
            </span>
          </div>
          {grp.cols.map((c) => {
            const icon = COLUMN_TYPE_ICONS[c.columnType] || 'dtable-icon-formula';
            const isReplace = c.action === 'replace-static';
            const ruleCount = c.affectedRules?.length || 0;
            const rowKey = `${c.tableName}:${c.columnKey}`;
            const isExpanded = verbose || expanded.has(rowKey);
            const isExpandable = ruleCount > 0 && !verbose;
            return (
              <div
                key={c.columnKey}
                className={verbose ? undefined : 'asset-audit-row'}
                style={{ paddingLeft: 14, borderRadius: 4 }}>
                <div
                  onClick={isExpandable ? () => toggle(rowKey) : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    lineHeight: '20px',
                    cursor: isExpandable ? 'pointer' : 'default',
                    userSelect: isExpandable ? 'none' : undefined,
                  }}>
                  {isExpandable ? (
                    <i
                      className={`dtable-font ${isExpanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                      style={{ fontSize: 10, color: '#888', width: 10, flexShrink: 0 }}
                    />
                  ) : (
                    <span style={{ width: 10, flexShrink: 0 }} />
                  )}
                  <i className={`dtable-font ${icon}`} style={{ fontSize: 13, color: '#aaa' }} />
                  <span
                    style={{
                      textDecoration: isReplace ? 'none' : 'line-through',
                      fontStyle: isReplace ? 'italic' : undefined,
                      color: '#555',
                    }}>
                    {c.columnName}
                  </span>
                  <span style={{ color: '#888' }}>{c.columnType}</span>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 11,
                      fontStyle: 'italic',
                      color: isReplace ? '#e6a117' : '#dc3545',
                    }}>
                    {isReplace
                      ? intl
                          .get('performance.action_replaced', {
                            type: c.replacementType?.type || '',
                          })
                          .d(`replaced → ${c.replacementType?.type || ''}`)
                      : intl.get('performance.action_deleted').d('deleted')}
                  </span>
                  {ruleCount > 0 && !verbose && (
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 11,
                        color: '#856404',
                        backgroundColor: '#fff8e1',
                        border: '1px solid #ffc107',
                        borderRadius: 10,
                        padding: '0 6px',
                      }}
                      title={intl
                        .get('performance.affected_rules_tooltip')
                        .d('Rules across the base that reference this column')}>
                      {intl
                        .get('performance.used_by_rules', { count: ruleCount })
                        .d(`used by ${ruleCount} rule(s)`)}
                    </span>
                  )}
                  {onRemove && !verbose && (
                    <span
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                      onClick={(e) => e.stopPropagation()}>
                      <ContextMenu
                        onDelete={() => onRemove(c.tableName, c.columnKey)}
                        label={intl.get('performance.remove_from_test').d('Remove from test')}
                      />
                    </span>
                  )}
                </div>
                {isExpanded && ruleCount > 0 && c.affectedRules && (
                  <div style={{ paddingLeft: 32, marginTop: 2, marginBottom: 4 }}>
                    {groupAffectedRules(c.affectedRules).map((grp, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#856404', lineHeight: '18px' }}>
                        <span style={{ color: '#ffc107', marginRight: 6 }}>&#9679;</span>
                        {grp.label}
                        <span style={{ color: '#b0894a', marginLeft: 6 }}>
                          — {grp.kinds.join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {grp.views.map((v) => (
            <div
              key={`view:${v.viewId}`}
              className={verbose ? undefined : 'asset-audit-row'}
              style={{ paddingLeft: 14, borderRadius: 4 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  lineHeight: '20px',
                }}>
                <span style={{ width: 10, flexShrink: 0 }} />
                <i
                  className="dtable-font dtable-icon-list-view"
                  style={{ fontSize: 13, color: '#aaa' }}
                />
                <span
                  style={{
                    textDecoration: 'line-through',
                    color: '#555',
                  }}>
                  {v.viewName}
                </span>
                {v.privateFor && (
                  <i
                    className="dtable-font dtable-icon-private-database"
                    style={{ fontSize: 12, color: '#888' }}
                    title={intl
                      .get('performance.private_view_tooltip', { owner: v.privateFor })
                      .d(`Private view (owner: ${v.privateFor})`)}
                  />
                )}
                <span
                  style={{
                    marginLeft: 4,
                    fontSize: 11,
                    fontStyle: 'italic',
                    color: '#dc3545',
                  }}>
                  {intl.get('performance.action_deleted').d('deleted')}
                </span>
                {onRemoveView && !verbose && (
                  <span
                    style={{ marginLeft: 'auto', flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}>
                    <ContextMenu
                      onDelete={() => onRemoveView(v.tableId, v.viewId)}
                      label={intl.get('performance.remove_from_test').d('Remove from test')}
                    />
                  </span>
                )}
              </div>
            </div>
          ))}
          {grp.hides.map((h) =>
            h.views.map((v) => (
              <div
                key={`hide:${h.columnKey}:${v.viewId}`}
                className={verbose ? undefined : 'asset-audit-row'}
                style={{ paddingLeft: 14, borderRadius: 4 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    lineHeight: '20px',
                  }}>
                  <span style={{ width: 10, flexShrink: 0 }} />
                  <i
                    className="dtable-font dtable-icon-eye-slash"
                    style={{ fontSize: 13, color: '#aaa' }}
                  />
                  <span style={{ color: '#555' }}>{h.columnName}</span>
                  <span style={{ color: '#888' }}>›</span>
                  <span style={{ color: '#555' }}>{v.viewName}</span>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 11,
                      fontStyle: 'italic',
                      color: '#0066cc',
                    }}>
                    {intl.get('performance.action_hidden_pair').d('hidden in view')}
                  </span>
                  {onRemoveHide && !verbose && (
                    <span
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                      onClick={(e) => e.stopPropagation()}>
                      <ContextMenu
                        onDelete={() => onRemoveHide(h.tableId, h.columnKey, v.viewId)}
                        label={intl.get('performance.remove_from_test').d('Remove from test')}
                      />
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sandbox link row — renders under a test's Before/After row when a sandbox
// has been created for that test. Click the name to open the sandbox in SeaTable.
// ---------------------------------------------------------------------------

const SandboxLinkRow: React.FC<{ sandbox: PerformanceTestSandbox }> = ({ sandbox }) => {
  const config = (window as any).dtable || {};
  const serverUrl: string = config.server || '';
  const url = serverUrl
    ? `${serverUrl.replace(/\/$/, '')}/workspace/${sandbox.workspaceId}/dtable/${encodeURIComponent(sandbox.name)}/`
    : '';
  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 10px',
        border: '1px solid #c3e6cb',
        borderRadius: 4,
        backgroundColor: '#f1f8f4',
        fontSize: 12,
        color: '#155724',
      }}>
      {intl
        .get('performance.sandbox_ready_label', { count: sandbox.appliedCount })
        .d(`Sandbox ready with ${sandbox.appliedCount} change(s) applied:`)}{' '}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#0a6b3a', fontWeight: 500 }}>
          {sandbox.name}
        </a>
      ) : (
        <span style={{ fontWeight: 500 }}>{sandbox.name}</span>
      )}
      <span style={{ marginLeft: 8, color: '#6b7d72' }}>· {sandbox.createdAt}</span>
      {sandbox.failedCount ? (
        <div style={{ marginTop: 4, color: '#b15050', fontSize: 11 }}>
          {intl
            .get('performance.sandbox_failed_label', { count: sandbox.failedCount })
            .d(`${sandbox.failedCount} change(s) failed — see browser console for details.`)}
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Test block — one per PerformanceTest, with three-dots menu (Run/Apply/Delete)
// ---------------------------------------------------------------------------

const TestBlock: React.FC<{
  test: PerformanceTest;
  index: number;
  isBusy: boolean;
  isApplyingThis: boolean;
  progressMsg: string;
  onRun: () => void;
  onDelete: () => void;
  // When true, the ContextMenu's "Delete test" entry uses its built-in two-step
  // "Confirm?" affordance instead of firing onDelete directly. Caller passes
  // true when there's no sandbox to also-delete — opening a modal with nothing
  // to choose just adds friction. When false, onDelete should open a modal.
  confirmDeleteInDropdown: boolean;
  onApply: () => void;
  onCopyToSandbox?: () => void;
  onRemoveRemediation: (tableName: string, columnKey: string) => void;
  onRemoveRemediationView: (tableId: string, viewId: string) => void;
  onRemoveRemediationHide: (tableId: string, columnKey: string, viewId: string) => void;
}> = ({
  test,
  index,
  isBusy,
  isApplyingThis,
  progressMsg,
  onRun,
  onDelete,
  confirmDeleteInDropdown,
  onApply,
  onCopyToSandbox,
  onRemoveRemediation,
  onRemoveRemediationView,
  onRemoveRemediationHide,
}) => {
  const hasResult = !!(test.beforeBenchmark && test.afterBenchmark);
  const runLabel = hasResult
    ? intl.get('performance.rerun_test').d('Rerun test')
    : intl.get('performance.run_test_action').d('Run test');

  return (
    <div
      style={{
        border: '1px solid #dee2e6',
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
        backgroundColor: '#fff',
      }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 8,
        }}>
        {intl.get('performance.test_run').d('Test')} #{index + 1}
        <span style={{ fontWeight: 400, color: '#888', marginLeft: 8 }}>
          {(() => {
            const colCount = test.remediations.length;
            const viewCount = test.remediationViews?.length || 0;
            const hideCount = (test.remediationHides || []).reduce((s, h) => s + h.views.length, 0);
            const parts: string[] = [];
            if (colCount > 0) {
              parts.push(
                intl.get('performance.cols_part', { count: colCount }).d(`${colCount} column(s)`)
              );
            }
            if (viewCount > 0) {
              parts.push(
                intl.get('performance.views_part', { count: viewCount }).d(`${viewCount} view(s)`)
              );
            }
            if (hideCount > 0) {
              parts.push(
                intl.get('performance.hides_part', { count: hideCount }).d(`${hideCount} hide(s)`)
              );
            }
            if (parts.length === 0) {
              return intl
                .get('performance.columns_remediated', { count: 0 })
                .d('0 column(s) remediated');
            }
            return intl
              .get('performance.parts_remediated', { parts: parts.join(', ') })
              .d(`${parts.join(', ')} remediated`);
          })()}
        </span>
        <span style={{ fontWeight: 400, color: '#aaa', marginLeft: 8, fontSize: 11 }}>
          {test.createdAt}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <ContextMenu
            onDelete={onDelete}
            label={intl.get('performance.delete_test').d('Delete test')}
            confirmDelete={confirmDeleteInDropdown}
            extraActions={[
              {
                label: runLabel,
                icon: 'dtable-icon-refresh',
                disabled: isBusy,
                onClick: onRun,
              },
              ...(onCopyToSandbox
                ? [
                    {
                      label: intl
                        .get('performance.copy_to_sandbox')
                        .d('Create sandbox with these changes'),
                      icon: 'dtable-icon-copy',
                      disabled: isBusy,
                      onClick: onCopyToSandbox,
                    },
                  ]
                : []),
              {
                label: intl.get('performance.apply_changes_menu').d('Apply changes'),
                icon: 'dtable-icon-check-mark',
                disabled: isBusy || !hasResult,
                disabledTooltip: hasResult
                  ? undefined
                  : intl.get('performance.apply_disabled_no_result').d('Run the test first'),
                onClick: onApply,
              },
            ]}
          />
        </span>
      </div>

      {/* Progress spinner — right under the title so it stays visible with long remediation lists */}
      {(test.status === 'running' || isApplyingThis) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            marginBottom: 10,
          }}>
          <div
            style={{
              width: 14,
              height: 14,
              border: '2px solid #ff8000',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              flexShrink: 0,
            }}
          />
          <span style={{ color: '#ff8000', fontStyle: 'italic' }}>
            {progressMsg || intl.get('performance.running').d('Running...')}
          </span>
        </div>
      )}

      {/* Remediations */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
          {intl.get('performance.remediations_subtitle').d('Remediations')}
        </div>
        <RemediatedColumnsList
          cols={test.remediations}
          views={test.remediationViews}
          hides={test.remediationHides}
          onRemove={isBusy ? undefined : onRemoveRemediation}
          onRemoveView={isBusy ? undefined : onRemoveRemediationView}
          onRemoveHide={isBusy ? undefined : onRemoveRemediationHide}
        />
      </div>

      {/* Test results */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
          {intl.get('performance.test_results_subtitle').d('Test results')}
        </div>
        {test.status === 'pending' && (
          <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>
            {intl.get('performance.not_run_yet').d('Not run yet')}
          </div>
        )}
        {test.status === 'error' && (
          <div style={{ fontSize: 12, color: '#dc3545' }}>
            {intl.get('performance.sandbox_error').d('Sandbox error')}: {test.errorMessage}
          </div>
        )}
        {test.status === 'ready' && test.beforeBenchmark && test.afterBenchmark && (
          <TestResultDisplay before={test.beforeBenchmark} after={test.afterBenchmark} />
        )}
      </div>

      {test.lastSandbox && !isApplyingThis && test.status !== 'running' && (
        <SandboxLinkRow sandbox={test.lastSandbox} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Generic confirmation modal — title + optional amber warning + optional body slot
// + Cancel/Confirm buttons. Used for apply-changes and run-all flows.
// ---------------------------------------------------------------------------

const ConfirmModal: React.FC<{
  title: string;
  warning?: string;
  body?: React.ReactNode;
  confirmLabel: string;
  confirmColor?: string;
  // Optional override for the cancel button label. Useful when the cancel path
  // performs a meaningful alternative action (e.g. "Skip and create with weaker
  // filter") rather than just dismissing the modal.
  cancelLabel?: string;
  // Optional two-step confirmation. When set, the first click on the confirm button
  // swaps its label to `doubleConfirmLabel` and requires a second click to actually fire.
  // Used e.g. by "Create sandbox with these changes" when a previous sandbox exists —
  // the label becomes "Overwrite existing sandbox?" so the user understands the old one
  // will be destroyed.
  doubleConfirmLabel?: string;
  // When true, the modal shows an inline spinner on the confirm button and
  // disables both buttons + backdrop dismissal. Use to give immediate feedback
  // for async confirm actions that take >1s (e.g. archival snapshot + delete).
  // Parent should also swap `confirmLabel` to a "…ing" form during processing.
  isProcessing?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({
  title,
  warning,
  body,
  confirmLabel,
  confirmColor = '#dc3545',
  cancelLabel,
  doubleConfirmLabel,
  isProcessing = false,
  onCancel,
  onConfirm,
}) => {
  const [awaitingSecondClick, setAwaitingSecondClick] = useState(false);
  const handleConfirmClick = () => {
    if (isProcessing) return;
    if (doubleConfirmLabel && !awaitingSecondClick) {
      setAwaitingSecondClick(true);
      return;
    }
    onConfirm();
  };
  // While processing, the parent's confirmLabel is the "…ing" message — show that
  // regardless of the awaitingSecondClick state so the user gets feedback.
  const currentConfirmLabel = isProcessing
    ? confirmLabel
    : doubleConfirmLabel && awaitingSecondClick
      ? doubleConfirmLabel
      : confirmLabel;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        zIndex: 1050,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={isProcessing ? undefined : onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#fff',
          borderRadius: 6,
          padding: 20,
          maxWidth: 560,
          width: '90%',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
        }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#333', marginBottom: 12 }}>
          {title}
        </div>
        {warning && (
          <div
            style={{
              padding: 12,
              border: '1px solid #ffc107',
              borderRadius: 4,
              backgroundColor: '#fff8e1',
              fontSize: 13,
              color: '#856404',
              marginBottom: 16,
            }}>
            {warning}
          </div>
        )}
        {body && <div style={{ marginBottom: 16 }}>{body}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={isProcessing ? undefined : onCancel}
            disabled={isProcessing}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              border: '1px solid #6c757d',
              borderRadius: 4,
              backgroundColor: '#fff',
              color: '#6c757d',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              opacity: isProcessing ? 0.5 : 1,
            }}>
            {cancelLabel || intl.get('performance.cancel').d('Cancel')}
          </button>
          <button
            onClick={handleConfirmClick}
            disabled={isProcessing}
            onMouseLeave={() => {
              // Match ContextMenu: bail out of confirm state if the user moves away.
              if (awaitingSecondClick && !isProcessing) setAwaitingSecondClick(false);
            }}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              border: `1px solid ${confirmColor}`,
              borderRadius: 4,
              // When a double-confirm is required: first state is outlined (low emphasis,
              // regular action), second state inverts to filled (high emphasis, destructive-
              // sounding label). Same visual language as the ContextMenu "Delete → Confirm?"
              // pattern used elsewhere in the plugin.
              backgroundColor:
                !isProcessing && doubleConfirmLabel && !awaitingSecondClick ? '#fff' : confirmColor,
              color:
                !isProcessing && doubleConfirmLabel && !awaitingSecondClick ? confirmColor : '#fff',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}>
            {isProcessing && (
              <span
                style={{
                  width: 12,
                  height: 12,
                  border: '2px solid currentColor',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  display: 'inline-block',
                }}
              />
            )}
            {currentConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Shared hook for the two apply-style modals (Apply + Copy-to-sandbox). Both need
 * the same body (verbose remediated-columns/views list + an optional checkbox
 * group for views that *would* become rule-less because of column deletions) and
 * the same "which views to delete" state. Only the framing (title/warning/confirm
 * label/color) differs.
 *
 * Explicitly-staged view deletions live in `test.remediationViews` and are shown
 * by `RemediatedColumnsList` at the top — they're committed already, so no
 * checkbox is offered for them. The hook just propagates them through
 * `collectViewsToDelete` so the apply path deletes them server-side.
 */
function useRemediationModalBody(test: PerformanceTest): {
  body: React.ReactNode;
  collectViewsToDelete: () => Array<{ tableName: string; viewName: string }>;
} {
  // Auto-suggested rule-less views: those that lose every filter/sort/groupby/etc.
  // because of the column deletions in this test. Skip any that are already in
  // `test.remediationViews` (explicit stagings handle them deterministically).
  const rulelessViews = React.useMemo(() => {
    const dtableSDK = (window as any).dtableSDK;
    const value = dtableSDK?.dtableStore?.value;
    if (!value)
      return [] as { tableName: string; tableId: string; viewName: string; viewId: string }[];
    const explicitKeys = new Set(
      (test.remediationViews || []).map((v) => `${v.tableName}::${v.viewName}`)
    );
    return findNowRulelessViews(value, test.remediations).filter(
      (v) => !explicitKeys.has(`${v.tableName}::${v.viewName}`)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.id]);

  const [viewsToDelete, setViewsToDelete] = useState<Set<string>>(
    () => new Set(rulelessViews.map((v) => `${v.tableName}::${v.viewName}`))
  );

  const toggleView = (key: string) =>
    setViewsToDelete((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const body = (
    <>
      <RemediatedColumnsList
        cols={test.remediations}
        views={test.remediationViews}
        hides={test.remediationHides}
        verbose
      />
      {rulelessViews.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 6 }}>
            {intl
              .get('performance.ruleless_views_title', { count: rulelessViews.length })
              .d(`${rulelessViews.length} view(s) will have no rules remaining`)}
          </div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            {intl
              .get('performance.ruleless_views_hint')
              .d(
                'Without any filter/sort/group-by, these views will show an unfiltered dump of their table. You can delete them instead.'
              )}
          </div>
          {rulelessViews.map((v) => {
            const k = `${v.tableName}::${v.viewName}`;
            const checked = viewsToDelete.has(k);
            return (
              <label
                key={k}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 13,
                  cursor: 'pointer',
                }}>
                <input type="checkbox" checked={checked} onChange={() => toggleView(k)} />
                <span>
                  <strong>{v.viewName}</strong>
                  <span style={{ color: '#888', marginLeft: 6 }}>in {v.tableName}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </>
  );

  const collectViewsToDelete = () => {
    const out: Array<{ tableName: string; viewName: string }> = [];
    const seen = new Set<string>();
    // Explicit stagings are always deleted; included unconditionally.
    for (const v of test.remediationViews || []) {
      const k = `${v.tableName}::${v.viewName}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ tableName: v.tableName, viewName: v.viewName });
    }
    // User-selected rule-less views (default-checked, but toggleable).
    for (const v of rulelessViews) {
      const k = `${v.tableName}::${v.viewName}`;
      if (seen.has(k)) continue;
      if (!viewsToDelete.has(k)) continue;
      seen.add(k);
      out.push({ tableName: v.tableName, viewName: v.viewName });
    }
    return out;
  };

  return { body, collectViewsToDelete };
}

const ApplyChangesModal: React.FC<{
  test: PerformanceTest;
  canDeleteSandbox: boolean;
  onCancel: () => void;
  onConfirm: (
    viewsToDelete: Array<{ tableName: string; viewName: string }>,
    deleteSandbox: boolean
  ) => void;
}> = ({ test, canDeleteSandbox, onCancel, onConfirm }) => {
  const { body, collectViewsToDelete } = useRemediationModalBody(test);
  const sandboxName = test.lastSandbox?.name;
  // Surface the concurrent-write caveat only when the apply will run at least
  // one freeze. Delete-only or view-only applies are atomic on the server side
  // and don't have a read-then-write window for new rows to slip into.
  const hasFreeze = test.remediations.some((r) => r.action === 'replace-static');
  // Default ON: after a successful apply the sandbox has served its purpose.
  // Hidden entirely when no sandbox exists or we have no account token to call
  // deleteBase with.
  const [deleteSandbox, setDeleteSandbox] = useState(true);
  const showSandboxOption = !!sandboxName && canDeleteSandbox;
  const extendedBody = (
    <>
      {body}
      {showSandboxOption && (
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            fontSize: 13,
            color: '#555',
            marginTop: 12,
            padding: '8px 10px',
            backgroundColor: '#f8f9fa',
            borderRadius: 4,
            cursor: 'pointer',
          }}>
          <input
            type="checkbox"
            checked={deleteSandbox}
            onChange={(e) => setDeleteSandbox(e.target.checked)}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span>
            <div style={{ fontWeight: 500, color: '#333' }}>
              {intl
                .get('performance.also_delete_sandbox_label', { name: sandboxName })
                .d(`Also delete the sandbox "${sandboxName}"`)}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              {intl
                .get('performance.also_delete_sandbox_hint')
                .d('Removes the sandbox base from your workspace after the apply succeeds.')}
            </div>
          </span>
        </label>
      )}
    </>
  );
  const baseWarning = intl
    .get('performance.apply_warning')
    .d(
      'Apply these changes to the original base? A snapshot will be created first, but deleted columns cannot be restored from within the plugin.'
    );
  const concurrentWriteWarning = intl
    .get('performance.apply_warning_concurrent_writes')
    .d(
      'During the freeze, rows added to the affected tables will land as null in the snapshot until you re-freeze. Avoid mass row additions while the apply runs.'
    );
  const warning = hasFreeze ? `${baseWarning} ${concurrentWriteWarning}` : baseWarning;
  return (
    <ConfirmModal
      title={intl.get('performance.apply_modal_title').d('Apply changes to original base')}
      warning={warning}
      body={extendedBody}
      confirmLabel={intl.get('performance.apply_changes').d('Apply changes to original base')}
      confirmColor="#dc3545"
      onCancel={onCancel}
      onConfirm={() => onConfirm(collectViewsToDelete(), showSandboxOption && deleteSandbox)}
    />
  );
};

const DeleteTestModal: React.FC<{
  test: PerformanceTest;
  canDeleteSandbox: boolean;
  isProcessing: boolean;
  onCancel: () => void;
  onConfirm: (deleteSandbox: boolean) => void;
}> = ({ test, canDeleteSandbox, isProcessing, onCancel, onConfirm }) => {
  const sandboxName = test.lastSandbox?.name;
  // Default ON: the user is throwing away the test config, so the sandbox
  // built from it is usually also unwanted. They can opt out if they want to
  // keep the base around to poke at manually.
  const [deleteSandbox, setDeleteSandbox] = useState(true);
  const showSandboxOption = !!sandboxName && canDeleteSandbox;
  const body = showSandboxOption ? (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        fontSize: 13,
        color: '#555',
        padding: '8px 10px',
        backgroundColor: '#f8f9fa',
        borderRadius: 4,
        cursor: 'pointer',
      }}>
      <input
        type="checkbox"
        checked={deleteSandbox}
        onChange={(e) => setDeleteSandbox(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <span>
        <div style={{ fontWeight: 500, color: '#333' }}>
          {intl
            .get('performance.also_delete_sandbox_label', { name: sandboxName })
            .d(`Also delete the sandbox "${sandboxName}"`)}
        </div>
        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
          {intl
            .get('performance.also_delete_sandbox_hint_on_test_delete')
            .d('Removes the sandbox base from your workspace too.')}
        </div>
      </span>
    </label>
  ) : null;
  return (
    <ConfirmModal
      title={intl.get('performance.delete_test_modal_title').d('Delete this test?')}
      body={body}
      confirmLabel={
        isProcessing
          ? intl.get('performance.deleting_test').d('Deleting...')
          : intl.get('performance.delete_test').d('Delete test')
      }
      confirmColor="#dc3545"
      isProcessing={isProcessing}
      onCancel={onCancel}
      onConfirm={() => onConfirm(showSandboxOption && deleteSandbox)}
    />
  );
};

const CopyToSandboxModal: React.FC<{
  test: PerformanceTest;
  onCancel: () => void;
  onConfirm: (
    viewsToDelete: Array<{ tableName: string; viewName: string }>,
    fullCopy: boolean
  ) => void;
}> = ({ test, onCancel, onConfirm }) => {
  const { body, collectViewsToDelete } = useRemediationModalBody(test);
  const [fullCopy, setFullCopy] = useState(false);
  const hasExistingSandbox = !!test.lastSandbox;

  // Extend the modal body with a checkbox for the full-copy mode. Wrapped in a
  // fragment so useRemediationModalBody's output (column list + ruleless views) stays
  // intact above the checkbox.
  const bodyWithFullCopyOption = (
    <>
      {body}
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          fontSize: 13,
          color: '#555',
          marginTop: 12,
          padding: '8px 10px',
          backgroundColor: '#f8f9fa',
          borderRadius: 4,
          cursor: 'pointer',
        }}>
        <input
          type="checkbox"
          checked={fullCopy}
          onChange={(e) => setFullCopy(e.target.checked)}
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <span>
          <div style={{ fontWeight: 500, color: '#333' }}>
            {intl.get('performance.full_copy_label').d('Include assets, scripts, and automations')}
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            {intl
              .get('performance.full_copy_hint')
              .d(
                'Uses export/import instead of quick copy. Slower but preserves everything — needed if you want to test automations or scripts in the sandbox.'
              )}
          </div>
        </span>
      </label>
    </>
  );

  return (
    <ConfirmModal
      title={intl.get('performance.copy_modal_title').d('Create a sandbox with these changes?')}
      body={bodyWithFullCopyOption}
      confirmLabel={intl.get('performance.copy_to_sandbox').d('Create sandbox with these changes')}
      confirmColor="#ff8000"
      doubleConfirmLabel={
        hasExistingSandbox
          ? intl.get('performance.copy_overwrite_confirm').d('Overwrite existing sandbox?')
          : undefined
      }
      onCancel={onCancel}
      onConfirm={() => onConfirm(collectViewsToDelete(), fullCopy)}
    />
  );
};

export default PerformanceAudit;
