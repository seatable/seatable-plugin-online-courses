import intl from 'react-intl-universal';
import {
  PerformanceCandidateColumn,
  RemediationAction,
} from '../../../utils/custom-interfaces/AuditTypes';
import { MenuAction } from './ContextMenu';

interface BuildCandidateMenuExtrasParams {
  candidate: PerformanceCandidateColumn;
  remediations: Map<string, RemediationAction>;
  isColumnDirty: boolean;
  // True when this candidate's cost share is below the relevance threshold.
  // TableTab shows below-threshold candidates and gates Stage actions on
  // them; Overview filters them out, so passing false there is fine.
  notRelevant?: boolean;
  onToggleAction: (key: string, action: RemediationAction) => void;
  onApplyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  // Direct freeze on the original base — skips the test/sandbox workflow.
  // Same indirection mechanism as the apply path, just invoked one column at
  // a time. Omit to hide the menu entry (e.g. in contexts where the host
  // doesn't wire a handler).
  onFreezeNow?: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
}

/**
 * Returns the `extraActions[]` for a candidate column's three-dots menu.
 * The primary "Delete column now" entry is set by the caller via
 * ContextMenu's `onDelete` + `label` props.
 *
 * Order: Stage delete column / Stage replace by static data / divider /
 * Apply views changes now.
 *
 * View visibility changes are direct-only — toggling the per-view sliders
 * + clicking "Apply views changes now" commits to the base immediately. The
 * old "Stage views changes" affordance was removed alongside the broader
 * view-staging redesign (views are hygiene cleanup, not test workflow).
 *
 * Shared between Overview's CandidateRow and TableTab's Columns row when a
 * column is a candidate. Non-candidate columns in TableTab use a simpler
 * menu (just delete-now).
 */
export function buildCandidateMenuExtras({
  candidate: c,
  remediations,
  isColumnDirty,
  notRelevant = false,
  onToggleAction,
  onApplyColumnVisibility,
  onFreezeNow,
}: BuildCandidateMenuExtrasParams): MenuAction[] {
  const key = `${c.tableId}:${c.columnKey}`;
  const action = remediations.get(key);
  // Multi-value columns are no longer blocked at stage time: the freeze
  // mechanism can serialize multi-array values into a long-text snapshot,
  // and the apply-time modal warns the user about the resulting shape change
  // (array → joined string for downstream consumers).
  const canReplace = !!c.replacementType;
  const replaceDisabledTooltip = !c.replacementType
    ? intl.get('performance.replace_disabled_type').d('Cannot freeze this column type')
    : undefined;
  const stageDeleteLabel =
    action === 'delete'
      ? intl.get('performance.unstage_delete_column').d('Unstage delete column')
      : intl.get('performance.stage_delete_column').d('Stage delete column');
  const replaceLabel =
    action === 'replace-static'
      ? intl.get('performance.unselect_replace').d('Unstage freeze column')
      : intl.get('performance.select_replace').d('Stage freeze column');
  const noUnsavedTooltip = intl
    .get('performance.no_unsaved_visibility')
    .d('Toggle the column sliders first.');
  const primaryDisabledTooltip = intl
    .get('performance.delete_disabled_primary')
    .d('Cannot delete — this is the table\'s first column');
  const notRelevantTooltip = intl
    .get('performance.stage_not_relevant_tooltip')
    .d('Not significant — staging this won\'t measurably improve performance.');

  // Stage-delete gate: primary column blocks unconditionally; below-threshold
  // blocks only when not already staged (so user can still un-stage).
  const stageDelPrimaryBlock = c.isPrimaryColumn && action !== 'delete';
  const stageDelIrrelevantBlock = notRelevant && action !== 'delete';
  const stageDelTip = stageDelPrimaryBlock
    ? primaryDisabledTooltip
    : stageDelIrrelevantBlock
      ? notRelevantTooltip
      : undefined;

  // Replace gate: !canReplace is the structural block; below-threshold blocks
  // when not already staged.
  const replaceIrrelevantBlock = notRelevant && action !== 'replace-static';
  const replaceTip = !canReplace
    ? replaceDisabledTooltip
    : replaceIrrelevantBlock
      ? notRelevantTooltip
      : undefined;

  return [
    {
      label: stageDeleteLabel,
      icon: 'dtable-icon-gauge',
      color: action === 'delete' ? '#999' : '#dc3545',
      disabled: stageDelPrimaryBlock || stageDelIrrelevantBlock,
      disabledTooltip: stageDelTip,
      onClick: () => onToggleAction(key, 'delete'),
    },
    {
      label: replaceLabel,
      icon: 'dtable-icon-gauge',
      color: action === 'replace-static' ? '#999' : '#e6a117',
      disabled:
        (!canReplace || replaceIrrelevantBlock) && action !== 'replace-static',
      disabledTooltip: replaceTip,
      onClick: () => onToggleAction(key, 'replace-static'),
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: intl
        .get('performance.apply_views_changes_now')
        .d('Update views now'),
      icon: 'dtable-icon-eye',
      color: isColumnDirty ? '#0066cc' : '#999',
      disabled: !isColumnDirty,
      disabledTooltip: noUnsavedTooltip,
      onClick: () =>
        onApplyColumnVisibility(c.tableId, c.tableName, c.columnKey, c.columnName),
    },
    // Direct freeze on the original base — single column, no staging. Two-click
    // confirm (needsConfirm) since it's a real mutation. Disabled when the
    // column is staged for delete (mutually exclusive) or staged for freeze
    // (redundant — user should commit via Apply).
    ...(onFreezeNow
      ? [
          {
            label: intl
              .get('performance.freeze_column_now')
              .d('Freeze column now'),
            icon: 'dtable-icon-pin',
            color: '#e6a117',
            needsConfirm: true,
            disabled:
              !canReplace ||
              action === 'replace-static' ||
              action === 'delete' ||
              notRelevant,
            disabledTooltip: !canReplace
              ? replaceDisabledTooltip
              : action === 'replace-static'
                ? intl
                    .get('performance.freeze_now_disabled_staged')
                    .d('Already staged for freeze — apply via the test workflow')
                : action === 'delete'
                  ? intl
                      .get('performance.freeze_now_disabled_delete_staged')
                      .d('Staged for deletion — unstage first to freeze instead')
                  : notRelevant
                    ? notRelevantTooltip
                    : undefined,
            onClick: () =>
              onFreezeNow(c.tableId, c.tableName, c.columnKey, c.columnName),
          } as MenuAction,
        ]
      : []),
  ];
}
