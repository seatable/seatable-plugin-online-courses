import { CourseManifest } from '../../custom-utils/courseContent';

/** One entry of the left-hand list: a course of the roster (COURSES, courseContent.ts). */
export interface ICourseEntry {
  _id: string; // the courseId
  name: string;
}

export interface IPresetsProps {
  // The fixed course roster, in display order.
  pluginPresets: ICourseEntry[];
  onSelectPreset: (courseId: string) => void;
  // Course navigation tree: each course expands to its manifest's steps (level 2).
  // `courses` holds every course's manifest.
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
