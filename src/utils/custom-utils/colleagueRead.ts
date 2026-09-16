/**
 * Reading the colleague's side of the collaboration.
 *
 * Course 3's lessons are observations made at Malika's: her bell lights up, the
 * base turns up in her "Shared with me" with a permission level, a mention
 * reaches her, and the moment you revoke, her access is gone. The course used to
 * send the learner into a second browser window to see all that.
 *
 * Every one of those is a READ, and every one of them can be made with her own
 * token — so the plugin can show them in the learner's own window instead. This
 * module is nothing but those reads. It never writes.
 *
 * ⚠️ ALL THREE ACCOUNT-LEVEL ENDPOINTS BELOW ARE UNDOCUMENTED (they are absent
 * from the OpenAPI spec) and were found by probing on 2026-09-16. They are
 * deliberately gathered in this one file so that a SeaTable version that moves
 * them breaks in a single place:
 *
 *   /api/v2.1/notifications/      her account bell   → `unseen_count` IS the badge
 *   /api/v2.1/dtables/shared/     her "Shared with me", with `permission`
 *   /api-gateway/…/related-users/ every collaborator's name AND avatar_url
 *
 * Two traps measured the same day, both silent:
 *   · `/api/v2.1/workspaces/` does NOT list bases shared with the user — its
 *     `shared` bucket stays empty even right after a share. With `?detail=true`
 *     it fills, but under `shared_table_list`, not `table_list`. Reading the
 *     obvious key on the obvious endpoint reports "nothing shared" while the
 *     share is plainly there. Hence `/api/v2.1/dtables/shared/` instead.
 *   · a base-level notification (a comment, a mention) does NOT appear in the
 *     account bell, and an account-level one (a base shared with you) does not
 *     appear in the base. They are two different inboxes, and the course teaches
 *     exactly that distinction — so both are exposed here.
 */

import { colleagueAccountGet, colleagueBaseToken, hostConfig } from './colleagueIdentity';

export interface BellEntry {
  id: number;
  type: string;
  seen: boolean;
  detail: any;
}

export interface Bell {
  /** The number on the badge. */
  unseen: number;
  entries: BellEntry[];
}

export interface SharedBase {
  name: string;
  /** 'rw' or 'r' — the step-2 lesson, seen from her side. */
  permission: string;
  fromUser: string;
  uuid: string;
}

export interface Collaborator {
  name: string;
  email: string;
  avatarUrl: string;
}

/** The learner's own base token, injected by the host (dev falls back to the SDK). */
function hostBaseToken(): { server: string; token: string; uuid: string } {
  const host: any = (window as any).dtable || {};
  const cfg: any = (window as any).dtableSDK?.config || {};
  return {
    server: String(host.server || cfg.server || '').replace(/\/+$/, ''),
    token: String(host.accessToken || cfg.accessToken || ''),
    uuid: String(host.dtableUuid || cfg.dtableUuid || ''),
  };
}

/**
 * Her ACCOUNT bell — the home-page one. A base shared with her lands here as
 * `share_dtable_to_user`, carrying the base's name and uuid in `detail.dtable`.
 */
export async function colleagueBell(): Promise<Bell> {
  const body = await colleagueAccountGet('/api/v2.1/notifications/');
  const entries: BellEntry[] = (body?.notification_list || []).map((n: any) => ({
    id: n.id,
    type: String(n.type || n.msg_type || ''),
    seen: Boolean(n.seen),
    detail: n.detail,
  }));
  return { unseen: Number(body?.unseen_count ?? 0), entries };
}

/** The bases shared DIRECTLY with her — her "Shared with me" section. */
export async function colleagueSharedBases(): Promise<SharedBase[]> {
  const body = await colleagueAccountGet('/api/v2.1/dtables/shared/');
  return (body?.table_list || []).map((t: any) => ({
    name: String(t.name || ''),
    permission: String(t.permission || ''),
    fromUser: String(t.from_user_name || t.from_user || ''),
    uuid: String(t.uuid || ''),
  }));
}

/** What she was told about THIS base: the share, if it is still in force. */
export async function colleagueShareOfThisBase(): Promise<SharedBase | null> {
  const { baseName } = hostConfig();
  const shared = await colleagueSharedBases();
  return shared.find((s) => s.name === baseName) || null;
}

/**
 * Her IN-BASE notifications — where a comment or an @mention lands (an account
 * event like a share never appears here; that is the point of the distinction).
 * Needs her base token, so it also fails once the share is revoked.
 */
export async function colleagueBaseNotifications(): Promise<BellEntry[]> {
  const { server } = hostConfig();
  const { accessToken, dtableUuid } = await colleagueBaseToken();
  const resp = await fetch(
    `${server}/api-gateway/api/v2/dtables/${dtableUuid}/notifications/`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  );
  if (!resp.ok) throw new Error(`Her in-base notifications answered ${resp.status}`);
  const body = await resp.json();
  const list = body?.notification_list || body?.notifications || [];
  return list.map((n: any) => ({
    id: n.id,
    type: String(n.msg_type || n.type || ''),
    seen: Boolean(n.seen),
    detail: n.detail,
  }));
}

/**
 * Can she still open this base? Minting her base token is the honest test, and
 * it is what Step 2 shows after the share is revoked.
 */
export async function colleagueStillHasAccess(): Promise<boolean> {
  try {
    await colleagueBaseToken();
    return true;
  } catch {
    return false;
  }
}

/**
 * Everyone with access to this base, with their real name and avatar.
 *
 * This is what lets a panel be rendered faithfully rather than approximated: the
 * learner recognises their own face and their colleague's, exactly as in the
 * comment thread they just left. Read with the LEARNER's own host token.
 */
export async function baseCollaborators(): Promise<Collaborator[]> {
  const { server, token, uuid } = hostBaseToken();
  if (!server || !token || !uuid) throw new Error('Base identity incomplete.');
  const resp = await fetch(`${server}/api-gateway/api/v2/dtables/${uuid}/related-users/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`related-users answered ${resp.status}`);
  const body = await resp.json();
  return (body?.user_list || []).map((u: any) => ({
    name: String(u.name || ''),
    email: String(u.email || ''),
    avatarUrl: String(u.avatar_url || ''),
  }));
}

export interface ColleagueAccount {
  email: string;
  name: string;
  contactEmail: string;
  avatarUrl: string;
}

/**
 * Who does the stored token belong to?
 *
 * Used by the setup step to confirm, before anything depends on it, that the
 * credential is valid AND that it belongs to the colleague rather than to the
 * learner. Pasting your own token is the natural mistake, and it would otherwise
 * only surface much later, as a colleague who mysteriously signs with your name.
 */
export async function colleagueAccountInfo(): Promise<ColleagueAccount> {
  const body = await colleagueAccountGet('/api2/account/info/');
  return {
    email: String(body?.email || ''),
    name: String(body?.name || ''),
    contactEmail: String(body?.contact_email || ''),
    avatarUrl: String(body?.avatar_url || ''),
  };
}
