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
   * action. 'live-modify' runs a sequence of learner edits so you can watch the grid
   * update and inspect how the edits are attributed in row history. 'load-example'
   * injects the canonical example rows (`example` below) so the learner is never
   * blocked when the AI extraction misfires. 'automation-guided' runs the Step-2
   * "build your first automation" flow: a choice between a guided, stage-by-stage
   * build (each verified before the next, from `automationStages`) and a one-shot
   * "just check it" against the step's `grade` (an 'automation-rule' rule).
   */
  demo?: 'live-modify' | 'load-example' | 'automation-guided';
  /** Rows injected by the 'load-example' action (column NAME → display value). */
  example?: { table_name: string; rows: Record<string, any>[] };
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

const EXERCISE_HTML = `
  A quality check flagged this delivery line (<b>To check</b> is ticked): the goods arrived
  <b>damaged</b>, but its <b>Status</b> still reads <b>"As expected"</b>. Set the line's
  <b>Status</b> to <b>"Damaged"</b>, then untick <b>To check</b> to validate the line.`;

const LIVE_MODIFY_HTML = `
  <b>Live modify example.</b> Watch the plugin edit the base for you: it steps a
  <b>Line items</b> row's <b>Status</b> through a few values. Keep the Line items table in
  view, click <b>Run live edits</b>, then open that row's history to see how the edits are
  attributed.`;

// The delivery line the Course-4 status exercises (Fix-the-stale-status + Live-modify)
// act on — a fixed row in the imported base.
const LINE_ITEM_ROW_ID = 'LK228TKwQW-uRMzT26obqw';

const LOAD_EXAMPLE_HTML = `
  <b>Load the example.</b> When the automatic extraction of the delivery note misfires,
  you're never blocked: the plugin can inject the expected <b>Line items</b> for you.
  Click <b>Load the example</b> to add the three delivery lines, then continue with the
  exercise.`;

// Course-4 Step 2 — "Import and link the lines". The learner builds their first
// automation on Line items; the plugin either walks them through it stage by stage
// or checks the finished rule. Grading reads the automation CONFIG over REST, so
// it works BEFORE any data has flowed through the rule (see automationGrade.ts).
const LINK_AUTOMATION_HTML = `
  <b>Build your first automation.</b> On the <b>Line items</b> table, create an automation that links
  every new line to its <b>Product</b> and its <b>Document</b> by matching references — no links entered by
  hand. Choose <b>Guide me</b> to build it one stage at a time (each checked before the next), or
  <b>Just check it</b> if you’ve already built it.`;

const LINK_AUTOMATION_STAGES: NonNullable<CourseStep['automationStages']> = [
  {
    title: 'Automation created',
    stage: 'created',
    instruction: 'Add a new rule in the Automations editor and give it a name.',
    html: `<b>Create the automation.</b> Open the <b>Automations editor</b> and add a new rule and 
      give it a name, then click <b>Check</b>.`,
  },
  {
    title: 'Trigger + guard',
    stage: 'trigger',
    instruction:
      'Trigger on “When a row is added”, with Product reference and Document reference both not empty.',
    html: `<b>Set the trigger — and guard it.</b> Choose <b>“When a row is added”</b>, then add two
      <b>conditions</b> so it only runs on complete lines: <b>Product reference</b> is <b>not empty</b>
      <b>and</b> <b>Document reference</b> is <b>not empty</b>.`,
  },
  {
    title: 'Link the product',
    stage: 'action:0',
    instruction: 'Add an “Add links” action matching Product reference to a product’s Reference.',
    html: `<b>Link the product.</b> Add an <b>Add links</b> action that fills the
      <b>Product</b> column: the line’s <b>Product reference</b> should equal a product’s
      <b>Reference</b>.`,
  },
  {
    title: 'Link the document',
    stage: 'action:1',
    instruction:
      'Add a second “Add links” action matching Document reference to a document’s Identifier.',
    html: `<b>Link the document.</b> Add a second <b>Add links</b> action that fills the
      <b>Document</b> column: the line’s <b>Document reference</b> should equal a document’s
      <b>Identifier</b>. That completes your automation.`,
  },
];

const AUTOMATION_HTML = `
  <b>Automation review.</b> Build an <b>automation rule</b> on <b>Documents</b> that fills the
  <b>Reviewer</b> column whenever a document needs review (<b>Review needed</b> = true), then run
  it on a document. Click <b>Verify</b>: the plugin checks the activity log to confirm the
  Reviewer was set <em>by an automation</em> — grading the method, not just the value.`;

// The canonical example rows the plugin injects into "Line items" when the AI OCR
// extraction misfires — the learner is never blocked (grading targets rows exist +
// validated, never AI success). Column NAME → display value; blank columns (links /
// formulas / automation-filled) are intentionally omitted. From line_items.csv.
const LINE_ITEMS_DOC_URL =
  'https://cloud.st-next.de/apps/custom/delivery-check/?page_id=XSyG&record_id=Vtf2nXaAQKWMzdT-pYDSGA';
const LINE_ITEMS_EXAMPLE: Record<string, any>[] = [
  {
    'Product reference': '098765',
    Qty: 1,
    'Document reference': 'DNINT-001',
    'To check': true,
    'Document URL': LINE_ITEMS_DOC_URL,
  },
  {
    'Product reference': '567890',
    Qty: 2,
    'Document reference': 'DNINT-001',
    'To check': true,
    'Document URL': LINE_ITEMS_DOC_URL,
  },
  {
    'Product reference': '345678',
    Qty: 3,
    'Document reference': 'DNINT-001',
    'To check': true,
    'Document URL': LINE_ITEMS_DOC_URL,
  },
];

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
      'Automate your workflows and connect external tools.<br><br>Will cover automations, scripts, API basics, webhooks, and integrations with n8n, Zapier, and Make.',
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
// back to the website via `continuesOn`. The status exercises act on a fixed Line
// items row (LINE_ITEM_ROW_ID) in the imported base.
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
      hint: 'On Line items: trigger “a new row is added”, two conditions (Product reference & Document reference not empty), then two Add links actions — one to Products (Reference), one to Documents (Identifier).',
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
            target_column: 'Identifier',
          },
        ],
      },
      successMessage:
        'Your linking automation is complete — every new line will now find its product and its document on its own.',
    },
    {
      id: 'ex01',
      type: 'exercise',
      title: 'Fix the stale status',
      continuesOn: 'website',
      html: EXERCISE_HTML,
      hint: 'In the Line items table, set the flagged line’s Status to Damaged and untick its To check box.',
      grade: {
        table_name: 'Line items',
        expected: [{ row_id: LINE_ITEM_ROW_ID, row: { Status: 'Damaged', 'To check': false } }],
      },
      successMessage: 'Well done — the status has been updated and your line item validated.',
    },
    {
      id: 'lm01',
      type: 'exercise',
      title: 'Live modify example',
      continuesOn: 'website',
      html: LIVE_MODIFY_HTML,
      demo: 'live-modify',
    },
    {
      id: 'le02',
      type: 'exercise',
      title: 'Load the example',
      continuesOn: 'website',
      html: LOAD_EXAMPLE_HTML,
      demo: 'load-example',
      example: { table_name: 'Line items', rows: LINE_ITEMS_EXAMPLE },
    },
    {
      id: 'au01',
      type: 'exercise',
      title: 'Automation review',
      continuesOn: 'website',
      handoffNote: 'You’re done here — head back to the website to continue the course ↩',
      html: AUTOMATION_HTML,
      hint: 'Add an automation on Documents: when Review needed becomes true, set the Reviewer column to a colleague. Trigger it on at least one document, then Verify.',
      // Open-ended (method) grade: pass only if an AUTOMATION set Reviewer on a
      // Documents row that needs review — graded from the op-log, not the cell state.
      grade: {
        kind: 'automation-set',
        table_name: 'Documents',
        column: 'Reviewer',
        condition: { column: 'Review needed', equals: true },
      },
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
