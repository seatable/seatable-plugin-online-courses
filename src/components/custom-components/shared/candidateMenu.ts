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
  onStageColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
  onApplyColumnVisibility: (
    tableId: string,
    tableName: string,
    columnKey: string,
    columnName: string
  ) => void;
}

/**
 * Returns the `extraActions[]` for a candidate column's three-dots menu.
 * The primary "Delete column now" entry is set by the caller via
 * ContextMenu's `onDelete` + `label` props; this helper produces the five
 * stage/apply items above the divider.
 *
 * Order: Stage views changes / Stage delete column / Stage replace by static
 * data / divider / Apply views changes now.
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
  onStageColumnVisibility,
  onApplyColumnVisibility,
}: BuildCandidateMenuExtrasParams): MenuAction[] {
  const key = `${c.tableId}:${c.columnKey}`;
  const action = remediations.get(key);
  const canReplace = !!c.replacementType && !c.isMultiValue;
  const replaceDisabledTooltip = c.isMultiValue
    ? intl
        .get('performance.replace_disabled_multi')
        .d('Cannot replace — some rows return multiple values')
    : !c.replacementType
      ? intl
          .get('performance.replace_disabled_type')
          .d('Cannot determine a safe replacement type')
      : undefined;
  const stageDeleteLabel =
    action === 'delete'
      ? intl.get('performance.unstage_delete_column').d('Unstage delete column')
      : intl.get('performance.stage_delete_column').d('Stage delete column');
  const replaceLabel =
    action === 'replace-static'
      ? intl.get('performance.unselect_replace').d('Cancel replacement')
      : intl.get('performance.select_replace').d('Replace by static data');
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
      label: intl.get('performance.stage_views_changes').d('Stage views changes'),
      icon: 'dtable-icon-gauge',
      color: isColumnDirty ? '#dc3545' : '#999',
      disabled: !isColumnDirty,
      disabledTooltip: noUnsavedTooltip,
      onClick: () =>
        onStageColumnVisibility(c.tableId, c.tableName, c.columnKey, c.columnName),
    },
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
        .d('Apply views changes now'),
      icon: 'dtable-icon-eye',
      color: isColumnDirty ? '#0066cc' : '#999',
      disabled: !isColumnDirty,
      disabledTooltip: noUnsavedTooltip,
      onClick: () =>
        onApplyColumnVisibility(c.tableId, c.tableName, c.columnKey, c.columnName),
    },
  ];
}
