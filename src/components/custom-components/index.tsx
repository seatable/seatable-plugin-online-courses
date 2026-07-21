import React, { useEffect, useRef } from 'react';
import { IPluginTRProps } from '../../utils/custom-interfaces/PluginTR';
import { COURSES } from '../../utils/custom-utils/courseContent';
import { ACTIVE_PRESET_ID, PLUGIN_NAME } from '../../utils/template-constants';
import OnlineCourse from './OnlineCourse';

// Online courses plugin — one fixed preset per course (Courses 1–7). Presets are
// seeded here (from the COURSES roster) and not meant to be created/edited/
// reordered by the user. Preset _id === courseId.
const COURSE_PRESETS = COURSES.map((c) => ({ _id: c.id, name: c.name, settings: {} }));

// Land on the course under active development by default (only on a fresh seed;
// subsequent loads resume the learner's last-selected course).
const DEFAULT_COURSE_ID = 'course-4';
const DEFAULT_COURSE_IDX = Math.max(
  0,
  COURSE_PRESETS.findIndex((p) => p._id === DEFAULT_COURSE_ID)
);

const CustomPlugin: React.FC<IPluginTRProps> = ({
  pluginDataStore,
  courseManifest,
  courseStepId,
  onSelectStep,
  onFloatControls,
  onContentHeight,
}) => {
  const initialized = useRef(false);

  // On first mount, force the preset list to the fixed course roster.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const presets = pluginDataStore.presets || [];
    const alreadySeeded =
      presets.length === COURSE_PRESETS.length &&
      COURSE_PRESETS.every((p, i) => presets[i]?._id === p._id);
    if (!alreadySeeded) {
      // Fresh seed → default the active course to course-4. Setting localStorage too
      // so App's resetData (which re-runs after this updatePluginSettings) picks it up.
      try {
        localStorage.setItem(ACTIVE_PRESET_ID, DEFAULT_COURSE_ID);
      } catch {
        /* localStorage unavailable — datastore default still applies */
      }
      (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
        ...pluginDataStore,
        activePresetId: DEFAULT_COURSE_ID,
        activePresetIdx: DEFAULT_COURSE_IDX,
        presets: COURSE_PRESETS,
      });
    }
  }, [pluginDataStore]);

  // The active course's manifest/step are owned by App so the left-panel tree and
  // the runner stay in sync; the runner is a controlled component. onSelectStep is
  // pre-bound to the active course by App.
  return (
    <OnlineCourse
      manifest={courseManifest ?? null}
      stepId={courseStepId ?? null}
      onSelectStep={onSelectStep ?? (() => {})}
      onFloatControls={onFloatControls}
      onContentHeight={onContentHeight}
    />
  );
};

export default CustomPlugin;
