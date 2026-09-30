import React from 'react';
import intl from 'react-intl-universal';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import {
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
} from '../../../utils/custom-utils/performanceAuditRunner';
import { PerformanceCandidateColumn } from '../../../utils/custom-interfaces/AuditTypes';
import ChainGraph, { ChainGraphRoot } from './ChainGraph';

interface CandidateExpansionProps {
  candidate: PerformanceCandidateColumn;
  liveValue: any;
  // Direct hide-toggle handler. Called when the user clicks a per-view slider
  // in the drill — commits to the base immediately (no staging). Optional:
  // when omitted the drill is rendered read-only-ish (toggles still call but
  // the parent can no-op).
  onToggleHideInView?: (
    tableId: string,
    tableName: string,
    viewId: string,
    viewName: string,
    columnKey: string,
    columnName: string
  ) => void;
  // When false, suppress the per-view hide drill — only the chain graph is
  // rendered. Used by Overview (perf-focused), where hiding columns has no
  // measurable effect on view-load time and the drill is more misleading than
  // useful. TableTab still shows it for structural / readability hygiene.
  showHideDrill?: boolean;
}

function candidateRoot(c: PerformanceCandidateColumn): ChainGraphRoot {
  if (c.columnType === 'link-formula') {
    return {
      columnType: 'link-formula',
      name: c.columnName,
      formulaType: c.formulaType,
      referencedLinkName: c.dependsOnLinkColumnName,
    };
  }
  if (c.columnType === 'link') {
    return { columnType: 'link', name: c.columnName };
  }
  return { columnType: 'formula', name: c.columnName };
}

/**
 * Single chevron-driven expansion for a candidate column row, shared by
 * Overview's Performance candidates table and TableTab's Columns table.
 *
 * Renders two stacked sections:
 *   1. Chain graph (when the candidate has a chain).
 *   2. Per-view drill — every view that displays this column in base, with a
 *      slider that hides/shows the column in that view. The slider commits
 *      directly to the base on click (no staging) so the plugin's behavior
 *      mirrors SeaTable's native UI.
 *
 * Returns null when neither section has content, so callers can detect
 * "nothing to expand" and suppress the chevron.
 */
const CandidateExpansion: React.FC<CandidateExpansionProps> = ({
  candidate: c,
  liveValue,
  onToggleHideInView,
  showHideDrill = true,
}) => {
  const hasChain = !!c.chain && c.chain.length > 0;

  const drillRows = (() => {
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    if (!t)
      return [] as Array<{
        viewId: string;
        viewName: string;
        ruleKinds: string[];
        isHidden: boolean;
      }>;
    const out: Array<{
      viewId: string;
      viewName: string;
      ruleKinds: string[];
      isHidden: boolean;
    }> = [];
    for (const v of t.views || []) {
      const isHidden = (v.hidden_columns || []).includes(c.columnKey);
      const ruleKinds = getColumnRuleKindsInView(v, c.columnKey);
      out.push({
        viewId: v._id,
        viewName: v.name,
        ruleKinds,
        isHidden,
      });
    }
    return out;
  })();
  const hasDrill = showHideDrill && drillRows.length > 0;
  if (!hasChain && !hasDrill) return null;

  const handleToggle = (viewId: string, viewName: string) => {
    if (!onToggleHideInView) return;
    onToggleHideInView(c.tableId, c.tableName, viewId, viewName, c.columnKey, c.columnName);
  };

  return (
    <>
      {hasChain && (
        <div style={{ marginLeft: 20 }}>
          <ChainGraph chain={c.chain!} rootColumn={candidateRoot(c)} />
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
                        onClick={() => handleToggle(row.viewId, row.viewName)}
                        title={
                          row.isHidden
                            ? intl.get('performance.toggle_show_col').d('Show in this view')
                            : intl.get('performance.toggle_hide_col').d('Hide in this view')
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
                            .d(`Referenced by ${localizedKinds} in this view.`)}
                          style={{
                            fontSize: 12,
                            color: '#aaa',
                            marginLeft: 6,
                            cursor: 'help',
                          }}
                        />
                      )}
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
 *
 * Pass `showHideDrill: false` to match Overview's CandidateExpansion call —
 * the chevron should only appear when there's a chain to show, since the
 * drill is suppressed there.
 */
export function hasCandidateExpansionContent(
  candidate: PerformanceCandidateColumn,
  liveValue: any,
  showHideDrill: boolean = true
): boolean {
  const hasChain = !!candidate.chain && candidate.chain.length > 0;
  if (hasChain) return true;
  if (!showHideDrill) return false;
  const tables: any[] = liveValue?.tables || [];
  const t = tables.find((tt: any) => tt._id === candidate.tableId);
  if (!t) return false;
  return (t.views || []).length > 0;
}
