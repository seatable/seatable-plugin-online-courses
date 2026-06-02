import { PresetsArray } from './Presets.interface';

export interface IPresetDropdownProps {
  togglePresetsUpdatePopUp: (e: React.MouseEvent<HTMLElement>) => void;
  dropdownRef: React.RefObject<HTMLUListElement> | undefined;
  pluginPresets: PresetsArray;
  presetName?: string;
  // Whether this preset has ever produced a performance-analysis result.
  // Drives the dropdown's "Run performance analysis" vs "Rerun performance
  // analysis" label so it stays consistent with the tables-audit entry.
  hasPerfRun?: boolean;
}
