/* eslint-disable react-hooks/exhaustive-deps */

import React, { useEffect, useRef, useState } from 'react';
import styles2 from '../../../../styles/template-styles/PluginPresets.module.scss';
import { IPresetInput } from '../../../../utils/template-interfaces/PluginPresets/Input.interface';
import { KeyDownActions } from '../../../../utils/template-constants';

const PresetInput: React.FC<IPresetInput> = ({
  presetName,
  onChangePresetName,
  isEditing,
  setIsEditing,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [_presetName, setPresetName] = useState('');
  const [blurCausedByKeyDown, setBlurCausedByKeyDown] = useState(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      setPresetName(presetName);
      inputRef.current.focus();
      setTimeout(() => {
        inputRef?.current?.select();
      }, 0);
    }
  }, [isEditing]);

  const onChangePresetNameSubmit = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPresetName(e.target.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case KeyDownActions.enter:
        onChangePresetName(e);
        break;
      case KeyDownActions.escape: {
        setBlurCausedByKeyDown(true);
        setIsEditing(false);
        break;
      }
      default:
        break;
    }
  };

  const handleFocusOut = (e: React.FormEvent<HTMLInputElement>) => {
    if (!blurCausedByKeyDown) {
      onChangePresetName(e);
      setBlurCausedByKeyDown(false);
    }
  };

  return (
    <div className={styles2.presets_input} style={{ display: !isEditing ? 'none' : 'flex' }}>
      <input
        id="select-input"
        ref={inputRef}
        value={_presetName}
        onKeyDown={onKeyDown}
        onChange={onChangePresetNameSubmit}
        onBlur={handleFocusOut}
      />
    </div>
  );
};

export default PresetInput;
