/**
 * The course layer's corner of the plugin datastore: what the courses have to
 * remember between visits. One plugin serves all seven courses, so progress and
 * flags are per-course maps.
 *
 * Content does NOT live here (that's Hugo, see courseContent.ts). This module
 * keeps the resume pointer, the one-way-action marks, and Course 3's colleague
 * credential. Persisted via updatePluginSettings, the same pattern used
 * everywhere else in the plugin datastore.
 *
 * ⚠️ The datastore is saved INSIDE the base — see colleagueIdentity.ts for why
 * that is where the colleague's token belongs, and what the course says about it
 * in exchange.
 */

import { PLUGIN_NAME } from '../template-constants';
import { IPluginDataStore } from '../template-interfaces/App.interface';

function sdk(): any {
  return (window as any).dtableSDK;
}

function readStore(): IPluginDataStore {
  return (sdk()?.getPluginSettings?.(PLUGIN_NAME) as IPluginDataStore) || ({} as IPluginDataStore);
}

type FlagMap = { [courseId: string]: { [key: string]: boolean } };
type ProgressMap = { [courseId: string]: string };

/**
 * ⚠️ What WE have written, kept in memory — because the datastore is written from
 * more than one place and not every writer knows about these keys.
 *
 * This module is the store's ONLY writer since 2026-11-12 (`app.tsx` used to rewrite
 * the whole store from a React state captured earlier, which dropped the marks stored
 * here — how Step 5a's "done" vanished on 2026-08-27). The shadow stays for the other
 * half of that bug: a read-modify-write here can read a store that does not yet
 * reflect the write before it.
 *
 * So: merge these over every read, and write the whole merged picture back on every
 * write, so the persisted store repairs itself at the next one.
 */
const written: {
  flags: FlagMap;
  progress: ProgressMap;
  colleagueToken?: string;
  bannerHeight?: number;
  activeCourseId?: string;
  floatPos?: { x: number; y: number };
} = {
  flags: {},
  progress: {},
};

function mergedFlags(store: IPluginDataStore): FlagMap {
  const out: FlagMap = { ...(store.courseFlags || {}) };
  Object.keys(written.flags).forEach((courseId) => {
    out[courseId] = { ...(out[courseId] || {}), ...written.flags[courseId] };
  });
  return out;
}

function mergedProgress(store: IPluginDataStore): ProgressMap {
  return { ...(store.courseProgress || {}), ...written.progress };
}

/**
 * The empty string is a real answer here — it is how "forget her token" is stored —
 * so the shadow wins as soon as it has been set at all: nullish check, not truthy.
 */
function mergedColleagueToken(store: IPluginDataStore): string {
  return written.colleagueToken ?? store.colleagueAccountToken ?? '';
}

/** The course the learner had open; `activePresetId` is where builds before 2026-11-12 kept it. */
function mergedActiveCourseId(store: IPluginDataStore): string | undefined {
  return written.activeCourseId ?? store.activeCourseId ?? store.activePresetId;
}

/**
 * Persist them all together — never one without the others, or we drop the others.
 * Only these keys are written: what the template once kept here (its presets, a
 * "New chart" preset, the plugin name) is dropped at the first write.
 */
function persist(): void {
  const store = readStore();
  const bannerHeight = written.bannerHeight ?? store.bannerHeight;
  const activeCourseId = mergedActiveCourseId(store);
  const floatIconPos = written.floatPos ?? store.floatIconPos;
  const next: IPluginDataStore = {
    courseFlags: mergedFlags(store),
    courseProgress: mergedProgress(store),
    colleagueAccountToken: mergedColleagueToken(store),
    ...(activeCourseId ? { activeCourseId } : {}),
    ...(bannerHeight ? { bannerHeight } : {}),
    ...(floatIconPos ? { floatIconPos } : {}),
  };
  sdk()?.updatePluginSettings?.(PLUGIN_NAME, next);
}

/** The last-reached step id for a course, or null if the learner is new to it. */
export function getCurrentStepId(courseId: string): string | null {
  return mergedProgress(readStore())[courseId] ?? null;
}

/**
 * Has this learner already run a one-way action of this course? Kept in the
 * datastore rather than in React state because the flow leaves the plugin in
 * between: Step 4's rewind empties the base, the learner goes off to the app to
 * receive the delivery again, and comes back — by which time session state has
 * long forgotten, and offering "rewind" again would delete what they just got.
 */
export function getCourseFlag(courseId: string, key: string): boolean {
  return mergedFlags(readStore())[courseId]?.[key] ?? false;
}

export function setCourseFlag(courseId: string, key: string, value: boolean): void {
  written.flags[courseId] = { ...(written.flags[courseId] || {}), [key]: value };
  persist();
  // The step list lives elsewhere in the tree and reads these flags for its
  // checkmarks — tell it something changed.
  window.dispatchEvent(new Event(PROGRESS_EVENT));
}

/** Fired whenever a course flag changes, so the step list can redraw its checkmarks. */
export const PROGRESS_EVENT = 'online-courses:progress';

/**
 * Two flags per step, because "the plugin's action has run" and "the step is
 * done" are not the same thing on a step that ALSO has a verify (Course 4's
 * reviewer and rewind steps: the plugin prepares the ground, the learner then does
 * the work that is graded).
 *
 *   demo-done:<id>  the action ran — it must not be replayed. Also set by a page
 *                   with nothing to do once opened, and by a window on Malika
 *                   once its success condition is seen.
 *   step-done:<id>  the verify passed.
 *
 * The step list shows a checkmark for a step that is done: step-done if it has a
 * grade, demo-done otherwise.
 */
export const stepDoneKey = (stepId: string) => `demo-done:${stepId}`;
export const stepPassedKey = (stepId: string) => `step-done:${stepId}`;

export function isStepDone(courseId: string, step: { id: string; grade?: unknown }): boolean {
  return step.grade
    ? getCourseFlag(courseId, stepPassedKey(step.id))
    : getCourseFlag(courseId, stepDoneKey(step.id));
}

/** Remember the learner's current step for a course (for resume next time). */
export function setCurrentStepId(courseId: string, stepId: string): void {
  written.progress[courseId] = stepId;
  persist();
}

/** Course 3's colleague credential — the empty string when none is configured. */
export function getStoredColleagueToken(): string {
  return mergedColleagueToken(readStore()).trim();
}

export function setStoredColleagueToken(token: string): void {
  written.colleagueToken = token.trim();
  persist();
}

/** The banner height the learner chose with the resize handle, or null if they never did. */
export function getStoredBannerHeight(): number | null {
  const px = written.bannerHeight ?? readStore().bannerHeight;
  return typeof px === 'number' && px > 0 ? px : null;
}

export function setStoredBannerHeight(px: number): void {
  written.bannerHeight = Math.round(px);
  persist();
}

/** The course the learner had open in this base, or null the first time. */
export function getStoredActiveCourseId(): string | null {
  return mergedActiveCourseId(readStore()) ?? null;
}

export function setStoredActiveCourseId(courseId: string): void {
  written.activeCourseId = courseId;
  persist();
}

/** Where the learner last left the floating toolbar, or null (bottom-left default). */
export function getStoredFloatPos(): { x: number; y: number } | null {
  const pos = written.floatPos ?? readStore().floatIconPos;
  return pos && typeof pos.x === 'number' && typeof pos.y === 'number' ? pos : null;
}

export function setStoredFloatPos(pos: { x: number; y: number }): void {
  written.floatPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
  persist();
}
