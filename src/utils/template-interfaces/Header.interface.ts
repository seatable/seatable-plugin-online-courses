export interface IHeaderProps {
  presetName: string | undefined;
  isShowSettings: boolean;
  isShowPresets: boolean;
  toggleSettings: () => void;
  togglePlugin: () => void;
  onTogglePresets: () => void;
  // Expand/collapse the plugin window (course view ↔ compact banner).
  expanded?: boolean;
  onToggleExpanded?: () => void;
}
