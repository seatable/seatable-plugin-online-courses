export interface IHeaderProps {
  presetName: string | undefined;
  isShowSettings: boolean;
  isShowPresets: boolean;
  toggleSettings: () => void;
  togglePlugin: () => void;
  onTogglePresets: () => void;
}
