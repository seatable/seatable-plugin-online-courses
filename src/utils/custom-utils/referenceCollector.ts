import { RefSource } from '../custom-interfaces/AuditTypes';

interface CollectResult {
  referenced: Set<string>;
  refSources: Record<string, RefSource[]>;
  refDisplayNames: Record<string, string>;
  externalUrls: Record<string, RefSource[]>;
}

function addSource(store: Record<string, RefSource[]>, key: string, source: RefSource) {
  if (!store[key]) store[key] = [];
  const exists = store[key].some(
    (s) =>
      s.tableName === source.tableName &&
      s.columnName === source.columnName &&
      s.rowId === source.rowId
  );
  if (!exists) store[key].push(source);
}

export function collectReferencedPaths(onProgress?: (msg: string) => void): CollectResult {
  const referenced = new Set<string>();
  const refSources: Record<string, RefSource[]> = {};
  const refDisplayNames: Record<string, string> = {};
  const externalUrls: Record<string, RefSource[]> = {};

  const tables: any[] = (window as any).dtableSDK.getTables();

  for (const table of tables) {
    const tableName: string = table.name;
    const assetCols = (table.columns || []).filter(
      (col: any) => col.type === 'file' || col.type === 'image'
    );
    if (assetCols.length === 0) continue;

    if (onProgress) {
      onProgress(`Scanning ${tableName}: ${assetCols.map((c: any) => c.name).join(', ')}`);
    }

    const rows: any[] = table.rows || [];
    for (const row of rows) {
      const rowId: string = row._id || 'unknown';

      for (const col of assetCols) {
        const colName: string = col.name;
        const colKey: string = col.key;
        const val = row[colKey];
        if (!val) continue;

        const items: any[] = Array.isArray(val) ? val : [val];
        for (const item of items) {
          const url: string =
            typeof item === 'object' && item !== null ? item.url || '' : String(item);
          if (!url) continue;

          // Real filename from the cell data (e.g. "ConvPerma-002.pdf")
          const displayName: string =
            typeof item === 'object' && item !== null ? item.name || '' : '';

          // Skip base64
          if (url.startsWith('data:')) continue;

          const source: RefSource = {
            tableName,
            columnName: colName,
            rowId,
          };

          // Handle custom-asset:// as internal reference
          if (url.startsWith('custom-asset://')) {
            const customPath = url.replace('custom-asset://', '');
            if (customPath) {
              referenced.add(customPath);
              addSource(refSources, customPath, source);
              if (displayName && !refDisplayNames[customPath]) {
                refDisplayNames[customPath] = displayName;
              }
            }
            continue;
          }

          // SeaTable asset URL (absolute or relative) — extract base path
          const marker = '/asset/';
          const assetIdx = url.indexOf(marker);
          if (assetIdx !== -1) {
            const afterMarker = url.substring(assetIdx + marker.length);
            const slash = afterMarker.indexOf('/');
            if (slash !== -1) {
              const normalised = decodeURIComponent(afterMarker.substring(slash));
              referenced.add(normalised);
              addSource(refSources, normalised, source);
              if (displayName && !refDisplayNames[normalised]) {
                refDisplayNames[normalised] = displayName;
              }
            }
            continue;
          }

          // External URL (no /asset/ marker)
          if (url.startsWith('http://') || url.startsWith('https://')) {
            addSource(externalUrls, url, source);
            continue;
          }

          // Relative base path
          referenced.add(url);
          addSource(refSources, url, source);
          if (displayName && !refDisplayNames[url]) {
            refDisplayNames[url] = displayName;
          }
        }
      }
    }
  }

  return { referenced, refSources, refDisplayNames, externalUrls };
}
