import React from 'react';
import PropTypes from 'prop-types';
import { Input } from 'reactstrap';

function NumberInput(props) {
  const {
    value,
    onChange,
    min = 0,
    step = 1,
    max = Infinity,
    readOnly = false,
    className,
    id = 'pixel-editor-number-input',
    ...otherProps
  } = props;
  return (
    <Input
      type="number"
      className={className}
      value={value || '0'}
      min={min}
      step={step}
      max={max}
      readOnly={readOnly}
      onChange={onChange}
      id={id}
      {...otherProps}
    />
  );
}

NumberInput.propTypes = {
  readOnly: PropTypes.bool,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  className: PropTypes.string,
  min: PropTypes.number,
  max: PropTypes.number,
  step: PropTypes.number,
  onChange: PropTypes.func.isRequired,
  id: PropTypes.string,
};

export default NumberInput;
