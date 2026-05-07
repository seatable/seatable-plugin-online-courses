# Performance Audit — Design Summary

## Problem

SeaTable databases can become slow to open/manipulate when they contain expensive computed columns (formulas, link-formulas). There's no built-in way to identify which columns are the bottleneck or to safely test the impact of removing them.

## Approach: real measurements, not heuristic scores

Instead of guessing column weights, we **measure actual performance** by timing real SDK/API operations, and let the user **experiment in a sandbox copy** of the base.

## What we measure

| Operation       | Method                                          | What it reflects                          |
| --------------- | ----------------------------------------------- | ----------------------------------------- |
| Base sync       | `dtableSDK.syncWithServer()`                    | Full base load time (what the user feels) |
| Formula results | `dtableSDK.getTableFormulaResults(table, rows)` | Formula computation cost                  |
| Link resolution | `dtableSDK.getTableLinkRows(rows, table)`       | Link-formula fan-out cost                 |
| View rows       | `dtableSDK.getViewRows(view, table)`            | Filter/sort/group overhead                |

All timed with `performance.now()`.

## UI presentation

### 1. Base-level benchmark

A single headline number: total base sync time in ms. This is the metric the user cares about — "is my base slow?".

### 2. Column-level candidate list

A flat ranked list of computed columns across **all tables**, each showing:

- Table name, column name, column type (formula / link-formula subtype)
- Heuristic labels explaining _why_ it's a candidate:
  - Nested formula chain (depth)
  - Link-formula fan-out (target table row count)
  - Chained link-formula (lookup on lookup)
  - Complex functions (dateadd, datediff, IF nesting) on large tables
- Checkbox to select for sandbox testing

No table-level ranking — tables are just context labels on the column list.

### 3. Sandbox test results

After deleting selected columns in the sandbox copy:

- New base sync time vs. original (ms + % improvement)
- Per-operation breakdown (formula results, link resolution, etc.)
- User can iterate: select more columns, re-test

## Sandbox workflow

```
Original base (NEVER modified during experimentation)
    │
    ├─ 1. BENCHMARK
    │     Time syncWithServer() + per-table operations
    │
    ├─ 2. IDENTIFY
    │     List computed columns with heuristic labels
    │     User selects columns to test
    │
    ├─ 3. CREATE SANDBOX
    │     POST /api/v2.1/dtable-copy/
    │       → returns copy UUID + workspace_id
    │     GET  /api/v2.1/workspace/{id}/dtable/{name}/access-token/
    │       → returns base token for the copy
    │
    ├─ 4. EXPERIMENT (in sandbox only)
    │     Delete selected columns → re-benchmark
    │     Show before/after delta
    │     User can iterate (remove more, re-benchmark)
    │
    ├─ 5. CLEANUP
    │     DELETE /api/v2.1/workspace/{id}/dtable/
    │       → soft-deletes sandbox copy to trash
    │
    └─ 6. APPLY (optional, user-initiated)
          Snapshot original base + confirmation dialog
          Delete same columns in the original base
```

## API requirements

All sandbox operations require the **account token** (not the base token). This is already available in plugin settings (used by Assets audit).

| Endpoint                                                   | Auth          | Purpose                     |
| ---------------------------------------------------------- | ------------- | --------------------------- |
| `POST /api/v2.1/dtable-copy/`                              | Account token | Copy base to same workspace |
| `GET /api/v2.1/workspace/{id}/dtable/{name}/access-token/` | Account token | Get base token for copy     |
| `DELETE /api/v2.1/workspace/{id}/dtable/`                  | Account token | Delete sandbox copy         |
| `POST /api-gateway/api/v2/dtables/{uuid}/snapshot/`        | Base token    | Snapshot before applying    |

## Column detection (heuristic labels, not scores)

These are used to **label and explain** candidates, not to rank them:

| Pattern                   | Detection method                                                 |
| ------------------------- | ---------------------------------------------------------------- |
| Nested formulas           | Parse `col.data.formula` for `{OtherFormulaCol}` references      |
| Link-formula fan-out      | Link column fill rate x target table row count                   |
| Chained link-formulas     | Follow `link_column_key` → target column type                    |
| Complex functions         | Regex on formula text: dateadd, datediff, concatenate, nested IF |
| High row count multiplier | `table.rows.length` context on any computed column               |

## Implementation plan

1. Create `performanceAuditRunner.ts` — benchmark logic + sandbox lifecycle
2. Add types to `AuditTypes.ts`
3. Build UI components in `src/components/custom-components/PerformanceAudit/`
   - Benchmark display (single base-level number)
   - Column candidate list (flat, cross-table, with heuristic labels + checkboxes)
   - Sandbox controls (create / delete selected / re-benchmark / cleanup)
   - Apply dialog (snapshot + confirmation)
4. Add preset type and i18n keys (all 7 language files)
5. Add caching + autoRerun support (same pattern as Tables/Links audits)
