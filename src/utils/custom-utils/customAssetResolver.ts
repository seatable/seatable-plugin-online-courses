import { AssetFile } from '../custom-interfaces/AuditTypes';

export async function resolveCustomAssetUUIDs(
  serverUrl: string,
  apiToken: string,
  customFiles: AssetFile[],
  onProgress?: (msg: string) => void
): Promise<void> {
  for (let i = 0; i < customFiles.length; i += 5) {
    const batch = customFiles.slice(i, i + 5);
    if (onProgress) {
      onProgress(
        `Resolving custom file UUIDs (${Math.min(i + 5, customFiles.length)}/${customFiles.length})...`
      );
    }

    await Promise.all(
      batch.map(async (file) => {
        try {
          // Strip /custom prefix to get the folder path relative to custom root
          const folderPath = file.folder.replace(/^\/custom\/?/, '/') || '/';
          const url =
            `${serverUrl}/api/v2.1/dtable/custom/app-asset-file/` +
            `?path=${encodeURIComponent(folderPath)}&name=${encodeURIComponent(file.name)}`;

          const resp = await fetch(url, {
            headers: {
              accept: 'application/json',
              Authorization: `Bearer ${apiToken}`,
            },
          });

          if (!resp.ok) return;

          const data = await resp.json();
          if (data.dirent?.uuid) {
            file.uuid = data.dirent.uuid;
          }
        } catch {
          // Skip files where metadata fetch fails
        }
      })
    );
  }
}
