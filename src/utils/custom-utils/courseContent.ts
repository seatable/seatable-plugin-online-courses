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
   * Optional demo hook — swaps the exercise's Verify flow for a scripted plugin
   * action. 'live-modify' runs a sequence of learner edits so you can watch the grid
   * update and inspect how the edits are attributed in row history. 'load-example'
   * injects the canonical example rows (`example` below) so the learner is never
   * blocked when the AI extraction misfires.
   */
  demo?: 'live-modify' | 'load-example';
  /** Rows injected by the 'load-example' action (column NAME → display value). */
  example?: { table_name: string; rows: Record<string, any>[] };
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

// Single-step deep-link. ⛔ DEAD in production — SeaTable's dtable-web strips
// unknown URL params before the plugin script evaluates (see
// PLANNED-CHANGES-2026-07-02.md §1). Kept ONLY as a dev-only convenience; the
// left-panel navigation tree is the real navigation surface. (Course selection is
// the active preset, not a URL param.)
const QID_PARAM = 'qid';
const QID_PATTERN = /^[a-zA-Z0-9]{4}$/;

function getQidFromUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get(QID_PARAM);
    return raw && QID_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Initial step: a valid `qid` deep-link wins (dev only); else resume saved
// progress; else the first step.
export function resolveInitialStepId(manifest: CourseManifest, courseId: string): string {
  const qid = getQidFromUrl();
  if (qid && findStep(manifest, qid)) return qid;
  const saved = getCurrentStepId(courseId);
  if (saved && findStep(manifest, saved)) return saved;
  return manifest.steps[0].id;
}

// --- offline fallback (keeps the plugin demonstrable before/without Hugo) -----
// Reproduces the original Course-3 demo. The grade rule is row_id-based (matching
// the gateway Update-Row shape), so we resolve the demo row's _id from the live
// base — letting the row_id grader work against the current test base with no host.

const LESSON_HTML = `
  <h1>Checking a delivery</h1>
  <p class="lead">Automate the busywork and connect your tools — let the base handle the
  repetitive steps so you only deal with the exceptions.</p>
  <p>You work in <b>receiving</b>. When a delivery arrives, its <b>delivery note</b> is scanned
  and the goods land in the base as <b>Line items</b> — one row per product, with the quantity
  ordered and the quantity received. Automations do the legwork: they read the note, create the
  lines, and flag anything that needs a human eye by ticking <b>To check</b>.</p>
  <p>Your job is to handle those exceptions — confirm what actually arrived, mark short or
  damaged deliveries, and let the automations carry the rest through. Let's start with a line
  that's been flagged for review.</p>`;

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

// Course 4 (active): the lesson + the status exercises (fix-the-stale-status +
// live-modify demo) + load-example + the op-log automation exercise. The status
// exercises act on a fixed Line items row (LINE_ITEM_ROW_ID) in the imported base.
function course4ContentSteps(): CourseStep[] {
  return [
    { id: 'le01', type: 'course', title: 'Checking a delivery', html: LESSON_HTML },
    {
      id: 'ex01',
      type: 'exercise',
      title: 'Fix the stale status',
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
      html: LIVE_MODIFY_HTML,
      demo: 'live-modify',
    },
    {
      id: 'le02',
      type: 'exercise',
      title: 'Load the example',
      html: LOAD_EXAMPLE_HTML,
      demo: 'load-example',
      example: { table_name: 'Line items', rows: LINE_ITEMS_EXAMPLE },
    },
    {
      id: 'au01',
      type: 'exercise',
      title: 'Automation review',
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

// Course 3: placeholder pages, purely for the demo look of the nav tree (the real
// collaboration content moved to Course 4).
function course3DummySteps(): CourseStep[] {
  const placeholder = (title: string, lead: string): CourseStep['html'] =>
    `<h1>${title}</h1><p class="lead">${lead}</p><p><em>Demo content — this page is a placeholder to show how a course with several pages looks in the plugin.</em></p>`;
  return [
    {
      id: 'd1',
      type: 'course',
      title: 'Sharing & permissions',
      html: placeholder(
        'Sharing & permissions',
        'Share a base or a view, and control what collaborators can see and edit.'
      ),
    },
    {
      id: 'd2',
      type: 'course',
      title: 'Comments & @mentions',
      html: placeholder(
        'Comments & @mentions',
        'Discuss rows in context and notify teammates with @mentions.'
      ),
    },
    {
      id: 'd3',
      type: 'course',
      title: 'Activity log',
      html: placeholder('Activity log', 'See who changed what, and when.'),
    },
  ];
}

// Build every demo course manifest: an Introduction page, plus the active/dummy
// pages for Courses 4 and 3.
export function buildAllFallbackManifests(): CourseManifest[] {
  return COURSES.map((c) => {
    const steps: CourseStep[] = [
      { id: 'intro', type: 'course', title: 'Introduction', html: introHtml(c) },
    ];
    if (c.id === 'course-4') steps.push(...course4ContentSteps());
    else if (c.id === 'course-3') steps.push(...course3DummySteps());
    return { courseId: c.id, title: c.name, steps };
  });
}

// Load all demo courses. A remote Hugo per-course fetch would slot in here when
// USE_REMOTE_CONTENT is enabled and a host exists; for now everything is bundled.
export async function loadAllCourses(): Promise<CourseManifest[]> {
  return buildAllFallbackManifests();
}
