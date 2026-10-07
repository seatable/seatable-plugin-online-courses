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
 * ⚠️ These account-level endpoints were found by probing on 2026-09-16. Two of
 * them are NOT in the OpenAPI spec (the bell, related-users); `/dtables/shared/`
 * IS — "List My Shares" (corrected 2026-09-29), and so is `/workspaces/`. They
 * are gathered in this one file all the same, so that a SeaTable version that
 * moves one breaks in a single place:
 *
 *   /api/v2.1/notifications/      her account bell   → `unseen_count` is the unread
 *                                 of the GENERAL category only (corrected
 *                                 2026-09-22: the bell's badge in the UI is the
 *                                 sum across General + Bases + Apps, and this
 *                                 endpoint answers for General)
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
import { t } from '../../locale/t';

export interface BellEntry {
  id: number;
  type: string;
  seen: boolean;
  detail: any;
  /** ISO timestamp, when the endpoint gives one — the panel shows "6 days ago". */
  createdAt: string;
  /**
   * Who caused it. The two inboxes describe that person differently and neither
   * does it in `detail`, so it is normalised here rather than hunted for in the UI:
   *
   *   account bell  `share_from_user_name` + `_avatar_url`, on the notification
   *                 ROOT — display-ready;
   *   in-base       `detail.author`, which is the internal username
   *                 (`…@auth.local`), with no name and no avatar. Resolving it to a
   *                 person needs `baseCollaborators()`, so the raw username is
   *                 carried out and the caller does the lookup.
   */
  actor: { name: string; avatarUrl: string; username: string };
}

/**
 * Pull the actor out of whichever shape the entry used (measured 2026-09-22):
 *
 *   share_dtable_to_user  detail.share_from.{share_from_user_name, _email,
 *                         _avatar_url} — nested one level down, NOT on `detail`
 *                         itself, which is what made every entry render as
 *                         "SeaTable / Someone" while the field plainly existed;
 *   add_user_to_group     detail.group_staff_name, and no avatar at all;
 *   row_comment (in-base) detail.author, the internal `…@auth.local` username,
 *                         with no name and no avatar — resolved by the caller
 *                         through `baseCollaborators()`.
 */
function actorOf(n: any): BellEntry['actor'] {
  const d = n?.detail || {};
  const from = d.share_from || {};
  return {
    name: String(from.share_from_user_name || d.group_staff_name || d.user_name || ''),
    avatarUrl: String(from.share_from_user_avatar_url || ''),
    username: String(d.author || from.share_from_user_email || d.op_user || ''),
  };
}

export interface Bell {
  /** The number on the badge. */
  unseen: number;
  entries: BellEntry[];
}

/**
 * How a base tile looks on a home page: its colour square and the glyph on it.
 * All three come back `null` for a base nobody customised — the tile then falls
 * back to SeaTable's default.
 */
export interface BaseLook {
  color: string;
  textColor: string;
  icon: string;
}

export interface HomeBase extends BaseLook {
  name: string;
  uuid: string;
}

export interface SharedBase extends HomeBase {
  /** 'rw' or 'r' — the step-2 lesson, seen from her side. */
  permission: string;
  /**
   * What the chip on a shared tile names: the base's OWNER. MEASURED 2026-09-29 —
   * the API calls it `from_user_name`, but for a base that belongs to a group it
   * is the GROUP ("Commercial", `from_user` = `1@seafile_group`), not the person
   * who shared it. The name misleads; the value is what SeaTable's own tile shows.
   */
  ownerName: string;
  /** The chip's picture (`from_user_avatar`): a generic one for a group. */
  ownerAvatarUrl: string;
}

function lookOf(t: any): BaseLook {
  return {
    color: t?.color ? String(t.color) : '',
    textColor: t?.text_color ? String(t.text_color) : '',
    icon: t?.icon ? String(t.icon) : '',
  };
}

/** Her workspaces, detailed — where her own bases and each base's look are. */
async function colleagueWorkspaces(): Promise<any[]> {
  const body = await colleagueAccountGet('/api/v2.1/workspaces/?detail=true');
  return body?.workspace_list || [];
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
    createdAt: String(n.created_at || n.ctime || ''),
    actor: actorOf(n),
  }));
  return { unseen: Number(body?.unseen_count ?? 0), entries };
}

/**
 * The bases shared DIRECTLY with her — her "Shared with me" section.
 *
 * MEASURED 2026-09-29: `/dtables/shared/` carries the permission but NOT the
 * base's look (`color`, `text_color`, `icon`) nor the owner's avatar; the `shared`
 * bucket of her detailed workspaces carries all of them. Both are read and merged
 * by uuid — a failed second read only costs the tile its colours.
 */
export async function colleagueSharedBases(): Promise<SharedBase[]> {
  const [body, workspaces] = await Promise.all([
    colleagueAccountGet('/api/v2.1/dtables/shared/'),
    colleagueWorkspaces().catch(() => [] as any[]),
  ]);
  const looks = new Map<string, any>();
  for (const ws of workspaces) {
    for (const t of ws?.shared_table_list || []) if (t?.uuid) looks.set(String(t.uuid), t);
  }
  return (body?.table_list || []).map((t: any) => {
    const uuid = String(t.uuid || '');
    const detailed = looks.get(uuid);
    return {
      name: String(t.name || ''),
      uuid,
      ...lookOf(detailed || t),
      permission: String(t.permission || ''),
      ownerName: String(t.from_user_name || detailed?.from_user_name || ''),
      ownerAvatarUrl: String(detailed?.from_user_avatar || t.from_user_avatar || ''),
    };
  });
}

/**
 * Her own bases — her "My bases" section: the `personal` bucket of her detailed
 * workspaces. In the course it is empty, which is itself worth seeing: a new team
 * member starts with nothing of anyone's.
 */
export async function colleagueOwnBases(): Promise<HomeBase[]> {
  const workspaces = await colleagueWorkspaces();
  const personal = workspaces.find((ws: any) => ws?.type === 'personal');
  return (personal?.table_list || []).map((t: any) => ({
    name: String(t.name || ''),
    uuid: String(t.uuid || ''),
    ...lookOf(t),
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
  const resp = await fetch(`${server}/api-gateway/api/v2/dtables/${dtableUuid}/notifications/`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(t('colleague.base_bell_failed', { status: resp.status }));
  const body = await resp.json();
  const list = body?.notification_list || body?.notifications || [];
  return list.map((n: any) => ({
    id: n.id,
    type: String(n.msg_type || n.type || ''),
    seen: Boolean(n.seen),
    detail: n.detail,
    createdAt: String(n.created_at || n.ctime || ''),
    actor: actorOf(n),
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
