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
}) => {
  const isPresets = pluginPresets.length >= 2;

  return (
    <ul ref={dropdownRef} className={styles.preset_dropdown}>
      <li
        onClick={togglePresetsUpdatePopUp}
        id={PresetHandleAction.rename}
        className="d-flex align-items-center">
        <i className="item-icon dtable-font dtable-icon-rename"></i>
        <p className="ml-2">{intl.get('preset_rename').d(`${d.preset_rename}`)}</p>
      </li>
      <li
        onClick={togglePresetsUpdatePopUp}
        id={PresetHandleAction.duplicate}
        className="d-flex align-items-center">
        <i className="item-icon dtable-font dtable-icon-copy"></i>
        <p className="ml-2">{intl.get('preset_duplicate').d(`${d.preset_duplicate}`)}</p>
      </li>
      <li
        onClick={isPresets ? togglePresetsUpdatePopUp : undefined}
        id={PresetHandleAction.delete}
        className={`d-flex align-items-center ${isPresets ? 'clickable' : 'not-clickable'}`}
        style={{ pointerEvents: isPresets ? 'auto' : 'none' }}>
        <i
          className={`item-icon dtable-font dtable-icon-delete ${
            !isPresets ? stylesPPresets.isPresetsCondition : ''
          }`}></i>
        <p className={`ml-2 ${!isPresets ? stylesPPresets.isPresetsCondition : ''}`}>
          {intl.get('preset_delete').d(`${d.preset_delete}`)}
        </p>
      </li>
    </ul>
  );
};

export default PresetDropdown;
