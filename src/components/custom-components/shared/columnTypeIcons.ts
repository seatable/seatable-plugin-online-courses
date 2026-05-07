// Mapping from SeaTable column type → dtable-font icon class. Shared across the
// audit components so any list of columns renders with consistent type icons.
// Default fallback ('dtable-icon-single-line-text') is fine for unknown types —
// readers see "some column" rather than nothing.

export const COLUMN_TYPE_ICONS: Record<string, string> = {
  text: 'dtable-icon-single-line-text',
  'long-text': 'dtable-icon-long-text',
  number: 'dtable-icon-number',
  checkbox: 'dtable-icon-check-square-solid',
  date: 'dtable-icon-calendar-alt-solid',
  'single-select': 'dtable-icon-single-election',
  'multiple-select': 'dtable-icon-multiple-selection',
  image: 'dtable-icon-picture',
  file: 'dtable-icon-file',
  collaborator: 'dtable-icon-collaborator',
  link: 'dtable-icon-link-other-record',
  'link-formula': 'dtable-icon-link-formulas',
  formula: 'dtable-icon-formula',
  creator: 'dtable-icon-creator',
  ctime: 'dtable-icon-creation-time',
  'last-modifier': 'dtable-icon-renewal-person-sync',
  mtime: 'dtable-icon-modification-record',
  'auto-number': 'dtable-icon-autonumber',
  url: 'dtable-icon-url',
  email: 'dtable-icon-email',
  duration: 'dtable-icon-duration',
  rate: 'dtable-icon-rate',
  geolocation: 'dtable-icon-location',
  button: 'dtable-icon-button',
  'digital-sign': 'dtable-icon-handwritten-signature',
};

export const DEFAULT_COLUMN_TYPE_ICON = 'dtable-icon-single-line-text';

export function iconForColumnType(type: string | undefined): string {
  return (type && COLUMN_TYPE_ICONS[type]) || DEFAULT_COLUMN_TYPE_ICON;
}
