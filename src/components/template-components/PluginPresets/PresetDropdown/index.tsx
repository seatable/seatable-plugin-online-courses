import React from 'react';
import styles from '../../../../styles/template-styles/Plugin.module.scss';
import stylesPPresets from '../../../../styles/template-styles/PluginPresets.module.scss';
import { IPresetDropdownProps } from '../../../../utils/template-interfaces/PluginPresets/Dropdown.interface';
import { PresetHandleAction } from '../../../../utils/template-constants';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../../locale';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

const PresetDropdown: React.FC<IPresetDropdownProps> = ({
  togglePresetsUpdatePopUp,
  dropdownRef,
  pluginPresets,
  presetName,
}) => {
  return (
    <ul ref={dropdownRef} className={styles.preset_dropdown}>
      <li
        onClick={togglePresetsUpdatePopUp}
        id={PresetHandleAction.rename}
        className="d-flex align-items-center">
        <i className="item-icon dtable-font dtable-icon-rename"></i>
        <p className="ml-2 mb-0">{intl.get('preset_rename').d(`${d.preset_rename}`)}</p>
      </li>
      <li
        onClick={togglePresetsUpdatePopUp}
        id={PresetHandleAction.reset}
        className="d-flex align-items-center">
        <i className="item-icon dtable-font dtable-icon-refresh"></i>
        <p className="ml-2 mb-0">{intl.get('preset_reset').d(`${d.preset_reset}`)}</p>
      </li>
    </ul>
  );
};

export default PresetDropdown;
