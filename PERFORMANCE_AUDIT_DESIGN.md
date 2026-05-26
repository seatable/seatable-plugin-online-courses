# Performance Audit — Design Summary

## Problem

SeaTable databases can become slow to open and manipulate when they contain expensive computed columns (formulas, link-formulas). There's no built-in way to identify which columns are the bottleneck, quantify their cost, or safely reduce it.

## Approach: theoretical cost model, validated against real measurements

We compute a **per-column cost** via isolated in-memory benchmarking (`DTableStore` median-of-3 timing), then roll up to **per-view theoretical cost** based on which columns are visible or rule-referenced in each view. The user can **experiment in a sandbox copy**, **freeze columns in-place** (replacing live formulas with static snapshots), or **archive old rows** — and see predicted vs. measured impact.

**Validation:** Paired-state experiment on a 75k-row customer base (6 view×state pairs) produced R² = 0.90 between predicted Δ% and measured view-switch Δ%. The model genuinely predicts perceived UX.

## What we measure (4-step pipeline)

| Step | Function | What it does |
| ---- | -------- | ------------ |
| 1/4 Scanning formulas | `scanCandidateColumns()` | Structural inventory of all formula / link-formula columns; chain-depth, fan-out, rule references |
| 2/4 Measuring formula cost | `measurePerColumnCost()` | Median-of-3 isolated `getTableFormulaResults()` timing per column |
| 3/4 Computing view weights | `countViewRows()` + `computeTheoreticalViewCosts()` | Row count per view (cached filter lengths, no recompute) × per-column cost → theoretical view cost |
| 4/4 Finding archivable rows | `measureRowArchival()` | Row staleness (`_ctime` + `_mtime` older than threshold) + cross-table incoming-link safety scan |

Cost attribution distinguishes **structural** (formula complexity — fix by rewriting or freezing) vs. **volume** (row count — fix by archiving old rows).

## UI presentation

### 1. Overview tab — two umbrella sections

**Archival candidates:** Per-table rows eligible for archival with absolute counts. Actions: "Create archival view" (filtered view of old rows), "Delete with snapshot" (server-side snapshot first).

**Performance candidates:** Formula/link-formula columns ranked by compute cost %. Each shows:
- Impact badge (Low / Medium / High) based on cost share
- PercentBar visualization (integer %, "not relevant" below 2%)
- Chain graph (column-as-node, table-as-edge-annotation, Welsh-Powell palette)
- Near-duplicate detection label (link-formulas with identical compute signature)
- Three-dots menu: Stage freeze / Stage delete / Stage views changes / direct Freeze now / direct Delete now

**Views section:** Heaviest views by theoretical cost, with rule-bound badges when a hidden column still affects filters/sorts/groupby. Per-view drill with column visibility sliders.

**Currently frozen section:** Columns already frozen via indirection. Per-row Unfreeze button. Orphan detection for stale settings entries and stranded helper columns.

### 2. Per-table tabs (inside Tables audit)

PerformanceAudit is embedded in TablesAudit as a sibling of per-table TableTabs. State mirrors UP via callbacks (`onResultChange`, `onStatusChange`, `onProgressChange`, `onDeletedArchivalTableIdsChange`). Each TableTab shows the same columns/views/rows data scoped to that table, with identical action menus.

### 3. Sandbox test results

After applying staged remediations to a sandbox copy:
- Before/after delta with dual-floor band (sub-200ms absolute savings = "no change" regardless of %)
- Per-view breakdown (composite-keyed by `${tableId}:${viewId}` — view `_id` is not globally unique)
- User can iterate: stage more changes, re-test

## Remediation types

| Type | What it does | Mechanism |
| ---- | ------------ | --------- |
| **Delete column** | Remove a computed column entirely | SDK `deleteColumn` (original) or HTTP `DELETE /columns/` (sandbox) |
| **Freeze column** (replace-static) | Replace a live formula with a static snapshot | Self-link indirection (see below) |
| **Hide in view** | Hide a column in specific views (reduces compute when not rule-referenced) | `PUT` view's `hidden_columns` array |
| **Delete view** | Remove a heavy or redundant view | SDK `deleteView` or HTTP `DELETE /views/` |
| **Archive rows** | Delete old rows (with server-side snapshot) | Filtered view creation + batch row deletion |

Two-phase model: **stage** (local, reversible) → **apply** (commit to sandbox or original base).

## Freeze mechanism — self-link indirection

The core innovation for making expensive columns static without breaking downstream references (forms, automations, apps that read the column by key).

**Why not `modify_column_type`?** HTTP `PUT /columns/` with `op_type: modify_column_type` has a hard 60s nginx timeout. On tables with ~50k+ rows, the per-row storage I/O exceeds it — the column gets corrupted (type=undefined, name=null). This wall is structural and cannot be bypassed by neutralizing the formula first.

**The indirection approach:** Keep the column as its original type but mutate its `data` so it evaluates as a trivial lookup of pre-computed values.

### Plain formula columns

1. Add a snapshot column (type matched to formula's `result_type`)
2. SQL-read current values in 10k chunks → batch-write into snapshot in 1k chunks
3. Swap formula expression to `{SnapshotColumn}` via `setColumnData` (metadata-only, O(1))
4. Verify with SQL LIMIT 10

### Link-formula columns

1. Add a snapshot column (type depends on shape mode — see below)
2. SQL-read current values in 10k chunks → batch-write into snapshot in 1k chunks
3. Add a same-table self-link column (shared per table, `_frozenLink_<tableName>`)
4. Populate self-link: each row links to itself via `PUT /links/` in 1k chunks
5. Mutate LF's `data` via `applyLocalOperation` so it evaluates as `lookup(self-link → snapshot)`
6. Verify with SQL LIMIT 10

Auto-rollback on any failure after snapshot creation.

### Three shape modes

| Mode | When | Snapshot type | Example |
| ---- | ---- | ------------- | ------- |
| scalar | `result_type` is not `array` (countlinks, etc.) | Mapped from result_type (number/text/date/...) | `# Attendees` → number |
| collapsed-array | `result_type = 'array'` AND every row has length ≤ 1 | Matches `array_type` exactly (date, text, ...) | `findmax → date` stays typed date |
| multi-array | `result_type = 'array'` AND at least one row has length > 1 | `long-text` (joined string) | `lookup → emails` → `"a@x, b@y"` |

Multi-array triggers a warning modal (shape change for downstream consumers) with cancellation.

### Key technical constraints

- **`canEditMetadata` gate:** `setColumnData` silently no-ops on columns with `edit_metadata_permission_type`. Bypass via `dtableStore.createOperation({type: 'modify_column_data', ...}) + applyLocalOperation`.
- **Shared self-link:** One `_frozenLink_<table>` per table, reference-counted. Only deleted when the last frozen LF on that table is unfrozen.
- **Persistence:** Frozen state stored in plugin settings as `frozenColumns: { [tableId.columnKey]: FrozenColumnRecord }`. Contains original `data` for unfreeze, snapshot/self-link column keys, shape mode, timestamp.
- **Helper naming:** `_frozen_<columnName>` for snapshots, `_frozenLink_<tableName>` for self-links.

### Measured performance

| Rows | Shape | Total wall time |
| ---- | ----- | --------------- |
| 77 | scalar (count_links) | 1.1s |
| 1,067 | multi-array (lookup → email) | 7.3s |
| 69,020 | collapsed-array (findmax → date) | 35.3s |

Linear scaling. No 60s wall — each individual HTTP call stays well under it.

## Sandbox workflow

```
Original base (NEVER modified during experimentation)
    │
    ├─ 1. AUDIT (4-step pipeline)
    │     Scan → Measure → Weight → Archival
    │     Produces candidates + view costs + archival counts
    │
    ├─ 2. STAGE
    │     User stages remediations: freeze, delete, hide-in-view, delete-view
    │     Cross-surface mirroring keeps Overview + per-table tabs in sync
    │
    ├─ 3. CREATE SANDBOX
    │     POST /api/v2.1/dtable-copy/ (or full-copy import with assets)
    │       → wait for api-gateway readiness (polls /metadata/ until 200)
    │       → returns copy UUID + workspace_id
    │
    ├─ 4. EXPERIMENT (in sandbox only)
    │     Apply staged remediations → re-audit → delta display
    │     Helper columns (_frozen_*, _frozenLink_*) kept visible in sandbox
    │     User can iterate (stage more, re-test)
    │
    ├─ 5. CLEANUP
    │     DELETE /api/v2.1/workspace/{id}/dtable/
    │       → soft-deletes sandbox copy to trash
    │
    └─ 6. APPLY (optional, user-initiated)
          Apply remediations to original base
          Frozen columns persisted in plugin settings for later unfreeze
          OR: "Freeze column now" direct action (bypasses sandbox)
```

## API endpoints

### Sandbox lifecycle (account token)

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api/v2.1/dtable-copy/` | Copy base to same workspace |
| `GET /api/v2.1/workspace/{id}/dtable/{name}/access-token/` | Get base token for copy |
| `DELETE /api/v2.1/workspace/{id}/dtable/` | Soft-delete sandbox copy |

### Freeze pipeline (base token via `dtableSDK.config`)

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api-gateway/api/v2/dtables/{uuid}/columns/` | Add snapshot / self-link column |
| `DELETE /api-gateway/api/v2/dtables/{uuid}/columns/` | Delete column (body: `{table_name, column}`) |
| `POST /api-gateway/api/v2/dtables/{uuid}/sql/` | Chunked reads (LIMIT 10000) |
| `PUT /api-gateway/api/v2/dtables/{uuid}/rows/` | Batch row update (chunks of 1000) |
| `PUT /api-gateway/api/v2/dtables/{uuid}/links/` | Batch self-link populate (chunks of 1000) |
| `GET /api-gateway/api/v2/dtables/{uuid}/metadata/` | Readiness polling + verification |

Auth: `Authorization: Bearer ${accessToken}` from `dtableSDK.config` (NOT `window.dtable`). Use `cache: 'no-store'` on metadata fetches to avoid 304 stale responses.

## Column detection

Candidates are identified structurally then **ranked by measured cost**:

| Signal | Detection | Used for |
| ------ | --------- | -------- |
| Formula/link-formula type | `column.type` check | Entry gate |
| Per-column cost (ms) | Median-of-3 `getTableFormulaResults()` isolation | Cost % ranking, impact badge |
| Chain depth | Recursive `data.formula` / `link_column_key` traversal | Chain graph visualization |
| Near-duplicate signature | Group by `formula\|link_column_key\|level1\|level2\|summary_method` | Consolidation label |
| Rule references | Scan filters/sorts/groupbys/colorbys/column_colors/summaries per view | Rule-bound badge, hide-in-view eligibility |
| Row staleness | `_ctime` + `_mtime` age threshold | Archival candidates |
| Incoming-link safety | Cross-table link scan for rows referenced by other tables | Archival safety gate |

## File structure

| File | Role |
| ---- | ---- |
| `src/utils/custom-utils/performanceAuditRunner.ts` | 4-step pipeline, remediation applier, sandbox lifecycle |
| `src/utils/custom-utils/freezeColumn.ts` | Freeze/unfreeze via indirection, retry/settle, shape detection |
| `src/components/custom-components/PerformanceAudit/index.tsx` | Overview UI, delta display, test management, frozen section |
| `src/components/custom-components/TablesAudit/index.tsx` | Host for embedded PerformanceAudit + per-table tabs |
| `src/components/custom-components/TablesAudit/TableTab.tsx` | Per-table columns/views/rows with perf enrichment |
| `src/components/custom-components/shared/ChainGraph.tsx` | Column-as-node chain visualization |
| `src/components/custom-components/shared/CandidateExpansion.tsx` | Chain graph + per-view drill (shared by Overview + TableTab) |
| `src/components/custom-components/shared/ViewVisibilityDrill.tsx` | Column visibility sliders per view |
| `src/components/custom-components/shared/candidateMenu.ts` | Three-dots menu items for candidates |
| `src/components/custom-components/shared/ImpactBadge.tsx` | Low/Medium/High badge component |
| `src/components/custom-components/shared/impactBands.ts` | Delta band logic (dual-floor: pct + absolute ms) |
| `src/utils/custom-utils/performanceAuditTest{1,1b,2,3,4,7}.ts` | Diagnostic harnesses (behind dev flag) |

## Status

Phases A–D shipped (uncommitted on `audit-v0`). Phase E (concurrent-write warning, mid-apply failure recovery, re-freeze smoke test, `/metadata/` cache lag audit) remains. Ready for small-cohort beta with documented caveats around concurrent writes and single-user testing history.
