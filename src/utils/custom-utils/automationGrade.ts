/**
 * Grade an automation by its STRUCTURE (config), not by its data effect.
 *
 * The dtable SDK has no automation support, so this is the one place we reach for
 * the account REST API instead of the SDK: List Automation Rules
 *   GET /api/v2.1/workspace/{workspace_id}/dtable/{base_name}/automation-rules/
 * returns `dtable_automation_rule_list[]`, each rule carrying its `trigger`
 * (table_id, condition, filters[], filter_conjunction) and `actions[]` — enough to
 * verify a learner's rule was BUILT correctly before any row has flowed through it.
 *
 * Auth: this is an /api/v2.1/workspace/… account endpoint (the same family the web
 * UI's own automation panel calls), so a same-origin GET authenticates with the
 * learner's SESSION cookie — no account token to enter, consistent with "the plugin
 * runs as the learner". ⚠️ Cross-origin on the localhost dev server (CORS), so — like
 * opLogGrade — it only works INSIDE a real base. GET needs no CSRF token.
 *
 * Column/table NAMES in the rule are resolved to the live base's ids/keys here, so
 * the manifest rule stays declarative. Link actions are matched by CONFIG (source
 * column → target table/column), never by position, so the two link actions may be
 * added in either order — required because a "check only" learner never followed the
 * guided order (see the Course 4 Step 2 brief).
 */

import { AutomationRuleRule, Outcome } from './grader';
import { getColumn, getTableByName } from './sdkRead';

// SeaTable stamps automation-rule link actions with this action type.
const LINK_ACTION_TYPE = 'link_records';
// The trigger condition for "a new row is added".
const ROWS_ADDED = 'rows_added';

/** Which slice of the automation to check — drives the guided stepper. */
export type AutomationStage = 'created' | 'trigger' | `action:${number}` | 'all';

function sdk(): any {
  return (window as any).dtableSDK;
}

// Resolve the account-API identity of the current base. Prod exposes it on
// window.dtable (fileName is the base NAME the api/v2.1 URL wants — dtableName is
// empty in prod, so we fall back across both surfaces, same as the old authored
// -write getConfig fix).
function accountApiConfig(): { server: string; workspaceId: string; baseName: string } {
  const cfg = sdk()?.config || {};
  const win = (window as any).dtable || {};
  return {
    server: String(cfg.server || win.server || '').replace(/\/+$/, ''),
    workspaceId: String(
      win.workspaceID || cfg.workspaceID || win.workspace_id || cfg.workspace_id || ''
    ),
    baseName: String(cfg.dtableName || cfg.fileName || win.dtableName || win.fileName || ''),
  };
}

/** List every automation rule in the base (session-cookie auth, prod-only). */
async function fetchAutomationRules(): Promise<any[]> {
  const { server, workspaceId, baseName } = accountApiConfig();
  if (!server || !workspaceId || !baseName) {
    throw new Error('missing base identity (only available inside the base)');
  }
  const url =
    `${server}/api/v2.1/workspace/${encodeURIComponent(workspaceId)}` +
    `/dtable/${encodeURIComponent(baseName)}/automation-rules/`;
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`automation-rules request failed (${resp.status})`);
  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data?.dtable_automation_rule_list) ? data.dtable_automation_rule_list : [];
}

// --- structural checks over one rule ----------------------------------------
// Each returns true/false against ids/keys already resolved from the live base.

interface ResolvedRule {
  triggerTableId: string;
  triggerEvent: string;
  conditions: { key: string; predicate: string }[];
  conjunction: string;
  linkActions: { sourceKey: string; targetTableId: string; targetKey: string }[];
}

// Resolve the manifest rule's NAMES to the current base's ids/keys. Returns a
// `missing` outcome (base doesn't match the exercise) if any name can't be found.
function resolveRule(rule: AutomationRuleRule): ResolvedRule | { missing: string } {
  const triggerTable = getTableByName(rule.trigger_table);
  if (!triggerTable) return { missing: `table "${rule.trigger_table}"` };

  const conditions: ResolvedRule['conditions'] = [];
  for (const c of rule.conditions || []) {
    const col = getColumn(triggerTable, c.column);
    if (!col) return { missing: `column "${c.column}" in "${rule.trigger_table}"` };
    conditions.push({ key: col.key, predicate: c.predicate });
  }

  const linkActions: ResolvedRule['linkActions'] = [];
  for (const la of rule.link_actions || []) {
    const sourceCol = getColumn(triggerTable, la.source_column);
    if (!sourceCol) return { missing: `column "${la.source_column}" in "${rule.trigger_table}"` };
    const targetTable = getTableByName(la.target_table);
    if (!targetTable) return { missing: `table "${la.target_table}"` };
    const targetCol = getColumn(targetTable, la.target_column);
    if (!targetCol) return { missing: `column "${la.target_column}" in "${la.target_table}"` };
    linkActions.push({
      sourceKey: sourceCol.key,
      targetTableId: targetTable._id,
      targetKey: targetCol.key,
    });
  }

  return {
    triggerTableId: triggerTable._id,
    triggerEvent: rule.trigger_event || ROWS_ADDED,
    conditions,
    conjunction: rule.conjunction || 'And',
    linkActions,
  };
}

/** Rule fires on the right table with the right event (e.g. new row added). */
function hasTrigger(rule: any, r: ResolvedRule): boolean {
  return (
    rule?.trigger?.table_id === r.triggerTableId && rule?.trigger?.condition === r.triggerEvent
  );
}

/** Every guard condition (not-empty on the ref columns) is present, combined right. */
function hasConditions(rule: any, r: ResolvedRule): boolean {
  const filters: any[] = rule?.trigger?.filters || [];
  const all = r.conditions.every((c) =>
    filters.some((f) => f?.column_key === c.key && f?.filter_predicate === c.predicate)
  );
  if (!all) return false;
  // Only enforce the conjunction when it actually matters (2+ conditions).
  if (r.conditions.length >= 2) {
    return (rule?.trigger?.filter_conjunction || 'And') === r.conjunction;
  }
  return true;
}

/** An *Add links* action linking `source → target` exists (either match orientation). */
function hasLinkAction(rule: any, la: ResolvedRule['linkActions'][number]): boolean {
  const actions: any[] = rule?.actions || [];
  return actions.some((a) => {
    if (a?.type !== LINK_ACTION_TYPE) return false;
    if (a?.linked_table_id !== la.targetTableId) return false;
    const matches: any[] = a?.match_conditions || [];
    // Accept either orientation of column_key/other_column_key — the API's
    // convention (source in the current table, target in the linked table) vs the
    // reverse — so grading doesn't hinge on which side SeaTable stores where.
    return matches.some(
      (m) =>
        (m?.column_key === la.sourceKey && m?.other_column_key === la.targetKey) ||
        (m?.column_key === la.targetKey && m?.other_column_key === la.sourceKey)
    );
  });
}

// Does this rule fully satisfy the whole spec (order-independent on actions)?
function ruleIsComplete(rule: any, r: ResolvedRule): boolean {
  return (
    hasTrigger(rule, r) &&
    hasConditions(rule, r) &&
    r.linkActions.every((la) => hasLinkAction(rule, la))
  );
}

/**
 * Grade the learner's automation, optionally only a `stage` of it (for the guided
 * stepper). Reads the automation config over REST (async, prod-only). The final
 * grade ('all') requires ONE rule to satisfy the whole spec; per-stage checks are
 * lenient (any candidate rule on the trigger table that has the stage's piece).
 */
export async function gradeAutomationRule(
  rule: AutomationRuleRule,
  stage: AutomationStage = 'all'
): Promise<Outcome> {
  const resolved = resolveRule(rule);
  if ('missing' in resolved) return { kind: 'missing', what: resolved.missing };

  let rules: any[];
  try {
    rules = await fetchAutomationRules();
  } catch (err: any) {
    return { kind: 'fail', reason: err?.message || 'could not read the automations' };
  }

  // 'created' — the learner has just ADDED and named a rule; nothing else is
  // configured yet (no trigger table, no actions), so the trigger table isn't
  // "Line items" at this point (that's the next stage). Detect ANY automation rule,
  // not one already triggering on the target table — otherwise this stage can never
  // pass. (Assumes this is the base's first automation, per "build your first
  // automation"; a freshly created rule must be SAVED to appear over the API.)
  if (stage === 'created') {
    return rules.length > 0
      ? { kind: 'pass' }
      : { kind: 'fail', reason: 'no automation rule yet — add one, name it, and save it' };
  }

  // Later stages need a rule that at least triggers on the right table.
  const candidates = rules.filter((rl) => rl?.trigger?.table_id === resolved.triggerTableId);
  if (candidates.length === 0) {
    return { kind: 'fail', reason: `no automation on "${rule.trigger_table}" yet` };
  }

  if (stage === 'trigger') {
    if (candidates.some((rl) => hasTrigger(rl, resolved) && hasConditions(rl, resolved))) {
      return { kind: 'pass' };
    }
    // Distinguish a wrong trigger from missing conditions for a helpful message.
    if (!candidates.some((rl) => hasTrigger(rl, resolved))) {
      return { kind: 'fail', reason: 'the trigger isn’t “when a new row is added”' };
    }
    return {
      kind: 'fail',
      reason: 'add both conditions — Product reference and Document reference are not empty',
    };
  }

  if (stage.startsWith('action:')) {
    const i = Number(stage.slice('action:'.length));
    const la = resolved.linkActions[i];
    if (!la) return { kind: 'fail', reason: `no link action #${i} defined in the exercise` };
    if (candidates.some((rl) => hasLinkAction(rl, la))) return { kind: 'pass' };
    const src = rule.link_actions?.[i];
    return {
      kind: 'fail',
      reason: src
        ? `add the “Add links” action linking ${src.source_column} to ${src.target_table}`
        : 'the link action is missing',
    };
  }

  // stage === 'all': one rule must satisfy everything (order-independent).
  if (candidates.some((rl) => ruleIsComplete(rl, resolved))) return { kind: 'pass' };

  // Report the first missing piece against the best-matching candidate.
  const best =
    candidates.find((rl) => hasTrigger(rl, resolved) && hasConditions(rl, resolved)) ||
    candidates.find((rl) => hasTrigger(rl, resolved)) ||
    candidates[0];
  if (!hasTrigger(best, resolved)) {
    return { kind: 'fail', reason: 'the trigger isn’t “when a new row is added”' };
  }
  if (!hasConditions(best, resolved)) {
    return {
      kind: 'fail',
      reason: 'both not-empty conditions (Product reference and Document reference) are required',
    };
  }
  const missingLink = resolved.linkActions.findIndex((la) => !hasLinkAction(best, la));
  const src = rule.link_actions?.[missingLink];
  return {
    kind: 'fail',
    reason: src
      ? `the “Add links” action for ${src.source_column} → ${src.target_table} is missing`
      : 'a link action is missing',
  };
}
