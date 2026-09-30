import { PresetsArray } from './Presets.interface';

export interface IPresetDropdownProps {
  togglePresetsUpdatePopUp: (e: React.MouseEvent<HTMLElement>) => void;
  dropdownRef: React.RefObject<HTMLUListElement> | undefined;
  pluginPresets: PresetsArray;
}
