import { PresetsArray } from './Presets.interface';

export interface IPresetItemProps {
  pluginPresets: PresetsArray;
  activePresetIdx: number;
  onSelectPreset: (presetId: string) => void;
  p: any; // preset
}
