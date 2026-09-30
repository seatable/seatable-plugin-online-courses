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

export interface IPluginDataStore
  extends Pick<AppActiveState, 'activePresetId' | 'activePresetIdx'> {
  presets: PresetsArray;
  pluginName: string;
}

export interface AvailableLocales {
  [key: string]: any;
}
export interface IActiveComponents {
  [componentKey: string]: boolean;
}
