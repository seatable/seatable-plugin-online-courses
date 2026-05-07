import { AppActiveState, IPluginDataStore } from '../template-interfaces/App.interface';
import { TableArray } from '../template-interfaces/Table.interface';
import { AuditTableDisplayState } from './AuditTypes';

export interface IPluginTRProps {
  appActiveState: AppActiveState;
  pluginDataStore: IPluginDataStore;
  allTables: TableArray;
  verifyUrls?: boolean;
  auditTableDisplay?: AuditTableDisplayState;
  autoRerun?: boolean;
  onPerfRunningChange?: (running: boolean) => void;
}
