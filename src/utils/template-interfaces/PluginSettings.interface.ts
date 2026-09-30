import { SettingsOption } from '../types';
import { RelationshipState } from '../custom-interfaces/PluginTR';
import { AppActiveState, IActiveComponents } from './App.interface';
import { PresetSettings, PresetsArray } from './PluginPresets/Presets.interface';
import { TableArray, TableViewArray } from './Table.interface';

interface IPluginSettingsProps {
  allTables: TableArray;
  appActiveState: AppActiveState;
  activeTableViews: TableViewArray;
  pluginPresets: PresetsArray;
  onTableOrViewChange: (type: SettingsOption, option: SelectOption) => void;
  onToggleSettings: () => void;
  isShowSettings: boolean;
  activeRelationships: RelationshipState;
  handleRelationships: (t: any) => void;
  activeComponents: IActiveComponents;
}

interface SelectOption {
  value: string; // item._id
  label: string; // item.name
}

interface IActivePresetSettings extends PresetSettings {
  activePresetId: string;
}

export type { IPluginSettingsProps, SelectOption, IActivePresetSettings };
