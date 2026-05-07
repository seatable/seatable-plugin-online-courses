import {
  AssetFile,
  AssetsAuditResult,
  FolderStorage,
  UrlCheckResult,
} from '../custom-interfaces/AuditTypes';
import { ORPHAN_EXCLUDE_PREFIXES } from '../custom-constants/constants';
import { folderDepth } from './formatters';
import { listAssets } from './assetScanner';
import { collectReferencedPaths } from './referenceCollector';
import { resolveCustomAssetUUIDs } from './customAssetResolver';

export async function runAssetsAudit(
  serverUrl: string,
  dtableUuid: string,
  accessToken: string,
  onProgress?: (msg: string) => void,
  shouldVerifyUrls?: boolean
): Promise<AssetsAuditResult> {
  // Step 1: List all assets
  if (onProgress) onProgress('Listing all assets...');
  const allFiles = await listAssets(serverUrl, dtableUuid, accessToken, onProgress);

  const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);

  // Step 1b: Resolve UUIDs for custom folder files
  const customFiles = allFiles.filter((f) => f.path.startsWith('/custom/'));
  if (customFiles.length > 0) {
    const apiToken = (window as any).dtableSDK?.config?.APIToken || '';
    if (apiToken) {
      if (onProgress) onProgress(`Resolving UUIDs for ${customFiles.length} custom file(s)...`);
      await resolveCustomAssetUUIDs(serverUrl, apiToken, customFiles, onProgress);
    }
  }

  // Step 2: Collect referenced paths
  if (onProgress) onProgress('Scanning tables for references...');
  const { referenced, refSources, refDisplayNames, externalUrls } =
    collectReferencedPaths(onProgress);

  // Step 3: Compute orphans
  const existingPaths = new Set(allFiles.map((f) => f.path));
  const referencedArray = Array.from(referenced);

  // Build UUID filename map for custom files (uuid + original extension)
  const uuidToFile = new Map<string, AssetFile>();
  for (const f of allFiles) {
    if (f.uuid) {
      const dotIdx = f.name.lastIndexOf('.');
      const ext = dotIdx !== -1 ? f.name.substring(dotIdx) : '';
      uuidToFile.set(f.uuid + ext, f);
    }
  }

  // Build set of real file paths that are referenced via UUID
  const uuidReferencedPaths = new Set<string>();
  for (const ref of referencedArray) {
    const file = uuidToFile.get(ref);
    if (file) uuidReferencedPaths.add(file.path);
  }

  const orphans = allFiles.filter((f) => {
    if (ORPHAN_EXCLUDE_PREFIXES.some((prefix) => f.path.startsWith(prefix))) return false;
    // UUID-based reference resolves to this file
    if (uuidReferencedPaths.has(f.path)) return false;
    return !referencedArray.some((ref) => {
      // Standard path matching
      if (f.path.endsWith(ref) || f.path.includes(ref)) return true;
      return false;
    });
  });
  const orphanSize = orphans.reduce((sum, f) => sum + f.size, 0);

  // Step 4: Compute missing references
  const missingRefs = referencedArray.filter((ref) => {
    // Standard path matching
    if (
      Array.from(existingPaths).some((existing) => existing.endsWith(ref) || existing.includes(ref))
    )
      return false;
    // UUID matching
    if (uuidToFile.has(ref)) return false;
    return true;
  });

  // Step 5: Compute folder storage (2-level depth)
  const folderSizeMap: Record<string, { size: number; count: number }> = {};
  for (const f of allFiles) {
    const key = folderDepth(f.folder, 2);
    if (!folderSizeMap[key]) folderSizeMap[key] = { size: 0, count: 0 };
    folderSizeMap[key].size += f.size;
    folderSizeMap[key].count += 1;
  }

  const folderSizes: FolderStorage[] = Object.entries(folderSizeMap)
    .map(([folder, data]) => ({
      folder,
      size: data.size,
      fileCount: data.count,
      percentage: totalSize > 0 ? data.size / totalSize : 0,
      isSystemFolder: ORPHAN_EXCLUDE_PREFIXES.includes(folder),
    }))
    .sort((a, b) => b.size - a.size);

  // Step 6: Verify external URLs (optional)
  const allExtUrls = Object.keys(externalUrls);
  const urlChecks: Record<string, UrlCheckResult> = {};
  if (shouldVerifyUrls && allExtUrls.length > 0) {
    if (onProgress) onProgress(`Verifying ${allExtUrls.length} external URL(s)...`);
    for (let i = 0; i < allExtUrls.length; i += 5) {
      const batch = allExtUrls.slice(i, i + 5);
      if (onProgress)
        onProgress(
          `Verifying URLs (${Math.min(i + 5, allExtUrls.length)}/${allExtUrls.length})...`
        );
      const results = await Promise.all(
        batch.map(async (url): Promise<UrlCheckResult> => {
          try {
            const resp = await fetch(url, { method: 'HEAD', mode: 'cors' });
            return resp.ok
              ? { result: 'ok', code: resp.status }
              : { result: 'broken', code: resp.status };
          } catch {
            try {
              await fetch(url, { method: 'HEAD', mode: 'no-cors' });
              return { result: 'unverifiable', error: 'CORS' };
            } catch {
              return { result: 'broken', error: 'Unreachable' };
            }
          }
        })
      );
      batch.forEach((url, j) => {
        urlChecks[url] = results[j];
      });
    }
  }

  const referencedCount = allFiles.length - orphans.length;

  return {
    allFiles,
    totalSize,
    referencedCount,
    orphans,
    orphanSize,
    missingRefs,
    refSources,
    refDisplayNames,
    externalUrls,
    urlChecks,
    folderSizes,
  };
}
