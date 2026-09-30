import settingLocal from '../../setting.local';

export interface AuthContext {
  serverUrl: string;
  dtableUuid: string;
  accessToken: string;
}

// Dev-mode cache for the explicit token-exchange path. Production reads
// window.dtable directly on every call so SeaTable's token rotations are picked
// up live. Dev tokens are valid for ~3 days; one fetch per session is enough.
let cachedDevAuth: AuthContext | null = null;

export async function getAuthContext(): Promise<AuthContext> {
  // Production: use window.dtable, populated by SeaTable when the plugin loads.
  // Read every time (no cache) so rotations propagate.
  const config = (window as any).dtable;
  if (config && config.accessToken) {
    return {
      serverUrl: config.server,
      dtableUuid: config.dtableUuid,
      accessToken: config.accessToken,
    };
  }

  // Development: exchange the per-base APIToken for a short-lived access token.
  // Cached so frequent callers (showToast, createSnapshot) don't re-fetch.
  if (cachedDevAuth) return cachedDevAuth;

  const server = settingLocal.server;
  const resp = await fetch(`${server}/api/v2.1/dtable/app-access-token/`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${settingLocal.APIToken}`,
    },
  });
  const data = await resp.json();
  cachedDevAuth = {
    serverUrl: server,
    dtableUuid: data.dtable_uuid,
    accessToken: data.access_token,
  };
  return cachedDevAuth;
}
