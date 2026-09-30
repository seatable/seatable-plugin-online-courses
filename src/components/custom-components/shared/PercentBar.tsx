import React from 'react';

// Bar visualization for "higher-is-worse" metrics — compute cost share, view-load
// weight, archival base impact. Mirrors FillRateBar's layout (bar + label) but
// inverts the color scale: high values are concerning (red), not good (green).
//
// FillRateBar covers the "higher-is-better" case (column fill quality). The two
// components share the same row dimensions so cells in adjacent columns line up.

interface PercentBarProps {
  // Percent value, 0-100. Clamped at render time.
  pct: number;
  // Bar width in pixels. Defaults to 80 — small enough to fit narrow columns
  // (e.g. 130px column = bar + 8 gap + ~36 label).
  width?: number;
}

// Below this percent, callers should render a "not relevant" label instead of
// a bar — the magnitude is too small to be worth visualizing or acting on.
// Same threshold as the Overview's noise filter so the mental model is uniform.
export const MIN_RELEVANT_PCT = 2;

function getColor(pct: number): string {
  if (pct >= 25) return '#dc3545'; // red
  if (pct >= 10) return '#e6a117'; // amber
  return '#6c757d'; // muted grey — share too small to flag
}

function formatPct(pct: number): string {
  // Integer rounding only. Anything that would round to 0% is below the
  // MIN_RELEVANT_PCT threshold and should be filtered upstream by the caller.
  return `${Math.round(pct)}%`;
}

const PercentBar: React.FC<PercentBarProps> = ({ pct, width = 80 }) => {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width,
          height: 16,
          backgroundColor: '#e9ecef',
          borderRadius: 4,
          overflow: 'hidden',
          flexShrink: 0,
        }}>
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            backgroundColor: getColor(pct),
            borderRadius: 4,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span style={{ fontSize: 13, minWidth: 36, color: '#555' }}>{formatPct(pct)}</span>
    </div>
  );
};

export default PercentBar;
