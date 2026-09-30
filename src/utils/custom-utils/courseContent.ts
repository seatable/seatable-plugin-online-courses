/**
 * Course content sourcing — the plugin fetches lesson/exercise material from the
 * Hugo-built course site rather than bundling it in the plugin build, so course
 * material is maintained as HTML in Hugo (simpler) and one plugin serves all
 * seven courses. See [[content-sourcing-and-page-registry]].
 *
 * A course is a manifest (ordered steps) + one HTML fragment per step. Grade rules
 * (see grader.ts) travel inside the manifest, so exercises can be added/edited
 * without a plugin release.
 *
 * Caveat: this is a cross-origin static fetch (NOT a Docker service, so it keeps
 * the "1-click, no external service" rule), but it needs CORS on the Hugo host and
 * an internet connection — a fully-offline self-hosted install can't reach it.
 * Full offline support is explicitly NOT a requirement; a bundled FALLBACK_MANIFEST
 * keeps the plugin demonstrable before/without the Hugo host.
 */

import { AnyGradeRule } from './grader';
import { RewindSpec } from './rewindDelivery';
import { WebhookBurstSpec } from './webhookBurst';
import { AutomationStage } from './automationGrade';
import { getCurrentStepId } from './courseProgress';

// Base URL of the Hugo-built course content. One sub-directory per courseId,
// each containing manifest.json + the step HTML fragments.
// TODO: point at the real academy host once it exists.
export const CONTENT_BASE = 'https://academy.seatable.io/courses';

export type StepType = 'course' | 'exercise';

export interface CourseStep {
  id: string; // 4-char qid-style id, used in the `qid` deep-link param
  type: StepType;
  title: string;
  /** Inline HTML (used by the fallback / small steps). Takes precedence over contentUrl. */
  html?: string;
  /** Relative path (to the course dir) of an HTML fragment fetched from Hugo. */
  contentUrl?: string;
  /** Optional hint, shown behind the exercise "Help" toggle. */
  hint?: string;
  /** Answer key — present on exercises. Omitted on pure lesson pages. */
  grade?: AnyGradeRule;
  /** Custom message shown when the exercise passes (else a generic one). */
  successMessage?: string;
  /**
   * Website-unfolding handoff: where the course continues AFTER this plugin step.
   * The website is the course spine; the plugin holds only the interactive
   * checkpoints, entered by the authored step number ("open the plugin and select
   * Step 3"). So the manifest is intentionally GAPPED and forward navigation is
   * driven by this flag, NOT by manifest adjacency:
   *   'website' → the next authored step is on the website; show a "continue on the
   *               website" closer instead of an in-plugin Next (even if a later
   *               checkpoint still exists in the manifest).
   *   'plugin'  → the next authored step is itself a plugin checkpoint (adjacent
   *               checkpoints, e.g. Step 6 → Step 7); chain to it in-plugin.
   * Left unset on the plugin's own front-matter (Introduction) → plain structural
   * nav (Continue to the next manifest step, or nothing if it's the last).
   */
  continuesOn?: 'website' | 'plugin';
  /** Optional override for the handoff sentence (else a generic one). */
  handoffNote?: string;
  /**
   * Short single-sentence instruction for the floating-icon caption. Kept concise
   * on purpose — the full-size plugin shows the richer `html`; this is what stays
   * readable under the shrunk icon. Falls back to the stripped `html` if absent.
   */
  instruction?: string;
  /**
   * Optional demo hook — swaps the exercise's Verify flow for a scripted plugin
   * action. 'automation-guided' runs the Step-2 "build your first automation" flow:
   * a choice between a guided, stage-by-stage build (each verified before the next,
   * from `automationStages`) and a one-shot "just check it" against the step's
   * `grade` (an 'automation-rule' rule). 'seed-discrepancy' creates the Step-3
   * delivery the learner's scheduled rule needs in order to have something to find.
   * 'rewind' removes a delivery from the base (lines, document and the stock they
   * moved) so Step 4 can receive it again for real, and keeps the `example` rows at
   * hand as the safety net for when the extraction misfires.
   */
  demo?: 'automation-guided' | 'seed-discrepancy' | 'rewind' | 'webhook-burst' | 'write-lines';
  /**
   * Label for a demo step's action button, when the generic one would be vague.
   * Say what the button DOES in the base ("Create new delivery"), not what it
   * prepares for you.
   */
  demoLabel?: string;
  /**
   * Shown when the step's action has already run — including on a later visit, when
   * the live status message is long gone. An action step without one would come back
   * looking untouched. Say what is now TRUE in the base, not what was clicked.
   */
  demoDoneMessage?: string;
  /**
   * The table this step's action shows its result in. When the learner is looking
   * at another one, the plugin says so before they press — most actions play out in
   * a single table, and from anywhere else nothing appears to happen at all.
   */
  watchTable?: string;
  /**
   * The VIEW of `watchTable` the action has to be watched from, for a result the
   * table's ordinary view cannot show. Step 5a writes a throwaway row into a catalog
   * of hundreds: it lands wherever the default view puts it, and a learner scrolled
   * anywhere at all sees nothing happen. A narrow view built for the step keeps the
   * row in sight whatever the scroll position — which sorting cannot guarantee.
   *
   * Enforced ONLY when the view actually exists in the base: a learner working from
   * an older `.dtable` that predates it must not be locked out of the step by a view
   * they have no way to open.
   */
  watchView?: string;
  /**
   * The rows the plugin writes when an extraction has to be rescued — what a clean
   * run would have produced (column NAME → display value). Written in REPLACE mode
   * on a 'rewind' step, so a partial extraction cannot leave duplicates behind.
   */
  example?: { table_name: string; rows: Record<string, any>[] };
  /**
   * Payload of the 'rewind' action (Step 4): the delivery to take back out of the
   * base — its lines, its document row, and the stock its validated lines moved —
   * so the learner can receive the same note again and let the AI read it. The
   * step's `example` rows are then the safety net for a misfiring extraction, and
   * are written in REPLACE mode. See rewindDelivery.ts.
   */
  rewind?: RewindSpec;
  /**
   * Payload of the 'webhook-burst' action (Step 5): a throwaway row created, edited
   * and deleted a second apart, so the learner has a change they KNOW the shape of
   * waiting for them at the other end of their webhook. See webhookBurst.ts.
   */
  burst?: WebhookBurstSpec;
  /**
   * Payload of the 'seed-discrepancy' action (Step 3): the plugin creates a delivery
   * and a short-delivered line so the learner's scheduled rule has something to find.
   * The document is created here on purpose — see seedDiscrepancy.ts — and the grade
   * is then pinned to that row rather than matched by condition.
   */
  /**
   * What a seed step must CLEAR before it (re)seeds — so running it twice cleans up
   * after itself instead of stacking a second delivery on the same reference, which
   * would make the reference-based links ambiguous.
   *
   * It is also what lets a learner start a step over. Nothing the plugin marks as
   * done may be a dead end: somebody who wants to redo an exercise without the
   * guidance has to be able to, and an irreversible "done" would trap them.
   */
  reset?: RewindSpec;
  seed?: {
    document: { table_name: string; row: Record<string, any> };
    /** Omitted for a document-only seed (Step 7) — see seedDiscrepancy.ts. */
    lines?: { table_name: string; rows: Record<string, any>[]; link_columns: string[] };
  };
  /**
   * "Watch it work" — an optional demo that runs AFTER an exercise passes, before
   * the learner is handed back to the website. Built for Step 2: the automation is
   * graded on its config, so at that point nothing has ever run through it. The
   * plugin writes `rows` into `table_name` in front of the learner and then confirms,
   * on those exact rows, that THEIR rule filled `link_columns` — columns the plugin
   * never wrote. See watchAutomation.ts.
   */
  watch?: {
    table_name: string;
    /** Rows the plugin writes (column NAME → display value). */
    rows: Record<string, any>[];
    /** Link columns the learner's automation is expected to fill on those rows. */
    link_columns: string[];
    /** HTML framing the demo, shown once the exercise passes. */
    html: string;
    /** Short caption for the floating toolbar (falls back to the stripped `html`). */
    instruction?: string;
    /** Message shown when every link came back filled. */
    successMessage?: string;
  };
  /**
   * Guided sub-stages for a 'automation-guided' step. Each is checked (in order)
   * against a slice of the step's `grade` rule via the given `stage`; the learner
   * only advances once a stage passes. The final "all" check is the same `grade`.
   */
  automationStages?: {
    title: string;
    html: string;
    /** Short single-sentence caption for the floating icon (falls back to `html`). */
    instruction?: string;
    /**
     * Hint for THIS stage only. The step's own `hint` describes the finished
     * automation, so offering it inside the guided build would hand over the three
     * stages the learner has not reached yet. When set, it replaces the step hint
     * while that stage is current; when absent, the step hint is used as before.
     * ONE SHORT LINE: it renders in the toolbar's small popover, so a paragraph
     * does not fit. Say the one thing that trips people up at this stage.
     */
    hint?: string;
    stage: AutomationStage;
  }[];
}

export interface CourseManifest {
  courseId: string;
  title?: string;
  version?: string;
  steps: CourseStep[];
}

function courseDirUrl(courseId: string): string {
  return `${CONTENT_BASE}/${encodeURIComponent(courseId)}`;
}

/** Fetch and validate a course manifest from the Hugo host. */
export async function fetchManifest(courseId: string): Promise<CourseManifest> {
  const resp = await fetch(`${courseDirUrl(courseId)}/manifest.json`, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`manifest fetch failed (${resp.status}) for "${courseId}"`);
  const data = (await resp.json()) as CourseManifest;
  if (!Array.isArray(data?.steps) || !data.steps.length) {
    throw new Error(`manifest for "${courseId}" has no steps`);
  }
  return data;
}

/** Resolve a step's HTML: inline `html` wins, else fetch its `contentUrl`. */
export async function fetchStepHtml(courseId: string, step: CourseStep): Promise<string> {
  if (step.html != null) return step.html;
  if (!step.contentUrl) return '';
  const resp = await fetch(`${courseDirUrl(courseId)}/${step.contentUrl}`, {
    headers: { Accept: 'text/html' },
  });
  if (!resp.ok) throw new Error(`content fetch failed (${resp.status}) for step "${step.id}"`);
  return resp.text();
}

export function findStep(manifest: CourseManifest, stepId: string | null): CourseStep | undefined {
  if (!stepId) return undefined;
  return manifest.steps.find((s) => s.id === stepId);
}

export function stepIndex(manifest: CourseManifest, stepId: string): number {
  return manifest.steps.findIndex((s) => s.id === stepId);
}

// --- runtime config + course/step resolution --------------------------------

// While the Hugo host doesn't exist yet, skip the remote manifest fetch entirely
// (it would throw CORS/NetworkError noise) and use the bundled fallback. Flip on
// once CONTENT_BASE points at a real, CORS-enabled host.
export const USE_REMOTE_CONTENT = false;

// Initial step: a valid `qid` deep-link wins (dev only); else resume saved
// progress; else the first step.
export function resolveInitialStepId(manifest: CourseManifest, courseId: string): string {
  const saved = getCurrentStepId(courseId);
  if (saved && findStep(manifest, saved)) return saved;
  return manifest.steps[0].id;
}

// --- offline fallback (keeps the plugin demonstrable before/without Hugo) -----
// Reproduces the original Course-3 demo. The grade rule is row_id-based (matching
// the gateway Update-Row shape), so we resolve the demo row's _id from the live
// base — letting the row_id grader work against the current test base with no host.

// The three lines of the delivery note the base ships with (INT-001). Written by
// the plugin twice over: in step 2 to set off the learner's brand-new linking rule,
// and in step 4 as the safety net when the AI extraction misfires. Only the two
// references and the quantity — exactly what step 4's script writes, no more: the
// safety net has to produce what a clean extraction would have produced, and Product
// and Document are LINK columns the learner's own automation fills.
const DELIVERY_REFERENCE = 'INT-001';
const DELIVERY_LINES: Record<string, any>[] = [
  { 'Product reference': '8004400007203', Qty: 24, 'Document reference': DELIVERY_REFERENCE },
  { 'Product reference': '9300605048454', Qty: 60, 'Document reference': DELIVERY_REFERENCE },
  { 'Product reference': '0850210008934', Qty: 36, 'Document reference': DELIVERY_REFERENCE },
];

// Course-4 Step 2 — "Import and link the lines". The learner builds their first
// automation on Line items; the plugin either walks them through it stage by stage
// or checks the finished rule. Grading reads the automation CONFIG over REST, so
// it works BEFORE any data has flowed through the rule (see automationGrade.ts).
const LINK_AUTOMATION_HTML = `
  <b>Build your first automation.</b> On the <b>Line items</b> table, create an automation that links
  every new line to its <b>Product</b> and its <b>Document</b> by matching references — no links entered by
  hand. Choose <b>Guide me</b> to build it one stage at a time (each checked before the next), or
  <b>Just check it</b> if you’ve already built it.`;

// Step 3's seeded delivery comes from a DIFFERENT supplier than the seeded note, and
// the two references in play do not belong to the same party: the delivery reference
// is the supplier's own numbering (so it looks nothing like the INT-00x of the note
// already in the base — every supplier numbers its own delivery notes), while the PO
// reference is the warehouse's, and stays in its series (INT-001 carries 2462/2026).
// The delivery reference must also be unique: links are made on the raw value, so
// reusing one would make them ambiguous.
const SEED_DELIVERY_REFERENCE = '2026-08-4417';
const SEED_PO_REFERENCE = '2588/2026';

const REVIEWER_HTML = `
  <b>Give your rule something to find.</b> A scheduled rule only shows what it is worth on a delivery
  that actually needs attention — so rather than have you stage one, the plugin does it: it creates a
  <b>new delivery</b> and one line received short of what was ordered. Your step-2 automation attaches
  the line on its own; the plugin waits until it has.</p>
  <p>Then go to the <b>Automations editor</b> and press <b>Run now</b> on your reviewer rule — no need to
  wait for the hour you set. Come back and verify: what is checked is not that a reviewer is there, but
  that <b>your automation</b>, and not you, is the one that put it there.`;

const LINK_AUTOMATION_STAGES: NonNullable<CourseStep['automationStages']> = [
  {
    title: 'Automation created',
    stage: 'created',
    instruction: 'Add a new rule in the Automations editor and give it a name.',
    hint: 'The name field of the rule has to be focused out for it to exist',
    html: `<b>Create the automation.</b> Open the <b>Automations editor</b> and add a new rule and 
      give it a name, then click <b>Check</b>.`,
  },
  {
    title: 'Trigger + guard',
    stage: 'trigger',
    instruction:
      'Trigger on “When a row is added”, with Product reference and Document reference both not empty.',
    hint: 'Set the conditions in the Trigger settings panel',
    html: `<b>Set the trigger — and guard it.</b> Choose <b>“When a row is added”</b>, then add two
      <b>conditions</b> so it only runs on complete lines: <b>Product reference</b> is <b>not empty</b>
      <b>and</b> <b>Document reference</b> is <b>not empty</b>.`,
  },
  {
    title: 'Link the product',
    stage: 'action:0',
    instruction: 'Add an “Add links” action matching Product reference to a product’s Reference.',
    hint: 'Choose the Add links action, then the Product column it should fill',
    html: `<b>Link the product.</b> Add an <b>Add links</b> action that fills the
      <b>Product</b> column: the line’s <b>Product reference</b> should equal a product’s
      <b>Reference</b>.`,
  },
  {
    title: 'Link the document',
    stage: 'action:1',
    instruction:
      'Add a second “Add links” action matching Document reference to a document’s Delivery reference.',
    hint: 'The same action again, this time filling Document',
    html: `<b>Link the document.</b> Add a second <b>Add links</b> action that fills the
      <b>Document</b> column: the line’s <b>Document reference</b> should equal a document’s
      <b>Delivery reference</b>. That completes your automation.`,
  },
];

const WATCH_HTML = `
  <b>Watch it work.</b> Your rule is built, but nothing has set it off yet — so let's give it
  something. First <b>open the Line items table</b> so you can see it happen, then let the plugin
  bring in the delivery lines, as if your supplier had sent through a tidy list of what was loaded
  onto the truck. Keep an eye on the <b>Product</b> and <b>Document</b> columns as the lines land:
  neither is part of what the plugin writes, and both fill themselves in.`;

// Course-4 Step 5 — the learner points a native webhook at a test endpoint and has
// to go and read what lands there. The plugin makes the change for them so the
// payload on screen is one the course can name field by field — and makes three of
// them, which is the step's other lesson: a native webhook fires on every content
// change in the base, and nothing filters it.
const WEBHOOK_BURST: WebhookBurstSpec = {
  table_name: 'Products',
  // Deliberately nothing like a real barcode: this row joins the catalog that
  // Step 4's snap() matches against for as long as it exists, and it must not be
  // able to win a fuzzy match. It is deleted a moment later anyway.
  // The reference moves from STEP0 to STEP1 so the edit is visible in the grid at a
  // glance: the base carries colouring rules keyed on these values, and Reference is
  // the primary column, so the change also shows up as `row_name` in the payload.
  row: {
    Reference: 'WEBHOOK-TEST-STEP0',
    Description: 'Test product',
    Brand: 'Course 4',
  },
  edit: {
    Reference: 'WEBHOOK-TEST-STEP1',
    Description: 'To be deleted',
  },
};

// Note 2 — the delivery dropped in at the end of step 5. A learner on the no-AI path
// would otherwise retype three 13-digit barcodes off a photograph: pure tax, and one
// wrong digit lands an unlinked line, which is step 2's failure replayed at a moment
// that teaches nothing. So the plugin offers to write them, exactly as it rescues a
// misfired extraction in step 4 — same mechanism, already met, and it leaves the
// learner holding the part that IS the lesson: press the button, get the push.
// Course-4 Step 7 — the delivery note of the supplier who has gone electronic. It
// carries no file on purpose: nothing was printed, nothing photographed. The
// reference is machine-shaped for the same reason — it was generated by their system
// the moment the truck was loaded, not written on a pad. Must match the reference
// printed in the course's step 7, which the learner types into the API reference.
const API_DELIVERY_REFERENCE = 'DN-2026-000871';
// The warehouse's own order number, so it stays in the warehouse's series — INT-001
// carries 2462/2026 and Step 3's seed 2588/2026 — and comes after both, this being
// the last delivery of the course. See the note above SEED_DELIVERY_REFERENCE: the
// delivery reference belongs to the supplier, the PO reference to you.
const API_PO_REFERENCE = '2634/2026';

const API_CREATE_HTML = `
  <b>Play the supplier's system — the first half.</b> One of your suppliers now generates its
  delivery note when the truck is loaded and sends it straight to your base. That conversation has
  two halves: the header of the note, then its lines. The plugin lays down the header, so that the
  half you do by hand stays small enough to read.</p>
  <p>A new document appears in <b>Documents</b> with the reference <b>${API_DELIVERY_REFERENCE}</b>
  and no file attached — there is nothing to photograph any more.</p>
  <p>Then it is your turn, back on the website: push at least one line into <b>Line items</b> from
  the API reference. Come back here at <b>Step 7b</b> when it is sent.`;

const API_VERIFY_HTML = `
  <b>The second half is yours.</b> From the API reference, push at least one line into
  <b>Line items</b>: the reference <b>${API_DELIVERY_REFERENCE}</b> in <b>Document reference</b>, a
  product from your catalog in <b>Product reference</b>, and a <b>Qty</b>.</p>
  <p>What is checked is not only that your line arrived, but that it attached itself — to its
  product and to its document — through the automation you built back in step 2, and that it really
  came in from outside: a row typed into the grid by hand does not count here.`;

const NOTE_2_REFERENCE = 'GR 2026/44718';
const NOTE_2_SPEC: RewindSpec = {
  document: {
    table_name: 'Documents',
    reference_column: 'Delivery reference',
    reference: NOTE_2_REFERENCE,
  },
  lines: {
    table_name: 'Line items',
    reference_column: 'Document reference',
    link_column: 'Document',
  },
  // No `stock`: nothing on this delivery has been validated, so there is nothing to
  // put back — and the writing path never touches stock in any case.
};
const NOTE_2_LINES: Record<string, any>[] = [
  { 'Product reference': '9310342001124', Qty: 48, 'Document reference': NOTE_2_REFERENCE },
  { 'Product reference': '8858702402323', Qty: 120, 'Document reference': NOTE_2_REFERENCE },
  { 'Product reference': '5057967574810', Qty: 30, 'Document reference': NOTE_2_REFERENCE },
];

const WEBHOOK_HTML = `
  <b>Give your webhook something to say.</b> With your webhook pointed at the test endpoint, the plugin
  will make a change you know the shape of: it adds a row to <b>Products</b>, edits it a few seconds
  later, then deletes it — leaving your catalog exactly as it was. Keep the test page beside your base: the
  three changes are spaced so you can watch each one land on both sides. If nothing reaches the endpoint, try
  moving both pages into the same browser window.</p>
  <p>Three operations, three requests: what was written, what changed (with the value it held before),
  and what went. Nothing is checked here — reading the other side is the whole exercise.`;

// The far end of authored step 5: the second note has arrived and its lines have to
// reach Line items before the dock can be told anything.
const WRITE_LINES_HTML = `
  <b>Let the plugin do the typing.</b> The second delivery note is in your base, and its lines are not.
  Copying three barcodes off a photograph teaches nothing, so the plugin writes them for you — the same
  lines a clean reading of that note would have produced.</p>
  <p>They land in <b>Line items</b> carrying their references, so the rule you built in step 2 attaches
  each one to its product and its document as it arrives. Nothing is checked here.</p>
  <p>Then finish the way the office finishes: read the list against the note, and press
  <b>Notify the dock</b> on the document.`;

// Course-4 Step 4 — the AI chain is built, and there is nothing to feed it: the
// delivery note it would read is already in the base, lines and all. The plugin
// takes that delivery back out so the learner can receive it for real, from the
// app, and let the AI do the reading. The safety net stays on hand throughout: the
// extraction is allowed to misfire, progress is not allowed to depend on it.
const REWIND_SPEC: RewindSpec = {
  document: {
    table_name: 'Documents',
    reference_column: 'Delivery reference',
    reference: DELIVERY_REFERENCE,
  },
  lines: {
    table_name: 'Line items',
    reference_column: 'Document reference',
    link_column: 'Document',
  },
  // Reverses what step 3's Validate script credited, rather than restoring fixed
  // numbers — see rewindDelivery.ts.
  stock: {
    table_name: 'Products',
    column: 'Stock',
    link_column: 'Product',
    quantity_column: 'Received qty',
    validated_column: 'Validated',
    status_column: 'Status',
    excluded_statuses: ['Damaged', 'Missing'],
  },
};

/**
 * The safety net names itself for what it is about to do — there are either no
 * lines to speak of, or some the extraction got wrong. Exported: the runner puts
 * them on the button, and they must read the same in both places.
 */
export const EXAMPLE_WRITE_LABEL = 'Write the lines';
export const EXAMPLE_FIX_LABEL = 'Fix the lines';

const REWIND_HTML = `
  <b>Take the delivery back out.</b> You have the chain — what you do not have is anything to feed
  it: that delivery is already in your base, lines and all. Let the plugin remove them, and the
  document with them, so the same note can arrive the way it really would. Your stock goes back to
  where it was too.</p>
  <p>Then receive it for real: in the <b>Delivery check</b> app, open <b>New delivery note</b>, attach
  the photo of the delivery note and submit. Watch the reading, the extraction and the script do the
  rest — then come back and verify.</p>
  <p>If the extraction goes off the rails, the plugin writes the delivery's lines for you — whole if it
  produced none, corrected if it got them wrong. What is checked is that the lines are back, never that
  the AI got them right on its own.`;

// The demo course roster. Each entry becomes a left-panel preset (id = preset _id)
// AND a fallback manifest. Content is bundled here (no Hugo host yet). Only
// Course 4 is "active" (real plugin exercises — the collaboration content was moved
// here while Course 4 is built); Courses 1–3 point learners to the website, and
// Courses 5–7 are placeholders. Descriptions come from the marketing hotspots
// (webservice-seatable-com .../data/en/hotspots-online-courses.yaml).
export type CourseAccess = 'active' | 'external' | 'soon';

export interface CourseMeta {
  id: string; // also the preset _id
  name: string; // preset display name
  access: CourseAccess;
  intro: string; // HTML description
  helpUrl?: string; // external courses only
}

export const COURSES: CourseMeta[] = [
  {
    id: 'welcome',
    name: 'Welcome — using the plugin',
    access: 'active',
    intro:
      'A quick tour of this course companion — how a course works, the buttons, and the movable toolbar.',
  },
  {
    id: 'course-1',
    name: 'Course 1 — Getting Started',
    access: 'external',
    helpUrl: 'https://seatable.com/help/online-course-1/',
    intro:
      'Build your first relational database and start collecting data.<br><br>Covers bases, views, columns, web forms, and links — everything you need to model and capture information in SeaTable.',
  },
  {
    id: 'course-2',
    name: 'Course 2 — Inputs and Outputs',
    access: 'external',
    helpUrl: 'https://seatable.com/help/online-course-2/',
    intro:
      'Bring data in and send results out.<br><br>Learn imports and exports, generating PDF documents, statistics, action buttons, and sending e-mails straight from your base.',
  },
  {
    id: 'course-3',
    name: 'Course 3 — Collaboration',
    access: 'external',
    helpUrl: 'https://seatable.com/help/online-course-3/',
    intro:
      'Work together on your data — share, co-edit, and keep everyone in sync.<br><br>Covers sharing and permissions, groups, comments and @mentions, the activity log, common datasets, and the whiteboard.',
  },
  {
    id: 'course-4',
    name: 'Course 4 — Automation & Integration',
    access: 'active',
    intro:
      'Automate your workflows and connect external tools.<br><br>Covers no-code automations, Python scripts, the API, webhooks, workflow orchestration with n8n, and AI-powered document extraction — around a warehouse receiving scenario.',
  },
  {
    id: 'course-5',
    name: 'Course 5 — Apps & Reporting',
    access: 'soon',
    intro:
      'Turn your bases into apps and polished reports for end users.<br><br>Will cover the Universal App (page types, per-page permissions, custom pages), dashboards, and the report design plugin.',
  },
  {
    id: 'course-6',
    name: 'Course 6 — Data Mastery',
    access: 'soon',
    intro:
      'Model, compute, and scale your data with formulas and relationships.<br><br>Will cover formulas, data processing, big data, and table relationships.',
  },
  {
    id: 'course-7',
    name: 'Course 7 — Maintenance & Hygiene',
    access: 'soon',
    intro:
      'Keep your bases clean, organized, and auditable over time.<br><br>Will cover deduplication, file management, and audit logs.',
  },
];

const NOTE_STYLE =
  'margin-top:22px;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.5;';

// The "Introduction" page each course opens with: its marketing description plus a
// status banner (external → follow on the website; soon → coming soon).
function introHtml(c: CourseMeta): string {
  let note = '';
  if (c.access === 'external') {
    const shown = (c.helpUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    note = `<div style="${NOTE_STYLE}background:#fff4e5;color:#8a5300;border:1px solid #ffd9a8;">📌 This course is <b>currently not supported by the plugin</b>, but you can follow it on <a href="${c.helpUrl}" target="_blank" rel="noopener" style="color:#b45309;font-weight:600;">${shown}</a>.</div>`;
  } else if (c.access === 'soon') {
    note = `<div style="${NOTE_STYLE}background:#eef1f5;color:#556070;border:1px solid #d6dbe2;">🚧 <b>Coming soon.</b></div>`;
  }
  return `<h1>${c.name}</h1><p class="lead">${c.intro}</p>${note}`;
}

// Welcome (active): a short, fully in-plugin tour so first-time learners get
// familiar with the companion before starting a real course. Pure lesson pages —
// no grading — and it references the real buttons (inline dtable-font icons render
// because the font is loaded globally), so the learner recognises them on screen.
function welcomeContentSteps(): CourseStep[] {
  return [
    {
      id: 'w1',
      type: 'course',
      title: 'Step 1 · Welcome',
      html: `
        <h1>Welcome 👋</h1>
        <p class="lead">This little panel is your course companion. It walks you through
        hands-on exercises and checks your work right here in your own base.</p>
        <p>Take a minute to get familiar with it — then you'll be ready for any course.
        Use <b>Next</b> at the top to move through this tour.</p>`,
    },
    {
      id: 'w2',
      type: 'course',
      title: 'Step 2 · How a course works',
      html: `
        <h1>How a course works</h1>
        <p>You follow each course mainly on the <b>website</b>. At certain points it asks you to
        <b>open this plugin and pick a step</b> — that's where you do something in your base and
        the plugin checks it for you.</p>
        <p>Use the <b>list on the left</b> to jump between the plugin's steps. Steps are numbered
        to match the website (Step&nbsp;2, Step&nbsp;6…), so a gap in the numbers just means those
        steps happen on the site.</p>`,
    },
    {
      id: 'w3',
      type: 'course',
      title: 'Step 3 · The buttons',
      html: `
        <h1>The buttons</h1>
        <p>The top bar carries everything you need for the current step:</p>
        <ul style="line-height:1.7;">
          <li><i class="dtable-font dtable-icon-left"></i> <b>Back</b> — return to the previous step.</li>
          <li><i class="dtable-font dtable-icon-help-center"></i> <b>Hint</b> — reveal a hint when you're stuck.</li>
          <li><i class="dtable-font dtable-icon-check-mark"></i> <b>Verify</b> (or <i class="dtable-font dtable-icon-right"></i> <b>Next</b>) — check your work, then move on once it passes.</li>
        </ul>
        <p>On the far right are the window controls: <i class="dtable-font dtable-icon-full-screen"></i>
        <b>shrink to a toolbar</b> and <i class="dtable-font dtable-icon-x"></i> <b>close</b>.</p>`,
    },
    {
      id: 'w4',
      type: 'course',
      title: 'Step 4 · The movable toolbar',
      html: `
        <h1>The movable toolbar</h1>
        <p>Working in your base and the panel is in the way? Click <b>shrink</b>
        (<i class="dtable-font dtable-icon-full-screen"></i>, top-right) to collapse it into a small
        <b>toolbar</b> you can drag anywhere.</p>
        <p>While it's a toolbar the whole base stays clickable — nothing is blocked — and you keep the
        essentials:</p>
        <ul style="line-height:1.7;">
          <li><i class="dtable-font dtable-icon-drag"></i> <b>Drag</b> it wherever it's out of your way.</li>
          <li><i class="dtable-font dtable-icon-info"></i> <b>Info</b> — show the instruction (and a hint) any time.</li>
          <li><i class="dtable-font dtable-icon-check-mark"></i> <b>Verify</b> — check your work without expanding.</li>
          <li><i class="dtable-font dtable-icon-full-screen"></i> <b>Expand</b> — bring the full panel back.</li>
        </ul>
        <p>On the next step you'll try it yourself.</p>`,
    },
    {
      id: 'w5',
      type: 'exercise',
      title: 'Step 5 · Try the toolbar',
      instruction: 'Shrink to the toolbar and drag it into the lower-right corner, then Verify.',
      html: `
        <b>Your turn.</b> Click <b>shrink</b> (<i class="dtable-font dtable-icon-full-screen"></i>,
        top-right) to collapse this panel into the toolbar, drag it into the <b>lower-right quarter</b>
        of your screen, then press <i class="dtable-font dtable-icon-check-mark"></i> <b>Verify</b> on
        the toolbar.`,
      hint: 'Shrink with the ⤢ icon at the top-right; drag using the ⠿ handle on the toolbar; then click the ✓ on the toolbar. “Lower-right” means the bottom-right quarter of your whole screen.',
      grade: { kind: 'plugin-ui', check: 'toolbar-lower-right' },
      successMessage:
        "Perfect — you've got the toolbar down 🎉 That's the tour! Expand the plugin and pick a course from the list to begin.",
    },
  ];
}

// Course 4 (active): the plugin CHECKPOINTS only — the course narrative unfolds on
// the website, which sends the learner into the plugin by authored step number. So
// the manifest is intentionally gapped (labelled "Step N") and each checkpoint hands
// back to the website via `continuesOn`. One checkpoint per authored step that has
// something for the plugin to do — steps 1, 6 and 8 deliberately have none.
function course4ContentSteps(): CourseStep[] {
  return [
    {
      id: 'am01',
      type: 'exercise',
      title: 'Step 2 · Build the linking automation',
      continuesOn: 'website',
      html: LINK_AUTOMATION_HTML,
      instruction:
        'Build an automation on Line items that links each new line to its product and document.',
      demo: 'automation-guided',
      automationStages: LINK_AUTOMATION_STAGES,
      hint: 'On Line items: trigger “a new row is added”, two conditions (Product reference & Document reference not empty), then two Add links actions — one to Products (Reference), one to Documents (Delivery reference).',
      // Structural (config) grade — read over REST, order-independent on the two
      // link actions so a "just check it" learner passes whatever order they built.
      grade: {
        kind: 'automation-rule',
        trigger_table: 'Line items',
        trigger_event: 'rows_added',
        conditions: [
          { column: 'Product reference', predicate: 'is_not_empty' },
          { column: 'Document reference', predicate: 'is_not_empty' },
        ],
        conjunction: 'And',
        link_actions: [
          {
            source_column: 'Product reference',
            target_table: 'Products',
            target_column: 'Reference',
          },
          {
            source_column: 'Document reference',
            target_table: 'Documents',
            target_column: 'Delivery reference',
          },
        ],
      },
      successMessage:
        'Your linking automation is complete — every new line will now find its product and its document on its own.',
      // Config-graded, so nothing has run through the rule yet: prove it on real rows
      // before handing back to the website.
      watch: {
        table_name: 'Line items',
        rows: DELIVERY_LINES,
        link_columns: ['Product', 'Document'],
        html: WATCH_HTML,
        instruction:
          'Open the Line items table, then add the three delivery lines and watch the links fill in.',
        successMessage:
          'Both links filled themselves in, on lines you never touched. You didn’t automate this delivery — you built a rule that holds for every line that will ever enter this table, whoever puts it there.',
      },
    },
    {
      id: 'rv01',
      type: 'exercise',
      watchTable: 'Documents',
      title: 'Step 3 · A reviewer for a short delivery',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: REVIEWER_HTML,
      instruction:
        'Let the plugin create a short delivery, then run your rule from the automation editor and verify.',
      hint: 'Use Run now in the automation editor — no need to wait for the scheduled hour.',
      demo: 'seed-discrepancy',
      reset: {
        document: {
          table_name: 'Documents',
          reference_column: 'Delivery reference',
          reference: SEED_DELIVERY_REFERENCE,
        },
        lines: {
          table_name: 'Line items',
          reference_column: 'Document reference',
          link_column: 'Document',
        },
      },
      seed: {
        document: {
          table_name: 'Documents',
          row: {
            'Delivery reference': SEED_DELIVERY_REFERENCE,
            'PO reference': SEED_PO_REFERENCE,
            'Movement type': 'Delivery',
          },
        },
        lines: {
          table_name: 'Line items',
          rows: [
            {
              // A product that is NOT on the seeded delivery note: reusing one would
              // put the same product on two open deliveries at once, which muddles
              // the stock story the previous section just told.
              'Product reference': '9310342001124',
              Qty: 48,
              'Received qty': 36,
              'Document reference': SEED_DELIVERY_REFERENCE,
              Status: 'Too few',
              // Already validated: the receiving side of this line is settled, only
              // the dispute is left. Without this it would sit in the operator's
              // "to check" queue, and validating it would credit the stock with
              // goods that were never delivered.
              Validated: true,
            },
          ],
          link_columns: ['Product', 'Document'],
        },
      },
      // Graded from the activity log of the document the plugin just created: what
      // has to be true is not that a reviewer is there, but that an AUTOMATION put
      // it there. The row being brand new is what makes that reading trustworthy.
      grade: {
        kind: 'automation-set',
        table_name: 'Documents',
        column: 'Reviewer',
      },
    },
    {
      id: 'rw01',
      type: 'exercise',
      watchTable: 'Line items',
      title: 'Step 4 · Rewind, and do it for real',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: REWIND_HTML,
      instruction:
        'Let the plugin take the seeded delivery back out, then receive it again from the app and let the AI read the note.',
      hint: 'The form is the second page of the Delivery check app — attach the photo and submit; everything else is read from the picture.',
      demo: 'rewind',
      rewind: REWIND_SPEC,
      // The safety net, written in REPLACE mode on a rewind step: what a clean
      // extraction would have produced, whatever the run actually produced.
      example: { table_name: 'Line items', rows: DELIVERY_LINES },
      // Counts the lines, and nothing else: the AI wrote them, and grading their
      // content would make the model's success a condition of progress.
      grade: {
        kind: 'rows-exist',
        table_name: 'Line items',
        where: { column: 'Document reference', equals: DELIVERY_REFERENCE },
        min_count: 3,
        noun: 'lines for this delivery',
      },
      successMessage:
        'The delivery is back — read off a photograph this time, with its lines linked by the rule you built in step 2.',
    },
    {
      id: 'wh01',
      type: 'exercise',
      watchTable: 'Products',
      // The catalog runs to hundreds of rows and the burst appends one: in the
      // default view it lands off-screen, and the edit and the delete then happen on
      // a row the learner never saw. A narrow view keeps all three in sight wherever
      // they had scrolled. Inert until the base actually carries the view.
      watchView: 'Step 5a - Webhook',
      title: 'Step 5a · See what SeaTable sends',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: WEBHOOK_HTML,
      instruction:
        'Point your webhook at the test endpoint first, then let the plugin make a change you know the shape of.',
      hint: 'Nothing is graded here — the whole exercise is to go and read what arrived at the other end.',
      demo: 'webhook-burst',
      burst: WEBHOOK_BURST,
      demoDoneMessage: '✅ The three changes have been made — go and read them at the other end.',
    },
    {
      // The other end of the same authored step, and its own menu entry: the course
      // sends the learner back here much later, once the second note has arrived.
      // One entry per "open the plugin" in the prose — a dropdown would have hidden
      // a chronological beat behind a button meant for choices.
      id: 'wl01',
      type: 'exercise',
      watchTable: 'Line items',
      title: 'Step 5b · Write the delivery’s lines',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: WRITE_LINES_HTML,
      instruction:
        'Let the plugin write the second delivery’s lines, rather than copy three barcodes off a photograph.',
      hint: 'The lines land in Line items and your step-2 rule attaches them; then press Notify the dock on the document.',
      demo: 'write-lines',
      demoLabel: 'Write the lines',
      demoDoneMessage: '✅ The delivery’s lines are in Line items, linked by your own rule.',
      rewind: NOTE_2_SPEC,
      example: { table_name: 'Line items', rows: NOTE_2_LINES },
    },
    {
      id: 'ap01',
      type: 'exercise',
      watchTable: 'Documents',
      title: 'Step 7a · The electronic delivery note',
      continuesOn: 'website',
      handoffNote: 'Now go and push one of its lines from the API reference ↩',
      html: API_CREATE_HTML,
      instruction:
        'Let the plugin drop in the electronic delivery note, then go and push one of its lines from the API reference.',
      hint: 'Nothing is graded here — this only puts the note in your base so your pushed lines have something to link to.',
      demo: 'seed-discrepancy',
      demoLabel: 'Create new delivery',
      demoDoneMessage: '✅ The delivery note is in your base, with no lines and no file.',
      // No `stock` to undo: nothing pushed through the API is ever validated here.
      reset: {
        document: {
          table_name: 'Documents',
          reference_column: 'Delivery reference',
          reference: API_DELIVERY_REFERENCE,
        },
        lines: {
          table_name: 'Line items',
          reference_column: 'Document reference',
          link_column: 'Document',
        },
      },
      // Document only: the lines are what the learner pushes through the API, and
      // the header has to be there first or they would land unlinked. No `grade`
      // either — the check belongs to 7b, once the line has actually been pushed.
      seed: {
        document: {
          table_name: 'Documents',
          row: {
            'Delivery reference': API_DELIVERY_REFERENCE,
            'PO reference': API_PO_REFERENCE,
            'Movement type': 'Delivery',
          },
        },
      },
    },
    {
      id: 'ap02',
      type: 'exercise',
      title: 'Step 7b · Check the pushed line',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: API_VERIFY_HTML,
      instruction:
        'Push at least one line into Line items from the API reference, then verify it arrived, linked itself and came in through the API.',
      hint: `In the API reference, table_name is "Line items" and the row needs Document reference "${API_DELIVERY_REFERENCE}", a Product reference from your catalog, and a Qty.`,
      // Counts a pushed line, but only one that has LINKED itself: the payoff of
      // this step is that a row arriving from outside is treated exactly like one
      // typed by hand, and that is the rule from step 2 doing the treating.
      grade: {
        kind: 'rows-exist',
        table_name: 'Line items',
        where: { column: 'Document reference', equals: API_DELIVERY_REFERENCE },
        min_count: 1,
        linked_columns: ['Product', 'Document'],
        // Without this the step passes for a line typed into the grid by hand, which
        // is the one thing it is not about.
        written_by_app: true,
        noun: 'pushed line',
      },
      successMessage:
        'Your line came in through the API and attached itself on the way — no scanner, no camera, no keyboard, and nothing in your base can tell the difference.',
    },
  ];
}

// Build every demo course manifest: an Introduction page, plus the active/dummy
// pages for Courses 4 and 3.
export function buildAllFallbackManifests(): CourseManifest[] {
  return COURSES.map((c) => {
    // The Welcome tour is fully in-plugin — its own pages, no generic intro.
    if (c.id === 'welcome') {
      return { courseId: c.id, title: c.name, steps: welcomeContentSteps() };
    }
    const steps: CourseStep[] = [
      { id: 'intro', type: 'course', title: 'Introduction', html: introHtml(c) },
    ];
    if (c.id === 'course-4') steps.push(...course4ContentSteps());
    return { courseId: c.id, title: c.name, steps };
  });
}

// Load all demo courses. A remote Hugo per-course fetch would slot in here when
// USE_REMOTE_CONTENT is enabled and a host exists; for now everything is bundled.
export async function loadAllCourses(): Promise<CourseManifest[]> {
  return buildAllFallbackManifests();
}
