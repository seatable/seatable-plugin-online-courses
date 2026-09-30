/* eslint-disable react-hooks/exhaustive-deps */

import React, { useEffect, useState } from 'react';
import { BsThreeDots } from 'react-icons/bs';
// External dependencies
import useClickOut from '../../../../hooks/useClickOut';
// Internal dependencies
import PresetDropdown from '../PresetDropdown';
import PresetInput from '../PresetInput';
// Constants
import { PresetHandleAction } from '../../../../utils/template-constants';
// Interfaces
import { IPresetItemProps } from '../../../../utils/template-interfaces/PluginPresets/Item.interface';
// Styles
import styles from '../../../../styles/template-styles/Plugin.module.scss';
import '../../../../assets/css/plugin-layout.css';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../../locale';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

const PresetItem: React.FC<IPresetItemProps> = ({
  p,
  activePresetIdx,
  presetName,
  pluginPresets,
  presetNameAlreadyExists,
  onChangePresetName,
  deletePreset,
  onSelectPreset,
  duplicatePreset,
  togglePresetsUpdate,
  onToggleSettings,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [pName, setPName] = useState(p.name);

  const onWindowResize = () => {
    if (window.innerWidth <= 1200 && p.name.length > 15) {
      setPName(p.name.slice(0, 15) + '...');
    } else if (window.innerWidth > 1200 && p.name.length > 25) {
      setPName(p.name.slice(0, 25) + '...');
    } else {
      setPName(p.name);
    }
  };

  useEffect(() => {
    onWindowResize();
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
    };
  }, [p.name]);

  let popupDomNode = useClickOut(() => {
    setShowPresetDropdown(false);
  });

  // toggle Preset dropdown(edit/delete)
  const togglePresetDropdown = () => {
    setShowPresetDropdown((prev) => !prev);
  };

  // Update a Preset
  const handlePresetsUpdate = (e: React.MouseEvent<HTMLElement>) => {
    const action = e.currentTarget.id;
    switch (action) {
      case PresetHandleAction.delete:
        deletePreset();
        togglePresetDropdown();
        break;
      case PresetHandleAction.rename:
        setIsEditing((prev) => !prev);
        togglePresetsUpdate(e, PresetHandleAction.edit);
        togglePresetDropdown();
        setShowPresetDropdown(false);
        break;
      case PresetHandleAction.duplicate:
        duplicatePreset(p);
        setShowPresetDropdown(false);
        break;
      default:
    }
  };

  const onClickPreset = (e: React.MouseEvent<HTMLElement>) => {
    if (e.detail === 2) {
      onToggleSettings();
    } else {
      onSelectPreset(p?._id);
    }
  };

  return (
    <div>
      <PresetInput
        onChangePresetName={onChangePresetName}
        isEditing={isEditing}
        setIsEditing={setIsEditing}
        presetName={presetName}
      />
      {presetNameAlreadyExists && (
        <div
          className="px-2 d-flex justify-content-start mt-1"
          style={{ fontSize: '11px', fontWeight: 'bold' }}>
          <span className="text-danger text-sm">
            {intl.get('preset_warn_exist').d(`${d.preset_warn_exist}`)}
          </span>
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div
          onClick={onClickPreset}
          style={{ display: isEditing ? 'none' : 'flex' }}
          className={
            pluginPresets[activePresetIdx]?._id === p?._id
              ? styles.plugin_header_viewBtn_active
              : styles.plugin_header_viewBtn
          }>
          <div className="d-flex align-items-center">
            <p className="mb-0">{pName}</p>
          </div>
          <span className="d-flex align-items-center">
            <span>
              <i
                className={`dtable-font dtable-icon-drag mr-1 ${styles.plugin_header_viewBtn_icons}`}></i>
            </span>
            <span
              className={`dtable-font dtable-icon-set-up ${styles.plugin_header_viewBtn_settings}`}
              onClick={onToggleSettings}></span>
            <BsThreeDots
              className={`ml-1 ${styles.plugin_header_viewBtn_icons}`}
              onClick={togglePresetDropdown}
            />
          </span>
        </div>
        {showPresetDropdown && (
          <PresetDropdown
            dropdownRef={popupDomNode}
            pluginPresets={pluginPresets}
            togglePresetsUpdatePopUp={handlePresetsUpdate}
          />
        )}
      </div>
    </div>
  );
};

export default PresetItem;
