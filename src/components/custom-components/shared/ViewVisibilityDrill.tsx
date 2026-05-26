import React, { useState } from 'react';
import intl from 'react-intl-universal';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import {
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
} from '../../../utils/custom-utils/performanceAuditRunner';
import { COLUMN_TYPE_ICONS } from './columnTypeIcons';
import PerfIcon from './PerfIcon';

interface ViewVisibilityDrillProps {
  tableId: string;
  viewId: string;
  liveView: any;
  liveColumns: any[];
  candidateColumnKeys: Set<string>;
  effectiveHidden: Set<string>;
  onToggleColumn: (colKey: string, colName: string) => void;
}

/**
 * Per-view "manage visibility" panel. Lists computed columns (formula /
 * link-formula) by default with a slider per column reflecting the effective
 * hidden state (base ∪ local edits). "Show all columns" expands the list to
 * non-computed columns too — those are greyed since toggling them has no
 * perf effect.
 *
 * Toggle calls `onToggleColumn` which the parent translates into an edit on
 * the shared per-view edits map. State for expansion / show-all is local to
 * this component.
 */
const ViewVisibilityDrill: React.FC<ViewVisibilityDrillProps> = ({
  liveView,
  liveColumns,
  candidateColumnKeys,
  effectiveHidden,
  onToggleColumn,
}) => {
  const [showAll, setShowAll] = useState(false);
  const visibleCols = liveColumns.filter((col: any) => {
    const isComputed = col.type === 'formula' || col.type === 'link-formula';
    return showAll || isComputed;
  });
  return (
    <div style={{ padding: '8px 16px 12px 32px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
          fontSize: 12,
          color: '#666',
        }}>
        <span>
          {intl
            .get('performance.manage_visibility_hint')
            .d('Toggle to plan changes; commit via the three-dots menu.')}
        </span>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
          <span>{intl.get('performance.show_all_columns').d('Show all columns')}</span>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className={
              showAll
                ? stylesPSettings.settings_fields_toggle_btns_active
                : stylesPSettings.settings_fields_toggle_btns
            }
          />
        </div>
      </div>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 13,
          width: '100%',
        }}>
        <tbody>
          {visibleCols.map((col: any) => {
            const isComputed = col.type === 'formula' || col.type === 'link-formula';
            const isHidden = effectiveHidden.has(col.key);
            const ruleKinds = getColumnRuleKindsInView(liveView, col.key)
              .map((k) => RULE_KIND_LABEL_SHORT[k] || k)
              .join(', ');
            const isReferenced = ruleKinds.length > 0;
            const isCandidate = candidateColumnKeys.has(col.key);
            return (
              <tr key={col.key}>
                <td style={{ padding: '3px 8px 3px 0', width: 40 }}>
                  <button
                    type="button"
                    onClick={() => onToggleColumn(col.key, col.name)}
                    title={
                      isHidden
                        ? intl.get('performance.toggle_show_col').d('Show in this view')
                        : intl.get('performance.toggle_hide_col').d('Hide in this view')
                    }
                    className={
                      !isHidden
                        ? stylesPSettings.settings_fields_toggle_btns_active
                        : stylesPSettings.settings_fields_toggle_btns
                    }
                  />
                </td>
                <td
                  style={{
                    padding: '3px 8px',
                    color: isComputed ? '#333' : '#aaa',
                  }}>
                  <i
                    className={`dtable-font ${COLUMN_TYPE_ICONS[col.type] || 'dtable-icon-single-line-text'}`}
                    style={{ fontSize: 13, color: '#aaa', marginRight: 6 }}
                  />
                  <span
                    style={{
                      textDecoration: isHidden ? 'line-through' : 'none',
                    }}>
                    {col.name}
                  </span>
                  {isCandidate && <PerfIcon size={11} style={{ marginLeft: 6 }} />}
                  {isReferenced && (
                    <i
                      className="dtable-font dtable-icon-rules"
                      title={intl
                        .get('performance.hide_rule_bound_tooltip', { kinds: ruleKinds })
                        .d(
                          `Referenced by ${ruleKinds} in this view. Hiding doesn't reduce compute cost — the value is still needed to evaluate the rule.`
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default ViewVisibilityDrill;
