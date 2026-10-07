import { AppActiveState } from '../App.interface';
import { SelectOption } from '../PluginSettings.interface';
import { CourseManifest } from '../../custom-utils/courseContent';

export interface IPresetsProps {
  pluginPresets: PresetsArray;
  activePresetIdx: number;
  onSelectPreset: (presetId: string, newPresetActiveState?: AppActiveState) => void;
  // Course navigation tree: each preset (id = courseId) expands to its manifest's
  // steps (level 2). `courses` holds every course's manifest.
  courses?: CourseManifest[];
  activeCourseId?: string;
  activeStepId?: string | null;
  onSelectStep?: (courseId: string, stepId: string) => void;
  // Compact mode (reduced/exercise view): show only the active course, scrollable,
  // auto-scrolled to the current step.
  compact?: boolean;
  // Shrink the plugin to the floating icon (same action as the header button);
  // wired to the plugin logo at the top of the panel.
  onFloat?: () => void;
  isShowPresets: boolean;
  onTogglePresets: () => void;
}

export interface IPresetsState {
  dragItemIndex: number | null;
  dragOverItemIndex: number | null;
  _allViews: any[];
}

export interface IPresetInfo {
  _id: string;
  name: string;
  settings?: PresetSettings;
  customSettings?: PresetCustomSettings;
}

export interface PresetSettings {
  shown_image_name?: string | undefined;
  shown_title_name?: string | undefined;
  selectedTable?: SelectOption;
  selectedView?: SelectOption;
  show_field_names?: boolean;
}
export interface PresetCustomSettings {
  [key: string]: any;
}

export type PresetsArray = IPresetInfo[];
