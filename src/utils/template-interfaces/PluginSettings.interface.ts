import { PresetSettings } from './PluginPresets/Presets.interface';

export interface SelectOption {
  value: string; // item._id
  label: string; // item.name
}

export interface IActivePresetSettings extends PresetSettings {
  activePresetId: string;
}
