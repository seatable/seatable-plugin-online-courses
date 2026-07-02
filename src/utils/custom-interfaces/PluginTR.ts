import { AppActiveState, IPluginDataStore } from '../template-interfaces/App.interface';
import { TableArray } from '../template-interfaces/Table.interface';
import { AuditTableDisplayState } from './AuditTypes';
import { CourseManifest } from '../custom-utils/courseContent';

export interface IPluginTRProps {
  appActiveState: AppActiveState;
  pluginDataStore: IPluginDataStore;
  allTables: TableArray;
  verifyUrls?: boolean;
  auditTableDisplay?: AuditTableDisplayState;
  autoRerun?: boolean;
  onPerfRunningChange?: (running: boolean) => void;
  // Active course, owned by App; the runner is controlled. `onSelectStep` is
  // pre-bound to the active course (the runner only navigates within it).
  courseManifest?: CourseManifest | null;
  courseStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
}
