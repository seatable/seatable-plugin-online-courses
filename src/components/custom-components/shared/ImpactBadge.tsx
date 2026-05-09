import React from 'react';
import intl from 'react-intl-universal';
import {
  ImpactBand,
  DeltaBand,
  BAND_COLORS,
  DELTA_COLORS,
  impactBandFromPct,
  deltaBandFromPct,
} from './impactBands';

// Single visual vocabulary for ranking items in the performance audit. Replaces
// the integer-percent display + PercentBar that drove the boss's "too many
// percentages" critique. Three surfaces share this component — different label
// vocabularies but the same coloured-pill shape:
//
//   • column     → "High / Medium / Low impact"  (cost share of formula compute)
//   • view       → "Slow loading / Moderate / Fast loading"  (felt load weight)
//   • delta      → 5 bands signed by improvement / regression
//
// Callers pass either a percent (and we band it) or a pre-computed band.
// Surface is required because the labels differ — keeping the wording inside
// this component avoids each caller re-fetching the same i18n keys.

type Surface = 'column' | 'view';

interface ImpactBadgeProps {
  // Provide either pct (will be banded) or band (already banded). pct wins.
  pct?: number | undefined;
  band?: ImpactBand;
  surface: Surface;
}

interface DeltaBadgeProps {
  pct?: number | undefined;
  band?: DeltaBand;
}

function impactLabel(band: ImpactBand, surface: Surface): string {
  if (band === 'not-relevant') {
    return intl.get('performance.not_relevant').d('not relevant');
  }
  if (surface === 'column') {
    if (band === 'high') return intl.get('performance.band_high_impact').d('High impact');
    if (band === 'medium') return intl.get('performance.band_medium_impact').d('Medium impact');
    return intl.get('performance.band_low_impact').d('Low impact');
  }
  // view surface
  if (band === 'high') return intl.get('performance.band_slow_loading').d('Slow loading');
  if (band === 'medium') return intl.get('performance.band_moderate_loading').d('Moderate');
  return intl.get('performance.band_fast_loading').d('Fast loading');
}

function deltaLabel(band: DeltaBand): string {
  switch (band) {
    case 'major-improvement':
      return intl.get('performance.delta_band_major').d('Major improvement');
    case 'significant-improvement':
      return intl.get('performance.delta_band_significant').d('Significant improvement');
    case 'moderate-improvement':
      return intl.get('performance.delta_band_moderate').d('Moderate improvement');
    case 'no-change':
      return intl.get('performance.delta_band_no_change').d('No significant change');
    case 'regression':
      return intl.get('performance.delta_band_regression').d('Regression');
  }
}

const PILL_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 500,
  color: '#fff',
  whiteSpace: 'nowrap',
};

const NOT_RELEVANT_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontStyle: 'italic',
  color: '#aaa',
};

const ImpactBadge: React.FC<ImpactBadgeProps> = ({ pct, band, surface }) => {
  const resolved: ImpactBand = band ?? impactBandFromPct(pct);
  if (resolved === 'not-relevant') {
    return <span style={NOT_RELEVANT_STYLE}>{impactLabel(resolved, surface)}</span>;
  }
  return (
    <span style={{ ...PILL_STYLE, backgroundColor: BAND_COLORS[resolved] }}>
      {impactLabel(resolved, surface)}
    </span>
  );
};

export const DeltaBadge: React.FC<DeltaBadgeProps> = ({ pct, band }) => {
  const resolved: DeltaBand = band ?? (pct !== undefined ? deltaBandFromPct(pct) : 'no-change');
  return (
    <span style={{ ...PILL_STYLE, backgroundColor: DELTA_COLORS[resolved] }}>
      {deltaLabel(resolved)}
    </span>
  );
};

export default ImpactBadge;
