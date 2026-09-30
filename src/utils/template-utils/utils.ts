import pluginContext from '../../plugin-context';
import { AppActiveState, IPluginDataStore } from '../template-interfaces/App.interface';
import {
  PresetSettings,
  PresetsArray,
} from '../template-interfaces/PluginPresets/Presets.interface';
import {
  IActiveTableAndView,
  Table,
  TableArray,
  TableColumn,
  TableRow,
  TableView,
} from '../template-interfaces/Table.interface';
import {
  ACTIVE_PRESET_ID,
  DEFAULT_PLUGIN_DATA,
  PLUGIN_NAME,
  POSSIBLE,
  PresetHandleAction,
} from '../template-constants';
import info from '../../setting.local';

export const cleanAllTables = () => {
  let allTables: TableArray = window.dtableSDK.getTables().map((t: Table) => {
    let nextTable = {
      ...t,
      rows: [],
      id_row_map: {},
    };

    nextTable.views = nextTable.views.map((v: TableView) => {
      return {
        ...v,
        rows: [],
        formula_rows: {},
      };
    });

    return nextTable;
  }); // All the Tables of the Base

  return allTables;
};

export const cleanActiveTable = () => {
  let activeTable: Table = window.dtableSDK.getActiveTable();
  activeTable = {
    ...activeTable,
    rows: [],
    id_row_map: {},
  };
  return activeTable;
};

export const cleanActiveTableViews = (activeTable: Table) => {
  activeTable.views = activeTable.views.map((v: TableView) => {
    return {
      ...v,
      rows: [],
      formula_rows: {},
    };
  });
  return activeTable.views;
};

export const fetchMetaData = async (isDevelopment: boolean) => {
  const config = window.dtable;
  let { APIToken } = info;
  let BASE_UUID;
  let BASE_TOKEN;
  let server = isDevelopment ? info.server : config.server;

  try {
    // Fetch the base UUID and token
    const optionsToken = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${APIToken}`,
      },
    };
    const tokenResponse = await fetch(`${server}/api/v2.1/dtable/app-access-token/`, optionsToken);
    let { dtable_uuid, access_token } = await tokenResponse.json();
    BASE_UUID = isDevelopment ? dtable_uuid : config.dtableUuid;
    BASE_TOKEN = isDevelopment ? access_token : config.accessToken;
    // Fetch the metadata using the obtained token and UUID

    const optionsData = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${BASE_TOKEN}`,
      },
    };
    const dataResponse = await fetch(
      `${server}/api-gateway/api/v2/dtables/${BASE_UUID}/metadata/`,
      optionsData
    );
    const response = await dataResponse.json();

    return response.metadata;
  } catch (err) {
    console.error('Error fetching metadata:', err);
  }
};
export const generatorBase64Code = (keyLength = 4) => {
  let key = '';
  for (let i = 0; i < keyLength; i++) {
    key += POSSIBLE.charAt(Math.floor(Math.random() * POSSIBLE.length));
  }
  return key;
};

export const generatorPresetId = (presets: Array<{ _id: string }>): string => {
  let preset_id: string = '',
    isUnique = false;

  const isIdUnique = (id: string): boolean => {
    return presets?.every((item) => {
      return item._id !== id;
    });
  };

  while (!isUnique) {
    preset_id = generatorBase64Code(4);
    isUnique = isIdUnique(preset_id);

    if (isUnique) {
      break;
    }
  }

  return preset_id;
};

export const getImageThumbnailUrl = (url: string, size?: number): string => {
  const server = pluginContext.getSetting('server');
  let isInternalLink = url.indexOf(server) > -1;
  if (isInternalLink) {
    size = size || 256;
    let imageThumbnailUrl = url.replace('/workspace', '/thumbnail/workspace') + '?size=' + size;
    return imageThumbnailUrl;
  }
  return url;
};

export const isValidEmail = (email: string): boolean => {
  const reg = /^[A-Za-zd]+([-_.][A-Za-zd]+)*@([A-Za-zd]+[-.])+[A-Za-zd]{2,6}$/;

  return reg.test(email);
};

export const calculateColumns = (
  galleryColumnsName: string[],
  currentColumns: { name: string }[]
): { name: string }[] => {
  let newColumns: { name: string }[] = [];
  galleryColumnsName.forEach((columnName) => {
    let column = currentColumns.find((column) => columnName === column.name);
    if (column) {
      newColumns.push(column);
    }
  });
  return newColumns;
};

export const calculateColumnsName = (
  currentColumns: { name: string }[],
  galleryColumnsName: string[] | undefined
): string[] => {
  let newColumnsName: string[] = [];
  currentColumns.forEach((column) => {
    newColumnsName.push(column.name);
  });
  if (galleryColumnsName) {
    let columnsName: string[] = Array.from(new Set([...galleryColumnsName, ...newColumnsName]));
    newColumnsName = columnsName.filter((columnName) =>
      newColumnsName.some((c) => c === columnName)
    );
  }
  return newColumnsName;
};

export const checkDesktop = () => {
  return window.innerWidth >= 768;
};

export const isTableEditable = (
  {
    permission_type = 'default',
    permitted_users = [],
  }: { permission_type?: string; permitted_users?: string[] },
  TABLE_PERMISSION_TYPE: {
    DEFAULT: string;
    ADMINS: string;
    SPECIFIC_USERS: string;
  }
): boolean => {
  const { isAdmin, username } = window.dtable ? window.dtable : window.dtablePluginConfig;

  if (!permission_type) {
    return true;
  }
  if (permission_type === TABLE_PERMISSION_TYPE.DEFAULT) {
    return true;
  }
  if (permission_type === TABLE_PERMISSION_TYPE.ADMINS && isAdmin) {
    return true;
  }
  if (
    permission_type === TABLE_PERMISSION_TYPE.SPECIFIC_USERS &&
    permitted_users.includes(username)
  ) {
    return true;
  }
  return false;
};

export const canCreateRows = (
  table: { table_permissions?: { add_rows_permission?: any } },
  TABLE_PERMISSION_TYPE: {
    DEFAULT: string;
    ADMINS: string;
    SPECIFIC_USERS: string;
  }
): boolean => {
  let canCreateRows = true;
  if (table && table.table_permissions && table.table_permissions.add_rows_permission) {
    canCreateRows = isTableEditable(
      table.table_permissions.add_rows_permission,
      TABLE_PERMISSION_TYPE
    );
  }
  return canCreateRows;
};

export const needUseThumbnailImage = (url: string): string | boolean => {
  if (!url || url.lastIndexOf('.') === -1) {
    return false;
  }
  const image_suffix = url.substr(url.lastIndexOf('.') + 1).toLowerCase();
  const suffix = ['bmp', 'tif', 'tiff'];
  return suffix.includes(image_suffix);
};

export const isInternalImg = (url: string): boolean | undefined => {
  if (!url) return;
  return url.indexOf(window.dtable.server) > -1;
};

export const checkSVGImage = (url: string): boolean | undefined => {
  if (!url) return false;
  return url.substr(-4).toLowerCase() === '.svg';
};

export const truncateTableName = (tableName: string) => {
  let _tableName;

  if (tableName.split('').length > 22) {
    _tableName = tableName.slice(0, 20) + '...';

    return _tableName;
  }

  return tableName;
};

/**
 * Checks whether a preset name already exists in the presets array, excluding the current index.
 *
 * @param {string} presetName - The name of the preset to check for existence.
 * @param {PresetsArray} presets - An array of presets to search for duplicates.
 * @param {number} currentIndex - The index of the preset to exclude from the check.
 * @returns {boolean} - Returns true if the preset name already exists, excluding the current index.
 */
export const isUniquePresetName = (
  presetName: string,
  presets: PresetsArray,
  currentIndex: number
): boolean => {
  // Using the `some` method to check if any preset (excluding the current index) has the same name
  return presets.some((preset, index) => index !== currentIndex && preset.name === presetName);
};

export const appendPresetSuffix = (name: string, nameList: string[], suffix: string): string => {
  if (!nameList.includes(name.trim())) {
    return name;
  } else {
    let _name = `${name} ${suffix}`;
    return appendPresetSuffix(_name, nameList, suffix);
  }
};

/**
 * The function has the purpose of getting the plugin data
 * If the plugin presets are not found, it maps inside the activeTable and returns set it as value.
 * @param {string} PLUGIN_NAME The name of the plugin.
 * @param {Table} activeTable A Table object needed in the .
 * @returns An array with the plugin's presets
 */
// export const getPluginSettings = (activeTable: Table) => {
// Function implementation...
// };
export const getPluginDataStore = (activeTable: Table, PLUGIN_NAME: string) => {
  // Retrieving the Plugin Data as the IPluginDataStore
  const getPluginDataStore: IPluginDataStore = window.dtableSDK.getPluginSettings(PLUGIN_NAME); // getPluginSettings = getPluginDataStore

  return getPluginDataStore === null || getPluginDataStore.presets.length === 0
    ? createDefaultPluginDataStore(activeTable, PLUGIN_NAME)
    : getPluginDataStore;
};

/**
 * Parses plugin data to create the active state for the application.
 *
 * @param {IPluginDataStore} pluginDataStore - The data store containing plugin-related information.
 * @param {PresetsArray} pluginPresets - An array of presets used by the plugin.
 * @param {TableArray} allTables - An array containing all available tables in the application.
 */
export const parsePluginDataToActiveState = (
  pluginDataStore: IPluginDataStore,
  pluginPresets: PresetsArray,
  allTables: TableArray
) => {
  // Extract relevant data from the pluginDataStore and allTables arrays
  const id = localStorage.getItem(ACTIVE_PRESET_ID) || pluginPresets[0]._id;
  const idx =
    pluginPresets.findIndex((p) => p._id === id) === -1
      ? 0
      : pluginPresets.findIndex((p) => p._id === id);

  let table =
    allTables.find((t) => t._id === pluginPresets[idx].settings?.selectedTable?.value) ||
    allTables[0];
  let tableName = table.name;
  let tableView = table.views.find(
    (v) => v._id === pluginPresets[idx].settings?.selectedView?.value
  )!;

  // Create the appActiveState object with the extracted data
  const appActiveState = {
    activePresetId: id,
    activePresetIdx: idx,
    activeTable: table,
    activeTableName: tableName,
    activeTableView: tableView,
  };

  // Return the active state object
  return appActiveState;
};

/**
 * Safeguard function to determine the active state, considering the presence of presets.
 * If no presets are available, the first Table and View are set as the active ones.
 *
 * @param {PresetsArray} pluginPresets - An array of presets used by the plugin.
 * @param {Table} activeTable - The currently active table in the application.
 * @param {object} activeTableAndView - The active table and view as an object containing {table: Table, view: TableView}.
 * @param {TableRow[]} activeViewRows - An array of rows for the active view.
 */
export const getActiveStateSafeGuard = (
  pluginPresets: PresetsArray,
  activeTable: Table,
  activeTableAndView: {
    table: Table;
    view: TableView;
  },
  activeViewRows: TableRow[]
) => {
  // Create the checkForPresets object with the active state based on presets or default values
  const checkForPresets: AppActiveState = {
    activeTable: (pluginPresets[0] && (activeTableAndView?.table as Table)) || activeTable,
    activeTableName:
      (pluginPresets[0] && pluginPresets[0].settings?.selectedTable?.label) || activeTable.name,
    activeTableView:
      (pluginPresets[0] && (activeTableAndView?.view as TableView)) || activeTable.views[0],
    activePresetId: (pluginPresets[0] && pluginPresets[0]._id) || '0000', // '0000' as Safe guard if there are no presets
    activePresetIdx: 0,
    activeViewRows: activeViewRows,
  };

  // Return the active state object considering presets or default values
  return checkForPresets;
};

/**
 * Retrieves the active table and view based on the preset handling action type.
 *
 * @param pluginPresets - Array of plugin presets.
 * @param allTables - Array of all available tables.
 * @param type - Type of preset handling action (e.g., new, duplicate).
 * @param option - Additional options for handling presets (e.g., preset ID, preset settings).
 * @returns An object containing the active table and view.
 */
export const getActiveTableAndActiveView = (
  pluginPresets: PresetsArray,
  allTables: TableArray,
  type?: string,
  option?: { pId: string; pSettings: PresetSettings }
) => {
  let tableViewObj;
  let table;
  let views;
  let view;

  // Type === 'new' we set the first Table and View as the active ones
  // Type === 'duplicate' we set the selected Table and View as the active ones
  // Type === undefined we set the last used Table and View as the active ones (TO-DO)
  if (type === PresetHandleAction.new) {
    table = allTables[0];
    view = table?.views[0];
  } else if (type === PresetHandleAction.duplicate) {
    table = allTables.find((i) => i.name === option?.pSettings.selectedTable?.label)!;
    views = table?.views;
    view = views?.find((v) => {
      return v.name === option?.pSettings.selectedView?.label;
    })!;
  } else if (pluginPresets.length > 0 && type === undefined) {
    // This needs to be changes since in this case we need to retrieve the Last Preset used from the USER
    table = allTables.find((i) => i.name === pluginPresets[0].settings?.selectedTable?.label)!;
    views = table?.views;
    view = views?.find((v) => {
      return v.name === pluginPresets[0].settings?.selectedView?.label;
    })!;
  }

  return (tableViewObj = {
    table: table,
    view: view,
  } as IActiveTableAndView);
};

/**
 * Creates a default preset for the plugin.
 * @param activeTable - The active table for which it retrieves the info.
 * @param pluginName - The name of the plugin associated with the preset.
 * @returns The default preset with initial settings.
 */
export const createDefaultPluginDataStore = (
  activeTable: Table,
  pluginName: string
): IPluginDataStore => {
  // This is a safe guard to prevent the plugin from crashing if there are no presets
  const _presetSettings: PresetSettings = {
    selectedTable: { value: activeTable._id, label: activeTable.name },
    selectedView: { value: activeTable.views[0]._id, label: activeTable.views[0].name },
  };

  // Importing the default settings from the constants file and updating the presets array with the Default Settings
  const updatedDefaultDataStore = {
    ...DEFAULT_PLUGIN_DATA,
    [PLUGIN_NAME]: pluginName,
    presets: [
      {
        ...DEFAULT_PLUGIN_DATA.presets[0],
        settings: _presetSettings,
      },
    ],
  };
  window.dtableSDK.updatePluginSettings(pluginName, updatedDefaultDataStore);
  return updatedDefaultDataStore;
};

/**
 * Creates default preset settings based on the provided array of tables.
 *
 * @param {TableArray} allTables - An array containing all available tables in the application.
 * @returns {object} defaultPresetSettings - Default settings for a preset.
 */
export const createDefaultPresetSettings = (allTables: TableArray) => {
  // Extract information for the default table and view
  const tableInfo = { value: allTables[0]._id, label: allTables[0].name };
  const viewInfo = { value: allTables[0].views[0]._id, label: allTables[0].views[0].name };

  // Create and return the default preset settings object
  return {
    shown_image_name: 'Image',
    shown_title_name: 'Title',
    selectedTable: tableInfo,
    selectedView: viewInfo,
  };
};

export const findPresetName = (presets: PresetsArray, presetId: string) => {
  return presets.find((preset) => preset._id === presetId)?.name;
};

export const isMobile = () => {
  return window.innerWidth <= 800;
};

export const getDefaultLinkColumn = (table: Table) => {
  return table.columns.filter((c: TableColumn) => c.type === 'link')[0];
};
