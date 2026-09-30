export interface PluginContext {
  getConfig: () => any;
  getSetting: (key: string) => string;
  getInitData: () => any;
  expandRow: (row: any, table: any) => void;
  closePlugin: () => void;
  getUserCommonInfo: (email: string, avatar_size: number) => Promise<any>;
}
