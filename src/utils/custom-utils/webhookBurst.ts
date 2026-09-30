/**
 * "A change to watch" — the plugin action behind Course 4 Step 5.
 *
 * The learner has just pointed a native webhook at a test endpoint and now has to
 * go and read what arrives. Left to themselves they would poke at any row they like,
 * and the payload on screen would be whatever that poke happened to produce — hard
 * to write a course around, and hard for the learner to know what they are looking
 * at. So the plugin makes the change instead, and the course can name the fields.
 *
 * It runs THREE operations on one throwaway row, a few seconds apart: create it,
 * edit it, delete it. That is deliberate on two counts:
 *
 * 1. **Three payloads, three shapes.** `insert_row` carries the row as written,
 *    `modify_row` carries only the columns that moved — each with its `old_value`
 *    beside the new one — and `delete_row` carries the row that went. One errand
 *    shows the learner all three, in the order they happened.
 * 2. **It IS the verbosity lesson.** A native webhook fires on every content change
 *    in the base and there is no way to filter it, so a small piece of housekeeping
 *    like this one costs the receiving service three calls. That is the honest
 *    argument for the scripted POST the step goes on to build — one message, sent
 *    at the moment the sender chooses.
 *
 * The row is removed again because `Products` is not a scratchpad: its references
 * feed the catalog Step 4's `snap()` matches against.
 *
 * Timing matters more than it looks, and the gap is set for a learner watching TWO
 * screens: the row appearing, changing and going in the base, and the matching
 * request landing at the other end. Five seconds leaves time to look from one to the
 * other, notice what changed and pair them up before the next one lands; fired back
 * to back the three would arrive in the same second and read as one confusing burst.
 * Err long rather than short — the whole point is that the learner sees three
 * separate things happen, and waiting costs them nothing.
 */

import { getTableByName } from './sdkRead';
import { learnerUpdateRow } from './learnerWrite';
import { appendRowsTracked } from './watchAutomation';

function sdk(): any {
  return (window as any).dtableSDK;
}

export interface WebhookBurstSpec {
  table_name: string;
  /** The throwaway row to create (column NAME → display value). */
  row: Record<string, any>;
  /** The edit made to it a moment later — one column is enough to show old_value. */
  edit: Record<string, any>;
  /**
   * Pause between the three operations. Long enough to watch the base and the
   * receiving page at the same time and see which request belongs to which change.
   */
  pause_ms?: number;
}

export interface WebhookBurstResult {
  /** Operations that actually reached the base — one webhook each. */
  operations: number;
}

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Create a row, edit it, delete it. Returns how many operations went through, so
 * the caller can tell the learner how many calls to expect at the other end.
 *
 * If the row cannot be created there is nothing to edit or delete, so we stop and
 * say so rather than reporting a burst that never happened.
 */
export async function webhookBurst(
  spec: WebhookBurstSpec,
  onTick?: (note: string) => void
): Promise<WebhookBurstResult> {
  const table = getTableByName(spec.table_name);
  if (!table) throw new Error(`Table "${spec.table_name}" not found in this base.`);
  const pause = spec.pause_ms ?? 5000;

  onTick?.('Adding a row…');
  const ids = await appendRowsTracked(spec.table_name, [spec.row]);
  if (ids.length !== 1) throw new Error(`Could not add the row to ${spec.table_name}.`);
  await wait(pause);

  onTick?.('Editing it…');
  await learnerUpdateRow(spec.table_name, ids[0], spec.edit);
  await wait(pause);

  onTick?.('Deleting it…');
  // Re-read the table: the store may have swapped the object under us during the
  // pauses, and deleting through a stale one would silently do nothing.
  const current = getTableByName(spec.table_name) || table;
  sdk().deleteRowById(current, ids[0]);

  return { operations: 3 };
}
