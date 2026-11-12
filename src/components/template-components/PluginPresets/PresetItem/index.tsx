/* eslint-disable react-hooks/exhaustive-deps */

import React, { useEffect, useState } from 'react';
// Interfaces
import { IPresetItemProps } from '../../../../utils/template-interfaces/PluginPresets/Item.interface';
import { courseName } from '../../../../utils/custom-utils/courseContent';
// Styles
import styles from '../../../../styles/template-styles/Plugin.module.scss';

// One course in the left-hand list. Selecting it is the only action.
const PresetItem: React.FC<IPresetItemProps> = ({ p, active, onSelectPreset }) => {
  // The name in the current language.
  const name: string = courseName(p._id) ?? p.name;
  const [pName, setPName] = useState(name);

  const onWindowResize = () => {
    if (window.innerWidth <= 1200 && name.length > 15) {
      setPName(name.slice(0, 15) + '...');
    } else if (window.innerWidth > 1200 && name.length > 25) {
      setPName(name.slice(0, 25) + '...');
    } else {
      setPName(name);
    }
  };

  useEffect(() => {
    onWindowResize();
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
    };
  }, [name]);

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <div
          onClick={() => onSelectPreset(p?._id)}
          style={{ display: 'flex' }}
          className={active ? styles.plugin_header_viewBtn_active : styles.plugin_header_viewBtn}>
          <div className="d-flex align-items-center">
            <p className="mb-0">{pName}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PresetItem;
