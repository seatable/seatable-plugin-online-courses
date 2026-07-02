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
  // Course navigation (owned by App; the runner is controlled).
  courseManifest?: CourseManifest | null;
  courseStepId?: string | null;
  courseLoadNote?: string;
  onSelectStep?: (stepId: string) => void;
}
