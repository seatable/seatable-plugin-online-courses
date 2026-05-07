import { getAuthContext } from '../../../utils/custom-utils/authHelper';

export type ToastType = 'success' | 'warning' | 'error';

export async function showToast(message: string, type: ToastType = 'success') {
  try {
    const { serverUrl, dtableUuid, accessToken } = await getAuthContext();
    const dtableSDK = (window as any).dtableSDK;
    const username =
      dtableSDK?.dtableStore?.dtableSettings?.username ||
      (window as any).app?.collaborators?.[0]?.email ||
      '';
    if (!serverUrl || !dtableUuid || !accessToken || !username) return;

    await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/ui-toasts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        toast_type: type,
        detail: { msg: message },
        to_user: username,
      }),
    });
  } catch {
    // Silently fail — toast is non-critical
  }
}
