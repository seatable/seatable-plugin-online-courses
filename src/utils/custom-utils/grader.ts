/**
 * Declarative grading engine (strategy "b").
 *
 * Grade rules live in the course MANIFEST (authored in Hugo), not in plugin code,
 * so adding or editing an exercise NEVER needs a plugin release — important with
 * one plugin serving all seven courses and self-hosted installs updating manually.
 *
 * A rule reuses the API-Gateway Update-Row payload shape: it lists, for a table,
 * the rows that must hold given cell values. The SAME `{ row_id, row: { Col: val } }`
 * objects that seed/write a row (see learnerWrite.ts / writeCell) also ASSERT it —
 * a course author can copy a seeding payload and turn it into the answer key.
 *
 * `row_id` is the base `_id`. Each course ships as a fixed imported base, so the
 * ids are stable across every learner — referencing them directly is safe.
 *
 * Cells are compared on DISPLAY values (single-select labels resolved), matching
 * how the Update-Row endpoint takes values. Reads only — no writing, no API calls.
 */

import { cellLabel, getColumn, getTableByName } from './sdkRead';
import { linkStatus } from './watchAutomation';
import { t } from '../../locale/t';

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
  kind?: 'cells';
  table_name: string;
  expected: ExpectedRow[];
  /** 'all' (default): every expected row must match. 'any': at least one must. */
  match?: 'all' | 'any';
}

/**
 * "Open-ended" rule: pass if an AUTOMATION set `column` (to a non-empty value) on a
 * row of `table_name` — optionally only on rows meeting `condition`. Grades the
 * METHOD (was it done by an automation?), not just the resulting cell state. Checked
 * against the per-row activity log (see opLogGrade.ts) — needs a REST call, so it's
 * async and only works inside a real base (cross-origin in dev).
 */
export interface AutomationSetRule {
  kind: 'automation-set';
  table_name: string;
  column: string;
  /** Only rows where this column equals this display value are checked. */
  condition?: { column: string; equals: any };
}

/**
 * "Automation-structure" rule: pass if an automation rule with a given SHAPE
 * exists in the base — a `rows_added` trigger on `trigger_table`, optional
 * not-empty guard conditions, and one *Add links* action per `link_actions`
 * entry. Unlike AutomationSetRule (which proves an automation RAN, from the
 * op-log), this reads the automation CONFIG via the account REST API and grades
 * how it was BUILT — used by Course 4 Step 2 to check the learner's first
 * automation before any data has flowed through it. See automationGrade.ts.
 *
 * Column/table NAMES are resolved to the live base's ids/keys at grade time, so
 * the rule stays declarative in the manifest. Link actions are matched by their
 * CONFIG (source column → target table/column), never by position, so a learner
 * who added the two actions in either order still passes.
 */
export interface AutomationRuleRule {
  kind: 'automation-rule';
  /** Table the `rows_added` trigger must fire on, e.g. 'Line items'. */
  trigger_table: string;
  /** Currently only the new-row trigger is checked. */
  trigger_event?: 'rows_added';
  /** Guard conditions on the trigger (all resolved by column NAME). */
  conditions?: { column: string; predicate: 'is_not_empty' | 'is_empty' }[];
  /** How the guard conditions combine. Default 'And'. */
  conjunction?: 'And' | 'Or';
  /** One expected *Add links* action per entry. */
  link_actions?: {
    /** Column in `trigger_table` whose value is matched, e.g. 'Product reference'. */
    source_column: string;
    /** Table searched for a match, e.g. 'Products'. */
    target_table: string;
    /** Column in `target_table` compared against, e.g. 'Reference'. */
    target_column: string;
  }[];
}

/**
 * "Rows exist" rule: pass when at least `min_count` rows of `table_name` carry
 * `where.equals` in `where.column`. Used by Course 4 Step 4, where the rows being
 * graded did not exist when the manifest was written — the learner (or rather the
 * AI chain they built) creates them — so there is no row id to assert against.
 *
 * Deliberately counts and nothing more. The lines it looks for are the output of an
 * AI extraction, and grading their CONTENT would make the model's success a
 * condition of progress; the plugin's safety net writes the same rows when the
 * extraction misfires, and both paths must pass equally.
 */
export interface RowsExistRule {
  kind: 'rows-exist';
  table_name: string;
  /** The cell that identifies the rows, by display value. */
  where: { column: string; equals: any };
  /** How many must be there. Default 1. */
  min_count?: number;
  /** Names the rows in the failure message, e.g. "delivery lines". */
  noun?: string;
  /**
   * LINK columns that must be filled on a matching row for it to count. Used by
   * Course 4 Step 7: a line pushed through the API is only interesting once the
   * learner's own step-2 automation has attached it, so the grade asks for the
   * links rather than for the row alone.
   *
   * ⚠️ Checked through `linkStatus`, NEVER by reading the cell: a link value is not
   * on the row at all (see the warning over linkStatus in watchAutomation.ts). This
   * option was first written as a generic "non-empty columns" test against
   * `row[column.key]`, which reports every link as empty and fails a learner whose
   * base plainly shows the links.
   */
  linked_columns?: string[];
  /**
   * Require that the row was WRITTEN BY A TOKEN — an API call or a script — and not
   * typed into the grid by hand. Course 4 Step 7 needs this: the whole point of the
   * step is that an outside system wrote the line, and without it the exercise passes
   * for a learner who simply typed the row (the user hit exactly that).
   *
   * Grades the METHOD rather than the cell, like the automation-set rule. Passes when
   * ANY activity on the row carries a token's signature — `op_user` empty, the app
   * named in `op_app` — since a person's edit carries their account and an automation
   * carries the literal "Automation Rule". Order-independent on purpose: the activity
   * list is not ordered as this file once assumed. Async — see gradeRowsExistWritten.
   */
  written_by_app?: boolean;
}

/**
 * "Dirty" plugin-UI-state check, used ONLY by the Welcome tour. It grades the state
 * of the PLUGIN itself (is it shrunk to the toolbar, and where is the toolbar?) with
 * no base data involved — so it works from any base the tour is opened in. Graded by
 * reading the plugin window's own DOM; see gradePluginUi in opLogGrade.ts.
 */
export interface PluginUiRule {
  kind: 'plugin-ui';
  check: 'toolbar-lower-right' | 'banner-resized';
}

/** Any grade rule a manifest step can carry. */
export type AnyGradeRule =
  | GradeRule
  | AutomationSetRule
  | AutomationRuleRule
  | RowsExistRule
  | PluginUiRule;

type RowResult =
  | { ok: true }
  | { ok: false; missing: true; what: string }
  | { ok: false; missing: false; reason: string };

// Check one expected row against the live base. Missing table/column/row is
// surfaced as `missing` (base doesn't match the exercise); a present-but-wrong
// cell is a `fail` (the learner hasn't done it yet).
function gradeRow(table: any, exp: ExpectedRow): RowResult {
  const row = (table.rows || []).find((r: any) => r._id === exp.row_id);
  if (!row)
    return {
      ok: false,
      missing: true,
      what: t('grade.what.row', { row: exp.row_id, table: table.name }),
    };

  for (const [colName, expectedRaw] of Object.entries(exp.row)) {
    const col = getColumn(table, colName);
    if (!col)
      return {
        ok: false,
        missing: true,
        what: t('grade.what.column', { column: colName, table: table.name }),
      };

    // Checkbox: compare as booleans (unchecked can be false, '' or absent, so a
    // label comparison won't do). Expected `true`/`'true'` = checked, else unchecked.
    if (col.type === 'checkbox') {
      const actualBool = row[col.key] === true;
      const expectedBool = expectedRaw === true || expectedRaw === 'true';
      if (actualBool !== expectedBool) {
        return {
          ok: false,
          missing: false,
          reason: t('grade.checkbox_mismatch', {
            table: table.name,
            column: colName,
            actual: actualBool ? t('grade.checked') : t('grade.unchecked'),
            expected: expectedBool ? t('grade.checked') : t('grade.unchecked'),
          }),
        };
      }
      continue;
    }

    const actual = cellLabel(col, row[col.key]);
    const expected = expectedRaw === null || expectedRaw === undefined ? null : String(expectedRaw);
    if (actual !== expected) {
      return {
        ok: false,
        missing: false,
        reason: t('grade.value_mismatch', {
          table: table.name,
          column: colName,
          actual: actual ?? t('grade.empty'),
          expected: expected ?? t('grade.empty'),
        }),
      };
    }
  }
  return { ok: true };
}

/** Evaluate a grade rule against the current base state. */
export function grade(rule: GradeRule): Outcome {
  const table = getTableByName(rule.table_name);
  if (!table) return { kind: 'missing', what: t('grade.what.table', { table: rule.table_name }) };
  if (!rule.expected?.length) return { kind: 'missing', what: 'grade rule has no expected rows' };

  const results = rule.expected.map((exp) => gradeRow(table, exp));

  if ((rule.match ?? 'all') === 'any') {
    if (results.some((r) => r.ok)) return { kind: 'pass' };
    // none passed: prefer a concrete fail reason over a "missing" one
    const failed = results.find((r) => !r.ok && !r.missing) as { reason: string } | undefined;
    if (failed) return { kind: 'fail', reason: failed.reason };
    const miss = results.find((r) => !r.ok && (r as any).missing) as { what: string } | undefined;
    return { kind: 'missing', what: miss?.what ?? t('grade.no_matching_row') };
  }

  // match === 'all': any missing → missing; any fail → fail; else pass.
  const miss = results.find((r) => !r.ok && (r as any).missing) as { what: string } | undefined;
  if (miss) return { kind: 'missing', what: miss.what };
  const fail = results.find((r) => !r.ok) as { reason: string } | undefined;
  if (fail) return { kind: 'fail', reason: fail.reason };
  return { kind: 'pass' };
}

/** Count the rows matching a `rows-exist` rule against the current base state. */
export function gradeRowsExist(rule: RowsExistRule): Outcome {
  const table = getTableByName(rule.table_name);
  if (!table) return { kind: 'missing', what: t('grade.what.table', { table: rule.table_name }) };
  const column = getColumn(table, rule.where.column);
  if (!column) {
    return {
      kind: 'missing',
      what: t('grade.what.column', { column: rule.where.column, table: rule.table_name }),
    };
  }

  const wanted = String(rule.where.equals);
  const matching = (table.rows || []).filter(
    (r: any) => cellLabel(column, r[column.key]) === wanted
  );
  const min = rule.min_count ?? 1;
  const noun = rule.noun ?? t('grade.rows_noun', { column: rule.where.column, value: wanted });

  const wantLinks = rule.linked_columns ?? [];
  if (!wantLinks.length) {
    if (matching.length >= min) return { kind: 'pass' };
    return {
      kind: 'fail',
      reason: t(matching.length === 0 ? 'grade.rows.none' : 'grade.rows.only', {
        count: matching.length,
        noun,
        table: rule.table_name,
        min,
      }),
    };
  }

  // Links live in the store, not on the row — linkStatus is the only correct read.
  const progress = linkStatus(
    rule.table_name,
    matching.map((r: any) => r._id),
    wantLinks
  );
  const found = progress.total - progress.pending;
  if (found >= min) return { kind: 'pass' };

  // The row being there but unlinked is a different problem from it being absent,
  // and it is the one the learner can act on — so say which it is.
  if (matching.length >= min) {
    return {
      kind: 'fail',
      reason: t('grade.rows.not_linked', {
        count: matching.length,
        noun,
        table: rule.table_name,
        columns: progress.missing.map((n) => `"${n}"`).join(t('course.list_and')),
      }),
    };
  }
  return {
    kind: 'fail',
    reason: t(matching.length === 0 ? 'grade.rows.none' : 'grade.rows.only', {
      count: matching.length,
      noun,
      table: rule.table_name,
      min,
    }),
  };
}
