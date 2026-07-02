export interface IHeaderProps {
  presetName: string | undefined;
  isShowSettings: boolean;
  isShowPresets: boolean;
  toggleSettings: () => void;
  togglePlugin: () => void;
  onTogglePresets: () => void;
  // Minimize the plugin window to its header bar (or restore its natural size).
  minimized?: boolean;
  onToggleMinimized?: () => void;
}
