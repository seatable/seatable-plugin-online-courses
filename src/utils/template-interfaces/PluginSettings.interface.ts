import { AppActiveState } from './App.interface';
import { PresetSettings, PresetsArray } from './PluginPresets/Presets.interface';
import { TableArray, TableViewArray } from './Table.interface';
import { AuditTableDisplayState } from '../custom-interfaces/AuditTypes';

export interface IPluginSettingsProps {
  allTables: TableArray;
  appActiveState: AppActiveState;
  activeTableViews: TableViewArray;
  pluginPresets: PresetsArray;
  onToggleSettings: () => void;
  isShowSettings: boolean;
  onSaveAccountToken?: (token: string) => void;
  accountToken?: string;
  verifyUrls?: boolean;
  onVerifyUrlsChange?: (value: boolean) => void;
  auditTableDisplay?: AuditTableDisplayState;
  onAuditTableDisplayChange?: (display: AuditTableDisplayState) => void;
  autoRerun?: boolean;
  onAutoRerunChange?: (value: boolean) => void;
  perfRunning?: boolean;
}

export interface SelectOption {
  value: string; // item._id
  label: string; // item.name
}

export interface IActivePresetSettings extends PresetSettings {
  activePresetId: string;
}
