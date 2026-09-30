import { AssetFile } from '../custom-interfaces/AuditTypes';

export async function listAssets(
  serverUrl: string,
  dtableUuid: string,
  token: string,
  onProgress?: (msg: string) => void
): Promise<AssetFile[]> {
  const results: AssetFile[] = [];

  // Scan regular assets starting from /
  await walkAssets(serverUrl, dtableUuid, token, '/', results, onProgress);

  // Scan custom folder assets using the same API and token, starting from /custom/.
  // Always probed, even when no reference in the base targets /custom/ — pure
  // orphans (files uploaded by a plugin that no longer references them, or by
  // a plugin that was uninstalled) live here and would otherwise be missed.
  // The 400 logged in the network panel on bases without a /custom/ namespace
  // is the accepted cost of catching those orphans.
  if (onProgress) onProgress(`Scanning custom folders... (${results.length} files found)`);
  try {
    await walkAssets(serverUrl, dtableUuid, token, '/custom/', results, onProgress);
  } catch {
    // Custom folder may not exist for this base — ignore
  }

  return results;
}

async function walkAssets(
  serverUrl: string,
  dtableUuid: string,
  token: string,
  path: string,
  results: AssetFile[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const encodedPath = path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('%2F');
  const url = `${serverUrl}/api/v2.1/dtable-asset/${dtableUuid}/?parent_dir=${encodedPath}`;

  const resp = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`Asset listing failed (${resp.status}) for path: ${path}`);
  }

  const data = await resp.json();
  const direntList: any[] = data.dirent_list || [];

  for (const item of direntList) {
    const itemPath = path.replace(/\/$/, '') + '/' + item.obj_name;

    if (item.is_file) {
      results.push({
        path: itemPath,
        name: item.obj_name,
        size: item.file_size || 0,
        lastUpdate: item.last_update || '',
        folder: path,
      });
    } else {
      if (onProgress) {
        onProgress(`Scanning ${itemPath}/ (${results.length} files found)`);
      }
      await walkAssets(serverUrl, dtableUuid, token, itemPath, results, onProgress);
    }
  }
}
