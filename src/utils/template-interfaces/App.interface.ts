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
  // Cache of named-API-token credentials used for authored ("colleague") row
  // edits, keyed by the token's app_name. Created on demand, reused across the
  // course, regenerated when the base token expires, deleted at course end.
  colleagueTokens?: { [appName: string]: IColleagueToken };
  // Course progress: the id of the last-reached step, keyed by courseId. One
  // plugin serves all seven courses, so it's a per-course map. Content lives in
  // Hugo (not here) — the datastore only remembers where to resume.
  courseProgress?: { [courseId: string]: string };
}

export interface IColleagueToken {
  apiToken: string;
  baseToken?: string;
  baseTokenExpiresAt?: number; // epoch ms
  dtableUuid?: string;
}

export interface AvailableLocales {
  [key: string]: any;
}
export interface IActiveComponents {
  [componentKey: string]: boolean;
}
