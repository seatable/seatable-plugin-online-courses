import { AppActiveState, IPluginDataStore } from './App.interface';

export interface IHeaderProps {
  presetName: string | undefined;
  isShowSettings: boolean;
  isShowPresets: boolean;
  toggleSettings: () => void;
  togglePlugin: () => void;
  onTogglePresets: () => void;
  appActiveState: AppActiveState;
  pluginDataStore: IPluginDataStore;
}
