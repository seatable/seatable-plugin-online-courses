import { AppIsShowState } from '../App.interface';
import { PresetsArray } from './Presets.interface';

export interface IPresetItemProps {
  pluginPresets: PresetsArray;
  activePresetIdx: number;
  presetName: string;
  presetNameAlreadyExists: boolean;
  onSelectPreset: (presetId: string) => void;
  togglePresetsUpdate: (e: React.MouseEvent<HTMLElement>, type?: string) => void;
  deletePreset: () => void;
  exportPreset: () => void;
  resetPreset: () => void;
  onToggleSettings: () => void;
  p: any; // preset
  onChangePresetName: (e: React.FormEvent<HTMLInputElement>) => void;
  duplicatePreset: (name: string) => void;
  showEditPresetPopUp: boolean;
  isShowState: AppIsShowState;
  setIsShowState: (value: React.SetStateAction<AppIsShowState>) => void;
}

// Not used, still to keep?
export interface IViewItemState {
  showViewDropdown: boolean;
  isEditing: boolean;
  popupRef: React.RefObject<HTMLUListElement> | undefined;
}
