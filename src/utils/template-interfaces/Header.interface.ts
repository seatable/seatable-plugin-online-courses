import { FloatControls } from '../custom-interfaces/FloatControls';

export interface IHeaderProps {
  presetName: string | undefined;
  isShowSettings: boolean;
  isShowPresets: boolean;
  toggleSettings: () => void;
  togglePlugin: () => void;
  onTogglePresets: () => void;
  // Current step's title — shown as the header label (falls back to the course name).
  stepTitle?: string;
  // Current step's actions (back / verify / advance, + the guided-build choice menu),
  // rendered as buttons in the header so the docked plugin matches the floating
  // toolbar. Reported up from the runner; null while loading.
  controls?: FloatControls | null;
  // Shrink the plugin to the small draggable toolbar so the whole base is reachable
  // (e.g. the bottom action buttons of the automation panel).
  onFloat?: () => void;
}
