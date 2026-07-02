/**
 * Declarative grading engine (strategy "b").
 *
 * Grade rules live in the course MANIFEST (authored in Hugo), not in plugin code,
 * so adding or editing an exercise NEVER needs a plugin release — important with
 * one plugin serving all seven courses and self-hosted installs updating manually.
 *
 * A rule reuses the API-Gateway Update-Row payload shape: it lists, for a table,
 * the rows that must hold given cell values. The SAME `{ row_id, row: { Col: val } }`
 * objects that seed/write a row (see authoredWrite.ts / writeCell) also ASSERT it —
 * a course author can copy a seeding payload and turn it into the answer key.
 *
 * `row_id` is the base `_id`. Each course ships as a fixed imported base, so the
 * ids are stable across every learner — referencing them directly is safe.
 *
 * Cells are compared on DISPLAY values (single-select labels resolved), matching
 * how the Update-Row endpoint takes values. Reads only — no writing, no API calls.
 */

import { cellLabel, getColumn, getTableByName } from './sdkRead';

export type Outcome =
  | { kind: 'idle' }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'missing'; what: string };

/** One asserted row — same shape as a gateway Update-Row `updates[]` entry. */
export interface ExpectedRow {
  row_id: string;
  row: Record<string, any>; // column NAME → expected display value
}

export interface GradeRule {
  table_name: string;
  expected: ExpectedRow[];
  /** 'all' (default): every expected row must match. 'any': at least one must. */
  match?: 'all' | 'any';
}

type RowResult =
  | { ok: true }
  | { ok: false; missing: true; what: string }
  | { ok: false; missing: false; reason: string };

// Check one expected row against the live base. Missing table/column/row is
// surfaced as `missing` (base doesn't match the exercise); a present-but-wrong
// cell is a `fail` (the learner hasn't done it yet).
function gradeRow(table: any, exp: ExpectedRow): RowResult {
  const row = (table.rows || []).find((r: any) => r._id === exp.row_id);
  if (!row) return { ok: false, missing: true, what: `row "${exp.row_id}" in "${table.name}"` };

  for (const [colName, expectedRaw] of Object.entries(exp.row)) {
    const col = getColumn(table, colName);
    if (!col) return { ok: false, missing: true, what: `column "${colName}" in "${table.name}"` };

    const actual = cellLabel(col, row[col.key]);
    const expected = expectedRaw === null || expectedRaw === undefined ? null : String(expectedRaw);
    if (actual !== expected) {
      return {
        ok: false,
        missing: false,
        reason: `${table.name} · ${colName} is "${actual ?? '(empty)'}", expected "${expected ?? '(empty)'}"`,
      };
    }
  }
  return { ok: true };
}

/** Evaluate a grade rule against the current base state. */
export function grade(rule: GradeRule): Outcome {
  const table = getTableByName(rule.table_name);
  if (!table) return { kind: 'missing', what: `table "${rule.table_name}"` };
  if (!rule.expected?.length) return { kind: 'missing', what: 'grade rule has no expected rows' };

  const results = rule.expected.map((exp) => gradeRow(table, exp));

  if ((rule.match ?? 'all') === 'any') {
    if (results.some((r) => r.ok)) return { kind: 'pass' };
    // none passed: prefer a concrete fail reason over a "missing" one
    const failed = results.find((r) => !r.ok && !r.missing) as { reason: string } | undefined;
    if (failed) return { kind: 'fail', reason: failed.reason };
    const miss = results.find((r) => !r.ok && (r as any).missing) as { what: string } | undefined;
    return { kind: 'missing', what: miss?.what ?? 'no matching row' };
  }

  // match === 'all': any missing → missing; any fail → fail; else pass.
  const miss = results.find((r) => !r.ok && (r as any).missing) as { what: string } | undefined;
  if (miss) return { kind: 'missing', what: miss.what };
  const fail = results.find((r) => !r.ok) as { reason: string } | undefined;
  if (fail) return { kind: 'fail', reason: fail.reason };
  return { kind: 'pass' };
}
