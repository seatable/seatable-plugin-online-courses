/**
 * A window onto the colleague's side: her header bar, her bell, and what is in it.
 *
 * Course 3 used to send the learner into a second browser window to watch things
 * arrive at Malika's. Every one of those arrivals is a READ (colleagueRead.ts), so
 * the plugin can show them in the learner's own window instead — and this is what
 * draws them.
 *
 * TWO SURFACES, and the difference is the lesson
 * ----------------------------------------------
 * SeaTable has two separate inboxes, and Course 3 teaches exactly that:
 *
 *   'home'  the account bell, on the home page — where a base SHARED with her
 *           lands (Step 2). White bar, SeaTable's mark on the left, tabs in the
 *           panel with a count per tab.
 *   'base'  the in-base bell, in the base editor — where a COMMENT or an @mention
 *           lands (Step 3). The bar is tinted with the base's own colour and
 *           carries its name; the panel has no tabs, and each entry is signed by
 *           its author.
 *
 * A share never appears in the base inbox and a comment never appears in the
 * account one. Drawing the wrong bar would teach the opposite of the step, so the
 * surface is a required prop rather than something inferred.
 *
 * A DRAWING, NOT A SCREENSHOT
 * ---------------------------
 * Everything here is real data — her avatar and name come from her account, the
 * badge is the real `unseen_count`, the entries are the real notifications — but
 * the bar is deliberately schematic: the two icons that matter, and nothing else
 * (no Apps / Forms / Statistics / search). It reads as a diagram rather than as a
 * screenshot that has quietly gone stale, and it survives SeaTable restyling its
 * header.
 *
 * ⚠️ Her header for this base is IDENTICAL to the learner's own, a few centimetres
 * higher up the screen — same colour, same base name. So the caption and her name
 * beside the avatar are not decoration: they are the only things saying whose
 * window this is. (The course used to carry 🌐/🕶 badges for that job; they went
 * when the second window did.)
 */

import { t, tNodes } from '../../../locale/t';
import React, { useEffect, useRef, useState } from 'react';
import { hostConfig } from '../../../utils/custom-utils/colleagueIdentity';
import { cellLabel, getColumn, getTables } from '../../../utils/custom-utils/sdkRead';
import {
  BellEntry,
  Collaborator,
  HomeBase,
  SharedBase,
  baseCollaborators,
  colleagueAccountInfo,
  colleagueBaseNotifications,
  colleagueBell,
  colleagueOwnBases,
  colleagueSharedBases,
  colleagueStillHasAccess,
} from '../../../utils/custom-utils/colleagueRead';

export type ColleagueSurface = 'home' | 'base';

interface Props {
  surface: ColleagueSurface;
  /** Overrides the default caption when a step wants to name the moment. */
  caption?: string;
  /**
   * Called once what the step exists to show is actually there — on her home page,
   * this base shared with her in Read-Write; in the base, a comment notification
   * in her bell. The page then counts as done, like an action that ran.
   */
  onSuccess?: () => void;
  /**
   * Called when a read shows that success is gone again — on her home page, the
   * share revoked or downgraded. Step 2 asks the learner to revoke and then share
   * again; a learner who forgets the second half leaves the companion unable to act
   * for her later, so the page must stop saying done.
   */
  onFailure?: () => void;
}

const NAVY = '#1d2838';
const MUTED = '#6c757d';
const ORANGE = '#ff8000';

const S: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 14 },
  captionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 14,
  },
  // Everything we say AROUND the drawing — caption, notes, the Refresh button — is
  // one voice: the page's own text size, one grey, no bold. The drawing keeps
  // SeaTable's sizes; our words should not compete with it or with each other.
  caption: { color: MUTED },
  refresh: {
    background: 'none',
    border: '1px solid #d0d5db',
    borderRadius: 3,
    padding: '2px 8px',
    fontSize: 'inherit',
    color: MUTED,
    cursor: 'pointer',
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 12px',
    height: 44,
    borderRadius: '6px 6px 0 0',
    position: 'relative',
  },
  brand: { height: 24, display: 'block' },
  baseLogo: { fontSize: 18, color: '#fff', zIndex: 1 },
  baseName: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: '#fff',
    fontWeight: 600,
    fontSize: 14,
    pointerEvents: 'none',
  },
  right: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, zIndex: 1 },
  // The glyph's own box, so the badge can be pinned to ITS corner. SeaTable's own
  // metrics: 4px of right margin, and a bell of 20px on the home page against 16px
  // in a base.
  bellButton: {
    position: 'relative',
    background: 'none',
    border: 'none',
    padding: 0,
    marginRight: 4,
    cursor: 'pointer',
    lineHeight: 0,
    fontSize: 0,
  },
  badge: {
    position: 'absolute',
    top: -16,
    right: -6,
    minWidth: 15,
    height: 15,
    padding: '0 4px',
    borderRadius: 8,
    background: '#fc6440',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    lineHeight: '15px',
    textAlign: 'center',
  },
  who: { display: 'flex', alignItems: 'center', gap: 7 },
  whoName: { fontSize: 13, fontWeight: 600 },
  // SeaTable backs every avatar with the same grey disc, which shows through a
  // transparent PNG and around a non-square one.
  avatar: { width: 26, height: 26, borderRadius: '50%', display: 'block', background: '#ced4da' },
  bellAnchor: { position: 'relative', display: 'flex', alignItems: 'center' },
  /**
   * SeaTable's `.notification-container` gives the look — white, 3px radius,
   * `0 0 5px #ccc` — and the widths: 530px on the home page, 320px in a base.
   *
   * Its own `top: -1px / right: -10px` do NOT transfer: they are offsets against a
   * container SeaTable positions itself, and against our bell they hung the panel
   * up over the bar. Here it is anchored to the BAR and drops below it, which is
   * what a dropdown looks like from the outside.
   *
   * ⚠️ No max-height and no scrollbar of its own: the page already scrolls, and two
   * nested scrollbars is a horrible way to read four notifications. The panel is as
   * tall as its content and the lesson page carries it — which is why these steps
   * are full-height 'course' pages rather than the compact exercise banner.
   */
  panel: {
    position: 'absolute',
    top: '100%',
    right: 4,
    marginTop: 4,
    zIndex: 5,
    background: '#fff',
    borderRadius: 3,
    boxShadow: '0 0 5px #ccc',
    maxWidth: 'calc(100vw - 24px)',
  },
  panelTitle: {
    textAlign: 'center',
    fontWeight: 600,
    fontSize: 14,
    padding: '10px 12px',
    borderBottom: '1px solid #eef0f3',
  },
  tabs: {
    display: 'flex',
    gap: 18,
    padding: '8px 14px',
    borderBottom: '1px solid #eef0f3',
    fontSize: 13,
  },
  tabOn: { color: ORANGE, borderBottom: `2px solid ${ORANGE}`, paddingBottom: 4 },
  tabOff: { color: NAVY, paddingBottom: 4 },
  entry: { display: 'flex', gap: 9, padding: '10px 14px', borderBottom: '1px solid #f2f4f6' },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#fc6440',
    marginTop: 6,
    flexShrink: 0,
  },
  entryAvatar: { width: 22, height: 22, borderRadius: '50%', flexShrink: 0, background: '#ced4da' },
  entryBody: { flex: 1, minWidth: 0 },
  entryHead: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' },
  entryName: { fontWeight: 600, fontSize: 13 },
  entryTime: { fontSize: 11, color: MUTED, whiteSpace: 'nowrap' },
  entryText: { fontSize: 12.5, lineHeight: 1.45, marginTop: 2 },
  highlight: { color: ORANGE },
  quote: { fontSize: 12, color: NAVY, marginTop: 3, fontFamily: 'monospace' },
  empty: { padding: '18px 14px', textAlign: 'center', fontSize: 13, color: MUTED },
  // Her home page below the bar, drawn after SeaTable's own: white, a heading
  // with its icon per section, bases as tiles in two columns. Only the sections the
  // step is about — the side menu, search and groups are left out.
  // No frame of its own: like SeaTable's, the page is set off from the bar only by
  // the bar's bottom line and shadow (see `barStyle`).
  page: {
    padding: '12px 16px 16px',
    background: '#fff',
  },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 15,
    color: '#212529',
    margin: '6px 0 10px',
  },
  sectionIcon: { color: '#999', fontSize: 15, display: 'flex' },
  grid: {
    display: 'grid',
    // Columns sized to their content rather than halves: by default the second one
    // holds nothing but "Add a folder", and the first needs the room for a base's
    // full name. Content wider than the panel still shrinks, and wraps.
    gridTemplateColumns: 'auto auto',
    justifyContent: 'start',
    columnGap: 40,
    rowGap: 12,
    marginBottom: 14,
  },
  tile: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, fontSize: 14 },
  tileIcon: {
    width: 36,
    height: 36,
    borderRadius: 4,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
  },
  // The full name, as SeaTable shows it: never cut short. The panel is narrower
  // than her home page, so a long name wraps (at its hyphens if need be) instead.
  tileName: {
    color: '#212529',
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  placeholderIcon: { background: '#f0f0f0', color: '#999', fontSize: 22, fontWeight: 300 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: '1px solid #e3e6ea',
    borderRadius: 10,
    padding: '1px 8px 1px 2px',
    fontSize: 12,
    color: '#212529',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  // SeaTable's generic user disc: a white person on grey, drawn small.
  chipAvatar: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#ced4da',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    fontSize: 0,
  },
  pageEmpty: { fontSize: 12.5, color: MUTED, gridColumn: '1 / -1' },
  // Our annotations, outside the drawing: what her page does not say by itself.
  pageNote: { color: MUTED, marginTop: 8, lineHeight: 1.45 },
  error: { padding: '12px 14px', fontSize: 12.5, color: '#b02a37' },
};

/** "6 days ago" — absent or unparsable timestamps simply show nothing. */
function ago(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  const unit = (name: string, count: number) =>
    t(`time.${name}_${count === 1 ? 'one' : 'other'}`, { count });
  if (mins < 1) return t('time.just_now');
  if (mins < 60) return unit('minutes', mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return unit('hours', hours);
  const days = Math.floor(hours / 24);
  return unit('days', days);
}

/**
 * Who the entry is about, as a person rather than as an identifier.
 *
 * The account bell hands us a display name and an avatar. The in-base one hands us
 * the internal username (`…@auth.local`) and nothing else — printing that raw is
 * what put an `@auth.local` address where a name belongs — so it is looked up in
 * the base's collaborators, who carry both the name and the avatar.
 */
function person(
  entry: BellEntry,
  collaborators: Map<string, Collaborator>
): { name: string; avatarUrl: string } {
  if (entry.actor.name) return { name: entry.actor.name, avatarUrl: entry.actor.avatarUrl };
  const known = collaborators.get(entry.actor.username);
  if (known) return { name: known.name, avatarUrl: known.avatarUrl };
  // Better an honest blank than an address dressed up as a name.
  return { name: '', avatarUrl: entry.actor.avatarUrl };
}

/**
 * The row a comment is about, named the way SeaTable names rows: by its first
 * column. The payload carries ids, not labels, and "record named 3kPq8vT1" would
 * be worse than saying nothing — so the id is resolved against the learner's own
 * store (same base, already loaded) and dropped if it cannot be.
 */
function rowName(detail: any): string {
  if (detail?.row_name) return String(detail.row_name);
  const { table_id: tableId, row_id: rowId } = detail || {};
  if (!tableId || !rowId) return '';
  const table = getTables().find((t: any) => t._id === tableId);
  const column = table && getColumn(table);
  const row = table && (table.rows || []).find((r: any) => r._id === rowId);
  if (!column || !row) return '';
  return cellLabel(column, row[column.key]) || '';
}

/**
 * What the entry says, in SeaTable's own words. The orange fragment is the thing
 * the sentence is about — the base for a share, the row for a comment — which is
 * how the real panel reads it too.
 */
function entryText(entry: BellEntry, who: string): React.ReactNode {
  const d = entry.detail || {};
  switch (entry.type) {
    case 'share_dtable_to_user':
    case 'share_dtable_to_group':
      return (
        <>
          {tNodes('colleague_window.entry.shared_base', {
            who: who || t('colleague_window.someone'),
            base: (
              <span style={S.highlight}>{d?.dtable?.name || t('colleague_window.a_base')}</span>
            ),
          })}
        </>
      );
    case 'add_user_to_group':
      return (
        <>
          {tNodes('colleague_window.entry.added_to_group', {
            who: <span style={S.highlight}>{who || t('colleague_window.someone')}</span>,
            group: d?.group_name || t('colleague_window.a_team'),
          })}
        </>
      );
    case 'row_comment':
    case 'comment':
      return (
        <>
          {tNodes('colleague_window.entry.comment', {
            row: <span style={S.highlight}>{rowName(d) || t('colleague_window.a_record')}</span>,
          })}
        </>
      );
    default:
      // An unknown type is still worth showing: the learner sees that something
      // arrived, which is the point, and we do not invent a sentence for it.
      return <>{entry.type.replace(/_/g, ' ')}</>;
  }
}

/**
 * The glyph a base tile carries. MEASURED 2026-09-29: the API's `icon` is the class
 * itself (`icon-dollar`), in SeaTable's BASE icon font — `base-font`, not the
 * `dtable-font` of the rest of the UI. A base nobody customised has no `icon`, and
 * gets the SeaTable mark from the ordinary font instead.
 * The base editor does not load `base-font`; `loadBaseFont` brings it in.
 */
function tileGlyphClass(icon: string): string {
  return icon
    ? `base-font dtable-icon-color-white ${icon} dtable-icon-style`
    : 'dtable-font dtable-icon-dtable-logo';
}

/** "My bases" has no icon in SeaTable's font we can name for sure — a person, drawn. */
const PersonIcon: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={Math.round((size * 14) / 13)} viewBox="0 0 13 14" aria-hidden="true">
    <circle cx="6.5" cy="3.6" r="3.2" fill="currentColor" />
    <path d="M0 14c0-3.9 2.9-6.3 6.5-6.3S13 10.1 13 14z" fill="currentColor" />
  </svg>
);

/** One base as a home-page tile: its colour square, its glyph, its name. */
/**
 * SeaTable's BASE icon font, as the home page loads it. The base editor this
 * plugin runs in does not (measured 2026-09-29: the glyph renders 0×0), so it is
 * brought in once, on demand. The path is stable across versions — only its `?v=`
 * query changes (measured on 6.2.12) — and it is served by the instance itself.
 * Resolves on load AND on error: a missing font must not hold the tile up, the
 * size check below then simply falls back to the SeaTable mark.
 */
let baseFontReady: Promise<void> | null = null;
function loadBaseFont(server: string): Promise<void> {
  if (!baseFontReady) {
    baseFontReady = new Promise<void>((resolve) => {
      const href = `${server}/media/css/base-font.css`;
      if (document.querySelector(`link[href^="${href}"]`)) return resolve();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    }).then(() => (document as any).fonts?.ready);
  }
  return baseFontReady;
}

const BaseTile: React.FC<{
  base: HomeBase;
  fallbackColor: string;
  children?: React.ReactNode;
}> = ({ base, fallbackColor, children }) => {
  // A glyph whose font was never loaded renders as a 0×0 box. Checked once the
  // font's stylesheet is in, and replaced by the SeaTable mark rather than left as
  // an empty square.
  const glyph = useRef<HTMLElement>(null);
  const [glyphMissing, setGlyphMissing] = useState(false);
  useEffect(() => {
    if (!base.icon) return;
    let cancelled = false;
    loadBaseFont(hostConfig().server).then(() => {
      if (!cancelled) setGlyphMissing((glyph.current?.offsetWidth ?? 0) === 0);
    });
    return () => {
      cancelled = true;
    };
  }, [base.icon]);
  return (
    <div style={S.tile}>
      <span
        style={{
          ...S.tileIcon,
          background: base.color || fallbackColor,
          color: base.textColor || '#fff',
        }}>
        {glyphMissing ? (
          <i className={tileGlyphClass('')} />
        ) : (
          <i
            ref={glyph}
            className={tileGlyphClass(base.icon)}
            // SeaTable sizes this glyph through `.dtable-icon-style` (18px), which sits
            // in its hashed app stylesheet we do not load — `.base-font` alone gives 16.
            style={{ fontSize: 18 }}
          />
        )}
      </span>
      <span style={S.tileName}>{base.name}</span>
      {children}
    </div>
  );
};

/** SeaTable's grey "+" tile that ends a section — part of what makes it look like one. */
const AddTile: React.FC<{ label: string }> = ({ label }) => (
  <div style={S.tile}>
    <span style={{ ...S.tileIcon, ...S.placeholderIcon }}>+</span>
    <span style={S.tileName}>{label}</span>
  </div>
);

/**
 * The permission as SeaTable's share dialog words it. `rw` and `r` are the two a
 * whole-base share can carry; anything else (a custom share) is shown raw rather
 * than guessed at.
 */
function permissionLabel(p: string): string {
  if (p === 'rw') return t('colleague_window.permission_rw');
  if (p === 'r') return t('colleague_window.permission_r');
  return p || t('colleague_window.permission_unknown');
}

const ColleagueWindow: React.FC<Props> = ({ surface, caption, onSuccess, onFailure }) => {
  const [entries, setEntries] = useState<BellEntry[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [who, setWho] = useState<{ name: string; avatarUrl: string }>({ name: '', avatarUrl: '' });
  const [people, setPeople] = useState<Map<string, Collaborator>>(new Map());
  // Home surface only: her "Shared with me" section, and whether she can still
  // open THIS base. `null` = not read yet.
  const [shared, setShared] = useState<SharedBase[] | null>(null);
  const [mine, setMine] = useState<HomeBase[] | null>(null);
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  // Bumped by the Refresh button — her reloading her page. Step 2 shares, revokes
  // and re-shares while this page stays open, and a view read once on arrival
  // would go on showing the state before the learner's last move.
  const [reloads, setReloads] = useState(0);
  const { baseName, color, server, dtableUuid } = hostConfig();
  /**
   * Is this entry of her "Shared with me" the base the plugin runs in? By uuid
   * when both sides carry one (a base can be renamed, and two can share a name),
   * dashes and case aside; by name otherwise.
   */
  const bare = (u: string) => u.replace(/-/g, '').toLowerCase();
  const isThisBase = (b: SharedBase) =>
    b.uuid && dtableUuid ? bare(b.uuid) === bare(dtableUuid) : b.name === baseName;
  const sharedDirectly = Boolean(shared?.some(isThisBase));

  useEffect(() => {
    let cancelled = false;
    setError('');
    colleagueAccountInfo()
      .then((acc) => !cancelled && setWho({ name: acc.name, avatarUrl: acc.avatarUrl }))
      .catch(() => !cancelled && setError(t('colleague_window.token_missing')));
    const read =
      surface === 'home'
        ? colleagueBell().then((b) => ({ entries: b.entries, unseen: b.unseen }))
        : // The in-base inbox has no unseen counter of its own, so the badge counts
          // what is actually unread in the list.
          colleagueBaseNotifications().then((e) => ({
            entries: e,
            unseen: e.filter((n) => !n.seen).length,
          }));
    read
      .then(({ entries: list, unseen: n }) => {
        if (cancelled) return;
        setEntries(list);
        setUnseen(n);
      })
      .catch(
        (err: any) => !cancelled && setError(err?.message || t('colleague_window.bell_failed'))
      );
    if (surface === 'home') {
      colleagueSharedBases()
        .then((list) => !cancelled && setShared(list))
        .catch(() => !cancelled && setShared(null));
      colleagueOwnBases()
        .then((list) => !cancelled && setMine(list))
        .catch(() => !cancelled && setMine(null));
      // Minting her base token is the honest test of access — and it is exactly
      // what the companion needs to act for her, so the same answer covers both.
      colleagueStillHasAccess().then((ok) => !cancelled && setHasAccess(ok));
    }
    // Read with the LEARNER's own token: it is only ever used to put a name on a
    // username, so it must not depend on what she has been given yet.
    baseCollaborators()
      .then((list) => !cancelled && setPeople(new Map(list.map((c) => [c.email, c]))))
      .catch(() => {
        /* No names to resolve with — entries simply show none. */
      });
    return () => {
      cancelled = true;
    };
  }, [surface, reloads]);

  // The step's own success, from what was just read — reported, not decided here.
  const succeeded =
    surface === 'home'
      ? Boolean(shared?.some((b) => isThisBase(b) && b.permission === 'rw'))
      : entries.some((e) => e.type === 'row_comment' || e.type === 'comment');
  // Only her home page can lose its success: a comment that reached her stays there.
  const homeRead = surface === 'home' && shared !== null;
  useEffect(() => {
    if (succeeded) onSuccess?.();
    else if (homeRead) onFailure?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [succeeded, homeRead]);

  /** What a category tab counts: the unread of that category alone. */
  const unread = entries.filter((e) => !e.seen).length;

  const onHome = surface === 'home';
  const barStyle: React.CSSProperties = {
    ...S.bar,
    background: onHome ? '#fff' : color,
    // SeaTable's home header, to the pixel: a light rule and a soft drop below it.
    borderBottom: onHome ? '1px solid #e8e8e8' : 'none',
    boxShadow: onHome ? '-1px 5px 3px -3px #eee' : 'none',
  };
  const iconColour = onHome ? MUTED : '#fff';

  return (
    <div style={S.wrap}>
      <div style={S.captionRow}>
        <div style={S.caption}>
          {caption ??
            (onHome ? t('colleague_window.caption_home') : t('colleague_window.caption_base'))}
        </div>
        <button type="button" style={S.refresh} onClick={() => setReloads((n) => n + 1)}>
          {t('colleague_window.refresh')}
        </button>
      </div>

      <div style={barStyle}>
        {onHome ? (
          // The instance serves its own wordmark — right colours, right typeface,
          // and it follows a rebrand without us noticing.
          <img src={`${server}/media/img/seatable-logo.png`} alt="SeaTable" style={S.brand} />
        ) : (
          <>
            <i className="dtable-font dtable-icon-dtable-logo" style={S.baseLogo} />
            <div style={S.baseName}>{baseName}</div>
          </>
        )}
        <div style={S.right}>
          <div style={S.bellAnchor}>
            <button
              type="button"
              style={S.bellButton}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={
                unseen
                  ? t('colleague_window.bell_label_unread', { count: unseen })
                  : t('colleague_window.bell_label')
              }>
              <i
                className="dtable-font dtable-icon-notice"
                style={{ fontSize: onHome ? 20 : 16, color: iconColour }}
              />
              {unseen > 0 && <span style={S.badge}>{unseen}</span>}
            </button>
          </div>
          <div style={S.who}>
            {who.avatarUrl && <img src={who.avatarUrl} alt="" style={S.avatar} />}
            <span style={{ ...S.whoName, color: onHome ? NAVY : '#fff' }}>
              {who.name || 'Malika'}
            </span>
          </div>
        </div>
        {open && (
          <div style={{ ...S.panel, width: onHome ? 530 : 320 }}>
            <div style={S.panelTitle}>{t('seatable_ui.notification')}</div>
            {onHome && (
              <div style={S.tabs}>
                {/* The bracketed count is the UNREAD of that category alone: the
                    bell's badge is the sum across the three (5 = General(4) + Bases(1)).
                    Bases and Apps stay bare — this endpoint answers for General, and a
                    number we cannot read would be a number we invented. No count at 0,
                    as SeaTable itself shows. */}
                <span style={S.tabOn}>
                  {unread > 0
                    ? t('seatable_ui.general', { count: unread })
                    : t('seatable_ui.general_bare')}
                </span>
                <span style={S.tabOff}>{t('seatable_ui.bases')}</span>
                <span style={S.tabOff}>{t('seatable_ui.apps')}</span>
              </div>
            )}
            {error && <div style={S.error}>{error}</div>}
            {!error && entries.length === 0 && (
              <div style={S.empty}>{t('seatable_ui.no_notifications')}</div>
            )}
            {entries.map((entry) => {
              const from = person(entry, people);
              return (
                <div key={entry.id} style={S.entry}>
                  {!entry.seen && <span style={S.dot} />}
                  {from.avatarUrl && <img src={from.avatarUrl} alt="" style={S.entryAvatar} />}
                  <div style={S.entryBody}>
                    <div style={S.entryHead}>
                      <span style={S.entryName}>{from.name || 'SeaTable'}</span>
                      <span style={S.entryTime}>{ago(entry.createdAt)}</span>
                    </div>
                    <div style={S.entryText}>{entryText(entry, from.name)}</div>
                    {entry.detail?.comment && <div style={S.quote}>" {entry.detail.comment} "</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {onHome && (
        <div style={S.page}>
          {/* My bases: in the course, empty — a new team member has nothing of anyone's. */}
          <div style={S.sectionTitle}>
            <span style={S.sectionIcon}>
              <PersonIcon />
            </span>
            {t('seatable_ui.my_bases')}
          </div>
          <div style={S.grid}>
            {mine?.map((b) => (
              <BaseTile key={b.uuid || b.name} base={b} fallbackColor={ORANGE} />
            ))}
            <AddTile label={t('seatable_ui.add_base_or_folder')} />
          </div>

          <div style={S.sectionTitle}>
            <span style={S.sectionIcon}>
              <i className="dtable-font dtable-icon-share-with-me" />
            </span>
            {t('seatable_ui.shared_with_me')}
          </div>
          <div style={S.grid}>
            {shared === null && (
              <div style={S.pageEmpty}>{t('colleague_window.shared_failed')}</div>
            )}
            {shared?.map((b) => {
              // The chip SeaTable puts on a shared tile names the base's OWNER
              // workspace — for a group base, the group ("Commercial") — behind a
              // generic user icon. Not the person who shared it.
              const here = isThisBase(b);
              return (
                <BaseTile key={b.uuid || b.name} base={b} fallbackColor={here ? color : ORANGE}>
                  {b.ownerName && (
                    <span style={S.chip}>
                      {b.ownerAvatarUrl ? (
                        <img src={b.ownerAvatarUrl} alt="" style={S.chipAvatar} />
                      ) : (
                        <span style={S.chipAvatar}>
                          <PersonIcon size={9} />
                        </span>
                      )}
                      {b.ownerName}
                    </span>
                  )}
                </BaseTile>
              );
            })}
            <AddTile label={t('seatable_ui.add_folder')} />
          </div>
        </div>
      )}

      {/* Our annotations, outside the drawing — what her page does not say by itself. */}
      {onHome &&
        shared?.filter(isThisBase).map((b) => (
          <div key="permission" style={S.pageNote}>
            {t('colleague_window.shared_with_permission', {
              base: b.name,
              permission: permissionLabel(b.permission),
            })}
          </div>
        ))}
      {/* She can open the base, yet it is not in her "Shared with me": the access
          comes from somewhere else — in practice a group she shares with the
          learner (a reused team, or a real colleague already in Commercial).
          Step 2 then has nothing to show: no "before", and revoking the share
          would not take her access away. Said plainly, with the way out. */}
      {onHome && hasAccess === true && shared !== null && !sharedDirectly && (
        <div style={S.pageNote}>
          {t('colleague_window.access_through_group', { base: baseName })}
        </div>
      )}
      {/* Said only once the answer is in: before the first share and after the
          revocation alike, this is the state the step wants the learner to see. */}
      {onHome && hasAccess === false && (
        <div style={S.pageNote}>{t('colleague_window.no_access', { base: baseName })}</div>
      )}
    </div>
  );
};

export default ColleagueWindow;
