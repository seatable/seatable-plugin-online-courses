/**
 * "Open-ended" grading against the per-row activity log — grades the METHOD, not
 * just the resulting cell state. Example: "an automation must fill Reviewer on a
 * document that needs review". We can't see automation CONFIG, but we can prove an
 * automation actually DID the write from the op-log.
 *
 * How an automation is identified (confirmed against a real base, 2026-07-02):
 * List Row Activities returns `activities[]`, each with `op_user` — a user email for
 * manual edits, `""` for some system writes, and the literal string "Automation Rule"
 * for automation-rule writes. Each activity's `detail.row_data[]` lists the changed
 * columns with their new `value` / `old_value`.
 *
 * Endpoint: GET {server}/api-gateway/api/v2/dtables/{base_uuid}/activities/?row_id=…
 * (base-token auth). It's PER-ROW, so we iterate the candidate rows — pruned by the
 * rule's `condition` first, so the REST calls stay few. ⚠️ This is a gateway REST
 * call, cross-origin on the localhost dev server (CORS) — it only works inside a real
 * base, exactly like the old authored-write path.
 */

import { AnyGradeRule, AutomationSetRule, grade, GradeRule, Outcome } from './grader';
import { cellLabel, getColumn, getTableByName } from './sdkRead';

// The op_user value SeaTable stamps on automation-rule writes.
const AUTOMATION_OP_USER = 'Automation Rule';
// Safety cap on the number of rows we hit the activity endpoint for.
const MAX_ROWS_SCANNED = 25;

function sdk(): any {
  return (window as any).dtableSDK;
}

// Base identity for the gateway call. The learner's session already holds a base
// token (dtableSDK.config.accessToken) — no minting needed.
function gatewayConfig(): { server: string; baseToken: string; baseUuid: string } {
  const cfg = sdk()?.config || {};
  return {
    server: String(cfg.server || '').replace(/\/+$/, ''),
    baseToken: String(cfg.accessToken || ''),
    baseUuid: String(cfg.dtableUuid || ''),
  };
}

/** List Row Activities for one row (newest first). */
async function fetchRowActivities(rowId: string): Promise<any[]> {
  const { server, baseToken, baseUuid } = gatewayConfig();
  if (!server || !baseToken || !baseUuid) {
    throw new Error('missing base token / uuid (only available inside the base)');
  }
  const url =
    `${server}/api-gateway/api/v2/dtables/${baseUuid}/activities/` +
    `?row_id=${encodeURIComponent(rowId)}&page=1&per_page=100`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${baseToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`activity log request failed (${resp.status})`);
  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data?.activities) ? data.activities : [];
}

function isEmptyValue(v: any): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Did an automation set `column` (to a non-empty value) on this row, in `tableName`?
function automationSetColumn(activities: any[], tableName: string, column: string): boolean {
  return activities.some((a) => {
    if (a?.op_user !== AUTOMATION_OP_USER) return false;
    if (a?.detail?.table_name !== tableName) return false;
    const cells: any[] = a?.detail?.row_data || [];
    return cells.some((c) => c?.column_name === column && !isEmptyValue(c?.value));
  });
}

function rowMeetsCondition(
  table: any,
  row: any,
  condition?: { column: string; equals: any }
): boolean {
  if (!condition) return true;
  const col = getColumn(table, condition.column);
  if (!col) return false;
  const label = cellLabel(col, row[col.key]);
  return String(label ?? '').toLowerCase() === String(condition.equals).toLowerCase();
}

/** Evaluate an automation-set rule against the live base + its activity log. */
export async function gradeAutomationSet(rule: AutomationSetRule): Promise<Outcome> {
  const table = getTableByName(rule.table_name);
  if (!table) return { kind: 'missing', what: `table "${rule.table_name}"` };
  if (!getColumn(table, rule.column)) {
    return { kind: 'missing', what: `column "${rule.column}" in "${rule.table_name}"` };
  }
  if (rule.condition && !getColumn(table, rule.condition.column)) {
    return { kind: 'missing', what: `column "${rule.condition.column}" in "${rule.table_name}"` };
  }

  const candidates: any[] = (table.rows || []).filter((r: any) =>
    rowMeetsCondition(table, r, rule.condition)
  );
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      reason: rule.condition
        ? `no ${rule.table_name} row has ${rule.condition.column} = ${rule.condition.equals}`
        : `there are no rows in ${rule.table_name}`,
    };
  }

  try {
    for (const row of candidates.slice(0, MAX_ROWS_SCANNED)) {
      const activities = await fetchRowActivities(row._id);
      if (automationSetColumn(activities, rule.table_name, rule.column)) {
        return { kind: 'pass' };
      }
    }
  } catch (err: any) {
    return { kind: 'fail', reason: err?.message || 'could not read the activity log' };
  }

  return {
    kind: 'fail',
    reason: `no automation has set ${rule.column} on a matching ${rule.table_name} row yet`,
  };
}

/**
 * Grade any manifest rule. Cell-match rules stay synchronous (SDK-only); the
 * automation-set rule is async (activity-log REST). One entry point so the runner
 * doesn't branch on rule type.
 */
export async function gradeStep(rule: AnyGradeRule): Promise<Outcome> {
  if ((rule as AutomationSetRule).kind === 'automation-set') {
    return gradeAutomationSet(rule as AutomationSetRule);
  }
  return grade(rule as GradeRule);
}
