import { CourseStep } from './courseContent';
import { getTables } from './sdkRead';

/**
 * What a course works on in the base, and what of it this base lacks — for the note
 * on the course's Introduction page (2026-11-10 test: a learner in the wrong base
 * only found out at the first action that failed).
 *
 * The list is DERIVED from the steps, never kept by hand: every table a step names
 * (`watchTable`, a grade's or a seed's `table_name`, a colleague write's `table`, an
 * automation's `trigger_table` / `target_table`…). Adding a step keeps the check right
 * on its own. Views are NOT checked: a step's `watchView` is optional by contract (an
 * older `.dtable` may predate it), so a missing one flagged the right base (2026-11-11).
 *
 * It warns, it never locks. And it only speaks on a positive answer: when the base's
 * tables cannot be read, there is nothing to report (null = no opinion).
 */
const TABLE_KEYS = new Set(['watchTable', 'table_name', 'table', 'trigger_table', 'target_table']);

export interface MissingPart {
  table: string;
}

function collectTables(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) node.forEach((n) => collectTables(n, out));
  else if (node && typeof node === 'object') {
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      if (TABLE_KEYS.has(key) && typeof value === 'string' && value) out.add(value);
      else collectTables(value, out);
    });
  }
}

export function missingBaseParts(steps: CourseStep[]): MissingPart[] {
  const tables = new Set<string>();
  collectTables(steps, tables);
  if (!tables.size) return [];

  let baseTables: any[];
  try {
    baseTables = getTables();
  } catch {
    return [];
  }
  if (!Array.isArray(baseTables) || !baseTables.length) return [];
  const names = new Set(baseTables.map((t: any) => t?.name));

  const missing: MissingPart[] = [];
  tables.forEach((table) => {
    if (!names.has(table)) missing.push({ table });
  });
  return missing;
}
