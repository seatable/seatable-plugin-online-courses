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

import { GradeRule } from './grader';
import { findRowByMatch, getTableByName } from './sdkRead';
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
  grade?: GradeRule;
  /**
   * Optional demo hook — swaps the exercise's Verify flow for a scripted plugin
   * action. 'live-modify' runs a sequence of learner edits so you can watch the
   * grid update and inspect how the edits are attributed in row history.
   */
  demo?: 'live-modify';
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

const COURSE_PARAM = 'cid';
const DEFAULT_COURSE_ID = 'course-3';
// Single-step deep-link. ⛔ DEAD in production — SeaTable's dtable-web strips
// unknown URL params before the plugin script evaluates (see
// PLANNED-CHANGES-2026-07-02.md §1). Kept ONLY as a dev-only convenience; the
// left-panel navigation tree is the real navigation surface.
const QID_PARAM = 'qid';
const QID_PATTERN = /^[a-zA-Z0-9]{4}$/;

// TODO: ultimately the courseId should come from the imported base itself (each
// course ships its own base). For now: `cid` URL param → default.
export function resolveCourseId(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get(COURSE_PARAM);
    return raw && /^[a-z0-9-]+$/i.test(raw) ? raw : DEFAULT_COURSE_ID;
  } catch {
    return DEFAULT_COURSE_ID;
  }
}

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
  <h1>Collaboration</h1>
  <p class="lead">Work together on shared data — share it, keep it in sync, and build the
  habits that keep everyone on the same page.</p>
  <p>Your company has three customer-facing teams — <b>Commercial</b>, <b>Marketing</b> and
  <b>Support</b>. Each kept its own copy of the customer list, and the copies drifted out of
  sync: wrong contacts, duplicates, stale statuses. You're on Commercial, and you own the
  <b>customer master</b>. Your job: make it the single source of truth for the whole company.</p>
  <p>Let's start with something concrete — a teammate has flagged a record that's out of date.</p>`;

const EXERCISE_HTML = `
  <b>Marketing</b> flagged that <b>James Bennett</b>'s account status is out of date.
  Update <b>James Bennett</b>'s <b>Status</b> to <b>"Client"</b> to keep everyone in sync.`;

const LIVE_MODIFY_HTML = `
  <b>Live modify example.</b> Watch the plugin edit the base for you: it steps
  <b>James Bennett</b>'s <b>Status</b> through a few values. Keep the Customers table in
  view, click <b>Run live edits</b>, then open that row's history to see how the edits
  are attributed.`;

export function buildFallbackManifest(courseId: string): CourseManifest {
  const table = getTableByName('Customers');
  const row = table ? findRowByMatch(table, 'Full Name', 'James Bennett') : null;
  const bennettId = row?._id ?? '__SET_DEMO_ROW_ID__';
  return {
    courseId,
    title: 'Collaboration (offline fallback)',
    steps: [
      { id: 'le01', type: 'course', title: 'Collaboration', html: LESSON_HTML },
      {
        id: 'ex01',
        type: 'exercise',
        title: 'Fix the stale status',
        html: EXERCISE_HTML,
        hint: 'Open the Customers table, find the James Bennett row, and set its Status cell to Client.',
        grade: {
          table_name: 'Customers',
          expected: [{ row_id: bennettId, row: { Status: 'Client' } }],
        },
      },
      {
        id: 'lm01',
        type: 'exercise',
        title: 'Live modify example',
        html: LIVE_MODIFY_HTML,
        demo: 'live-modify',
      },
    ],
  };
}

// Load a course manifest: the remote Hugo fetch when enabled, else (or on failure)
// the bundled fallback. Returns a non-fatal note when the fallback is used, so the
// UI can surface it. The fallback reads the SDK tables, so call this only once the
// base data is available.
export async function loadManifest(
  courseId: string
): Promise<{ manifest: CourseManifest; loadNote: string }> {
  if (USE_REMOTE_CONTENT) {
    try {
      return { manifest: await fetchManifest(courseId), loadNote: '' };
    } catch (err: any) {
      return {
        manifest: buildFallbackManifest(courseId),
        loadNote: `Using offline fallback (${err?.message || 'manifest unavailable'}).`,
      };
    }
  }
  return { manifest: buildFallbackManifest(courseId), loadNote: '' };
}
