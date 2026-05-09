// Impact band classification — replaces the integer-percent display across the
// performance audit. Three concerns:
//   1) Avoid false precision: the underlying signal (theoretical compute share)
//      is a ranking tool, not a wall-clock predictor accurate to ±1%.
//   2) Cross-base comparability: a "High" on one base should mean roughly the
//      same as a "High" on another. Hence FIXED thresholds (not distribution-
//      based — those would always paint something Red and erode trust).
//   3) Empty-state honesty: on a healthy base, the audit should be allowed to
//      say "nothing significant found" — distribution-based banding can't.
//
// Cutoffs (tuned around MIN_RELEVANT_PCT = 2 to keep the noise floor consistent
// with the Overview's existing 2% filter):
//   <  2 %  → not-relevant  (suppress display upstream)
//   2-10 %  → low           🟢
//   10-25 % → medium        🟡
//   ≥ 25 %  → high          🔴

export type ImpactBand = 'not-relevant' | 'low' | 'medium' | 'high';

// Same colour palette already used elsewhere (red/amber matching PercentBar's
// thresholds). Green added for the Low band — under the current PercentBar
// scheme that range is muted-grey; the redesign elevates it to a positive
// signal so the user sees three meaningful tiers, not two-and-a-half.
export const BAND_COLORS: Record<Exclude<ImpactBand, 'not-relevant'>, string> = {
  low: '#28a745', // green
  medium: '#e6a117', // amber
  high: '#dc3545', // red
};

export const MIN_RELEVANT_PCT = 2;

export function impactBandFromPct(pct: number | undefined): ImpactBand {
  if (pct === undefined || pct < MIN_RELEVANT_PCT) return 'not-relevant';
  if (pct >= 25) return 'high';
  if (pct >= 10) return 'medium';
  return 'low';
}

// Sort order for grouping by band — higher impact first. 'not-relevant' sorts
// last so the user always sees the worst items at the top of any banded list.
export const BAND_SORT_ORDER: Record<ImpactBand, number> = {
  high: 0,
  medium: 1,
  low: 2,
  'not-relevant': 3,
};

// ---------------------------------------------------------------------------
// Delta bands (signed) — used for the test result headline. Different cuts
// than impact bands because Delta is a *change* metric, not a *cost* metric:
// the sign matters, the noise floor is wider (±5% lives inside per-test
// variance), and wider buckets are acceptable at high improvements where
// precision matters less than direction.
//
// Negative = improvement (after < before, lower compute cost).
// Positive = regression.
//   ≤ -30 %        → major-improvement
//   -30 % to -15 % → significant-improvement
//   -15 % to -5 %  → moderate-improvement
//   -5 %  to  +5 % → no-change
//   >  +5 %        → regression
// ---------------------------------------------------------------------------

export type DeltaBand =
  | 'major-improvement'
  | 'significant-improvement'
  | 'moderate-improvement'
  | 'no-change'
  | 'regression';

export const DELTA_COLORS: Record<DeltaBand, string> = {
  'major-improvement': '#1d8836', // deep green
  'significant-improvement': '#28a745', // green
  'moderate-improvement': '#7cb342', // yellow-green
  'no-change': '#6c757d', // muted grey
  regression: '#dc3545', // red
};

export function deltaBandFromPct(pct: number): DeltaBand {
  if (pct <= -30) return 'major-improvement';
  if (pct <= -15) return 'significant-improvement';
  if (pct <= -5) return 'moderate-improvement';
  if (pct <= 5) return 'no-change';
  return 'regression';
}
