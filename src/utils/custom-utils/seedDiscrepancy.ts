/**
 * "Seed a discrepancy" — the plugin action behind Course 4 Step 3.
 *
 * The learner has just built a scheduled rule that assigns a `Reviewer` to any
 * delivery with lines to review. To check it, something must first give the rule
 * work to do. The plugin creates that work itself: a NEW delivery document, plus one
 * short-delivered line pointing at it.
 *
 * Creating the document (rather than reusing the seeded one) buys three things at
 * once:
 *
 * 1. **A trustworthy check.** The Reviewer assignment is graded from the row's
 *    activity log, which is historical: on a document the learner already ran the
 *    rule against, an "Automation Rule set Reviewer" entry is sitting there from
 *    before, and the check would pass without them lifting a finger. A row created
 *    here has no history, so any such entry can only come from the run we asked for.
 * 2. **No assumption about the base's state.** Existing lines may have been edited,
 *    validated or deleted; a fresh document and a fresh line are true whatever the
 *    learner did.
 * 3. **Nothing to undo.** The rule's exit condition is `Reviewer` is empty, so on a
 *    document that already has one it would (rightly) do nothing — we would have had
 *    to clear it first. A new document is empty by definition.
 *
 * The line reaches its document through the learner's OWN step-2 automation, so we
 * wait for that link before handing back: until it exists, the document's
 * `Lines to review` does not count the line, and the rule would find nothing.
 *
 * Step 7 reuses the same action with the lines left out. There the supplier's system
 * is supposed to send the whole delivery note — header then lines — and the course
 * splits that conversation in two: the plugin plays the header, the learner plays the
 * lines through the API. So the document has to exist FIRST, or the pushed lines have
 * nothing to link themselves to.
 */

import { appendRowsTracked, awaitLinks } from './watchAutomation';

export interface SeedSpec {
  /** The document to create (column NAME → display value). */
  document: { table_name: string; row: Record<string, any> };
  /**
   * The problem line(s) to create, pointing at that document by reference.
   * OMITTED for a document-only seed (Course 4 Step 7): there the lines are the
   * learner's job — they arrive through the API — so the plugin lays down the
   * header and stops.
   */
  lines?: { table_name: string; rows: Record<string, any>[]; link_columns: string[] };
}

export interface SeedResult {
  /** Row id of the document created — what the grade is then pinned to. */
  documentRowId: string;
  /**
   * True when the learner's step-2 automation linked the line(s) in time.
   * `undefined` on a document-only seed: no line was created, so there is nothing
   * to have linked and nothing to report either way.
   */
  linked?: boolean;
}

/**
 * Create the document and its problem line, then wait for the learner's linking
 * automation to attach them. Throws if the document could not be created; returns
 * `linked: false` (rather than throwing) when the link never arrives, so the caller
 * can tell the learner what to look at instead of failing silently.
 */
export async function seedDiscrepancy(
  spec: SeedSpec,
  onTick?: (note: string) => void
): Promise<SeedResult> {
  onTick?.('Creating a delivery…');
  const docIds = await appendRowsTracked(spec.document.table_name, [spec.document.row]);
  if (docIds.length !== 1) {
    throw new Error(`could not create the ${spec.document.table_name} row`);
  }

  if (!spec.lines) return { documentRowId: docIds[0] };

  onTick?.('Adding a short-delivered line…');
  const lineIds = await appendRowsTracked(spec.lines.table_name, spec.lines.rows);

  // The line has to reach the document before the document counts it, and that is
  // the learner's own automation's job — so this wait doubles as a check that it
  // still works.
  onTick?.('Waiting for your automation to attach it…');
  const outcome = await awaitLinks(spec.lines.table_name, lineIds, spec.lines.link_columns, {
    timeoutMs: 15000,
  });

  return { documentRowId: docIds[0], linked: outcome.kind === 'linked' };
}
