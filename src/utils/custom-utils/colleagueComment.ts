/**
 * The colleague's REPLY in a row's comment thread (Course 3, Step 3).
 *
 * Comments do not go through the dtable-store — there is no store operation for
 * one — so this is a REST call, made with a base token minted from HER account
 * token. Measured 2026-09-16: a comment posted that way is signed with her name
 * (a named API token signs nobody, and the UI then shows "Unknown").
 *
 * HOW A REPLY REACHES THE LEARNER (corrected 2026-09-29)
 * A row's comments notify its conversation's SUBSCRIBERS: whoever commented on
 * the row, and whoever was added with @ or the + button — until unchecked there.
 * The learner wrote the request, so they are subscribed and her reply reaches them
 * with no mention at all — which is the point Step 3b makes. (What we took on
 * 2026-09-16 for "an API comment notifies even without a mention" was this rule:
 * the thread already had subscribers.)
 *
 * The named-token bug — a badge over an empty notification list, because the
 * author resolved to no collaborator — does NOT occur with her account token:
 * checked in the learner's bell on 2026-09-29, entry present and complete.
 *
 * If a reply ever needs a mention: it is stored as plain text, `@<display name> …`
 * (measured on a mention typed in the UI). Resolving the LEARNER's display name
 * is the hard part — matching `window.dtable.username` against the base's
 * collaborators failed on 2026-09-29 — so it was dropped along with the mention.
 */

import { colleagueBaseToken, hostConfig } from './colleagueIdentity';
import { findRowByMatch, getTableByName } from './sdkRead';
import { t } from '../../locale/t';

export interface ColleagueReplySpec {
  /** Table holding the row, e.g. 'Customers'. */
  table: string;
  /** How to find the row, e.g. Full Name = James Bennett. */
  match: { column: string; equals: string };
  /** The reply, as posted. */
  text: string;
}

export async function colleagueReply(spec: ColleagueReplySpec): Promise<string> {
  const table = getTableByName(spec.table);
  if (!table) throw new Error(t('colleague.no_table_named', { table: spec.table }));
  const row = findRowByMatch(table, spec.match.column, spec.match.equals);
  if (!row)
    throw new Error(
      t('colleague.no_row_where', { column: spec.match.column, value: spec.match.equals })
    );

  const { server } = hostConfig();
  const { accessToken, dtableUuid } = await colleagueBaseToken();
  const params = new URLSearchParams({ table_id: table._id, row_id: row._id });
  const resp = await fetch(
    `${server}/api-gateway/api/v2/dtables/${dtableUuid}/comments/?${params}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: spec.text }),
    }
  );
  if (!resp.ok) throw new Error(t('colleague.reply_refused', { status: resp.status }));
  return spec.text;
}
