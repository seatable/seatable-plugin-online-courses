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
 * runs as the learner". GET needs no CSRF token. On the localhost DEV server the
 * cookie can't travel (different origin), so an account token from setting.local.js
 * is used instead — see devAccountToken below.
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

/**
 * DEV ONLY — an account token for the call below.
 *
 * Inside a real base the endpoint authenticates with the learner's SESSION cookie:
 * same origin, nothing to configure. The dev server is a DIFFERENT origin, so that
 * cookie is never sent, and asking for it (`credentials: 'include'`) makes the
 * browser reject the response outright — the opaque "NetworkError when attempting to
 * fetch resource" — unless the server also returns Access-Control-Allow-Credentials.
 * There is no base-token flavour of this endpoint (the OpenAPI spec marks it
 * AccountTokenAuth), so dev needs a real ACCOUNT token: either `accountToken` in
 * setting.local.js, or `username`/`password`, exchanged once for one.
 */
let devTokenPromise: Promise<string> | null = null;

/** The dev harness's config — set by setting.ts, which only the dev entry loads. */
function devConfig(): any {
  return (window as any).dtablePluginConfig || null;
}

async function devAccountToken(): Promise<string> {
  const cfg = devConfig();
  if (!cfg) return '';
  if (cfg.accountToken) return String(cfg.accountToken);
  if (!cfg.username || !cfg.password) return '';
  if (!devTokenPromise) {
    const server = String(cfg.server || '').replace(/\/+$/, '');
    devTokenPromise = fetch(`${server}/api2/auth-token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`auth-token failed (${r.status})`))))
      .then((d: any) => String(d?.token || ''))
      .catch((err) => {
        devTokenPromise = null; // let the next attempt retry
        throw err;
      });
  }
  return devTokenPromise;
}

/** List every automation rule in the base (session cookie in a base, token in dev). */
async function fetchAutomationRules(): Promise<any[]> {
  const { server, workspaceId, baseName } = accountApiConfig();
  if (!server || !workspaceId || !baseName) {
    throw new Error('missing base identity (only available inside the base)');
  }
  const url =
    `${server}/api/v2.1/workspace/${encodeURIComponent(workspaceId)}` +
    `/dtable/${encodeURIComponent(baseName)}/automation-rules/`;
  const token = await devAccountToken().catch(() => '');
  let resp: Response;
  try {
    resp = await fetch(url, {
      // With a token we authenticate by header, and must NOT ask for cookies: a
      // credentialed cross-origin request also needs Access-Control-Allow-Credentials.
      credentials: token ? 'omit' : 'include',
      headers: token
        ? { Accept: 'application/json', Authorization: `Token ${token}` }
        : { Accept: 'application/json' },
    });
  } catch (err: any) {
    if (devConfig() && !token) {
      throw new Error(
        'checking automations from the dev server needs an account token — add ' +
          '`accountToken` (or `username` + `password`) to src/setting.local.js'
      );
    }
    throw err;
  }
  if (!resp.ok) throw new Error(`automation-rules request failed (${resp.status})`);
  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data?.dtable_automation_rule_list) ? data.dtable_automation_rule_list : [];
}

/**
 * The ids of every automation rule currently in the base. Taken as a BASELINE right
 * before a guided build starts, so the "created" stage can require a rule the
 * learner has actually just added rather than accepting one that was already there
 * (a base is rarely pristine — a previous run of the course leaves its rule behind).
 * Best-effort: the caller falls back to no baseline if this throws.
 */
export async function listAutomationRuleIds(): Promise<string[]> {
  const rules = await fetchAutomationRules();
  return rules.map((rl) => String(rl?.id ?? '')).filter(Boolean);
}

/** How a guided build pins its checks to ONE rule across stages. */
export interface GuidedRuleTracking {
  /** Rule ids that existed before the build started — never accepted as "created". */
  ignoreRuleIds?: string[];
  /** Once identified, every later stage is checked against THIS rule only. */
  pinRuleId?: string | null;
  /** Reports the rule the "created" stage settled on, so it can be pinned. */
  onRuleIdentified?: (ruleId: string) => void;
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
  stage: AutomationStage = 'all',
  guided: GuidedRuleTracking = {}
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
  // configured yet (no trigger table, no actions), so we can't recognise it by its
  // trigger (that's the next stage). We recognise it by being NEW: any rule absent
  // from the baseline taken when the guided build started. Without that baseline
  // this stage would accept a rule the base already had — including the complete
  // one left behind by a previous run, which then also satisfies every later stage.
  // (A freshly created rule must be SAVED to appear over the API.)
  if (stage === 'created') {
    const ignore = new Set(guided.ignoreRuleIds || []);
    const fresh = rules.filter((rl) => !ignore.has(String(rl?.id ?? '')));
    if (fresh.length === 0) {
      return {
        kind: 'fail',
        reason: ignore.size
          ? 'no NEW automation rule yet — add one, name it, and save it'
          : 'no automation rule yet — add one, name it, and save it',
      };
    }
    // Pin the most recently created one (highest id) so every later stage checks
    // the rule the learner is actually building, not a lookalike elsewhere.
    const picked = fresh.reduce((a, b) => (Number(b?.id) > Number(a?.id) ? b : a));
    guided.onRuleIdentified?.(String(picked.id));
    return { kind: 'pass' };
  }

  // Later stages check the pinned rule when the guided build identified one; only a
  // free-standing check ("I built it — just check it") looks at every rule.
  const pinned = guided.pinRuleId
    ? rules.filter((rl) => String(rl?.id ?? '') === String(guided.pinRuleId))
    : rules;
  if (guided.pinRuleId && pinned.length === 0) {
    return { kind: 'fail', reason: 'the rule you created is gone — create it again' };
  }

  // Later stages need a rule that at least triggers on the right table.
  const candidates = pinned.filter((rl) => rl?.trigger?.table_id === resolved.triggerTableId);
  if (candidates.length === 0) {
    return {
      kind: 'fail',
      reason: guided.pinRuleId
        ? `your rule doesn’t trigger on "${rule.trigger_table}" yet`
        : `no automation on "${rule.trigger_table}" yet`,
    };
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
