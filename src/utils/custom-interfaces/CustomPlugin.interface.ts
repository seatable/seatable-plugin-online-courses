import { CourseManifest } from '../custom-utils/courseContent';
import { FloatControls } from './FloatControls';

export interface ICustomPluginProps {
  // Active course, owned by App; the runner is controlled. `onSelectStep` is
  // pre-bound to the active course (the runner only navigates within it).
  courseManifest?: CourseManifest | null;
  courseStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
  // Bumped by App on every change to the base (local or remote), so what the runner
  // derives from the base AS IT IS NOW is recomputed — see OnlineCourse's controls.
  baseVersion?: number;
  // Reports the current step's instruction + actions (back / verify / advance), so
  // App's floating toolbar can drive the step without re-expanding the plugin.
  onFloatControls?: (controls: FloatControls) => void;
  // Lets the runner ASK to be shrunk to the floating toolbar, for a step whose very
  // first instruction points at a control the expanded panel is sitting on top of.
  onRequestFloat?: () => void;
  // Reports the exercise banner's natural height so App can size the plugin to fit.
  onContentHeight?: (px: number) => void;
}
