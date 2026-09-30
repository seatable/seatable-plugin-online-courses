import React from 'react';

interface PerfIconProps {
  size?: number;
  color?: string;
  title?: string;
  style?: React.CSSProperties;
}

const PerfIcon: React.FC<PerfIconProps> = ({ size = 14, color = '#ff8000', title, style }) => (
  <i
    className="dtable-font dtable-icon-gauge"
    style={{ fontSize: size, color, ...style }}
    title={title}
  />
);

export default PerfIcon;
