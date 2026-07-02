import React from 'react';
import styles from '../../../styles/template-styles/Plugin.module.scss';
import stylesPPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import { IHeaderProps } from '../../../utils/template-interfaces/Header.interface';
import { HiOutlineChevronDoubleRight } from 'react-icons/hi2';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../locale';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

const Header: React.FC<IHeaderProps> = (props) => {
  const { presetName, isShowPresets, onTogglePresets, togglePlugin, expanded, onToggleExpanded } =
    props;

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
        {onToggleExpanded && (
          // Toggle a full-height plugin vs the compact bottom banner, so learners
          // don't have to close and reopen it. Arrow points down when expanded
          // (click to shrink) and up when reduced (click to grow).
          <span
            className={styles.plugin_header_icon_btn}
            onClick={onToggleExpanded}
            title={expanded ? 'Reduce' : 'Expand'}>
            <span
              className="dtable-font dtable-icon-down"
              style={{ border: 'none', transform: expanded ? 'none' : 'rotate(180deg)' }}></span>
          </span>
        )}
      </div>

      <div
        className={`d-flex align-items-center justify-content-end ${styles.plugin_header_settings}`}>
        <span className={styles.plugin_header_icon_btn} onClick={togglePlugin}>
          <span
            className="dtable-font dtable-icon-x"
            style={{ border: 'none' }}
            title={intl.get('custom_plugin.close').d(`${d.custom_plugin.close}`)}></span>
        </span>
      </div>
    </div>
  );
};

export default Header;
