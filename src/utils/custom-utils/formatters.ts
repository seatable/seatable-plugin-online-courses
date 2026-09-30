const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function fmtSize(sizeBytes: number): string {
  let size = sizeBytes;
  for (const unit of UNITS) {
    if (size < 1024 || unit === 'TB') {
      return `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}

export function fmtPct(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${(rate * 100).toFixed(0)}%`;
}

export function folderDepth(path: string, depth: number = 2): string {
  const parts = path.replace(/^\/|\/$/g, '').split('/');
  return '/' + parts.slice(0, depth).join('/');
}

/**
 * Shared "audit timestamp" formatter — used by every audit's "Last audit",
 * "Performance test: ..." headers and the "Frozen at" column. Renders in the
 * user's browser locale (so French users see "21/05/2026", US users see
 * "5/21/2026") while always showing 24-hour time for unambiguous timestamps.
 *
 * Pass `undefined` for the locale and the runtime uses the browser's default
 * (navigator.language equivalent). Format parts stay explicit so the layout is
 * stable: 2-digit day/month, numeric year, 2-digit hour and minute, no seconds.
 */
export function formatTimestamp(d: Date): string {
  return (
    d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  );
}

export function formatNow(): string {
  return formatTimestamp(new Date());
}
