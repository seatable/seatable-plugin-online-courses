import React from 'react';
import PropTypes from 'prop-types';
import { DTableColorPicker } from 'dtable-ui-component';

class ColorPicker extends React.PureComponent {
  static default = {
    activeColor: '#000000',
  };

  constructor(props) {
    super(props);
    this.state = {
      isShowColorPicker: false,
      popoverStyle: {},
      pendingColor: null,
    };
    this.colorPickerContainerRef = null;
    this.colorPickerRef = React.createRef();
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
  }

  componentDidUpdate(_prevProps, prevState) {
    if (this.state.isShowColorPicker && !prevState.isShowColorPicker) {
      document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    } else if (!this.state.isShowColorPicker && prevState.isShowColorPicker) {
      document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    }
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
  }

  _onDocumentMouseDown(e) {
    if (!this.colorPickerContainerRef) return;
    if (this.colorPickerContainerRef.contains(e.target)) return;
    // Also check if click is inside the portal-rendered color picker
    const portal = document.querySelector('.dtable-color-picker');
    if (portal && portal.contains(e.target)) return;
    this.onPickColorToggle();
  }

  onInputChanged = (event) => {
    const value = event.target.value;
    this.props.onColorChanged(value);
  };

  onPickColorToggle = () => {
    const { readOnly } = this.props;
    if (readOnly) return;
    const isClosing = this.state.isShowColorPicker;
    this.setState({ isShowColorPicker: !isClosing }, () => {
      if (!isClosing) {
        this.getPopoverStyle();
      } else {
        if (this.props.onColorCommitted && this.state.pendingColor) {
          this.props.onColorCommitted(this.state.pendingColor);
        }
        this.setState({ pendingColor: null });
      }
    });
  };

  getPopoverStyle = () => {
    if (!this.colorPickerContainerRef || !this.colorPickerRef) return {};
    setTimeout(() => {
      const { top, height } = this.colorPickerContainerRef.getBoundingClientRect();
      const { clientHeight } = document.body;
      const selectTop = top + height;
      let colorPickerHeight = 0;
      if (this.colorPickerRef.current) {
        colorPickerHeight = this.colorPickerRef.current.getHeight();
      }
      let style = { left: 0 };
      if (clientHeight - selectTop < colorPickerHeight) {
        style = { ...style, bottom: '2.375rem' };
      }
      this.setState({ popoverStyle: style });
    }, 10);
  };

  render() {
    const hexRegex = /^#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3}|[a-fA-F0-9]{9})$/i;
    const rgbaRegex =
      /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;
    let { readOnly, activeColor } = this.props;
    const inputActiveColor = activeColor;
    if (!hexRegex.test(activeColor)) {
      const match = activeColor.match(rgbaRegex);
      if (match) {
        const [, r, g, b, a] = match;
        const rgba = {
          r: parseInt(r),
          g: parseInt(g),
          b: parseInt(b),
          a: a !== undefined ? parseFloat(a) : 1,
        };
        const toHex = (value) => {
          const hex = value.toString(16);
          return hex.length === 1 ? '0' + hex : hex;
        };
        activeColor = `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}${toHex(
          Math.round(rgba.a * 255)
        )}`;
      }
    }
    const isWhiteColor = activeColor && activeColor.toUpperCase() === '#FFFFFF';

    return (
      <div className="color-picker-container" ref={(ref) => (this.colorPickerContainerRef = ref)}>
        <div className={`picker-control ${readOnly ? 'readOnly' : ''}`}>
          <div
            className={`color-control ${isWhiteColor ? 'white-color' : ''} ${
              readOnly ? 'readOnly' : ''
            }`}
            onClick={this.onPickColorToggle}
            style={{ background: activeColor }}></div>
          <input
            className="text-control"
            type="text"
            value={inputActiveColor}
            onChange={this.onInputChanged}
            readOnly={readOnly}
          />
        </div>
        {this.state.isShowColorPicker && (
          <DTableColorPicker
            ref={this.colorPickerRef}
            color={activeColor}
            onSubmit={(color) => {
              this.setState({ pendingColor: color });
              this.props.onColorChanged(color);
            }}
            onToggle={this.onPickColorToggle}
            popoverStyle={this.state.popoverStyle}
          />
        )}
      </div>
    );
  }
}

ColorPicker.propTypes = {
  readOnly: PropTypes.bool,
  activeColor: PropTypes.string.isRequired,
  onColorChanged: PropTypes.func.isRequired,
  onColorCommitted: PropTypes.func,
};

export default ColorPicker;
