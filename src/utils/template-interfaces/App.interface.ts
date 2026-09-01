import { PresetsArray } from './PluginPresets/Presets.interface';
import { Table, TableRow, TableView } from './Table.interface';

export interface IAppProps {
  isDevelopment?: boolean;
  showDialog?: boolean;
  lang?: string;
  row?: any;
}
export interface AppIsShowState {
  isShowPlugin: boolean;
  isShowSettings: boolean;
  isLoading: boolean;
  isShowPresets: boolean;
  isShowWaiting: boolean;
}

// AppActiveState is a state that holds the active state of what is shown in the plugin
// as "active" is meant the state of the selected Preset
export interface AppActiveState {
  activePresetId: string; // Stores the ID of the active preset
  activePresetIdx: number; // Keeps track of the index of the active preset
  activeTable: Table | null; // Represents the currently active table in the app
  activeTableName: string; // Holds the name of the active table // TO REMOVE
  activeTableView: TableView | null; // Represents the currently active table view in the app
  activeViewRows?: TableRow[]; // Represents the currently active view rows in the app
}

export interface AppActiveState {
  activePresetId: string; // Stores the ID of the active preset
  activePresetIdx: number; // Keeps track of the index of the active preset
  activeTable: Table | null; // Represents the currently active table in the app
  activeTableName: string; // Holds the name of the active table // TO REMOVE
  activeTableView: TableView | null; // Represents the currently active table view in the app
  activeViewRows?: TableRow[]; // Represents the currently active view rows in the app
}

export interface IPluginDataStore extends Pick<
  AppActiveState,
  'activePresetId' | 'activePresetIdx'
> {
  presets: PresetsArray;
  pluginName: string;
  accountToken?: string;
  // Course progress: the id of the last-reached step, keyed by courseId. One
  // plugin serves all seven courses, so it's a per-course map. Content lives in
  // Hugo (not here) — the datastore only remembers where to resume.
  courseProgress?: { [courseId: string]: string };
  // Per-course marks for actions that must not be offered twice by accident —
  // today only Step 4's rewind, which would delete the delivery the learner has
  // just had the AI read back in. Session state would forget it the moment they
  // paged to another step. See courseProgress.ts.
  courseFlags?: { [courseId: string]: { [key: string]: boolean } };
  // Last position (top-left, px) of the floating "movable icon" puck, so it
  // re-pops where the learner left it next time. Defaults to the bottom-left.
  floatIconPos?: { x: number; y: number };
}

export interface AvailableLocales {
  [key: string]: any;
}
export interface IActiveComponents {
  [componentKey: string]: boolean;
}
