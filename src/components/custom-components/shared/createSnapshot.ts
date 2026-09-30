import { getAuthContext } from '../../../utils/custom-utils/authHelper';

// Triggers a server-side snapshot of the current base via the SeaTable API.
// Returns true if the request was accepted. Note: snapshots back up tables and
// rows but NOT asset files (see project memory for the data-loss incident this
// matters for). Used both on plugin open (best-effort backup) and before any
// destructive action like archival-row deletion (where snapshot success gates
// whether we proceed).
export async function createSnapshot(): Promise<boolean> {
  try {
    const { serverUrl, dtableUuid, accessToken } = await getAuthContext();
    const config = (window as any).dtable || {};
    const dtableName = config.dtableName || '';

    if (!serverUrl || !dtableUuid || !accessToken || !dtableName) return false;

    const resp = await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/snapshot/`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ dtable_name: dtableName }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
