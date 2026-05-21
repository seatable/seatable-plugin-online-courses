/* eslint-disable no-restricted-globals */
// Interface property names like `name` and `status` trigger false positives from
// no-restricted-globals; the rule can't distinguish a type-level property from a
// bare reference to window.name / window.status. Disabled at the file level.

export interface AssetFile {
  path: string;
  name: string;
  size: number;
  lastUpdate: string;
  folder: string;
  uuid?: string;
}

export interface RefSource {
  tableName: string;
  columnName: string;
  rowId: string;
}

export interface FolderStorage {
  folder: string;
  size: number;
  fileCount: number;
  percentage: number;
  isSystemFolder: boolean;
}

export type UrlCheckStatus = 'ok' | 'broken' | 'unverifiable';

export interface UrlCheckResult {
  result: UrlCheckStatus;
  code?: number;
  error?: string;
}

export interface AssetsAuditResult {
  allFiles: AssetFile[];
  totalSize: number;
  referencedCount: number;
  orphans: AssetFile[];
  orphanSize: number;
  missingRefs: string[];
  refSources: Record<string, RefSource[]>;
  refDisplayNames: Record<string, string>;
  externalUrls: Record<string, RefSource[]>;
  urlChecks: Record<string, UrlCheckResult>;
  folderSizes: FolderStorage[];
}

export interface ColumnAuditInfo {
  name: string;
  type: string;
  fillRate: number | null;
  errorRate: number | null;
  matchesCtime: boolean;
  duplicateOf: string[];
  lastActivity: string | null;
}

export interface ViewAuditInfo {
  name: string;
  // SeaTable's `view._id`. Populated alongside `name` so callers don't need to
  // round-trip through the SDK to identify the view (e.g. for stage-delete).
  viewId: string;
  filterCount: number;
  filterSummary: string;
  sortCount: number;
  sortSummary: string;
  groupbyCount: number;
  groupbySummary: string;
  // Names of other views in the same table with the same filters, sorts, groupbys,
  // and hidden-columns set. Empty when the view is unique. Populated after all views
  // are built so comparisons are mutual.
  duplicateOf: string[];
  // SeaTable's `private_for` field — null/undefined for public views, otherwise an
  // identifier ending in "@auth.local" naming the user the view is private to.
  // Surfaced in the UI as a small lock icon + warning on the delete action, since
  // the SDK lets anyone delete any view regardless of ownership.
  privateFor?: string | null;
}

export interface TableAuditResult {
  tableName: string;
  // SeaTable's `table._id` — passed alongside tableName so per-table tab actions
  // can identify the table for the embedded PerformanceAudit handle without
  // round-tripping through the SDK.
  tableId: string;
  rowCount: number;
  columnCount: number;
  totalColumnCount: number;
  viewCount: number;
  lastRowAdded: string | null;
  lastRowModified: string | null;
  columns: ColumnAuditInfo[];
  views: ViewAuditInfo[];
}

export interface AuditTableDisplayState {
  selectedTables: string[]; // Array of table IDs to audit
  isAllSelected: boolean;
  // Row archival threshold in days — rows whose _ctime AND _mtime are older than this
  // are flagged as archival candidates in the Rows section.
  rowArchivalThresholdDays?: number; // default 730 (2 years)
  // Timestamp bumped by PluginSettings when the user clicks a staleness notification
  // to trigger a performance analysis rerun from the settings panel. TablesAudit
  // watches it and calls the embedded PerformanceAudit's run() method.
  perfRerunAt?: number;
}

export const DEFAULT_ROW_ARCHIVAL_DAYS = 730;

// --- Links Audit ---

export interface LinkColumnInfo {
  tableId: string;
  tableName: string;
  columnKey: string;
  columnName: string;
  targetTableId: string;
  targetTableName: string;
  targetColumnName: string;
  linkId: string;
  isSelfLink: boolean;
  hasMirror: boolean;
  linkedRowCount: number;
  totalRowCount: number;
  fillRate: number;
  outboundChain?: ChainNode[];
  // True when this self-link column was created by the performance-audit
  // freeze mechanism (referenced as `selfLinkColumnKey` in plugin settings'
  // frozenColumns). Surfaced as a badge in the Links audit; excluded from
  // redundancy and missing-mirror detection so a freeze artifact doesn't
  // pollute structural findings.
  isFreezeHelper?: boolean;
}

export interface LinkFormulaInfo {
  tableId: string;
  tableName: string;
  columnKey: string;
  columnName: string;
  columnType: 'link-formula' | 'formula';
  formulaType: string;
  dependsOnColumnKey: string;
  dependsOnColumnName: string;
  targetTableName: string;
  targetColumnName: string;
  targetColumnIsLink: boolean;
  outboundChain?: ChainNode[];
}

export interface RedundantLink {
  tableAId: string;
  tableAName: string;
  tableBId: string;
  tableBName: string;
  columns: { columnName: string; linkId: string; tableName: string }[];
}

export interface LookupSuggestion {
  tableName: string;
  columnName: string;
  columnKey: string;
  columnType: string;
  linkColumnName: string;
  linkColumnKey: string;
  targetTableName: string;
  targetColumnName: string;
  targetColumnKey: string;
}

export interface LinksAuditResult {
  linkColumns: LinkColumnInfo[];
  linkFormulas: LinkFormulaInfo[];
  redundantLinks: RedundantLink[];
  unusedLinks: LinkColumnInfo[];
  missingMirrors: LinkColumnInfo[];
  lookupSuggestions: LookupSuggestion[];
}

// --- Performance Audit ---

export interface ChainColumn {
  name: string;
  type: string; // 'link', 'link-formula', 'formula', 'text', etc.
}

export interface ChainNode {
  tableName: string;
  tableRows: number;
  columns: ChainColumn[];
  children: ChainNode[]; // next level (chained lookups)
}

export interface ReplacementType {
  type: string; // target plain column type: text, number, date, single-select, multiple-select, checkbox, etc.
  data?: any; // optional column data: format for number/date, options[] for select (to be created after column exists)
}

export interface PerformanceCandidateColumn {
  tableId: string;
  tableName: string;
  columnKey: string;
  columnName: string;
  columnType: string; // 'formula' | 'link-formula' | 'link'
  formulaType?: string; // lookup, rollup, countlinks, findmax, findmin, or formula subtype
  labels: string[]; // problem tags: "nested formula", "large linked table", etc.
  chain: ChainNode[]; // dependency tree for visual display (grouped by table)
  // For link-formula candidates only: the human-readable name of the link
  // column this formula traverses (e.g. "Customer" for a lookup that walks
  // the Customer link). Used by ChainGraph to render the reference edge from
  // the formula head to the explicit link-column row.
  dependsOnLinkColumnName?: string;
  rowCount: number;
  isMultiValue?: boolean; // true if any row's value is an array with length >= 2
  isPrimaryColumn?: boolean; // true when this is the first column of its table — SeaTable disallows deletion
  measuredCostMs?: number; // median isolation cost from getTableFormulaResults; undefined if not measured
  replacementType?: ReplacementType; // undefined when the column can't be safely replaced by a plain static column
  affectedRules?: AffectedRule[]; // filled after scanCandidateColumns runs scanColumnReferences
  // Other link-formula columns in the same table with an identical compute signature
  // (same formula type, link column, source field(s), and aggregation/comparison key).
  // Members may differ in display config (format, result_type, array_type) but produce
  // the same value per row at the same compute cost — N-1 of them are wasted work.
  // Empty / undefined when no peers share this column's signature.
  nearDuplicateGroup?: Array<{ columnKey: string; columnName: string }>;
}

export type RemediationAction = 'delete' | 'replace-static';

export type RuleKind =
  | 'view-filter'
  | 'view-sort'
  | 'view-groupby'
  | 'view-hidden'
  | 'view-colorby'
  | 'view-column-color'
  | 'view-summary'
  | 'link-formula-condition'
  | 'link-row-filter-static'
  | 'link-row-filter-dynamic';

export interface AffectedRule {
  kind: RuleKind;
  // Table where the rule lives (for view-*: the view's own table; for link-*: the table
  // holding the link-formula or link column whose data carries the filter).
  tableName: string;
  tableId: string;
  // For view-* kinds: the view identifying info
  viewName?: string;
  viewId?: string;
  // For link-* kinds: the column that owns the rule (the link-formula or link column)
  ownerColumnName?: string;
  ownerColumnKey?: string;
  // For link-row-filter-dynamic: which side of the filter references the target column:
  // 'filtered' = linked_table_column_key; 'value' = column_key (read from this table's row).
  dynamicRole?: 'filtered' | 'value';
}

export interface RemediatedColumn {
  tableName: string;
  columnKey: string;
  columnName: string;
  columnType: string;
  action: RemediationAction;
  replacementType?: ReplacementType;
  // Rules across the base that reference this column — populated at test-creation time
  // so the Test block + Apply modal can show the blast radius and, later, adapt them.
  affectedRules?: AffectedRule[];
}

// One frozen column's restoration record. Persisted in plugin settings so an
// "Unfreeze" can restore the original formula via applyLocalOperation later,
// even after a page reload or across sessions. Keyed in the store by
// `${tableId}.${columnKey}` — see [[reference_seatable_view_id_not_globally_unique]]
// for why composite identifiers matter on this platform.
export interface FrozenColumnRecord {
  tableId: string;
  tableName: string;
  columnKey: string;
  columnName: string;
  /** Original `data` block on the LF / formula column at freeze time. Restore via
   * `applyLocalOperation` with type:'modify_column_data'. */
  originalData: any;
  /** Helper column keys created (or reused) by the freeze pipeline. */
  snapshotColumnKey: string;
  /** Empty for plain-formula candidates — only link-formula uses a self-link. */
  selfLinkColumnKey: string;
  /** Empty for plain-formula candidates. */
  selfLinkId: string;
  /** Whether the snapshot was scalar, collapsed from an array, or a multi-array
   * joined to long-text. Affects what shape the column returns post-freeze and
   * how the UI should warn about downstream consumer impact. */
  shapeMode: 'scalar' | 'collapsed-array' | 'multi-array';
  /** ISO timestamp of when the freeze applied successfully. */
  frozenAt: string;
}

// Staged view-deletion. Views only have one possible action (delete), so no
// `action` field — presence of the entry IS the staging.
export interface RemediatedView {
  tableId: string;
  tableName: string;
  viewId: string;
  viewName: string;
  privateFor?: string | null;
}

// Staged "hide this column in these views". One entry per (column, view set);
// `viewIds` carries the views to flip into hidden_columns. Mutually exclusive
// with delete / replace-static for the same column at staging time.
export interface RemediatedColumnHide {
  tableId: string;
  tableName: string;
  columnKey: string;
  columnName: string;
  // Each entry carries `viewId` for the staging key and `viewName` for display.
  views: Array<{ viewId: string; viewName: string }>;
}

// Per-view sizing for the audit's Views section and the test before/after delta.
// Migrated 2026-05-05: this used to carry the wall-clock time of a single
// `Views.getViewRows` call. That signal was retired (HTTP correlation R²~0.1,
// and the recompute cost was minutes on large bases). The shape is preserved
// to keep the test before/after delta path stable; the `ms` field now carries
// the theoretical compute cost (Σ per-cell × visibleRows over visible computed
// columns) computed via `computeTheoreticalViewCosts`.
export interface ViewLoadTiming {
  tableId: string;
  tableName: string;
  viewId: string;
  viewName: string;
  rowCount: number;
  // Theoretical compute cost in ms for this view (Σ per-cell × visibleRows over
  // visible computed columns). Already total-cost-for-the-view — consumers
  // computing weighted aggregates must NOT multiply by rowCount again.
  ms: number;
  // SeaTable's `private_for` (null/undefined for public views).
  privateFor?: string | null;
}

export interface BenchmarkTimings {
  viewLoads: ViewLoadTiming[];
}

export type TestStatus = 'pending' | 'running' | 'ready' | 'error';

export interface PerformanceTestSandbox {
  name: string;
  workspaceId: number;
  appliedCount: number;
  failedCount?: number;
  createdAt: string;
}

export interface PerformanceTest {
  id: string;
  createdAt: string;
  remediations: RemediatedColumn[];
  // Staged view deletions. Optional for backwards-compatibility with tests
  // serialized before view-staging existed.
  remediationViews?: RemediatedView[];
  // Staged column-in-view hides. Optional, same back-compat reason.
  remediationHides?: RemediatedColumnHide[];
  // Both timings use the same HTTP-benchmark path. beforeBenchmark is measured against the
  // original base immediately before afterBenchmark against the sandbox, so short-term
  // network drift cancels out. Both undefined until the test has been run.
  beforeBenchmark?: BenchmarkTimings;
  afterBenchmark?: BenchmarkTimings;
  status: TestStatus;
  errorMessage?: string;
  // Info about the most recent sandbox created for this test, if any.
  lastSandbox?: PerformanceTestSandbox;
}

export interface SandboxState {
  status: 'idle' | 'creating' | 'applying' | 'benchmarking' | 'cleaning' | 'error';
  copyName?: string;
  copyUuid?: string;
  copyWorkspaceId?: number;
  copyAccessToken?: string;
  runningTestId?: string;
  errorMessage?: string;
}

// Per-view entry in the audit result. Sorted by `loadMs` desc in the runner so
// the UI can display "heaviest views first" without re-sorting.
//
// Migrated 2026-05-05: `loadMs` used to be the wall-clock time of a single
// `Views.getViewRows` call. That signal was retired (HTTP correlation R²~0.1,
// and minutes of recompute cost on large bases). `loadMs` now carries the same
// value as `theoreticalCostMs` — kept as a separate field for backwards-compat
// with UI consumers (Views section weight column, test delta math).
export interface PerformanceAuditView {
  tableId: string;
  tableName: string;
  viewId: string;
  viewName: string;
  rowCount: number;
  // SeaTable's `private_for` (null/undefined for public views).
  privateFor?: string | null;
  // Theoretical compute cost in ms (mirror of `theoreticalCostMs`). Already
  // total-cost-for-the-view; do not multiply by rowCount.
  loadMs: number;
  // Deterministic estimate of view compute cost: Σ (per-cell cost × visible rows)
  // over the view's *visible* computed columns. Anchored on the reproducible
  // per-column cost signal (median-of-3 isolation). Doesn't capture filter/sort/
  // group cost — accepted gap (SeaTable's compute is client-side, no clean signal
  // for filter/sort cost is available). Always emitted for views that were measured;
  // 0 when the table has no computed columns or the view has zero visible rows.
  theoreticalCostMs?: number;
}

// Per-table row-archival analysis — how many rows are "stale" (ctime AND mtime
// older than threshold) and how many of those have no incoming links (safe to
// archive without breaking references).
export interface PerformanceAuditTableArchival {
  tableId: string;
  tableName: string;
  totalRows: number;
  // Rows whose _ctime and _mtime are both older than thresholdDate.
  candidateCount: number;
  // Subset of candidates that are not referenced by any link column in any other
  // table — genuinely orphan-able. When incoming-link computation was skipped (no
  // link columns in base), this equals candidateCount.
  candidateCountNoIncomingLinks: number;
  // Column keys for existing ctime/mtime columns, when present. Used by the
  // "Create archival view" action to build a filter without schema modification.
  ctimeColumnKey?: string;
  mtimeColumnKey?: string;
  // ISO date used as the threshold when this audit ran. Frozen here so a view
  // created later uses the exact same cutoff as shown to the user.
  thresholdDate: string;
}

export interface PerformanceAuditResult {
  candidates: PerformanceCandidateColumn[];
  views: PerformanceAuditView[];
  archival: PerformanceAuditTableArchival[];
  // Per-column measured compute cost from step 1 (key: `${tableId}:${columnKey}`,
  // value: total ms across the table's rows for that column). Intrinsic to the
  // formula — stays valid when columns are deleted elsewhere, so sandbox tests
  // can reuse this map to compute the "after" theoretical cost without re-running
  // the (expensive) candidate detection pass.
  costByKey: Map<string, number>;
}

export type AuditStatus = 'idle' | 'running' | 'done' | 'error';

export interface AuditProgress {
  status: AuditStatus;
  step: string;
  current: number;
  total: number;
}
