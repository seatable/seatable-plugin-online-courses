import React, { useState, useEffect } from 'react';
import styles from '../../../styles/template-styles/Plugin.module.scss';
import stylesPPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import { IHeaderProps } from '../../../utils/template-interfaces/Header.interface';
import { PLUGIN_ID } from '../../../utils/template-constants';
import { HiOutlineChevronDoubleRight } from 'react-icons/hi2';

import { useReactFlow } from 'reactflow';
import { setViewportPluginDataStoreFn } from '../../../utils/custom-utils/utils';

const Header: React.FC<IHeaderProps> = (props) => {
  const {
    presetName,
    isShowPresets,
    onTogglePresets,
    togglePlugin,
    pluginDataStore,
    appActiveState,
  } = props;
  const [customComponentContent, setCustomComponentContent] = useState<string | null>(null);
  const reactFlowInstance = useReactFlow();

  useEffect(() => {
    const input = document.getElementById(PLUGIN_ID);
    if (input) {
      setCustomComponentContent(input.innerHTML);
    }
  }, []);

  function onToggleView() {
    reactFlowInstance.fitView();
    const fitView = reactFlowInstance.getViewport();
    setViewportPluginDataStoreFn(pluginDataStore, appActiveState.activePresetId, fitView);
  }

  return (
    <div className={styles.plugin_header}>
      <div className={'d-flex align-items-center justify-content-start'}>
        <div className={`align-items-center ${isShowPresets ? 'd-none' : 'd-flex'} `}>
          <button
            className={stylesPPresets.presets_uncollapse_btn2_settings}
            onClick={onTogglePresets}>
            <HiOutlineChevronDoubleRight />
          </button>
        </div>
        <div className={styles.plugin_header_pluginName}>
          <p className="font-weight-bold">{presetName}</p>
        </div>
      </div>

      <div
        className={`d-flex align-items-center justify-content-end ${styles.plugin_header_settings}`}>
        <span className={styles.plugin_header_icon_btn} onClick={onToggleView}>
          <span className="dtable-font dtable-icon-full-screen"></span>
        </span>
        <span className={styles.plugin_header_icon_btn} onClick={togglePlugin}>
          <span className="dtable-font dtable-icon-x"></span>
        </span>
      </div>
    </div>
  );
};

export default Header;
