import React from 'react';
import { ICustomPluginProps } from '../../utils/custom-interfaces/CustomPlugin.interface';
import OnlineCourse from './OnlineCourse';

// The active course's manifest/step are owned by App so the left-panel tree and the
// runner stay in sync; the runner is a controlled component. onSelectStep is
// pre-bound to the active course by App.
const CustomPlugin: React.FC<ICustomPluginProps> = ({
  courseManifest,
  courseStepId,
  onSelectStep,
  baseVersion,
  onFloatControls,
  onRequestFloat,
  onContentHeight,
}) => (
  <OnlineCourse
    manifest={courseManifest ?? null}
    stepId={courseStepId ?? null}
    onSelectStep={onSelectStep ?? (() => {})}
    baseVersion={baseVersion ?? 0}
    onFloatControls={onFloatControls}
    onRequestFloat={onRequestFloat}
    onContentHeight={onContentHeight}
  />
);

export default CustomPlugin;
