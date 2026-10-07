/* eslint-disable react-hooks/exhaustive-deps */

import React, { useEffect, useState } from 'react';
// Interfaces
import { IPresetItemProps } from '../../../../utils/template-interfaces/PluginPresets/Item.interface';
// Styles
import styles from '../../../../styles/template-styles/Plugin.module.scss';
import '../../../../assets/css/plugin-layout.css';

// One course in the left-hand list. The course presets are fixed (see
// custom-components/index.tsx): selecting one is the only action, so the template's
// rename / duplicate / delete menu and its name input are gone.
const PresetItem: React.FC<IPresetItemProps> = ({
  p,
  activePresetIdx,
  pluginPresets,
  onSelectPreset,
}) => {
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

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <div
          onClick={() => onSelectPreset(p?._id)}
          style={{ display: 'flex' }}
          className={
            pluginPresets[activePresetIdx]?._id === p?._id
              ? styles.plugin_header_viewBtn_active
              : styles.plugin_header_viewBtn
          }>
          <div className="d-flex align-items-center">
            <p className="mb-0">{pName}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PresetItem;
