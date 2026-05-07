import React from 'react';
import intl from 'react-intl-universal';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import {
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
} from '../../../utils/custom-utils/performanceAuditRunner';
import {
  PerformanceCandidateColumn,
  RemediatedColumnHide,
} from '../../../utils/custom-interfaces/AuditTypes';
import ChainGraph from './ChainGraph';

interface CandidateExpansionProps {
  candidate: PerformanceCandidateColumn;
  liveValue: any;
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  stagedHides: Map<string, RemediatedColumnHide>;
  costByKey: Map<string, number>;
  visibleRowsByKey: Map<string, number>;
  totalViewLoadMs: number;
}

/**
 * Single chevron-driven expansion for a candidate column row, shared by
 * Overview's Performance candidates table and TableTab's Columns table.
 *
 * Renders two stacked sections:
 *   1. Chain graph (when the candidate has a chain).
 *   2. Per-view drill — every view that displays this column in base, with a
 *      slider toggling hide-in-view. Slider state factors viewEdits if set,
 *      otherwise (base ∪ stagedHides_for_view), so freshly-staged hides
 *      mirror across surfaces and the candidate drill stays in sync with
 *      the per-view slider expansion.
 *
 * Returns null when neither section has content, so callers can detect
 * "nothing to expand" and suppress the chevron.
 */
const CandidateExpansion: React.FC<CandidateExpansionProps> = ({
  candidate: c,
  liveValue,
  viewEdits,
  onSetViewEdit,
  stagedHides,
  costByKey,
  visibleRowsByKey,
  totalViewLoadMs,
}) => {
  const hasChain = !!c.chain && c.chain.length > 0;
  const stagedViewIdsForCol = (() => {
    const entry = stagedHides.get(`${c.tableId}:${c.columnKey}`);
    if (!entry) return new Set<string>();
    return new Set(entry.views.map((v) => v.viewId));
  })();

  const drillRows = (() => {
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    if (!t) return [] as Array<{
      viewId: string;
      viewName: string;
      ruleKinds: string[];
      costSavedPct: number;
      isHidden: boolean;
    }>;
    const tableRows = (t.rows || []).length;
    const colTotal = costByKey.get(`${c.tableId}:${c.columnKey}`) || 0;
    const perCell = tableRows > 0 ? colTotal / tableRows : 0;
    const out: Array<{
      viewId: string;
      viewName: string;
      ruleKinds: string[];
      costSavedPct: number;
      isHidden: boolean;
    }> = [];
    for (const v of t.views || []) {
      const baseHidden = new Set<string>(v.hidden_columns || []);
      if (baseHidden.has(c.columnKey)) continue;
      const edits = viewEdits.get(v._id);
      const isHidden = edits
        ? edits.has(c.columnKey)
        : stagedViewIdsForCol.has(v._id);
      const ruleKinds = getColumnRuleKindsInView(v, c.columnKey);
      const isReferenced = ruleKinds.length > 0;
      const visibleRows = visibleRowsByKey.get(`${c.tableId}:${v._id}`) ?? 0;
      const contribution = perCell * visibleRows;
      const costSavedPct =
        isReferenced || totalViewLoadMs <= 0
          ? 0
          : (contribution / totalViewLoadMs) * 100;
      out.push({
        viewId: v._id,
        viewName: v.name,
        ruleKinds,
        costSavedPct,
        isHidden,
      });
    }
    out.sort((a, b) => b.costSavedPct - a.costSavedPct);
    return out;
  })();
  const hasDrill = drillRows.length > 0;
  if (!hasChain && !hasDrill) return null;

  const handleToggle = (viewId: string) => {
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    const v = t?.views?.find((vv: any) => vv._id === viewId);
    const baseHidden = new Set<string>(v?.hidden_columns || []);
    // Merge in committed staged-hides for this view (any column in the table).
    const stagedForView = new Set<string>(baseHidden);
    stagedHides.forEach((h) => {
      if (h.tableId !== c.tableId) return;
      if (h.views.some((vv) => vv.viewId === viewId)) stagedForView.add(h.columnKey);
    });
    const current = new Set(viewEdits.get(viewId) ?? stagedForView);
    if (current.has(c.columnKey)) current.delete(c.columnKey);
    else current.add(c.columnKey);
    onSetViewEdit(viewId, current);
  };

  return (
    <>
      {hasChain && (
        <div style={{ marginLeft: 20 }}>
          <ChainGraph chain={c.chain!} />
        </div>
      )}
      {hasDrill && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            marginLeft: 20,
            marginTop: 6,
            padding: '6px 0',
            borderTop: hasChain ? '1px solid #eee' : 'none',
          }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
            {intl
              .get('performance.hide_drill_title', { count: drillRows.length })
              .d(`Visible in ${drillRows.length} view(s) — hide where not needed:`)}
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {drillRows.map((row) => {
                const localizedKinds = row.ruleKinds
                  .map((k) => RULE_KIND_LABEL_SHORT[k] || k)
                  .join(', ');
                return (
                  <tr key={row.viewId}>
                    <td style={{ padding: '3px 8px 3px 0' }}>
                      <button
                        type="button"
                        onClick={() => handleToggle(row.viewId)}
                        title={
                          row.isHidden
                            ? intl
                                .get('performance.toggle_show_col')
                                .d('Show in this view')
                            : intl
                                .get('performance.toggle_hide_col')
                                .d('Hide in this view')
                        }
                        className={
                          !row.isHidden
                            ? stylesPSettings.settings_fields_toggle_btns_active
                            : stylesPSettings.settings_fields_toggle_btns
                        }
                      />
                    </td>
                    <td
                      style={{
                        padding: '3px 8px',
                        color: '#333',
                        minWidth: 200,
                      }}>
                      {row.viewName}
                      {row.ruleKinds.length > 0 && (
                        <i
                          className="dtable-font dtable-icon-rules"
                          title={intl
                            .get('performance.hide_rule_bound_tooltip', {
                              kinds: localizedKinds,
                            })
                            .d(
                              `Referenced by ${localizedKinds} in this view. Hiding doesn't reduce compute cost — the value is still needed to evaluate the rule.`
                            )}
                          style={{
                            fontSize: 12,
                            color: '#aaa',
                            marginLeft: 6,
                            cursor: 'help',
                          }}
                        />
                      )}
                    </td>
                    <td
                      style={{
                        padding: '3px 8px',
                        color: row.ruleKinds.length > 0 ? '#aaa' : '#28a745',
                        fontStyle: row.ruleKinds.length > 0 ? 'italic' : 'normal',
                      }}>
                      {row.ruleKinds.length > 0
                        ? intl
                            .get('performance.hide_used_in_rules', { kinds: localizedKinds })
                            .d(`0% — used in ${localizedKinds}`)
                        : `−${row.costSavedPct.toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

export default CandidateExpansion;

/**
 * True iff the candidate has anything to expand (chain or drill). Mirrors
 * the internal CandidateExpansion logic so callers can decide whether to
 * render an expand chevron without rendering the expansion itself.
 */
export function hasCandidateExpansionContent(
  candidate: PerformanceCandidateColumn,
  liveValue: any
): boolean {
  const hasChain = !!candidate.chain && candidate.chain.length > 0;
  if (hasChain) return true;
  const tables: any[] = liveValue?.tables || [];
  const t = tables.find((tt: any) => tt._id === candidate.tableId);
  if (!t) return false;
  for (const v of t.views || []) {
    const baseHidden = new Set<string>(v.hidden_columns || []);
    if (!baseHidden.has(candidate.columnKey)) return true;
  }
  return false;
}
