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
