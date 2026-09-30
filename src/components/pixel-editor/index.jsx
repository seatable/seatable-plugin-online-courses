import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { v4 as uuidv4 } from 'uuid';
import { isNumber } from 'dtable-utils';
import NumberInput from './number-input';

import './index.css';

const PixelEditor = (props) => {
  const { pixel, readOnly } = props;
  const [currPixel, setCurrPixel] = useState(isNumber(pixel) ? pixel : null);

  const mountRef = useRef(false);
  const uniqueId = useRef(uuidv4());

  useEffect(() => {
    if (!mountRef.current) {
      mountRef.current = true;
    } else {
      setCurrPixel(isNumber(props.pixel) ? props.pixel : null);
    }
  }, [props.pixel]);

  const onSavePixel = () => {
    if (currPixel !== props.pixel) {
      props.modifyPixel(currPixel);
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  };

  return (
    <div className="pixel-editor-wrapper">
      <label htmlFor={uniqueId.current}></label>
      <NumberInput
        readOnly={readOnly}
        value={currPixel}
        onChange={(event) => setCurrPixel(event.target.value)}
        onMouseUp={onSavePixel}
        onBlur={onSavePixel}
        onKeyDown={onKeyDown}
        id={uniqueId.current}
      />
      <div className="pixel-unit">
        <span>px</span>
      </div>
    </div>
  );
};

PixelEditor.propTypes = {
  readOnly: PropTypes.bool,
  pixel: PropTypes.number,
  modifyPixel: PropTypes.func,
};

export default PixelEditor;
