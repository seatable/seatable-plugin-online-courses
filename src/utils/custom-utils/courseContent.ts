/**
 * Course content — the steps of each course, as the plugin shows them.
 *
 * A course is split in two: its LOGIC, in this file (the steps and their order, the
 * grade rules, what the plugin writes into a base), and its WORDS, in one JSON file
 * per language under src/content/<courseId>/ (manifest.en.json, manifest.fr.json…,
 * all of the same shape — see courseTexts.ts). `buildAllFallbackManifests()` puts the
 * two together, in the language SeaTable is displayed in.
 *
 * A course is a manifest (ordered steps) + one HTML body per step. Grade rules (see
 * grader.ts) travel inside the manifest.
 *
 * The remote path below (CONTENT_BASE, fetchManifest, fetchStepHtml,
 * USE_REMOTE_CONTENT) is kept, unused: the team chose bundled content (2026-10-06),
 * but may come back to serving it from a host. See [[content-sourcing-and-page-registry]].
 */
import { AnyGradeRule } from './grader';
import { RewindSpec } from './rewindDelivery';
import { ColleagueWriteSpec } from './colleagueStoreWrite';
import { ColleagueReplySpec } from './colleagueComment';
import { WebhookBurstSpec } from './webhookBurst';
import { AutomationStage } from './automationGrade';
import { getCurrentStepId } from './courseStore';
import { fillParams, getCourseTexts } from './courseTexts';

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
  /** Optional hint, shown behind the Hint toggle. Authored HTML: SeaTable icons welcome. */
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
  demo?:
    | 'automation-guided'
    | 'seed-discrepancy'
    | 'rewind'
    | 'webhook-burst'
    | 'write-lines'
    | 'colleague-write'
    | 'colleague-setup'
    | 'colleague-window';
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
   * Payload of the 'colleague-write' action (Course 3 EXPERIMENT): the edit the
   * colleague makes, driven through a SECOND dtable-store opened with her own base
   * token, so the operation is singular, names the row, carries its before-values
   * and is signed by her. See colleagueStoreWrite.ts for what this is testing and
   * why the REST route cannot serve Step 4.
   */
  colleagueWrite?: ColleagueWriteSpec;
  /**
   * Optional reply the colleague posts in the row's thread AFTER `colleagueWrite`
   * (Course 3, Step 3: she does what was asked, then says so). See colleagueComment.ts
   * for how it reaches the learner without a mention.
   */
  colleagueReply?: ColleagueReplySpec;
  /**
   * Edits the colleague makes on OTHER rows, after `colleagueWrite` and its reply
   * (Course 3, Steps 3b and 4). They are there for Step 4: its base log, filtered on
   * her, should read like the history of someone who works in the base — a run of
   * similar entries, with the Status change buried among them rather than on top.
   * Same-minute entries on other rows do not blur Step 4's search: each entry names
   * its row, and the time only has to tell James Bennett's two entries apart. Keep
   * them off Status (the quiz counts the active customers), Email (the key of Step
   * 5's Compare and copy) and James Bennett's row (Step 4 reads its row log).
   */
  colleagueSideWrites?: ColleagueWriteSpec[];
  /**
   * Which of the colleague's two surfaces the 'colleague-window' step draws.
   * 'home' is her account bell, where a SHARED BASE lands (Step 2); 'base' is the
   * in-base one, where a COMMENT or an @mention lands (Step 3). They are separate
   * inboxes, so the surface is stated by the step rather than guessed — drawing
   * the wrong one teaches the opposite of the lesson. See ColleagueWindow.tsx.
   */
  colleagueWindow?: { surface: 'home' | 'base'; caption?: string };
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

// --- the courses: logic here, words in src/content/<courseId>/manifest.<lang>.json ---
// Everything below is what does not change with the language: the steps and their
// order, the grade rules, and what the plugin writes into a base. The titles, bodies,
// captions, hints and messages are added by `withTexts` from the course's text files
// (see courseTexts.ts). A step written here needs its texts in manifest.en.json under
// the same id, or it shows its id as a title and nothing else.

/** A step as written in this file: everything but its words. */
type StepLogic = Omit<CourseStep, 'title' | 'watch' | 'automationStages'> & {
  watch?: Omit<NonNullable<CourseStep['watch']>, 'html' | 'instruction' | 'successMessage'>;
  automationStages?: { stage: AutomationStage }[];
};

const STEP_TEXT_FIELDS = [
  'title',
  'instruction',
  'hint',
  'html',
  'successMessage',
  'handoffNote',
  'demoLabel',
  'demoDoneMessage',
] as const;

// Each `{name}` in the texts is filled from `params`, so a value the logic also uses
// is written once, here.
function withTexts(
  courseId: string,
  steps: StepLogic[],
  params: Record<string, string> = {}
): CourseStep[] {
  const texts = getCourseTexts(courseId).steps;
  const fill = (fields: Record<string, string | undefined> = {}) => {
    const out: Record<string, string> = {};
    Object.keys(fields).forEach((key) => {
      const value = fields[key];
      if (value != null) out[key] = fillParams(value, params);
    });
    return out;
  };
  return steps.map((logic) => {
    const t = texts[logic.id] || {};
    const words = fill(
      STEP_TEXT_FIELDS.reduce((acc, field) => ({ ...acc, [field]: t[field] }), {})
    );
    const step = { ...logic, title: logic.id, ...words } as CourseStep;
    if (logic.grade && t.grade?.noun != null) {
      step.grade = { ...logic.grade, noun: fillParams(t.grade.noun, params) } as AnyGradeRule;
    }
    if (logic.colleagueWindow && t.colleagueWindow?.caption != null) {
      step.colleagueWindow = {
        ...logic.colleagueWindow,
        caption: fillParams(t.colleagueWindow.caption, params),
      };
    }
    if (logic.watch) {
      step.watch = { html: '', ...logic.watch, ...fill(t.watch) };
    }
    if (logic.automationStages) {
      step.automationStages = logic.automationStages.map((stage) => ({
        title: stage.stage,
        html: '',
        ...stage,
        ...fill(t.automationStages?.[stage.stage]),
      }));
    }
    return step;
  });
}

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

// Step 3's seeded delivery comes from a DIFFERENT supplier than the seeded note, and
// the two references in play do not belong to the same party: the delivery reference
// is the supplier's own numbering (so it looks nothing like the INT-00x of the note
// already in the base — every supplier numbers its own delivery notes), while the PO
// reference is the warehouse's, and stays in its series (INT-001 carries 2462/2026).
// The delivery reference must also be unique: links are made on the raw value, so
// reusing one would make them ambiguous.
const SEED_DELIVERY_REFERENCE = '2026-08-4417';
const SEED_PO_REFERENCE = '2588/2026';

// Course-4 Step 2 — "Import and link the lines". The learner builds their first
// automation on Line items; the plugin either walks them through it stage by stage
// or checks the finished rule. Grading reads the automation CONFIG over REST, so
// it works BEFORE any data has flowed through the rule (see automationGrade.ts).
const LINK_AUTOMATION_STAGES: NonNullable<StepLogic['automationStages']> = [
  { stage: 'created' },
  { stage: 'trigger' },
  { stage: 'action:0' },
  { stage: 'action:1' },
];

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
// Also shown in Step 7's texts, as {apiDeliveryReference}.
const API_DELIVERY_REFERENCE = 'DN-2026-000871';
// The warehouse's own order number, so it stays in the warehouse's series — INT-001
// carries 2462/2026 and Step 3's seed 2588/2026 — and comes after both, this being
// the last delivery of the course. See the note above SEED_DELIVERY_REFERENCE: the
// delivery reference belongs to the supplier, the PO reference to you.
const API_PO_REFERENCE = '2634/2026';

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

// The demo course roster. Each entry becomes a left-panel preset (id = preset _id)
// AND a fallback manifest. The name and the intro of each course are in its text
// files (`title`, `intro`). Courses 1–2 point learners to the website, and Courses
// 5–7 are placeholders. Descriptions come from the marketing hotspots
// (webservice-seatable-com .../data/en/hotspots-online-courses.yaml).
export type CourseAccess = 'active' | 'external' | 'soon';

export interface CourseMeta {
  id: string; // also the preset _id
  name: string; // preset display name
  access: CourseAccess;
  intro: string; // HTML description
  helpUrl?: string; // external courses only
}

const COURSE_ROSTER: Omit<CourseMeta, 'name' | 'intro'>[] = [
  { id: 'welcome', access: 'active' },
  { id: 'course-1', access: 'external', helpUrl: 'https://seatable.com/help/online-course-1/' },
  { id: 'course-2', access: 'external', helpUrl: 'https://seatable.com/help/online-course-2/' },
  { id: 'course-3', access: 'active', helpUrl: 'https://seatable.com/help/online-course-3/' },
  { id: 'course-4', access: 'active' },
  { id: 'course-5', access: 'soon' },
  { id: 'course-6', access: 'soon' },
  { id: 'course-7', access: 'soon' },
];

export const COURSES: CourseMeta[] = COURSE_ROSTER.map((c) => {
  const { title, intro } = getCourseTexts(c.id);
  return { ...c, name: title, intro };
});

const NOTE_STYLE =
  'margin-top:22px;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.5;';

// The "Introduction" page each course opens with: its marketing description plus a
// status banner (external → follow on the website; soon → coming soon).
function introHtml(c: CourseMeta): string {
  let note = '';
  if (c.access === 'external') {
    const shown = (c.helpUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    note = `<div style="${NOTE_STYLE}background:#fff4e5;color:#8a5300;border:1px solid #ffd9a8;">📌 This course is currently not supported by the plugin, but you can follow it on <a href="${c.helpUrl}" target="_blank" rel="noopener" style="color:#b45309;font-weight:600;">${shown}</a>.</div>`;
  } else if (c.access === 'soon') {
    note = `<div style="${NOTE_STYLE}background:#eef1f5;color:#556070;border:1px solid #d6dbe2;">🚧 Coming soon.</div>`;
  }
  return `<h1>${c.name}</h1><p>${c.intro}</p>${note}`;
}

// Welcome (active): a short, fully in-plugin tour so first-time learners get
// familiar with the companion before starting a real course. Pure lesson pages —
// no grading — and it references the real buttons (inline dtable-font icons render
// because the font is loaded globally), so the learner recognises them on screen.
function welcomeContentSteps(): CourseStep[] {
  return withTexts('welcome', [
    { id: 'welcome', type: 'course' },
    { id: 'how-a-course-works', type: 'course' },
    {
      // An exercise page, so the learner meets the banner layout and its resize
      // handle while being told about it, rather than by surprise in a course.
      id: 'room-for-your-base',
      type: 'exercise',
      grade: { kind: 'plugin-ui', check: 'banner-resized' },
    },
    // The page has a hint of its own, so the Hint button it describes is there to try.
    { id: 'the-buttons', type: 'course' },
    { id: 'the-movable-toolbar', type: 'course' },
    {
      id: 'try-the-toolbar',
      type: 'exercise',
      grade: { kind: 'plugin-ui', check: 'toolbar-lower-right' },
    },
    // A full-height page to end on: the course list on the left is only readable
    // at full height, and it is what the learner needs next.
    { id: 'youre-ready', type: 'course' },
  ]);
}

// Course 4 (active): the plugin CHECKPOINTS only — the course narrative unfolds on
// the website, which sends the learner into the plugin by authored step number. So
// the manifest is intentionally gapped (labelled "Step N") and each checkpoint hands
// back to the website via `continuesOn`. One checkpoint per authored step that has
// something for the plugin to do — steps 1, 6 and 8 deliberately have none.
function course4ContentSteps(): CourseStep[] {
  return withTexts(
    'course-4',
    [
      {
        id: 'build-the-linking-automation',
        type: 'exercise',
        continuesOn: 'website',
        demo: 'automation-guided',
        automationStages: LINK_AUTOMATION_STAGES,
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
        // Config-graded, so nothing has run through the rule yet: prove it on real rows
        // before handing back to the website.
        watch: {
          table_name: 'Line items',
          rows: DELIVERY_LINES,
          link_columns: ['Product', 'Document'],
        },
      },
      {
        id: 'a-reviewer-for-a-short-delivery',
        type: 'exercise',
        watchTable: 'Documents',
        continuesOn: 'website',
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
        id: 'rewind-and-do-it-for-real',
        type: 'exercise',
        watchTable: 'Line items',
        continuesOn: 'website',
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
        },
      },
      {
        id: 'see-what-seatable-sends',
        type: 'exercise',
        watchTable: 'Products',
        // The catalog runs to hundreds of rows and the burst appends one: in the
        // default view it lands off-screen, and the edit and the delete then happen on
        // a row the learner never saw. A narrow view keeps all three in sight wherever
        // they had scrolled. Inert until the base actually carries the view.
        watchView: 'Step 5a - Webhook',
        continuesOn: 'website',
        demo: 'webhook-burst',
        burst: WEBHOOK_BURST,
      },
      {
        // The other end of the same authored step, and its own menu entry: the course
        // sends the learner back here much later, once the second note has arrived.
        // One entry per "open the plugin" in the prose — a dropdown would have hidden
        // a chronological beat behind a button meant for choices.
        id: 'write-the-deliverys-lines',
        type: 'exercise',
        watchTable: 'Line items',
        continuesOn: 'website',
        demo: 'write-lines',
        rewind: NOTE_2_SPEC,
        example: { table_name: 'Line items', rows: NOTE_2_LINES },
      },
      {
        id: 'the-electronic-delivery-note',
        type: 'exercise',
        watchTable: 'Documents',
        continuesOn: 'website',
        demo: 'seed-discrepancy',
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
        id: 'check-the-pushed-line',
        type: 'exercise',
        continuesOn: 'website',
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
        },
      },
    ],
    { apiDeliveryReference: API_DELIVERY_REFERENCE }
  );
}

/**
 * ⚠️ Where the token is KEPT is stated by the setup widget (ColleagueSetup.tsx),
 * not by the step's text — deliberately. That text is translated, in files that do
 * not ship next to the code deciding where the token goes; the widget cannot drift
 * from it, a translation can.
 *
 * Course 3 — the plugin's pages, one or two per course step: 2a/2b (Malika joins,
 * her home page), 3a/3b (her window in the base, her answer), 4 (her status
 * change). Her edits go through her own store — see colleagueStoreWrite.ts for
 * why no REST route could give the log the shape Step 4 teaches.
 *
 * What she writes INTO the base (cells, and her reply in the thread) is logic, not
 * text: it is data in an English base, like the rest of the sample data.
 */
function course3ContentSteps(): CourseStep[] {
  return withTexts('course-3', [
    {
      id: 'malika-joins-you',
      // A full page: nothing in the base to watch while pasting a token.
      type: 'course',
      demo: 'colleague-setup',
      // 2a flows straight into 2b: nothing on the website sits between the two, and
      // 2b's "before" (her home page without the base) is the next thing to see.
      // Across numbered steps the learner goes back to the website instead.
      continuesOn: 'plugin',
    },
    {
      id: 'malikas-home-page',
      type: 'course',
      // Read on the website next: the course text goes on before the next page.
      continuesOn: 'website',
      demo: 'colleague-window',
      colleagueWindow: { surface: 'home' },
    },
    {
      id: 'malikas-window-in-this-base',
      type: 'course',
      // 3a hands straight on to 3b in-plugin once the mention has reached her: the
      // website text between them is about this same window, and says to move on.
      continuesOn: 'plugin',
      demo: 'colleague-window',
      colleagueWindow: { surface: 'base' },
    },
    {
      id: 'malika-answers',
      type: 'exercise',
      demo: 'colleague-write',
      watchTable: 'Customers',
      continuesOn: 'website',
      colleagueWrite: {
        table: 'Customers',
        match: { column: 'Full Name', equals: 'James Bennett' },
        cells: { Industry: 'Technology' },
      },
      // No mention, on purpose: the learner wrote the request, so they are subscribed
      // to the row's conversation and the reply reaches them anyway — Step 3b's point.
      colleagueReply: {
        table: 'Customers',
        match: { column: 'Full Name', equals: 'James Bennett' },
        text: 'Done — James Bennett’s industry is now Technology.',
      },
      colleagueSideWrites: [
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Clara Moreau' },
          cells: { 'Job Title': 'Head of Operations' },
        },
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Harry Sánchez' },
          cells: { Phone: '+44 63 770 2688' },
        },
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Inès Weber' },
          cells: { 'Job Title': 'Head of Communications' },
        },
      ],
    },
    {
      id: 'malika-changes-a-status',
      type: 'exercise',
      demo: 'colleague-write',
      watchTable: 'Customers',
      continuesOn: 'website',
      // Made through her own store, so the log shows exactly what a hand edit in the
      // grid would: "Row James Bennett modified", signed by her, with Restore
      // available — validated in the UI on 2026-09-16. See colleagueStoreWrite.ts.
      colleagueWrite: {
        table: 'Customers',
        match: { column: 'Full Name', equals: 'James Bennett' },
        cells: { Status: 'Client' },
      },
      // After the status change, so it sits below them in the newest-first base log.
      colleagueSideWrites: [
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Manon Fischer' },
          cells: { 'Job Title': 'Senior Project Manager' },
        },
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Pablo Rousseau' },
          cells: { Phone: '+31 10 874 1390' },
        },
        {
          table: 'Customers',
          match: { column: 'Full Name', equals: 'Emily Bakker' },
          cells: { 'Job Title': 'Facilities Manager' },
        },
      ],
    },
  ]);
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
      { id: 'introduction', type: 'course', title: 'Introduction', html: introHtml(c) },
    ];
    if (c.id === 'course-4') steps.push(...course4ContentSteps());
    if (c.id === 'course-3') steps.push(...course3ContentSteps());
    return { courseId: c.id, title: c.name, steps };
  });
}

// Load all demo courses. A remote Hugo per-course fetch would slot in here when
// USE_REMOTE_CONTENT is enabled and a host exists; for now everything is bundled.
export async function loadAllCourses(): Promise<CourseManifest[]> {
  return buildAllFallbackManifests();
}
