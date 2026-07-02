/* eslint-disable react-hooks/exhaustive-deps */

import React, { useEffect, useState } from 'react';
// External dependencies
import useClickOut from '../../../../hooks/useClickOut';
// Internal dependencies
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
  exportPreset,
  resetPreset,
  onSelectPreset,
  duplicatePreset,
  togglePresetsUpdate,
  onToggleSettings,
  isShowState,
  setIsShowState,
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

  // Allow remote opens of this preset's dropdown via a custom event so other
  // surfaces (e.g. TablesAudit's "not run yet" hint link) can guide the user
  // into the menu without prop-drilling a setter through several layers.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.presetId && detail.presetId === p?._id) {
        setShowPresetDropdown(true);
      }
    };
    window.addEventListener('audit:open-preset-menu', handler);
    return () => window.removeEventListener('audit:open-preset-menu', handler);
  }, [p?._id]);

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
      case PresetHandleAction.reset:
        resetPreset();
        setShowPresetDropdown(false);
        break;
      case PresetHandleAction.runPerf:
        // Fire-and-forget — TablesAudit listens for this event on its active
        // preset id and triggers the run. PresetItem doesn't import / depend
        // on TablesAudit's state.
        window.dispatchEvent(new CustomEvent('audit:run-perf', { detail: { presetId: p?._id } }));
        setShowPresetDropdown(false);
        break;
      case PresetHandleAction.export:
        setIsShowState({ ...isShowState, isShowWaiting: true });
        togglePresetDropdown();
        exportPreset();
        break;
      default:
    }
  };

  const onClickPreset = (_e: React.MouseEvent<HTMLElement>) => {
    // v0: double-click-to-open-settings disabled — selecting the course is the
    // only action. Settings panel is kept in code but has no trigger for now.
    onSelectPreset(p?._id);
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
          {/* v0: single fixed course preset — drag handle, settings gear and the
              "..." dropdown menu are intentionally removed. The settings panel code
              is kept (see app.tsx / PluginSettings) but has no trigger for now.
              (Re-add the gear span here temporarily if you need to inspect the
              account-token field again.) */}
        </div>
      </div>
    </div>
  );
};

export default PresetItem;
