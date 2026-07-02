import React, { useEffect, useRef } from 'react';
import { IPluginTRProps } from '../../utils/custom-interfaces/PluginTR';
import { PRESET_COURSE_3 } from '../../utils/custom-constants/constants';
import { PLUGIN_NAME } from '../../utils/template-constants';
import OnlineCourse from './OnlineCourse';

// Online courses plugin — single fixed preset (one online course). Presets are
// seeded here and not meant to be created/edited/reordered by the user.
const COURSE_PRESET = { _id: 'course3', name: PRESET_COURSE_3, settings: {} };

const CustomPlugin: React.FC<IPluginTRProps> = ({
  pluginDataStore,
  courseManifest,
  courseStepId,
  courseLoadNote,
  onSelectStep,
}) => {
  const initialized = useRef(false);

  // On first mount, force the preset list to our single course preset.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const presets = pluginDataStore.presets || [];
    const alreadyCourse = presets.length === 1 && presets[0].name === PRESET_COURSE_3;
    if (!alreadyCourse) {
      (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
        ...pluginDataStore,
        activePresetId: COURSE_PRESET._id,
        activePresetIdx: 0,
        presets: [COURSE_PRESET],
      });
    }
  }, [pluginDataStore]);

  // Manifest/step are owned by App so the left-panel tree and the runner stay in
  // sync; the runner is a controlled component.
  return (
    <OnlineCourse
      manifest={courseManifest ?? null}
      stepId={courseStepId ?? null}
      loadNote={courseLoadNote}
      onSelectStep={onSelectStep ?? (() => {})}
    />
  );
};

export default CustomPlugin;
