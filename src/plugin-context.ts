import { PluginContext } from './utils/template-interfaces/PluginContext.interface';

const pluginContext: PluginContext = {
  getConfig: () => (window.dtable ? window.dtable : window.dtablePluginConfig),
  getSetting: (key: string) => (window.dtable ? window.dtable[key] : '') || '',
  getInitData: () => window.app && window.app.dtableStore,
  expandRow: (row, table) => window.app && window.app.expandRow(row, table),
  closePlugin: () => window.app && window.app.onClosePlugin(),
  getUserCommonInfo: (email, avatar_size) => {
    if (!window.dtableWebAPI) return Promise.reject();
    return window.dtableWebAPI.getUserCommonInfo(email, avatar_size);
  },
};

export default pluginContext;
