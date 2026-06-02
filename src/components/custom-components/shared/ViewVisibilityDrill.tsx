import React from 'react';
import intl from 'react-intl-universal';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import {
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
} from '../../../utils/custom-utils/performanceAuditRunner';
import { COLUMN_TYPE_ICONS } from './columnTypeIcons';

interface ViewVisibilityDrillProps {
  tableId: string;
  viewId: string;
  liveView: any;
  liveColumns: any[];
  effectiveHidden: Set<string>;
  onToggleColumn: (colKey: string, colName: string) => void;
  // Bulk visibility toggle. Caller commits the supplied desired array via a
  // single PUT (and mutates the live SDK state so the drill re-renders with
  // the new effectiveHidden). Pass the new full hidden_columns array.
  onSetAllHidden: (hiddenKeys: string[]) => void;
}

// Best-effort current-user identifier. Tries both sources we know about; the
// SeaTable host populates at least one. Used to gate toggles on private views
// owned by someone else.
function getCurrentUsername(): string {
  const w = window as any;
  return (
    w.dtableSDK?.dtableStore?.dtableSettings?.username ||
    w.dtable?.username ||
    ''
  );
}

// SeaTable's primary column key is always '0000'. It can't be hidden — the
// bulk "Hide all" action excludes it so the view stays usable.
const PRIMARY_COLUMN_KEY = '0000';

/**
 * Per-view "manage visibility" panel. Lists every column in the table with
 * a slider per row reflecting the effective hidden state. Toggling a slider
 * commits to the base immediately via `onToggleColumn`.
 *
 * The header "Show all columns" switch is a bulk-visibility toggle: ON iff
 * no column is hidden. Clicking it flips between hidden_columns = [] (show
 * all) and hidden_columns = [every key except primary] (hide all).
 *
 * When the view is private to someone else, all toggles are disabled and an
 * explanatory message replaces the usual hint.
 */
const ViewVisibilityDrill: React.FC<ViewVisibilityDrillProps> = ({
  liveView,
  liveColumns,
  effectiveHidden,
  onToggleColumn,
  onSetAllHidden,
}) => {
  const privateFor: string | null = liveView?.private_for ?? null;
  const isOtherOwnedPrivate = !!privateFor && privateFor !== getCurrentUsername();
  const lockedTooltip = isOtherOwnedPrivate
    ? intl
        .get('performance.private_view_other_owner_block', { owner: privateFor })
        .d(`This view is private to ${privateFor} — only the owner can change its visibility.`)
    : undefined;

  // Switch state: ON iff every column is visible (nothing hidden).
  const allVisible = effectiveHidden.size === 0;
  const handleBulkToggle = () => {
    if (isOtherOwnedPrivate) return;
    if (allVisible) {
      // Hide every column except the primary so the view stays usable.
      const allButPrimary = liveColumns
        .map((c: any) => c.key)
        .filter((k: string) => k !== PRIMARY_COLUMN_KEY);
      onSetAllHidden(allButPrimary);
    } else {
      onSetAllHidden([]);
    }
  };

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
          {isOtherOwnedPrivate
            ? intl
                .get('performance.private_view_other_owner_block', { owner: privateFor })
                .d(
                  `This view is private to ${privateFor} — only the owner can change its visibility.`
                )
            : intl
                .get('performance.manage_visibility_hint')
                .d('Toggle to hide or show columns in this view.')}
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
            disabled={isOtherOwnedPrivate}
            onClick={isOtherOwnedPrivate ? undefined : handleBulkToggle}
            title={
              lockedTooltip ??
              (allVisible
                ? intl
                    .get('performance.bulk_hide_all')
                    .d('Hide every column except the primary one')
                : intl.get('performance.bulk_show_all').d('Show every column in this view'))
            }
            style={isOtherOwnedPrivate ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
            className={
              allVisible
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
          {liveColumns.map((col: any) => {
            const isComputed = col.type === 'formula' || col.type === 'link-formula';
            const isPrimary = col.key === PRIMARY_COLUMN_KEY;
            const isHidden = effectiveHidden.has(col.key);
            const ruleKinds = getColumnRuleKindsInView(liveView, col.key)
              .map((k) => RULE_KIND_LABEL_SHORT[k] || k)
              .join(', ');
            const isReferenced = ruleKinds.length > 0;
            const primaryTooltip = intl
              .get('performance.primary_column_uncloseable')
              .d("First column can't be hidden.");
            return (
              <tr key={col.key}>
                <td
                  style={{ padding: '3px 8px 3px 0', width: 40 }}
                  title={isPrimary ? primaryTooltip : undefined}>
                  {isPrimary ? null : (
                    <button
                      type="button"
                      disabled={isOtherOwnedPrivate}
                      onClick={
                        isOtherOwnedPrivate ? undefined : () => onToggleColumn(col.key, col.name)
                      }
                      title={
                        lockedTooltip ??
                        (isHidden
                          ? intl.get('performance.toggle_show_col').d('Show in this view')
                          : intl.get('performance.toggle_hide_col').d('Hide in this view'))
                      }
                      style={
                        isOtherOwnedPrivate ? { cursor: 'not-allowed', opacity: 0.5 } : undefined
                      }
                      className={
                        !isHidden
                          ? stylesPSettings.settings_fields_toggle_btns_active
                          : stylesPSettings.settings_fields_toggle_btns
                      }
                    />
                  )}
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
                  <span>{col.name}</span>
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
