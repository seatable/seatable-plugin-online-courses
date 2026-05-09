/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useState } from 'react';

// Import of Component
import Header from './components/template-components/Header';
import PluginSettings from './components/template-components/PluginSettings';
import PluginPresets from './components/template-components/PluginPresets';
import ResizableWrapper from './components/template-components/ResizableWrapper';
import CustomPlugin from './components/custom-components/index';
// Import of Interfaces
import {
  AppActiveState,
  AppIsShowState,
  IAppProps,
  IPluginDataStore,
} from './utils/template-interfaces/App.interface';
import { AuditTableDisplayState } from './utils/custom-interfaces/AuditTypes';
import {
  TableArray,
  TableViewArray,
  Table,
  TableView,
  TableRow,
  IActiveTableAndView,
} from './utils/template-interfaces/Table.interface';
import { PresetsArray } from './utils/template-interfaces/PluginPresets/Presets.interface';
// Import of CSS
import styles from './styles/template-styles/Plugin.module.scss';
import './assets/css/plugin-layout.css';
// Import of Constants
import {
  INITIAL_IS_SHOW_STATE,
  INITIAL_CURRENT_STATE,
  PLUGIN_NAME,
  DEFAULT_PLUGIN_DATA,
  ACTIVE_PRESET_ID,
} from './utils/template-constants';
import './locale';
import {
  cleanActiveTable,
  cleanActiveTableViews,
  cleanAllTables,
  createDefaultPluginDataStore,
  findPresetName,
  getActiveStateSafeGuard,
  getActiveTableAndActiveView,
  getPluginDataStore,
  isMobile,
  parsePluginDataToActiveState,
} from './utils/template-utils/utils';
const App: React.FC<IAppProps> = (props) => {
  const { isDevelopment, lang } = props;

  // Boolean state to show/hide the plugin's components
  const [isShowState, setIsShowState] = useState<AppIsShowState>(INITIAL_IS_SHOW_STATE);
  const { isShowPlugin, isShowSettings, isLoading, isShowPresets } = isShowState;
  // Tables, Presets, Views as dataStates. The main data of the plugin
  const [allTables, setAllTables] = useState<TableArray>([]);
  const [activeTableViews, setActiveTableViews] = useState<TableViewArray>([]);
  const [pluginDataStore, setPluginDataStore] = useState<IPluginDataStore>(DEFAULT_PLUGIN_DATA);
  const [pluginPresets, setPluginPresets] = useState<PresetsArray>([]);
  // Transient: true while the on-demand performance analysis is in flight.
  // Used by PluginSettings to disable the staleness-rerun link.
  const [perfRunning, setPerfRunning] = useState(false);
  // appActiveState: Define the app's active Preset + (Table + View) state using the useState hook
  const [appActiveState, setAppActiveState] = useState<AppActiveState>(INITIAL_CURRENT_STATE);
  // Destructure properties from the app's active state for easier access
  const { activeTable, activePresetId, activePresetIdx } = appActiveState;

  useEffect(() => {
    initPluginDTableData();
    return () => {
      unsubscribeLocalDtableChanged();
      unsubscribeRemoteDtableChanged();
    };
  }, []);

  useEffect(() => {
    if (isMobile()) {
      setIsShowState((prevState) => ({ ...prevState, isShowPresets: false }));
    }
  }, []);

  const initPluginDTableData = async () => {
    if (isDevelopment) {
      window.dtableSDK.subscribe('dtable-connect', () => {
        onDTableConnect();
      });
    }
    unsubscribeLocalDtableChanged = window.dtableSDK.subscribe('local-dtable-changed', () => {
      onDTableChanged();
    });
    unsubscribeRemoteDtableChanged = window.dtableSDK.subscribe('remote-dtable-changed', () => {
      onDTableChanged();
    });
    resetData();
  };

  let unsubscribeLocalDtableChanged = () => {
    throw new Error('Method not implemented.');
  };
  let unsubscribeRemoteDtableChanged = () => {
    throw new Error('Method not implemented.');
  };

  const onDTableConnect = () => {
    resetData();
  };
  const onDTableChanged = () => {
    resetData();
  };

  const resetData = async () => {
    let allTables: TableArray = cleanAllTables();
    let activeTable: Table = cleanActiveTable();
    let activeTableViews: TableViewArray = cleanActiveTableViews(activeTable);
    let pluginDataStore: IPluginDataStore = getPluginDataStore(activeTable, PLUGIN_NAME);
    let pluginPresets: PresetsArray = pluginDataStore.presets;

    let localActivePresetId = localStorage.getItem(ACTIVE_PRESET_ID);
    if (!localActivePresetId) {
      localActivePresetId = pluginPresets[0]._id;
      localStorage.setItem(ACTIVE_PRESET_ID, localActivePresetId);
    }
    setPluginDataStore(pluginDataStore);
    setAllTables(allTables);
    setPluginPresets(pluginPresets);
    setIsShowState((prevState) => ({ ...prevState, isLoading: false }));

    if (localActivePresetId) {
      const appActiveState = parsePluginDataToActiveState(
        pluginDataStore,
        pluginPresets,
        allTables
      );

      onSelectPreset(localActivePresetId, appActiveState);
      return;
    } else {
      if (pluginPresets.length === 0) {
        const defaultPluginDataStore: IPluginDataStore = createDefaultPluginDataStore(
          activeTable,
          PLUGIN_NAME
        );
        window.dtableSDK.updatePluginSettings(PLUGIN_NAME, defaultPluginDataStore);
      }
      const activeTableAndView: IActiveTableAndView = getActiveTableAndActiveView(
        pluginPresets,
        allTables
      );
      const activeViewRows: TableRow[] = [];

      const activeStateSafeGuard = getActiveStateSafeGuard(
        pluginPresets,
        activeTable,
        activeTableAndView,
        activeViewRows
      );

      setActiveTableViews(activeTableAndView?.table?.views || activeTableViews);
      setAppActiveState(activeStateSafeGuard);
    }
  };

  const onPluginToggle = () => {
    setTimeout(() => {
      setIsShowState((prevState) => ({ ...prevState, isShowPlugin: false }));
    }, 300);
    window.app.onClosePlugin(lang);
  };

  const onSelectPreset = (presetId: string, newPresetActiveState?: AppActiveState) => {
    localStorage.setItem(ACTIVE_PRESET_ID, presetId);

    let updatedActiveState: AppActiveState;
    let updatedActiveTableViews: TableView[];
    const _activePresetIdx = pluginPresets.findIndex((preset) => preset._id === presetId);

    if (newPresetActiveState !== undefined) {
      updatedActiveState = {
        ...newPresetActiveState,
      };
      updatedActiveTableViews = newPresetActiveState?.activeTable?.views!;
    } else {
      const activePreset = pluginPresets.find((preset) => preset._id === presetId);
      const selectedTable = activePreset?.settings?.selectedTable;
      const selectedView = activePreset?.settings?.selectedView;

      const _activeTableName = selectedTable?.label as string;
      const _activeTableId = selectedTable?.value as string;
      const _activeViewId = selectedView?.value as string;

      updatedActiveTableViews =
        allTables.find((table) => table._id === _activeTableId)?.views || [];

      updatedActiveState = {
        activeTable: allTables.find((table) => table._id === _activeTableId) || activeTable,
        activeTableName: _activeTableName,
        activeTableView:
          updatedActiveTableViews.find((view) => view._id === _activeViewId) || activeTableViews[0],
        activePresetId: presetId,
        activePresetIdx: _activePresetIdx,
      };

      updatePluginDataStore({
        ...pluginDataStore,
        activePresetId: presetId,
        activePresetIdx: _activePresetIdx,
      });
    }

    setActiveTableViews(updatedActiveTableViews);
    setAppActiveState(updatedActiveState);
  };

  const updatePresets = (
    _activePresetIdx: number,
    updatedPresets: PresetsArray,
    pluginDataStore: IPluginDataStore,
    activePresetId: string,
    callBack: any = null
  ) => {
    let _pluginDataStore = {
      ...pluginDataStore,
      activePresetId: activePresetId,
      activePresetIdx: _activePresetIdx,
    };
    const updatedActiveState = (prevState: AppActiveState) => ({
      ...prevState,
      activePresetIdx: _activePresetIdx,
    });

    setAppActiveState((prevState: AppActiveState) => updatedActiveState(prevState));
    setPluginPresets(updatedPresets);
    setPluginDataStore(pluginDataStore);
    updatePluginDataStore(_pluginDataStore);
  };

  const updatePluginDataStore = (pluginDataStore: IPluginDataStore) => {
    window.dtableSDK.updatePluginSettings(PLUGIN_NAME, pluginDataStore);
  };

  const updateActiveData = () => {
    let allTables: TableArray = cleanAllTables();
    let tableOfPresetOne = pluginPresets[0].settings?.selectedTable || {
      value: allTables[0]._id,
      label: allTables[0].name,
    };
    let viewOfPresetOne = pluginPresets[0].settings?.selectedView || {
      value: allTables[0].views[0]._id,
      label: allTables[0].views[0].name,
    };
    let table = allTables.find((t) => t._id === tableOfPresetOne.value)!;
    let view = table?.views.find((v) => v._id === viewOfPresetOne.value)!;

    const newPresetActiveState: AppActiveState = {
      activePresetId: pluginPresets[0]._id,
      activePresetIdx: 0,
      activeTable: table,
      activeTableName: table.name,
      activeTableView: view,
      activeViewRows: [],
    };

    setAppActiveState(newPresetActiveState);
  };

  const toggleSettings = () => {
    if (isMobile() && isShowState.isShowPresets) {
      togglePresets();
    }

    setIsShowState((prevState) => ({ ...prevState, isShowSettings: !prevState.isShowSettings }));
  };

  const togglePresets = () => {
    if (isMobile() && isShowState.isShowSettings) {
      toggleSettings();
    }

    setIsShowState((prevState) => ({ ...prevState, isShowPresets: !prevState.isShowPresets }));
  };

  const getAccountToken = (): string => {
    // Shared across all presets — stored at store level
    return pluginDataStore.accountToken || '';
  };

  const handleSaveAccountToken = (token: string) => {
    const updatedStore = { ...pluginDataStore, accountToken: token };
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getVerifyUrls = (): boolean => {
    const activePreset = pluginPresets[activePresetIdx];
    return activePreset?.customSettings?.verifyUrls ?? false;
  };

  const handleVerifyUrlsChange = (value: boolean) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, verifyUrls: value } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getAutoRerun = (): boolean => {
    const activePreset = pluginPresets[activePresetIdx];
    return activePreset?.customSettings?.autoRerun ?? false;
  };

  const handleAutoRerunChange = (value: boolean) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, autoRerun: value } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getAuditTableDisplay = (): AuditTableDisplayState => {
    const activePreset = pluginPresets[activePresetIdx];
    const saved = activePreset?.customSettings?.auditTableDisplay;
    if (saved) return saved;
    // Default: all tables selected.
    return {
      selectedTables: allTables.map((t) => t._id),
      isAllSelected: true,
    };
  };

  const handleAuditTableDisplayChange = (display: AuditTableDisplayState) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, auditTableDisplay: display } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  if (!isShowPlugin) {
    return null;
  }

  return isLoading ? (
    <div></div>
  ) : (
    <ResizableWrapper>
      {/* presets  */}
      <PluginPresets
        appActiveState={appActiveState}
        allTables={allTables}
        pluginPresets={pluginPresets}
        activePresetIdx={activePresetIdx}
        pluginDataStore={pluginDataStore}
        isShowPresets={isShowPresets}
        onTogglePresets={togglePresets}
        onToggleSettings={toggleSettings}
        onSelectPreset={onSelectPreset}
        updatePresets={updatePresets}
        updateActiveData={updateActiveData}
        isShowState={isShowState}
        setIsShowState={setIsShowState}
      />
      <div className={styles.plugin} style={{ flex: 1, width: 'auto', minWidth: 0 }}>
        <Header
          presetName={findPresetName(pluginPresets, activePresetId)}
          isShowPresets={isShowPresets}
          isShowSettings={isShowSettings}
          onTogglePresets={togglePresets}
          toggleSettings={toggleSettings}
          togglePlugin={onPluginToggle}
        />
        {/* main body  */}
        <div
          className="d-flex position-relative"
          style={{ height: 'calc(100% - 50px)', width: '100%', backgroundColor: '#f5f5f5' }}>
          <div
            id={PLUGIN_NAME}
            className={styles.body}
            style={{ padding: '10px', flex: '1', minWidth: 0 }}>
            <CustomPlugin
              appActiveState={appActiveState}
              allTables={allTables}
              pluginDataStore={pluginDataStore}
              verifyUrls={getVerifyUrls()}
              auditTableDisplay={getAuditTableDisplay()}
              autoRerun={getAutoRerun()}
              onPerfRunningChange={setPerfRunning}
            />
          </div>

          <PluginSettings
            allTables={allTables}
            appActiveState={appActiveState}
            activeTableViews={activeTableViews}
            pluginPresets={pluginPresets}
            isShowSettings={isShowSettings}
            onToggleSettings={toggleSettings}
            onSaveAccountToken={handleSaveAccountToken}
            accountToken={getAccountToken()}
            verifyUrls={getVerifyUrls()}
            onVerifyUrlsChange={handleVerifyUrlsChange}
            auditTableDisplay={getAuditTableDisplay()}
            onAuditTableDisplayChange={handleAuditTableDisplayChange}
            autoRerun={getAutoRerun()}
            onAutoRerunChange={handleAutoRerunChange}
            perfRunning={perfRunning}
          />
        </div>
      </div>
    </ResizableWrapper>
  );
};

export default App;
