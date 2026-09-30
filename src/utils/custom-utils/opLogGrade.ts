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

import {
  AnyGradeRule,
  AutomationRuleRule,
  AutomationSetRule,
  grade,
  GradeRule,
  gradeRowsExist,
  Outcome,
  PluginUiRule,
  RowsExistRule,
} from './grader';
import { cellLabel, getColumn, getTableByName } from './sdkRead';
import { gradeAutomationRule } from './automationGrade';

// The op_user value SeaTable stamps on automation-rule writes.
const AUTOMATION_OP_USER = 'Automation Rule';
// Safety cap on the number of rows we hit the activity endpoint for.
const MAX_ROWS_SCANNED = 25;

function sdk(): any {
  return (window as any).dtableSDK;
}

// Base identity for the gateway call. No minting is needed — the session already holds
// a base token — but WHERE it lives depends on the environment, and reading only one of
// the two places is why this failed inside a real base:
//   - production: the host injects `window.dtable` ({ server, accessToken, dtableUuid }).
//     `dtableSDK.config` is not guaranteed to carry them there.
//   - development: the plugin self-initializes the SDK, so `dtableSDK.config` holds them
//     and `window.dtable` is absent.
// Same precedence as `fetchMetaData` in template-utils/utils.ts and as the audit path in
// performanceAuditTest4.ts, which is the one verified against a real base.
function gatewayConfig(): { server: string; baseToken: string; baseUuid: string } {
  const host = (window as any).dtable || {};
  const cfg = sdk()?.config || {};
  const pick = (key: string) => String(host[key] || cfg[key] || '');
  return {
    server: pick('server').replace(/\/+$/, ''),
    baseToken: pick('accessToken'),
    baseUuid: pick('dtableUuid'),
  };
}

/** List Row Activities for one row. ⚠️ Do NOT rely on the order — see rowWrittenByApp. */
async function fetchRowActivities(rowId: string): Promise<any[]> {
  const { server, baseToken, baseUuid } = gatewayConfig();
  if (!server || !baseToken || !baseUuid) {
    // Name what is actually absent: the old message blamed "not inside the base", which
    // sent us looking in the wrong place when the real cause was reading the identity
    // from `dtableSDK.config` alone.
    const missing = [
      !server && 'server',
      !baseToken && 'accessToken',
      !baseUuid && 'dtableUuid',
    ].filter(Boolean);
    throw new Error(
      `base identity incomplete: ${missing.join(', ')} not found on window.dtable or dtableSDK.config`
    );
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
export async function gradeAutomationSet(
  rule: AutomationSetRule,
  opts: { rowIds?: string[] } = {}
): Promise<Outcome> {
  const table = getTableByName(rule.table_name);
  if (!table) return { kind: 'missing', what: `table "${rule.table_name}"` };
  if (!getColumn(table, rule.column)) {
    return { kind: 'missing', what: `column "${rule.column}" in "${rule.table_name}"` };
  }
  if (rule.condition && !getColumn(table, rule.condition.column)) {
    return { kind: 'missing', what: `column "${rule.condition.column}" in "${rule.table_name}"` };
  }

  // Pinned rows win over the condition: when the plugin created the row itself, that
  // id IS the criterion — and, more to the point, a row it just created has no
  // history, so an "automation set this column" entry can only come from the run we
  // just asked for. Matching by condition would happily accept an assignment the
  // learner triggered earlier on some other row.
  const rows: any[] = table.rows || [];
  const candidates: any[] = opts.rowIds?.length
    ? rows.filter((r: any) => opts.rowIds!.includes(r._id))
    : rows.filter((r: any) => rowMeetsCondition(table, r, rule.condition));
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      reason: opts.rowIds?.length
        ? `the ${rule.table_name} row prepared for this exercise is gone`
        : rule.condition
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

// Op types that CREATE a row, as they may appear on an activity entry. Filtering on
// the type is the only order-independent way to single out the creation — reading
// "the last entry" was tried and was wrong (see below).
const CREATE_OP_TYPES = ['insert_row', 'insert_rows', 'append_rows', 'row_insert'];

function opTypeOf(a: any): string {
  return String(a?.op_type ?? a?.detail?.op_type ?? '');
}

/**
 * Did a TOKEN — an API call or a script — write this row?
 *
 * Judged on the CREATION entries when the activity log identifies them by `op_type`,
 * and on the row's whole history otherwise. Both paths ask the same question of an
 * entry: a token write leaves `op_user` EMPTY and names the app in `op_app`, while a
 * person's edit carries their account and an automation carries the literal
 * "Automation Rule".
 *
 * ⚠️ Never single out the creation BY POSITION. That was the first implementation —
 * "activities come newest first, so the creation is the last entry", trusting this
 * file's own fetch comment — and on a hand-made row it answered "created by an
 * automation": the last entry was the step-2 link write, i.e. the most RECENT change
 * (measured in a real base, 2026-08-27).
 *
 * Why the fallback still matters: if creation is not logged (or carries a type we do
 * not recognise), asking "did anything here come from a token?" is the robust
 * question. It has one blind spot in this course — a line typed by hand and then sent
 * through step 3's `Validate` script would carry a token write — which is exactly why
 * the typed path is preferred whenever it is available.
 */
function rowWrittenByApp(activities: any[]): { ok: boolean } {
  const created = activities.filter((a) => CREATE_OP_TYPES.includes(opTypeOf(a)));
  const judged = created.length ? created : activities;
  return { ok: judged.some((a) => String(a?.op_user ?? '').trim() === '') };
}

/**
 * A rows-exist rule that also asks WHERE the row came from. The synchronous part
 * (the rows are there, and their links are filled) runs first and unchanged; only
 * `written_by_app` adds the activity-log read.
 */
export async function gradeRowsExistWritten(rule: RowsExistRule): Promise<Outcome> {
  const base = gradeRowsExist(rule);
  if (base.kind !== 'pass' || !rule.written_by_app) return base;

  const table = getTableByName(rule.table_name);
  const column = table ? getColumn(table, rule.where.column) : null;
  if (!table || !column) return base; // already proven present by gradeRowsExist
  const wanted = String(rule.where.equals);
  const candidates: any[] = (table.rows || []).filter(
    (r: any) => cellLabel(column, r[column.key]) === wanted
  );

  try {
    for (const row of candidates.slice(0, MAX_ROWS_SCANNED)) {
      if (rowWrittenByApp(await fetchRowActivities(row._id)).ok) return { kind: 'pass' };
    }
  } catch (err: any) {
    return { kind: 'fail', reason: err?.message || 'could not read the activity log' };
  }

  const noun = rule.noun ?? 'row';
  return { kind: 'fail', reason: `the ${noun} is there, but it did not come in through the API` };
}

// "Dirty" UI-state check for the Welcome tour: is the plugin shrunk to the floating
// toolbar AND parked in the lower-right quadrant of the screen? Reads the plugin
// window DOM directly — setPluginFloating (app.tsx) sets the host to
// pointer-events:none while floating, and the toolbar is the host's first child. No
// base data, so it works in any base the tour is opened from.
function gradePluginUi(rule: PluginUiRule): Outcome {
  const host = document.querySelector('#plugin-wrapper') as HTMLElement | null;
  const modal = host?.firstElementChild as HTMLElement | null;
  if (!host || !modal) return { kind: 'fail', reason: 'could not read the plugin window' };
  // Set by ResizableWrapper when the learner lets go of the resize handle.
  if (rule.check === 'banner-resized') {
    if (host.dataset.userResized === '1') return { kind: 'pass' };
    return {
      kind: 'fail',
      reason: 'drag the grip at the top center of the panel up or down first',
    };
  }
  const floating = host.style.pointerEvents === 'none';
  if (!floating) {
    return {
      kind: 'fail',
      reason: 'shrink the plugin to the toolbar first (the shrink icon, top-right)',
    };
  }
  if (rule.check === 'toolbar-lower-right') {
    const r = modal.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx > window.innerWidth / 2 && cy > window.innerHeight / 2) return { kind: 'pass' };
    return { kind: 'fail', reason: 'drag the toolbar into the lower-right quarter of the screen' };
  }
  return { kind: 'fail', reason: 'unknown plugin-ui check' };
}

/**
 * Grade any manifest rule. Cell-match and plugin-UI rules stay synchronous; the
 * automation rules are async (activity-log / config REST). One entry point so the
 * runner doesn't branch on rule type.
 */
export async function gradeStep(
  rule: AnyGradeRule,
  opts: { rowIds?: string[] } = {}
): Promise<Outcome> {
  if ((rule as PluginUiRule).kind === 'plugin-ui') {
    return gradePluginUi(rule as PluginUiRule);
  }
  if ((rule as AutomationSetRule).kind === 'automation-set') {
    return gradeAutomationSet(rule as AutomationSetRule, opts);
  }
  if ((rule as AutomationRuleRule).kind === 'automation-rule') {
    return gradeAutomationRule(rule as AutomationRuleRule);
  }
  if ((rule as RowsExistRule).kind === 'rows-exist') {
    return gradeRowsExistWritten(rule as RowsExistRule);
  }
  return grade(rule as GradeRule);
}
